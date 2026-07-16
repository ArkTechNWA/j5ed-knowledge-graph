#!/usr/bin/env python3
"""
Ambient Recall Proxy — injects semantically-retrieved KG memories
into Claude Code API requests.

Sits between Claude Code and the Anthropic API:
  Claude Code → this proxy → api.anthropic.com

Usage: ANTHROPIC_BASE_URL=http://localhost:8780 run-claude
"""

import asyncio
import copy
import hashlib
import json
import re
import sqlite3
import struct
import time
import urllib.request
from collections import defaultdict
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
import tiktoken
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse, JSONResponse, Response

import config as cfg


# ── sqlite-vec extension ───────────────────────────────────────────

def load_vec_extension(db: sqlite3.Connection) -> None:
    """Load sqlite-vec into a Python sqlite3 connection."""
    db.enable_load_extension(True)
    try:
        import sqlite_vec
        sqlite_vec.load(db)
    except ImportError:
        vec_path = str(Path(__file__).parent.parent / "node_modules/sqlite-vec-linux-x64/vec0")
        db.load_extension(vec_path)


# ── Token counting ────────────────────────────────────────────────

_enc = None

def count_tokens(text: str) -> int:
    global _enc
    if _enc is None:
        try:
            _enc = tiktoken.get_encoding("cl100k_base")
        except Exception:
            pass
    return len(_enc.encode(text)) if _enc else len(text) // 4


# ── Ollama embedding ──────────────────────────────────────────────

def embed_text(text: str) -> bytes:
    """Embed text via Ollama. Returns raw float32 bytes for sqlite-vec."""
    payload = json.dumps({"model": cfg.EMBED_MODEL, "input": [text]}).encode()
    req = urllib.request.Request(
        f"{cfg.OLLAMA_URL}/api/embed",
        data=payload,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        data = json.loads(resp.read())
    return struct.pack(f"{cfg.EMBED_DIM}f", *data["embeddings"][0])


# ── Vector retrieval ──────────────────────────────────────────────

def retrieve_memories(query_embedding: bytes, k: int) -> list[dict]:
    """kNN search against vec_observations, join to observations + entities."""
    db = sqlite3.connect(f"file:{cfg.DB_PATH}?mode=ro", uri=True)
    db.execute("PRAGMA journal_mode=WAL")
    load_vec_extension(db)

    rows = db.execute("""
        SELECT v.rowid, v.distance, o.content, vm.entity_name, vm.authored_by
        FROM vec_observations v
        JOIN observations o ON o.id = v.rowid
        JOIN vec_metadata vm ON vm.observation_id = v.rowid
        WHERE v.embedding MATCH ? AND k = ? AND o.superseded_at IS NULL
        ORDER BY v.distance
    """, (query_embedding, k)).fetchall()
    db.close()

    return [{
        "obs_id": r[0], "distance": r[1], "content": r[2],
        "entity_name": r[3], "authored_by": r[4],
        "similarity": 1.0 - (r[1] ** 2) / 2.0,
    } for r in rows]


# ── Query building ────────────────────────────────────────────────

def strip_xml_tags(text: str) -> str:
    """Remove system-injected XML blocks from text."""
    text = re.sub(r'<system-reminder>.*?</system-reminder>', '', text, flags=re.DOTALL)
    text = re.sub(r'<local-command-.*?>.*?</local-command-.*?>', '', text, flags=re.DOTALL)
    text = re.sub(r'<bash-.*?>.*?</bash-.*?>', '', text, flags=re.DOTALL)
    text = re.sub(r'<command-.*?>.*?</command-.*?>', '', text, flags=re.DOTALL)
    return re.sub(r'\s+', ' ', text).strip()


def build_query_text(messages: list[dict]) -> str:
    """Extract last 2-3 turns as query text, cap at 500 chars."""
    relevant = []
    for msg in reversed(messages[-6:]):
        if msg.get("role") in ("user", "assistant"):
            content = msg.get("content", "")
            if isinstance(content, list):
                content = " ".join(
                    b.get("text", "") for b in content
                    if isinstance(b, dict) and b.get("type") == "text"
                )
            content = strip_xml_tags(content)
            if content:
                relevant.append(content)
        if len(relevant) >= 3:
            break
    return " ".join(reversed(relevant))[:500]


def should_inject(messages: list[dict]) -> bool:
    """Trigger rules: user turn, 10+ chars after XML strip, not a tool_result."""
    if not messages or messages[-1].get("role") != "user":
        return False
    content = messages[-1].get("content", "")
    if isinstance(content, list):
        if any(isinstance(b, dict) and b.get("type") == "tool_result" for b in content):
            return False
        content = " ".join(
            b.get("text", "") for b in content
            if isinstance(b, dict) and b.get("type") == "text"
        )
    return len(strip_xml_tags(content).strip()) >= 10


# ── Conversation state ────────────────────────────────────────────

_conv_state: dict[str, dict[int, int]] = defaultdict(dict)
_conv_turns: dict[str, int] = defaultdict(int)


def get_conv_hash(body: dict) -> str:
    """Hash system prompt for conversation identity."""
    system = body.get("system", "")
    if isinstance(system, list):
        system = " ".join(
            b.get("text", "") for b in system
            if isinstance(b, dict) and b.get("type") == "text"
        )
    return hashlib.sha256(system.encode()).hexdigest()[:16]


def filter_and_budget(candidates: list[dict], conv_hash: str, turn: int) -> list[dict]:
    """Apply similarity threshold, dedup, and token budget."""
    injected = _conv_state[conv_hash]
    selected = []
    budget = cfg.TOKEN_BUDGET

    for mem in candidates:
        if mem["similarity"] < cfg.TAU_INJECT:
            continue
        obs_id = mem["obs_id"]
        if obs_id in injected and turn - injected[obs_id] <= cfg.DEDUP_TURNS:
            continue
        tokens = count_tokens(mem["content"])
        if tokens > budget:
            continue
        selected.append(mem)
        budget -= tokens
        if budget < 50:
            break

    return selected


# ── Injection ─────────────────────────────────────────────────────

def format_injection(memories: list[dict]) -> str:
    """Format memories as <ambient_recall> block."""
    lines = ["<ambient_recall>"]
    for mem in memories:
        lines.append(f"- [entity: {mem['entity_name']}] {mem['content']}")
    lines.append("</ambient_recall>")
    return "\n".join(lines)


def inject_into_body(body: dict, injection: str) -> dict:
    """Append ambient recall as a content block in the last user message.

    System prompt is NEVER modified — Anthropic validates it on OAuth requests.
    """
    if not injection:
        return body
    body = copy.deepcopy(body)
    messages = body.get("messages", [])
    for i in range(len(messages) - 1, -1, -1):
        if messages[i].get("role") == "user":
            content = messages[i].get("content", "")
            block = {"type": "text", "text": injection}
            if isinstance(content, list):
                messages[i]["content"] = content + [block]
            else:
                messages[i]["content"] = [{"type": "text", "text": content}, block]
            break
    body["messages"] = messages
    return body


# ── Logging ───────────────────────────────────────────────────────

def log_event(event: dict):
    """Append to JSONL log."""
    try:
        path = Path(cfg.LOG_PATH)
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "a") as f:
            f.write(json.dumps(event) + "\n")
    except Exception:
        pass  # best-effort


# ── App ───────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    print(f"[AMBIENT] Proxy on :{cfg.PROXY_PORT} → {cfg.UPSTREAM_URL}")
    print(f"[AMBIENT] DB: {cfg.DB_PATH} | Ollama: {cfg.OLLAMA_URL} ({cfg.EMBED_MODEL})")
    print(f"[AMBIENT] tau={cfg.TAU_INJECT} budget={cfg.TOKEN_BUDGET} k={cfg.KNN_K}")
    yield

app = FastAPI(lifespan=lifespan)
client = httpx.AsyncClient(base_url=cfg.UPSTREAM_URL, timeout=300.0)
_upstream_sem = asyncio.Semaphore(1)

STRIP_HEADERS = {"host", "content-length", "transfer-encoding", "content-encoding", "connection"}


@app.get("/health")
async def health():
    components = {}
    try:
        embed_text("ping")
        components["ollama"] = "ok"
    except Exception as e:
        components["ollama"] = f"error: {e}"
    try:
        db = sqlite3.connect(f"file:{cfg.DB_PATH}?mode=ro", uri=True)
        load_vec_extension(db)
        vec = db.execute("SELECT COUNT(*) FROM vec_metadata").fetchone()[0]
        live = db.execute("SELECT COUNT(*) FROM observations WHERE superseded_at IS NULL").fetchone()[0]
        db.close()
        components["database"] = "ok"
        components["vec_count"] = vec
        components["live_observations"] = live
    except Exception as e:
        components["database"] = f"error: {e}"
    ok = all(v == "ok" for k, v in components.items() if k in ("ollama", "database"))
    return JSONResponse({"status": "healthy" if ok else "degraded", **components}, status_code=200 if ok else 503)


@app.head("/")
@app.get("/")
async def root():
    return JSONResponse({"status": "ok", "proxy": "ambient-recall"})


@app.api_route("/{path:path}", methods=["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH"])
async def proxy_request(request: Request, path: str):
    query_string = request.url.query
    url = f"/{path}?{query_string}" if query_string else f"/{path}"
    headers = {k: v for k, v in request.headers.items() if k not in STRIP_HEADERS}

    if cfg.ANTHROPIC_API_KEY and "x-api-key" not in headers and "authorization" not in headers:
        headers["x-api-key"] = cfg.ANTHROPIC_API_KEY

    body_bytes = await request.body()
    injection_log = None

    # Ambient recall injection
    if request.method == "POST" and path == "v1/messages" and body_bytes:
        try:
            body = json.loads(body_bytes)
            messages = body.get("messages", [])

            if should_inject(messages):
                t0 = time.time()
                query_text = build_query_text(messages)
                query_emb = embed_text(query_text)
                candidates = retrieve_memories(query_emb, cfg.KNN_K)
                conv_hash = get_conv_hash(body)
                turn = _conv_turns[conv_hash] + 1
                selected = filter_and_budget(candidates, conv_hash, turn)

                if selected:
                    injection = format_injection(selected)
                    body = inject_into_body(body, injection)
                    body_bytes = json.dumps(body).encode()
                    _conv_turns[conv_hash] = turn
                    for mem in selected:
                        _conv_state[conv_hash][mem["obs_id"]] = turn

                latency_ms = int((time.time() - t0) * 1000)
                top = round(candidates[0]["similarity"], 3) if candidates else 0
                print(f"[AMBIENT] q={query_text[:60]!r} cand={len(candidates)} inj={len(selected)} top={top} {latency_ms}ms", flush=True)

                injection_log = {
                    "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "conv_hash": conv_hash, "turn": turn,
                    "query_preview": query_text[:80],
                    "candidates": len(candidates), "injected": len(selected),
                    "injected_ids": [m["obs_id"] for m in selected],
                    "top_score": top, "latency_ms": latency_ms,
                }
        except Exception as e:
            print(f"[AMBIENT] Injection error: {e}", flush=True)

    # Forward upstream
    is_stream = False
    if body_bytes:
        try:
            is_stream = json.loads(body_bytes).get("stream", False)
        except Exception:
            pass

    if is_stream:
        await _upstream_sem.acquire()
        try:
            req = client.build_request(method=request.method, url=url, headers=headers, content=body_bytes)
            resp = await client.send(req, stream=True)
        except Exception:
            _upstream_sem.release()
            raise

        async def stream():
            try:
                async for chunk in resp.aiter_bytes():
                    yield chunk
            finally:
                await resp.aclose()
                await asyncio.sleep(0.3)
                _upstream_sem.release()

        if injection_log:
            log_event(injection_log)

        resp_headers = {k: v for k, v in resp.headers.items() if k not in STRIP_HEADERS}
        return StreamingResponse(stream(), status_code=resp.status_code, headers=resp_headers)
    else:
        async with _upstream_sem:
            resp = await client.request(method=request.method, url=url, headers=headers, content=body_bytes)
        if injection_log:
            log_event(injection_log)
        resp_headers = {k: v for k, v in resp.headers.items() if k not in STRIP_HEADERS}
        return Response(content=resp.content, status_code=resp.status_code, headers=resp_headers)


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=cfg.PROXY_PORT, log_level="info")
