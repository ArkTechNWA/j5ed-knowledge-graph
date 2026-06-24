# j5ed-knowledge-graph

Knowledge graph memory server for MCP. Entities, relations, observations — NDJSON flat file storage.

## Quick Reference

```bash
npm install && npm run build    # Build
npm test                        # 7 suites, 80 tests
npm run dev                     # stdio dev mode
npm start                       # stdio production
npm start -- --http --port 3100 # Streamable HTTP
npm start -- --sse --port 3100  # SSE (legacy)
```

## Architecture

```
src/
  index.ts                      # Entry point, transport setup, tool dispatch
  types/graph.ts                # All interfaces (Entity, Relation, AgentContext, etc.)
  graph/knowledge-graph-manager.ts  # Core logic: CRUD, search, isolation, mutex
  persistence/storage.ts        # NDJSON read/write, backup rotation
  server/api-tools.ts           # MCP tool schema definitions
  utils/config.ts               # Env var parsing, credential/grant config
  __tests__/                    # 7 test suites covering auth, isolation, search, writes
```

## Key Concepts

- **Tenant isolation**: `authored_by:<agentId>` observations are the ownership boundary
- **Index navigation**: `read_graph()` returns stubs; `open_nodes()` on index entities returns inbound `indexed_in` relations
- **Write mutex**: All mutations serialized via `AsyncMutex` — no lost writes under concurrency
- **Backup rotation**: Last 5 `.bak.*` files kept on every save
