# j5ed-knowledge-graph

Knowledge graph MCP server — entities, observations, relations. SQLite storage with WAL mode, FTS5 full-text search, soft-delete version chains.

@skills/j5-knowledge-graph.md
@skills/j5-knowledge-graph-wiki.md
@skills/j5-knowledge-graph-dev.md

## Quick Reference

```bash
npm install && npm run build    # Build (native addon — see Node version note in dev skill)
npm test                        # 8 suites, ~58 tests
npm run dev                     # stdio dev mode
npm start                       # stdio production
npm start -- --http --port 3100 # Streamable HTTP
npm start -- --sse --port 3100  # SSE (legacy)
npm run migrate                 # One-shot NDJSON → SQLite migration
```

## Architecture

```
src/
  index.ts                          # Entry point, transport setup, tool dispatch
  types/graph.ts                    # All interfaces (Entity, Relation, AgentContext, etc.)
  graph/knowledge-graph-manager.ts  # Core logic: CRUD, search, isolation, wiki-mode
  persistence/schema.ts             # SQLite DDL — tables, indexes, FTS5, pragmas
  persistence/sqlite-storage.ts     # SqliteStorageService — all DB queries
  server/api-tools.ts               # MCP tool schema definitions (core + wiki)
  utils/config.ts                   # Env var parsing, credential/grant config
  migrations/migrate-ndjson.ts      # One-shot NDJSON → SQLite migration
  __tests__/                        # 8 test suites
    helpers/test-db.ts              # createTestManager() — :memory: SQLite for tests
```

## Key Concepts

- **SQLite WAL mode** — crash-safe, concurrent reads, no application-level mutex
- **Soft deletes** — all delete_* tools stamp `superseded_at`; no rows physically removed
- **Tenant isolation** — `authored_by` column + SQL WHERE; `AGENT_READ_GRANTS` for cross-agent access
- **Wire compatibility** — synthetic `authored_by:`, `authored_at:`, `user_id:` observations re-injected on read
- **FTS5 search** — full-text index on observation content, synced via INSERT/UPDATE triggers
- **Index navigation** — `read_graph()` returns stubs; `open_nodes()` on index entities returns inbound `indexed_in` relations
- **Wiki-mode tools** — entity_history, supersede, comments, changes_to_mine for version tracking
