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

def strip_xml_tags(text: str) -> str:
    """Remove <system-reminder>...</system-reminder> and similar XML blocks."""
    import re
    # Remove full XML blocks (system-reminder, local-command, etc.)
    text = re.sub(r'<system-reminder>.*?</system-reminder>', '', text, flags=re.DOTALL)
    text = re.sub(r'<local-command-.*?>.*?</local-command-.*?>', '', text, flags=re.DOTALL)
    text = re.sub(r'<bash-.*?>.*?</bash-.*?>', '', text, flags=re.DOTALL)
    text = re.sub(r'<command-.*?>.*?</command-.*?>', '', text, flags=re.DOTALL)
    # Collapse whitespace
    text = re.sub(r'\s+', ' ', text).strip()
    return text


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
                # Strip system-injected XML before using as query
                content = strip_xml_tags(content)
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

    text = strip_xml_tags(text)
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
    """Inject ambient recall as a user message in the conversation.

    Appended as the last user message content block, so the model sees it
    as context provided alongside the user's input. System prompt is NEVER
    modified — that's Anthropic's territory.
    """
    if not injection:
        return body

    import copy
    body = copy.deepcopy(body)
    messages = body.get("messages", [])

    if not messages:
        return body

    # Find the last user message and append the recall as a content block
    for i in range(len(messages) - 1, -1, -1):
        if messages[i].get("role") == "user":
            content = messages[i].get("content", "")
            recall_block = {"type": "text", "text": injection}

            if isinstance(content, list):
                # Content is already blocks — append ours
                messages[i]["content"] = content + [recall_block]
            elif isinstance(content, str):
                # Content is a string — convert to blocks
                messages[i]["content"] = [
                    {"type": "text", "text": content},
                    recall_block,
                ]
            break

    body["messages"] = messages
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

# Serialize upstream requests to prevent concurrent 429s
# Claude Code sends two POST /v1/messages simultaneously on startup
# (fast-mode probe + real request). Without serialization, both hit
# Anthropic concurrently and one gets 429.
# The semaphore holds through the FULL response (including streaming body)
# so requests are truly sequential end-to-end.
import asyncio
_upstream_sem = asyncio.Semaphore(1)


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


@app.head("/")
@app.get("/")
async def root():
    """Connectivity check — Claude Code sends HEAD / on startup."""
    return JSONResponse({"status": "ok", "proxy": "ambient-recall"})


@app.api_route("/{path:path}", methods=["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH"])
async def proxy_request(request: Request, path: str):
    """Proxy all requests to upstream, injecting ambient recall on /v1/messages."""
    # Preserve query string from original request
    query_string = request.url.query
    url = f"/{path}"
    if query_string:
        url = f"/{path}?{query_string}"
    # Forward all headers except hop-by-hop and size headers (httpx rebuilds these)
    STRIP_HEADERS = {"host", "content-length", "transfer-encoding", "content-encoding", "connection"}
    raw_headers = dict(request.headers)
    headers = {k: v for k, v in raw_headers.items() if k.lower() not in STRIP_HEADERS}

    # Auth: forward whatever Claude Code sends (OAuth Bearer or x-api-key)
    # If ANTHROPIC_API_KEY is set and no auth present, use it as fallback
    if cfg.ANTHROPIC_API_KEY and "x-api-key" not in headers and "authorization" not in headers:
        headers["x-api-key"] = cfg.ANTHROPIC_API_KEY

    body_bytes = await request.body()

    injection_log = None

    # Intercept POST /v1/messages for ambient recall injection
    # Skip small requests (<10KB) — these are Claude Code system negotiations
    # that don't contain user conversation and would cause concurrent 429s
    if request.method == "POST" and path == "v1/messages" and body_bytes:
        try:
            body = json.loads(body_bytes)
            messages = body.get("messages", [])
            print(f"[AMBIENT] Parsed body: {len(messages)} messages, system={'present' if body.get('system') else 'absent'}", flush=True)

            inject = should_inject(messages)
            print(f"[AMBIENT] should_inject={inject}", flush=True)

            if inject:
                t0 = time.time()

                query_text = build_query_text(messages)
                print(f"[AMBIENT] Query: {query_text[:100]!r}", flush=True)

                query_emb = embed_text(query_text)
                print(f"[AMBIENT] Embedded query ({len(query_emb)} bytes)", flush=True)

                candidates = retrieve_memories(query_emb, cfg.KNN_K)
                print(f"[AMBIENT] Retrieved {len(candidates)} candidates", flush=True)
                if candidates:
                    print(f"[AMBIENT] Top 3 scores: {[round(c['similarity'], 3) for c in candidates[:3]]}", flush=True)

                conv_hash = get_conv_hash(body)
                turn = _conv_turns[conv_hash] + 1
                # Don't increment turn counter yet — only after successful forward

                selected = filter_and_budget(candidates, conv_hash, turn)
                print(f"[AMBIENT] Selected {len(selected)} after filtering (tau={cfg.TAU_INJECT})", flush=True)

                if selected:
                    injection = format_injection(selected)
                    print(f"[AMBIENT] INJECTING {len(selected)} memories ({len(injection)} chars)", flush=True)
                    body = inject_into_body(body, injection)
                    body_bytes = json.dumps(body).encode()
                    print(f"[AMBIENT] Body grew to {len(body_bytes)} bytes", flush=True)

                    for mem in selected:
                        _conv_state[conv_hash][mem["obs_id"]] = turn
                else:
                    print(f"[AMBIENT] Nothing passed filter — no injection", flush=True)

                latency_ms = int((time.time() - t0) * 1000)
                print(f"[AMBIENT] Total injection latency: {latency_ms}ms", flush=True)

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
            import traceback
            print(f"[AMBIENT] INJECTION EXCEPTION: {e}", flush=True)
            traceback.print_exc()

    # Debug: log what we're about to forward
    print(f"[AMBIENT] >>> {request.method} {url}", flush=True)
    print(f"[AMBIENT] >>> Headers forwarded: {list(headers.keys())}", flush=True)
    if 'x-api-key' in headers:
        key = headers['x-api-key']
        print(f"[AMBIENT] >>> Auth: x-api-key {key[:12]}...{key[-4:]}", flush=True)
    elif 'authorization' in headers:
        print(f"[AMBIENT] >>> Auth: Bearer token (OAuth)", flush=True)
    else:
        print(f"[AMBIENT] >>> WARNING: No auth header!", flush=True)
    print(f"[AMBIENT] >>> Body size: {len(body_bytes)} bytes", flush=True)

    # Check if streaming is requested
    is_stream = False
    if body_bytes:
        try:
            is_stream = json.loads(body_bytes).get("stream", False)
        except Exception:
            pass

    if is_stream:
        # Hold semaphore through entire response (including streaming body)
        # to prevent concurrent requests from overlapping at Anthropic
        await _upstream_sem.acquire()
        try:
            upstream_req = client.build_request(
                method=request.method,
                url=url,
                headers=headers,
                content=body_bytes,
            )
            upstream_resp = await client.send(upstream_req, stream=True)
        except Exception:
            _upstream_sem.release()
            raise

        async def stream_body():
            try:
                async for chunk in upstream_resp.aiter_bytes():
                    yield chunk
            finally:
                await upstream_resp.aclose()
                # Brief cooldown before releasing — Anthropic's rate limiter
                # may still consider the connection active for a short window
                await asyncio.sleep(0.5)
                _upstream_sem.release()

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
        # Non-streaming: forward and return (serialized)
        async with _upstream_sem:
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
