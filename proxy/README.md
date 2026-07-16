# Ambient Recall Proxy

Transparent HTTP proxy that injects semantically-retrieved KG memories into Claude Code API requests. The model wakes up already primed with relevant context — no tool calls, no deliberation.

## Quick Start

```bash
# Install dependencies
pip install -r requirements.txt

# Ensure Ollama is running with nomic-embed-text
ollama pull nomic-embed-text

# Ensure the KG server has been started with EMBED_ENABLED=true at least once
# (this creates the vec_observations table)

# Backfill existing observations
python3 ../scripts/backfill-embeddings.py

# Start the proxy
python3 proxy.py

# In another terminal, start Claude Code through the proxy
ANTHROPIC_BASE_URL=http://localhost:8787 claude
```

## How It Works

```
Claude Code ──→ Proxy (:8787) ──→ api.anthropic.com
                  │
                  ├── Embeds last 2-3 turns via Ollama (~10ms)
                  ├── kNN search against vec_observations (~5ms)
                  ├── Filters by similarity threshold + dedup
                  └── Prepends <ambient_recall> block to system message
```

The proxy is **best-effort augmentation, never a point of failure.** If Ollama is down, the database is missing, or anything fails — the request passes through unmodified.

## Configuration

All via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | _(required)_ | Forwarded to upstream |
| `AMBIENT_UPSTREAM` | `https://api.anthropic.com` | Upstream API URL |
| `AMBIENT_DB_PATH` | `~/Projects/PRJ-johnny5-memory/dist/memory.db` | KG SQLite database |
| `AMBIENT_OLLAMA_URL` | `http://localhost:11434` | Ollama API |
| `AMBIENT_EMBED_MODEL` | `nomic-embed-text` | Embedding model |
| `AMBIENT_EMBED_DIM` | `768` | Embedding dimension |
| `AMBIENT_TAU_INJECT` | `0.55` | Minimum similarity to inject |
| `AMBIENT_TAU_SIGNAL` | `0.65` | Strong signal threshold (logging) |
| `AMBIENT_TOKEN_BUDGET` | `1500` | Max tokens injected per turn |
| `AMBIENT_KNN_K` | `20` | Candidates retrieved per query |
| `AMBIENT_DEDUP_TURNS` | `3` | Don't re-inject within N turns |
| `AMBIENT_PROXY_PORT` | `8787` | Proxy listen port |
| `AMBIENT_LOG_PATH` | `~/.ambient-recall/log.jsonl` | Per-turn log |

## Health Check

```bash
curl http://localhost:8787/health
```

Returns component status: Ollama reachability, database access, vec coverage.

## Observability

Every injection is logged to `~/.ambient-recall/log.jsonl`:

```json
{
  "ts": "2026-07-16T10:00:00Z",
  "conv_hash": "abc123",
  "turn": 5,
  "query_preview": "thinking about the pfSense LED...",
  "candidates": 20,
  "injected": 4,
  "injected_ids": [42, 87, 103, 215],
  "top_score": 0.71,
  "budget_used": 847,
  "latency_ms": 14
}
```

## Future Trippin'

- **ONNX Runtime**: Load nomic-embed-text as an ONNX model directly in-process. Eliminates Ollama dependency entirely — ~5ms in-process embeddings, ~300MB memory, zero network. The optimization for when you want zero external service dependencies.
- **Semantic search MCP tool**: The vec_observations table could power a `semantic_search` tool on the KG server itself, complementing FTS5.
- **Cross-session continuity**: Even if J5 boot is skipped or degraded, ambient recall primes the model with relevant context from recent work.
