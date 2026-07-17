#!/usr/bin/env python3
"""
Ambient Recall Proxy — injects semantically-retrieved KG memories
into Claude Code API requests.

Sits between Claude Code and the Anthropic API:
  Claude Code → this proxy → api.anthropic.com

Usage: ANTHROPIC_BASE_URL=http://localhost:8780 run-claude
"""

import asyncio
import os
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
import classifier


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

def retrieve_memories(query_embedding: bytes, k: int, query_text: str = "") -> list[dict]:
    """Hybrid retrieval: vec kNN + FTS5 keyword search, merged and deduplicated."""
    db = sqlite3.connect(f"file:{cfg.DB_PATH}?mode=ro", uri=True)
    db.execute("PRAGMA journal_mode=WAL")
    load_vec_extension(db)

    results: dict[int, dict] = {}

    # Path 1: Vector kNN (semantic similarity)
    vec_rows = db.execute("""
        SELECT v.rowid, v.distance, o.content, vm.entity_name, vm.authored_by
        FROM vec_observations v
        JOIN observations o ON o.id = v.rowid
        JOIN vec_metadata vm ON vm.observation_id = v.rowid
        WHERE v.embedding MATCH ? AND k = ? AND o.superseded_at IS NULL
              AND (? = '' OR vm.authored_by = ?)
        ORDER BY v.distance
    """, (query_embedding, k, cfg.AGENT_FILTER, cfg.AGENT_FILTER)).fetchall()

    for r in vec_rows:
        results[r[0]] = {
            "obs_id": r[0], "distance": r[1], "content": r[2],
            "entity_name": r[3], "authored_by": r[4],
            "similarity": 1.0 - (r[1] ** 2) / 2.0,
            "source": "vec",
        }

    # Path 2: FTS5 keyword search (lexical match)
    if query_text:
        fts_query = _build_fts_query(query_text)
        if fts_query:
            try:
                fts_rows = db.execute("""
                    SELECT o.id, o.content, e.name,
                           (SELECT vm.authored_by FROM vec_metadata vm WHERE vm.observation_id = o.id)
                    FROM observations_fts fts
                    JOIN observations o ON o.rowid = fts.rowid
                    JOIN entities e ON e.id = o.entity_id
                    LEFT JOIN vec_metadata vm2 ON vm2.observation_id = o.id
                    WHERE observations_fts MATCH ? AND o.superseded_at IS NULL
                          AND (? = '' OR vm2.authored_by = ?)
                    ORDER BY rank
                    LIMIT ?
                """, (fts_query, cfg.AGENT_FILTER, cfg.AGENT_FILTER, k)).fetchall()

                for r in fts_rows:
                    obs_id = r[0]
                    if obs_id not in results:
                        results[obs_id] = {
                            "obs_id": obs_id, "distance": 0, "content": r[1],
                            "entity_name": r[2], "authored_by": r[3],
                            "similarity": 0.70,  # FTS hits get a baseline similarity score
                            "source": "fts",
                        }
                    else:
                        # Boost: found by both vec AND fts
                        results[obs_id]["source"] = "hybrid"
                        results[obs_id]["similarity"] = min(results[obs_id]["similarity"] + 0.05, 1.0)
            except Exception as e:
                print(f"[AMBIENT] FTS5 search error: {e}", flush=True)

    db.close()

    # Sort by similarity descending
    return sorted(results.values(), key=lambda x: x["similarity"], reverse=True)


# FTS5 stopwords — skip these in keyword queries
_FTS_STOP = {"the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could", "should",
    "may", "might", "can", "shall", "to", "of", "in", "for", "on", "with", "at",
    "by", "from", "as", "into", "about", "it", "its", "this", "that", "these",
    "those", "i", "me", "my", "we", "our", "you", "your", "he", "she", "they",
    "what", "which", "who", "how", "when", "where", "why", "not", "no", "so",
    "if", "or", "and", "but", "just", "also", "up", "out", "all", "some", "any"}


def _build_fts_query(text: str) -> str:
    """Build an FTS5 OR query from natural language, filtering stopwords."""
    # Strip XML and normalize
    text = strip_xml_tags(text)
    # Extract words, filter short/stop
    words = re.findall(r"[a-zA-Z0-9_]+", text.lower())
    words = [w for w in words if len(w) >= 3 and w not in _FTS_STOP]
    if not words:
        return ""
    # Deduplicate preserving order
    seen = set()
    unique = []
    for w in words:
        if w not in seen:
            seen.add(w)
            unique.append(w)
    return " OR ".join(unique[:10])  # cap at 10 terms


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
_conv_injections: dict[str, dict[int, str]] = defaultdict(dict)  # conv_hash → {turn → injection_text}




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



# ── Retroactive pruning (V3) ──────────────────────────────────────

def _summarize_subsequent(messages: list[dict], start_idx: int, max_chars: int = 400) -> str:
    """Build a brief summary of conversation after a given message index."""
    parts = []
    total = 0
    for msg in messages[start_idx:]:
        role = msg.get("role", "")
        content = msg.get("content", "")
        if isinstance(content, list):
            content = " ".join(
                b.get("text", "") for b in content
                if isinstance(b, dict) and b.get("type") == "text"
            )
        content = strip_xml_tags(content)
        if content:
            snippet = f"{role}: {content[:150]}"
            parts.append(snippet)
            total += len(snippet)
            if total >= max_chars:
                break
    return "\n".join(parts)


def _extract_recall_block(content_block: dict) -> str | None:
    """Extract <ambient_recall> text from a content block."""
    text = content_block.get("text", "")
    m = re.search(r'<ambient_recall>.*?</ambient_recall>', text, re.DOTALL)
    return m.group() if m else None


def _rebuild_recall_block(original_text: str, keep_indices: list[int]) -> str | None:
    """Rebuild an ambient_recall block keeping only specified 1-indexed items."""
    lines = [
        line for line in original_text.split("\n")
        if line.strip().startswith("- [entity:")
    ]
    if not lines:
        return None
    kept = [lines[i - 1] for i in keep_indices if 1 <= i <= len(lines)]
    if not kept:
        return None
    return "<ambient_recall>\n" + "\n".join(kept) + "\n</ambient_recall>"


def prune_message_history(messages: list[dict], conv_hash: str, current_turn: int) -> dict:
    """Re-inject past ambient_recall blocks from proxy memory, evaluate relevance,
    and only keep what still matters. Returns stats dict.

    Claude Code doesn't echo our injections — so the proxy is the source of truth.
    We re-inject the last PRUNE_WINDOW turns of context, then let SuperGemma decide
    what's still relevant in a single batch call.
    """
    stats = {"blocks_scanned": 0, "blocks_pruned": 0, "memories_removed": 0, "tokens_reclaimed": 0}

    if not cfg.CLASSIFIER_ENABLED:
        return stats

    past_injections = _conv_injections.get(conv_hash, {})
    if not past_injections:
        return stats

    # Collect injections within the prune window
    window_start = max(1, current_turn - cfg.PRUNE_WINDOW)
    in_window = {t: text for t, text in past_injections.items() if window_start <= t < current_turn}

    if not in_window:
        return stats

    # Summarize recent conversation (last ~6 messages) — this is the current context
    # that determines whether past memories are still relevant
    start_idx = max(0, len(messages) - 6)
    subsequent = _summarize_subsequent(messages, start_idx)

    # Collect all memory lines across all blocks for one batch eval
    all_memories = []  # (turn, line_idx_in_block, line_text)
    for turn in sorted(in_window):
        lines = [
            line for line in in_window[turn].split("\n")
            if line.strip().startswith("- [entity:")
        ]
        for idx, line in enumerate(lines):
            all_memories.append((turn, idx, line))

    if not all_memories:
        return stats

    stats["blocks_scanned"] = len(in_window)

    # Single batch classifier call — which of these past memories are still relevant?
    numbered = "\n".join(f"{i+1}. {m[2].strip('- ')}" for i, m in enumerate(all_memories))
    recall_text = "<ambient_recall>\n" + numbered + "\n</ambient_recall>"

    print(f"[AMBIENT] prune: evaluating {len(all_memories)} memories against conversation", flush=True)
    print(f"[AMBIENT] prune: subsequent preview: {subsequent[:200]!r}", flush=True)

    keep = classifier.evaluate_past_recall(recall_text, subsequent)

    print(f"[AMBIENT] prune: classifier returned: {keep}", flush=True)

    if keep is None:
        # Classifier unavailable — re-inject everything (V2 fallback)
        keep_set = set(range(1, len(all_memories) + 1))
    else:
        keep_set = set(keep)

    # Determine which memories survived
    surviving = [all_memories[i] for i in range(len(all_memories)) if (i + 1) in keep_set]
    pruned_count = len(all_memories) - len(surviving)

    if pruned_count > 0:
        stats["blocks_pruned"] = len(in_window)
        stats["memories_removed"] = pruned_count

    # Build the surviving injection block (or nothing if all pruned)
    if surviving:
        surviving_lines = [m[2] for m in surviving]
        surviving_text = "<ambient_recall>\n" + "\n".join(surviving_lines) + "\n</ambient_recall>"
        stats["tokens_reclaimed"] = count_tokens(
            "\n".join(m[2] for m in all_memories)
        ) - count_tokens("\n".join(m[2] for m in surviving))
    else:
        surviving_text = None
        stats["tokens_reclaimed"] = count_tokens("\n".join(m[2] for m in all_memories))

    # Find the last user message and inject surviving context
    for i in range(len(messages) - 1, -1, -1):
        if messages[i].get("role") == "user":
            content = messages[i].get("content", "")
            if surviving_text:
                block = {"type": "text", "text": surviving_text}
                if isinstance(content, list):
                    messages[i]["content"] = content + [block]
                else:
                    messages[i]["content"] = [{"type": "text", "text": content}, block]
            break

    return stats


# ── App ───────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    print(f"[AMBIENT] Proxy on :{cfg.PROXY_PORT} → {cfg.UPSTREAM_URL}")
    print(f"[AMBIENT] DB: {cfg.DB_PATH} | Ollama: {cfg.OLLAMA_URL} ({cfg.EMBED_MODEL})")
    print(f"[AMBIENT] tau={cfg.TAU_INJECT} budget={cfg.TOKEN_BUDGET} k={cfg.KNN_K}")
    cls_status = f"{cfg.CLASSIFIER_MODEL}" if cfg.CLASSIFIER_ENABLED else "disabled"
    print(f"[AMBIENT] V3 classifier: {cls_status}")
    # Warm up SuperGemma so first real request isn't slow
    if cfg.CLASSIFIER_ENABLED:
        try:
            classifier._call_supergemma("test: 1. hello → Answer:")
            print("[AMBIENT] classifier warmed up", flush=True)
        except Exception:
            print("[AMBIENT] classifier warmup failed (will retry on first request)", flush=True)
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
    # Classifier health (optional — degraded doesn't mean unhealthy)
    if cfg.CLASSIFIER_ENABLED:
        try:
            classifier._call_supergemma("test: 1. hello → Answer:")
            components["classifier"] = "ok"
            components["classifier_model"] = cfg.CLASSIFIER_MODEL
        except Exception as e:
            components["classifier"] = f"degraded: {e}"
    else:
        components["classifier"] = "disabled"

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

                # V3: retroactive pruning of past ambient_recall blocks
                conv_hash = get_conv_hash(body)
                turn = _conv_turns[conv_hash] + 1
                prune_stats = prune_message_history(messages, conv_hash, turn)
                if prune_stats["blocks_pruned"]:
                    print(f"[AMBIENT] pruned {prune_stats['memories_removed']} memories "
                          f"from {prune_stats['blocks_pruned']} blocks, "
                          f"reclaimed ~{prune_stats['tokens_reclaimed']} tokens", flush=True)

                query_text = build_query_text(messages)
                query_emb = embed_text(query_text)
                candidates = retrieve_memories(query_emb, cfg.KNN_K, query_text)
                selected = filter_and_budget(candidates, conv_hash, turn)

                # V3: classify candidates before injection
                if selected:
                    relevant_idx = classifier.classify_candidates(selected, query_text)
                    classified = [selected[i] for i in relevant_idx]
                else:
                    classified = []

                if classified:
                    injection = format_injection(classified)
                    body = inject_into_body(body, injection)
                    body_bytes = json.dumps(body).encode()
                    _conv_turns[conv_hash] = turn
                    for mem in classified:
                        _conv_state[conv_hash][mem["obs_id"]] = turn
                    _conv_injections[conv_hash][turn] = injection

                latency_ms = int((time.time() - t0) * 1000)
                top = round(candidates[0]["similarity"], 3) if candidates else 0
                print(f"[AMBIENT] q={query_text[:60]!r} cand={len(candidates)} sel={len(selected)} cls={len(classified)} top={top} {latency_ms}ms", flush=True)

                injection_log = {
                    "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "conv_hash": conv_hash, "turn": turn,
                    "query_preview": query_text[:80],
                    "candidates": len(candidates), "selected": len(selected), "classified": len(classified),
                    "injected_ids": [m["obs_id"] for m in classified],
                    "top_score": top, "latency_ms": latency_ms,
                    "prune_stats": prune_stats,
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
