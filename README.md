# j5ed-knowledge-graph

[![CI](https://github.com/ArkTechNWA/j5ed-knowledge-graph/actions/workflows/ci.yml/badge.svg)](https://github.com/ArkTechNWA/j5ed-knowledge-graph/actions/workflows/ci.yml)
[![CodeQL](https://github.com/ArkTechNWA/j5ed-knowledge-graph/actions/workflows/codeql.yml/badge.svg)](https://github.com/ArkTechNWA/j5ed-knowledge-graph/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/ArkTechNWA/j5ed-knowledge-graph/badge)](https://scorecard.dev/viewer/?uri=github.com/ArkTechNWA/j5ed-knowledge-graph)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A knowledge graph memory server for the [Model Context Protocol](https://modelcontextprotocol.io/) (MCP). Gives AI assistants persistent, structured memory across sessions using a simple entity-relation-observation graph.

Forked from the official [`@modelcontextprotocol/server-memory`](https://github.com/modelcontextprotocol/servers/tree/main/src/memory) and significantly enhanced with multi-agent isolation, tiered search, index navigation, backup rotation, and three transport modes.

## What's different from upstream

| Feature | Upstream | j5ed |
|---------|----------|------|
| `read_graph()` | Returns full graph every time | Returns lightweight index stubs by default; `force=true` for full dump |
| `search_nodes()` | Flat substring match | Tokenized multi-word queries, tiered results by match count, field-priority ranking, per-tier caps |
| `open_nodes()` | Returns relations between opened nodes only | Also returns inbound relations to index entities (table-of-contents navigation) |
| Multi-agent | None | Tenant isolation via `authored_by:` provenance — agents only see their own entities |
| Multi-user | None | Two-dimensional isolation with `user_id:` tags — users share agent memory but not private entities |
| Auth | None | Bearer token authentication for HTTP/SSE transports |
| Read grants | None | Cross-agent read visibility via `AGENT_READ_GRANTS` |
| Write safety | None | Async mutex serializes all mutations — no lost writes under concurrency |
| Backups | None | Automatic backup rotation (last 5 copies) on every save |
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
        "MEMORY_FILE_PATH": "/path/to/memory.json"
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
| `MEMORY_FILE_PATH` | `./memory.json` (relative to install) | Path to the NDJSON graph file |
| `DEFAULT_AGENT_ID` | `default` | Agent identity used for stdio connections and when no auth header is provided |
| `AGENT_CREDENTIALS` | _(empty)_ | Comma-separated `agentId:token` pairs for bearer auth. When set, all HTTP/SSE connections require `Authorization: Bearer <token>` |
| `AGENT_READ_GRANTS` | _(empty)_ | Comma-separated `readerId:sourceId` pairs. Grants `readerId` read access to entities authored by `sourceId` |

## Multi-Agent Setup

When multiple agents share a graph, each agent's writes are tagged with `authored_by:<agentId>` and reads are filtered to show only entities owned by (or granted to) that agent.

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

| Tool | Description |
|------|-------------|
| `create_entities` | Create new entities with name, type, and observations |
| `create_relations` | Create directed relations between entities |
| `add_observations` | Append observations to existing entities |
| `delete_entities` | Delete entities and their relations (agent-scoped) |
| `delete_observations` | Remove specific observations from entities |
| `delete_relations` | Remove specific relations |
| `read_graph` | Returns index stubs by default; `force: true` for full graph |
| `search_nodes` | Tiered search across entity names, types, and observations |
| `open_nodes` | Retrieve full entities by name, with index navigation |

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

## Storage Format

NDJSON (newline-delimited JSON). Each line is either:

```json
{"type":"entity","name":"MY_ENTITY","entityType":"service","observations":["fact 1","fact 2"]}
{"type":"relation","from":"MY_ENTITY","to":"MY_INDEX","relationType":"indexed_in"}
```

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
npm test        # 7 suites, 80 tests
npm run dev     # stdio mode with ts-node
```

## License

MIT
