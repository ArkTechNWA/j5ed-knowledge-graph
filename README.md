# j5ed-knowledge-graph

[![CI](https://github.com/ArkTechNWA/j5ed-knowledge-graph/actions/workflows/ci.yml/badge.svg)](https://github.com/ArkTechNWA/j5ed-knowledge-graph/actions/workflows/ci.yml)
[![CodeQL](https://github.com/ArkTechNWA/j5ed-knowledge-graph/actions/workflows/codeql.yml/badge.svg)](https://github.com/ArkTechNWA/j5ed-knowledge-graph/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/ArkTechNWA/j5ed-knowledge-graph/badge)](https://scorecard.dev/viewer/?uri=github.com/ArkTechNWA/j5ed-knowledge-graph)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A knowledge graph memory server for the [Model Context Protocol](https://modelcontextprotocol.io/) (MCP). Gives AI assistants persistent, structured memory across sessions using a simple entity-relation-observation graph.

Forked from the official [`@modelcontextprotocol/server-memory`](https://github.com/modelcontextprotocol/servers/tree/main/src/memory) and significantly enhanced with SQLite storage, multi-agent isolation, tiered search, index navigation, wiki-mode history tracking, and three transport modes.

## What's different from upstream

| Feature | Upstream | j5ed |
|---------|----------|------|
| Storage | NDJSON flat file | SQLite with WAL mode, FTS5 search, foreign keys |
| `read_graph()` | Returns full graph every time | Returns lightweight index stubs by default; `force=true` for full dump |
| `search_nodes()` | Flat substring match | Tokenized multi-word queries, tiered results by match count, field-priority ranking, per-tier caps |
| `open_nodes()` | Returns relations between opened nodes only | Also returns inbound relations to index entities (table-of-contents navigation) |
| Deletes | Hard delete — data destroyed | Soft delete — observations/relations superseded, history preserved |
| Multi-agent | None | Tenant isolation via provenance columns — agents only see their own entities |
| Multi-user | None | Two-dimensional isolation with `user_id` — users share agent memory but not private entities |
| Auth | None | Bearer token authentication for HTTP/SSE transports |
| Read grants | None | Cross-agent read visibility via `AGENT_READ_GRANTS` |
| Write safety | None | SQLite transactions — atomic writes, no lost data under concurrency |
| History | None | Full mutation timeline per entity — who changed what, when, why |
| Transports | stdio only | stdio, SSE, and Streamable HTTP |
| Param handling | Strict | Gracefully handles double-serialized JSON from flaky clients |

## Installation

```bash
npm install j5ed-knowledge-graph
```

Or run directly:

```bash
npx j5ed-knowledge-graph
```

## MCP Configuration

### stdio (local, default)

```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "j5ed-knowledge-graph"],
      "env": {
        "DB_PATH": "/path/to/memory.db"
      }
    }
  }
}
```

### Streamable HTTP (network)

```bash
npx j5ed-knowledge-graph --http --port 3100
```

```json
{
  "mcpServers": {
    "memory": {
      "url": "http://localhost:3100/mcp"
    }
  }
}
```

### SSE (legacy network)

```bash
npx j5ed-knowledge-graph --sse --port 3100
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DB_PATH` | `./memory.db` (relative to install) | Path to the SQLite database file |
| `MEMORY_FILE_PATH` | `./memory.json` | Legacy NDJSON file path (used by migration script only) |
| `DEFAULT_AGENT_ID` | `default` | Agent identity used for stdio connections and when no auth header is provided |
| `AGENT_CREDENTIALS` | _(empty)_ | Comma-separated `agentId:token` pairs for bearer auth. When set, all HTTP/SSE connections require `Authorization: Bearer <token>` |
| `AGENT_READ_GRANTS` | _(empty)_ | Comma-separated `readerId:sourceId` pairs. Grants `readerId` read access to entities authored by `sourceId` |

## Multi-Agent Setup

When multiple agents share a graph, each agent's writes are tagged with provenance and reads are filtered to show only entities owned by (or granted to) that agent.

**Example: two agents with cross-read access**

```bash
AGENT_CREDENTIALS="assistant:token-abc,researcher:token-xyz" \
AGENT_READ_GRANTS="assistant:researcher" \
npx j5ed-knowledge-graph --http --port 3100
```

- `assistant` authenticates with `Bearer token-abc`, sees its own entities + `researcher`'s
- `researcher` authenticates with `Bearer token-xyz`, sees only its own entities
- Writes are always scoped — agents can only delete what they authored

## Tools

### Core Tools

| Tool | Description |
|------|-------------|
| `create_entities` | Create new entities with name, type, and observations |
| `create_relations` | Create directed relations between entities |
| `add_observations` | Append observations to existing entities |
| `delete_entities` | Soft-delete entities — all observations/relations superseded, history preserved |
| `delete_observations` | Soft-delete specific observations — gone from live view, preserved in history |
| `delete_relations` | Soft-delete specific relations |
| `read_graph` | Returns index stubs by default; `force: true` for full graph |
| `search_nodes` | Tiered search across entity names, types, and observations |
| `open_nodes` | Retrieve full entities by name, with index navigation |

### Wiki-Mode Tools

| Tool | Description |
|------|-------------|
| `entity_history` | Full mutation timeline for an entity — all observations ever written, ordered chronologically |
| `changes_to_mine` | Show observations you wrote that another agent changed, with rationale |
| `supersede` | Replace an observation with new content, preserving the version chain with rationale |
| `comment` | Add a comment to an observation without modifying it |
| `observation_comments` | List all comments on an observation |

## Always Supersede, Never Delete

All delete operations are **soft deletes**. When you delete an observation, it gets a `superseded_at` timestamp and disappears from live queries — but it remains in the database for full history tracking.

The `supersede` tool goes further: it creates a *replacement* observation linked to the original via `previous_version_id`, forming a version chain. Use `entity_history` to walk the full timeline.

This design exists because the graph is shared across agents. If agent A deletes agent B's observation, there should be an audit trail — not silent data loss.

## Index Navigation Pattern

The graph supports an **index-first navigation** pattern for large knowledge bases:

1. **`read_graph()`** — returns lightweight stubs for index entities (name, type, summary)
2. **Pick relevant index** — `open_nodes(["MY_INDEX"])`
3. **See inbound relations** — entities with `indexed_in` relations to the index are its table of contents
4. **Drill into specifics** — `open_nodes(["SPECIFIC_ENTITY"])`

Index entities are detected by `entityType` containing "index" (case-insensitive) or entity name ending with `_INDEX`.

## Search Behavior

Multi-word queries are tokenized. Results are grouped into tiers by how many tokens matched:

- **Tier 1**: entities matching any 1 token (broadest)
- **Tier N**: entities matching all N tokens (most specific)

Within each tier, entities are ranked by field priority: index entities first, then name matches (+30), type matches (+20), observation matches (+10). Per-tier caps prevent noise.

Results are returned as lightweight stubs (name, type, matchedIn fields, optional snippet). Use `open_nodes()` to get full observations.

## Storage

SQLite database with WAL mode for concurrent read safety. Schema includes:

- **entities** — immutable rows with unique name constraint
- **observations** — versioned facts with soft-delete via supersession
- **relations** — directed edges with soft-delete, partial unique index on live rows
- **comments** — append-only annotations on observations
- **observations_fts** — FTS5 virtual table for full-text search, auto-synced via triggers

### Migrating from NDJSON

If you're upgrading from a previous version that used NDJSON storage:

```bash
MEMORY_FILE_PATH=/path/to/memory.json DB_PATH=/path/to/memory.db npm run migrate
```

The migration script extracts provenance tags (`authored_by:`, `authored_at:`, `user_id:`) from observation strings into proper database columns. The original NDJSON file is not modified.

## Docker

```bash
docker build -t j5ed-knowledge-graph .
docker run -i -v graph-data:/app/dist --rm j5ed-knowledge-graph
```

## Development

```bash
git clone https://github.com/arktechnwa/j5ed-knowledge-graph.git
cd j5ed-knowledge-graph
npm install
npm run build
npm test        # 8 suites, 58 tests
npm run dev     # stdio mode with ts-node
```

## License

MIT
