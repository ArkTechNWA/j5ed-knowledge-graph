#!/usr/bin/env python3
"""
Ambient Recall Proxy — injects semantically-retrieved KG memories
into Claude Code API requests.

Sits between Claude Code and the Anthropic API:
  Claude Code → this proxy → api.anthropic.com

Set ANTHROPIC_BASE_URL=http://localhost:8787 when launching Claude Code.
"""

import hashlib
import json
import sqlite3
import struct
import time
import urllib.request
import urllib.error
from collections import defaultdict
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
import tiktoken
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse, JSONResponse

import config as cfg


# ── sqlite-vec extension loading ───────────────────────────────

def load_vec_extension(db: sqlite3.Connection) -> None:
    db.enable_load_extension(True)
    try:
        import sqlite_vec
        sqlite_vec.load(db)
    except ImportError:
        from pathlib import Path
        vec_path = str(Path(__file__).parent.parent / "node_modules/sqlite-vec-linux-x64/vec0")
        db.load_extension(vec_path)


# ── State ──────────────────────────────────────────────────────────

# Per-conversation dedup: conv_hash → { obs_id: last_turn }
_conv_state: dict[str, dict[int, int]] = defaultdict(dict)
_conv_turns: dict[str, int] = defaultdict(int)

# Token counter (approximate — cl100k is close enough for budgeting)
_enc = None

def get_encoder():
    global _enc
    if _enc is None:
        try:
            _enc = tiktoken.get_encoding("cl100k_base")
        except Exception:
            _enc = None
    return _enc

def count_tokens(text: str) -> int:
    enc = get_encoder()
    if enc:
        return len(enc.encode(text))
    return len(text) // 4  # rough fallback


# ── Ollama ─────────────────────────────────────────────────────────

def embed_text(text: str) -> bytes:
    """Embed a single text via Ollama. Returns raw float32 bytes."""
    payload = json.dumps({"model": cfg.EMBED_MODEL, "input": [text]}).encode()
    req = urllib.request.Request(
        f"{cfg.OLLAMA_URL}/api/embed",
        data=payload,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        data = json.loads(resp.read())
    emb = data["embeddings"][0]
    return struct.pack(f"{cfg.EMBED_DIM}f", *emb)


# ── SQLite vec retrieval ───────────────────────────────────────────

def retrieve_memories(query_embedding: bytes, k: int) -> list[dict]:
    """kNN search against vec_observations, join back to observations + entities."""
    db = sqlite3.connect(f"file:{cfg.DB_PATH}?mode=ro", uri=True)
    db.execute("PRAGMA journal_mode=WAL")
    load_vec_extension(db)

    rows = db.execute("""
        SELECT
            v.rowid AS obs_id,
            v.distance,
            o.content,
            vm.entity_name,
            vm.authored_by
        FROM vec_observations v
        JOIN observations o ON o.id = v.rowid
        JOIN vec_metadata vm ON vm.observation_id = v.rowid
        WHERE v.embedding MATCH ?
          AND k = ?
          AND o.superseded_at IS NULL
        ORDER BY v.distance
    """, (query_embedding, k)).fetchall()

    db.close()

    return [
        {
            "obs_id": r[0],
            "distance": r[1],
            "content": r[2],
            "entity_name": r[3],
            "authored_by": r[4],
            "similarity": 1.0 - (r[1] ** 2) / 2.0,  # L2 distance → cosine similarity (for unit-normalized vectors)
        }
        for r in rows
    ]


# ── Injection logic ───────────────────────────────────────────────

def build_query_text(messages: list[dict]) -> str:
    """Extract last 2-3 turns as query text, cap at 500 chars."""
    relevant = []
    for msg in reversed(messages[-6:]):  # look at last 6 messages max
        role = msg.get("role", "")
        if role in ("user", "assistant"):
            content = msg.get("content", "")
            if isinstance(content, list):
                # Handle content blocks
                content = " ".join(
                    b.get("text", "") for b in content
                    if isinstance(b, dict) and b.get("type") == "text"
                )
            if content:
                relevant.append(content)
        if len(relevant) >= 3:
            break

    text = " ".join(reversed(relevant))
    return text[:500]


def should_inject(messages: list[dict]) -> bool:
    """Check trigger rules: user turn, not too short, not a tool_result."""
    if not messages:
        return False
    last = messages[-1]
    if last.get("role") != "user":
        return False

    content = last.get("content", "")
    if isinstance(content, list):
        # Check for tool_result blocks
        for block in content:
            if isinstance(block, dict) and block.get("type") == "tool_result":
                return False
        text = " ".join(
            b.get("text", "") for b in content
            if isinstance(b, dict) and b.get("type") == "text"
        )
    else:
        text = content

    return len(text.strip()) >= 10


def get_conv_hash(body: dict) -> str:
    """Hash the system prompt for conversation identity."""
    system = body.get("system", "")
    if isinstance(system, list):
        system = " ".join(
            b.get("text", "") for b in system
            if isinstance(b, dict) and b.get("type") == "text"
        )
    return hashlib.sha256(system.encode()).hexdigest()[:16]


def filter_and_budget(
    candidates: list[dict],
    conv_hash: str,
    turn: int,
) -> list[dict]:
    """Apply similarity threshold, dedup, and token budget."""
    injected = _conv_state[conv_hash]

    selected = []
    budget = cfg.TOKEN_BUDGET

    for mem in candidates:
        # Similarity threshold
        if mem["similarity"] < cfg.TAU_INJECT:
            continue

        # Dedup: skip if injected within DEDUP_TURNS
        obs_id = mem["obs_id"]
        if obs_id in injected:
            last_turn = injected[obs_id]
            if turn - last_turn <= cfg.DEDUP_TURNS:
                # Unless similarity is much higher this time (re-surfacing)
                continue

        # Token budget
        tokens = count_tokens(mem["content"])
        if tokens > budget:
            continue

        selected.append(mem)
        budget -= tokens

        if budget < 50:
            break

    return selected


def format_injection(memories: list[dict]) -> str:
    """Format memories as <ambient_recall> block."""
    if not memories:
        return ""

    lines = ["<ambient_recall>"]
    for mem in memories:
        entity = mem["entity_name"]
        content = mem["content"]
        lines.append(f"- [entity: {entity}] {content}")
    lines.append("</ambient_recall>")
    return "\n".join(lines)


def inject_into_body(body: dict, injection: str) -> dict:
    """Prepend ambient_recall block to the system message."""
    if not injection:
        return body

    body = body.copy()
    system = body.get("system", "")

    if isinstance(system, list):
        # System is content blocks — prepend a text block
        body["system"] = [{"type": "text", "text": injection}] + system
    elif isinstance(system, str) and system:
        body["system"] = injection + "\n\n" + system
    else:
        body["system"] = injection

    return body


# ── Logging ────────────────────────────────────────────────────────

def log_event(event: dict):
    """Append to JSONL log."""
    try:
        log_path = Path(cfg.LOG_PATH)
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with open(log_path, "a") as f:
            f.write(json.dumps(event) + "\n")
    except Exception as e:
        print(f"[AMBIENT] Log write failed: {e}", flush=True)


# ── Proxy ──────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    print(f"[AMBIENT] Proxy starting on :{cfg.PROXY_PORT}")
    print(f"[AMBIENT] Upstream: {cfg.UPSTREAM_URL}")
    print(f"[AMBIENT] DB: {cfg.DB_PATH}")
    print(f"[AMBIENT] Ollama: {cfg.OLLAMA_URL} ({cfg.EMBED_MODEL})")
    print(f"[AMBIENT] Thresholds: inject={cfg.TAU_INJECT}, signal={cfg.TAU_SIGNAL}")
    print(f"[AMBIENT] Token budget: {cfg.TOKEN_BUDGET}")
    yield
    print("[AMBIENT] Proxy shutting down")

app = FastAPI(lifespan=lifespan)
client = httpx.AsyncClient(base_url=cfg.UPSTREAM_URL, timeout=300.0)


@app.get("/health")
async def health():
    """Health check — reports component status."""
    components = {}

    # Ollama
    try:
        embed_text("ping")
        components["ollama"] = "ok"
    except Exception as e:
        components["ollama"] = f"error: {e}"

    # Database
    try:
        db = sqlite3.connect(f"file:{cfg.DB_PATH}?mode=ro", uri=True)
        load_vec_extension(db)
        vec_count = db.execute("SELECT COUNT(*) FROM vec_metadata").fetchone()[0]
        live_count = db.execute(
            "SELECT COUNT(*) FROM observations WHERE superseded_at IS NULL"
        ).fetchone()[0]
        db.close()
        components["database"] = "ok"
        components["vec_count"] = vec_count
        components["live_observations"] = live_count
        components["coverage"] = f"{vec_count}/{live_count}" if live_count else "0/0"
    except Exception as e:
        components["database"] = f"error: {e}"

    all_ok = all(v == "ok" for k, v in components.items() if k in ("ollama", "database"))
    return JSONResponse(
        {"status": "healthy" if all_ok else "degraded", **components},
        status_code=200 if all_ok else 503,
    )


@app.api_route("/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH"])
async def proxy_request(request: Request, path: str):
    """Proxy all requests to upstream, injecting ambient recall on /v1/messages."""
    url = f"/{path}"
    headers = dict(request.headers)
    headers.pop("host", None)
    headers.pop("content-length", None)  # recalculated by httpx after body modification

    # Forward API key
    if cfg.ANTHROPIC_API_KEY and "x-api-key" not in headers:
        headers["x-api-key"] = cfg.ANTHROPIC_API_KEY

    body_bytes = await request.body()

    injection_log = None

    # Only intercept POST /v1/messages
    if request.method == "POST" and path == "v1/messages" and body_bytes:
        try:
            body = json.loads(body_bytes)
            messages = body.get("messages", [])

            if should_inject(messages):
                t0 = time.time()

                # Build query from recent turns
                query_text = build_query_text(messages)

                # Embed the query
                query_emb = embed_text(query_text)

                # Retrieve candidates
                candidates = retrieve_memories(query_emb, cfg.KNN_K)

                # Filter and budget
                conv_hash = get_conv_hash(body)
                turn = _conv_turns[conv_hash] + 1
                _conv_turns[conv_hash] = turn

                selected = filter_and_budget(candidates, conv_hash, turn)

                if selected:
                    # Format and inject
                    injection = format_injection(selected)
                    body = inject_into_body(body, injection)
                    body_bytes = json.dumps(body).encode()

                    # Track injected IDs
                    for mem in selected:
                        _conv_state[conv_hash][mem["obs_id"]] = turn

                latency_ms = int((time.time() - t0) * 1000)

                injection_log = {
                    "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "conv_hash": conv_hash,
                    "turn": turn,
                    "query_preview": query_text[:80],
                    "candidates": len(candidates),
                    "injected": len(selected),
                    "injected_ids": [m["obs_id"] for m in selected],
                    "top_score": round(candidates[0]["similarity"], 3) if candidates else 0,
                    "budget_used": cfg.TOKEN_BUDGET - sum(count_tokens(m["content"]) for m in selected) if selected else 0,
                    "latency_ms": latency_ms,
                }
        except Exception as e:
            # Best-effort: if anything fails, pass through unmodified
            print(f"[AMBIENT] Injection failed, passing through: {e}", flush=True)

    # Check if streaming is requested
    is_stream = False
    if body_bytes:
        try:
            is_stream = json.loads(body_bytes).get("stream", False)
        except Exception:
            pass

    if is_stream:
        # Stream the response
        upstream_req = client.build_request(
            method=request.method,
            url=url,
            headers=headers,
            content=body_bytes,
        )
        upstream_resp = await client.send(upstream_req, stream=True)

        async def stream_body():
            async for chunk in upstream_resp.aiter_bytes():
                yield chunk
            await upstream_resp.aclose()

        if injection_log:
            log_event(injection_log)

        # Strip headers that httpx already handled (decompression, framing)
        resp_headers = {k: v for k, v in upstream_resp.headers.items()
                       if k.lower() not in ("content-length", "transfer-encoding", "content-encoding")}
        return StreamingResponse(
            stream_body(),
            status_code=upstream_resp.status_code,
            headers=resp_headers,
        )
    else:
        # Non-streaming: forward and return
        upstream_resp = await client.request(
            method=request.method,
            url=url,
            headers=headers,
            content=body_bytes,
        )

        if injection_log:
            log_event(injection_log)

        return JSONResponse(
            content=upstream_resp.json() if upstream_resp.headers.get("content-type", "").startswith("application/json") else upstream_resp.text,
            status_code=upstream_resp.status_code,
            headers={k: v for k, v in upstream_resp.headers.items()
                    if k.lower() not in ("content-length", "transfer-encoding", "content-encoding")},
        )


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=cfg.PROXY_PORT, log_level="info")
