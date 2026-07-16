# Ambient Recall Proxy — Spec

A local proxy that sits between Claude Code and the Anthropic API, injecting semantically-retrieved memories into every user turn so the model wakes up already primed. No tool calls. No deliberation. Preattentive context.

## Architecture

```
Claude Code ──HTTPS──▶ Local Proxy ──HTTPS──▶ api.anthropic.com
                          │
                          ├──▶ Embedder (nomic-embed-text via Ollama)
                          └──▶ Vector Store (LanceDB)
                                    ▲
                                    │ (write path)
                          MCP Memory Server
```

Claude Code points at the proxy via `ANTHROPIC_BASE_URL`. It has no idea injection is happening. The MCP memory server writes to the same vector store on `add_observations` / `create_entities` / `create_relations` so ambient recall stays in sync with deliberative memory.

## Component Choices

| Component | Choice | Why |
|---|---|---|
| Proxy runtime | Python + FastAPI + httpx | Fast to write, easy to intercept streaming, good async |
| Embedder | `nomic-embed-text` via Ollama | 768-dim, ~10ms local, no API cost, runs on CPU fine |
| Vector store | LanceDB | Embedded (no server), fast, columnar, handles metadata filters |
| Reranker | None at inject time | Latency budget is tight; rely on embedding quality + threshold |
| Transport | HTTP passthrough w/ streaming | Preserves SSE for streamed responses |

Ollama endpoint: `http://localhost:11434/api/embeddings`.
LanceDB path: `~/.ambient-recall/lance/`.

## Data Model

Single LanceDB table, `memories`:

| Field | Type | Notes |
|---|---|---|
| `id` | string | UUID or `entity:observation_hash` |
| `kind` | string | `observation` \| `entity_summary` \| `relation` |
| `entity_name` | string | For join-back to graph |
| `text` | string | The embedded content, natural language |
| `embedding` | vector(768) | nomic-embed-text output |
| `created_at` | timestamp | For decay/recency weighting |
| `source` | string | e.g. `mcp:add_observations`, `manual` |

Relations get embedded as sentences: `"{from} {relationType} {to}"` — "claude worked_on ambient_recall_proxy".

## Request Flow

1. Claude Code sends `POST /v1/messages` to the proxy.
2. Proxy parses body, extracts `messages[]`.
3. **Trigger check**: is the last message `role: user`? If no → pass through untouched.
4. **Query construction**: take last 2–3 turns (rolling window, user + assistant), concatenate as query text. Cap at ~500 chars for embedding.
5. **Embed**: call Ollama, get 768-dim vector. ~10ms.
6. **Retrieve**: LanceDB kNN, `k=20`, cosine similarity.
7. **Filter**:
   - Drop anything below similarity threshold `τ = 0.55` (tune empirically).
   - Drop anything in the per-conversation "recently injected" set (last 3 turns).
8. **Budget**: pack top results into a token budget of 500–1500. Use `tiktoken` (cl100k proxy) for a rough count; nomic-embed doesn't share Claude's tokenizer but the estimate is close enough for budgeting.
9. **Inject**: prepend to the existing system prompt:
   ```
   <ambient_recall>
   {formatted memories}
   </ambient_recall>
   ```
   If no system prompt exists, create one containing only the block. If nothing passed the filter, inject nothing (empty priming > noisy priming).
10. **Forward**: proxy the modified request to `api.anthropic.com`, stream the response back untouched.
11. **Track**: record injected IDs in per-conversation state (keyed by a hash of the first user message, or a header if Claude Code provides one).

## Injection Format

Each memory rendered as one line, most-relevant first:

```
<ambient_recall>
- [entity: fishing_gear] Bass preference: prefers largemouth over smallmouth; catch-and-release only.
- [entity: fishing_trips] Last trip 2026-06-14, Lake Tenkiller, 3 largemouth, wind SSW 12mph.
- [entity: lures] Oreshnik lure — custom, chartreuse skirt, only used in stained water above 68°F.
- [relation] fishing_gear preferred_technique topwater_dawn
</ambient_recall>
```

Rationale for the bracket-tags: gives the model a cheap signal about *where* the memory came from without extra prose. `entity:` for node-level, `relation:` for edge-level, `observation:` for raw. The model learns to treat these as ambient facts, not dialogue.

## Trigger Rules

- **User turn only**: assistant turns and tool-result turns skip injection.
- **Skip on tool-use continuations**: if the last user turn is a `tool_result`, skip — the model is mid-thought, don't perturb it.
- **Skip on short turns**: user messages under ~10 chars ("ok", "yes", "continue") — no semantic signal to embed. Pass through.
- **Skip if similarity ceiling < τ**: nothing relevant enough; stay silent.

## Decay & Dedup

Per-conversation state (in-memory dict, keyed by conversation hash, TTL 1 hour):

```python
{
  "conv_hash": {
    "injected_ids": {"id1": turn_3, "id2": turn_3, "id5": turn_5},
    "turn_count": 6
  }
}
```

Rule: don't re-inject an ID within 3 turns of its last injection *unless* its similarity score this turn is >0.15 higher than last time (meaning: it's much more relevant now than it was then, worth re-surfacing).

Optional recency boost at retrieval time: `score = cosine_sim + 0.05 * exp(-age_days / 30)`. Keeps newer memories slightly favored without drowning out older-but-relevant ones.

## Token Budget

- **Target**: 500–1500 tokens injected.
- **Hard cap**: 1500. Truncate the lowest-scored memories first.
- **Floor**: 0 (inject nothing rather than pad).
- **Per-memory cap**: 200 tokens. Anything longer gets summarized at write time, not read time.

Budgeting logic:
```
budget = 1500
selected = []
for mem in sorted(candidates, by=score, desc):
    if token_count(mem.text) <= budget:
        selected.append(mem)
        budget -= token_count(mem.text)
    if budget < 100: break
```

## Confidence Gating

Two thresholds:
- `τ_inject = 0.55` — minimum similarity to include a memory.
- `τ_signal = 0.65` — if nothing hits this, likely the query has no strong associations. Log a "cold" event for tuning. Still inject anything above `τ_inject`.

Both thresholds are guesses; tune against real usage. Expose them via env vars: `AMBIENT_TAU_INJECT`, `AMBIENT_TAU_SIGNAL`.

## Sync With MCP Memory

The MCP memory server's write handlers (`create_entities`, `add_observations`, `create_relations`, `delete_*`) need to also write to LanceDB. Two options:

1. **Direct**: MCP server imports LanceDB and writes on every mutation. Simplest, tightest coupling.
2. **Event bus**: MCP server writes to a local queue (SQLite table or Redis), a small worker embeds and upserts. Decoupled, resilient to embedder downtime.

Start with (1). Move to (2) if embedding latency ever blocks writes noticeably (it won't at your scale).

Delete path matters: `delete_entities` must also delete all memory rows where `entity_name` matches. Otherwise ghost memories haunt the ambient layer forever.

## Observability

Log per-turn (to `~/.ambient-recall/log.jsonl`):
```json
{
  "ts": "2026-07-15T14:22:01Z",
  "conv_hash": "abc123",
  "turn": 5,
  "query_preview": "thinking about fishing this weekend...",
  "candidates": 20,
  "injected": 4,
  "injected_ids": ["mem_1", "mem_7", "mem_12", "mem_18"],
  "top_score": 0.71,
  "budget_used": 847,
  "latency_ms": 14
}
```

This is the tuning corpus. Threshold tweaks are guesswork without it.

## Failure Modes

| Failure | Behavior |
|---|---|
| Ollama down | Skip injection, pass request through, log error. Never block the model. |
| LanceDB corrupt/missing | Skip injection, pass through, log error. |
| Anthropic API error | Return upstream error unchanged to Claude Code. |
| Injection would exceed context window | Truncate injection to fit, prefer keeping the highest-scored memories. |
| Malformed request | Pass through untouched — don't try to "fix" it. |

Guiding principle: **the proxy is best-effort augmentation, never a point of failure.** If anything goes wrong, it degrades to a transparent passthrough.

## Non-Goals

- **Not a reranker.** No cross-encoder at inject time; latency budget doesn't allow it. If retrieval quality drags, add rerank at *write* time — precompute entity summaries via LLM on ingestion instead of reranking on read.
- **Not a memory writer.** The proxy only reads. Writes happen through the existing MCP path. One writer, many readers.
- **Not conversation-aware in a deep sense.** No summarization, no thread modeling. Rolling 2–3 turn window is the whole context model. Simpler is more predictable.
- **Not per-user.** Single-user local system. If it ever goes multi-user, add a `user_id` filter at retrieval — but that's a different tool.

## Minimum Viable Build Order

1. LanceDB table + schema.
2. Ollama embedding client wrapper.
3. Backfill script: read existing knowledge graph JSON, embed everything, populate LanceDB.
4. FastAPI proxy skeleton: pass-through of `/v1/messages` with streaming intact. Test with Claude Code end-to-end before adding any logic.
5. Injection logic: trigger check → embed → retrieve → filter → inject.
6. Per-conversation dedup state.
7. Logging.
8. MCP write-path hook: dual-write on every mutation.
9. Tune thresholds against real usage.

Steps 1–4 get you a working passthrough. Step 5 is where ambient recall starts. Everything after is refinement.

## Config Surface

Env vars, all optional:

```
ANTHROPIC_API_KEY          # forwarded, not consumed
AMBIENT_LANCE_PATH         # default ~/.ambient-recall/lance
AMBIENT_OLLAMA_URL         # default http://localhost:11434
AMBIENT_EMBED_MODEL        # default nomic-embed-text
AMBIENT_TAU_INJECT         # default 0.55
AMBIENT_TAU_SIGNAL         # default 0.65
AMBIENT_TOKEN_BUDGET       # default 1500
AMBIENT_WINDOW_TURNS       # default 3
AMBIENT_DEDUP_TURNS        # default 3
AMBIENT_LOG_PATH           # default ~/.ambient-recall/log.jsonl
AMBIENT_UPSTREAM           # default https://api.anthropic.com
```

Claude Code invocation:
```
ANTHROPIC_BASE_URL=http://localhost:8787 claude
```

That's the whole system. Small, boring, transparent to Claude Code, invisible to the model until the moment it isn't.
