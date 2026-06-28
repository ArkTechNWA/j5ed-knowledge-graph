# j5-knowledge-graph — Development Guide

How to safely modify, test, deploy, and maintain the knowledge graph MCP server. This is live infrastructure — the service running on port 3101 powers every session's memory. Changes here affect every boot sequence.

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

**Storage:** SQLite with WAL mode, FTS5 full-text search, foreign keys, partial unique indexes on live rows. `better-sqlite3` (synchronous API, native addon).

**Transports:** stdio (default), SSE (`--sse`), Streamable HTTP (`--http`). HTTP mode has 10-min session TTL with `mcp-session-id` header tracking.

**Concurrency:** SQLite `BEGIN IMMEDIATE` transactions are atomic. No application-level mutex needed.

## Build & Test

```bash
npm run build     # tsc + chmod dist/
npm test          # Jest — 8 suites
npm run lint      # ESLint (test file failures are known, cosmetic)
npm run dev       # ts-node dev mode (stdio)
```

**Testing a change without touching the live service:**
```bash
node dist/index.js    # stdio transport — isolated from running HTTP service
```

## Node Version Gotcha

`better-sqlite3` is a native addon. It must be compiled against the same Node version that runs it.

- **nvm** may give you a different Node than `/usr/bin/node`
- **systemd** uses `/usr/bin/node` — not nvm's version
- If you see `MODULE_NOT_FOUND` or version mismatch errors after `npm install`, rebuild:

```bash
cd node_modules/better-sqlite3 && /usr/bin/npx node-gyp rebuild
```

Always verify which Node the service will use before deploying.

## Deployment

The service runs as `johnny5-memory.service` (systemd user service) on `--http --port 3101`.

```bash
# Build and deploy
npm run build
systemctl --user restart johnny5-memory.service
curl http://localhost:3101/health    # confirm live — should show "storage": "sqlite"
```

**Systemd override pattern:** Environment overrides live in `~/.config/systemd/user/johnny5-memory.service.d/`. The `sqlite.conf` drop-in sets `DB_PATH` and `ExecStart`.

After modifying overrides:
```bash
systemctl --user daemon-reload
systemctl --user restart johnny5-memory.service
```

## SQLite Schema (Key Tables)

| Table | Purpose |
|-------|---------|
| `entities` | `id, name (UNIQUE), entity_type, created_by, user_id, created_at` |
| `observations` | `id, entity_id (FK), content, version, authored_by, user_id, authored_at, superseded_at/by/rationale, previous_version_id (self FK)` |
| `comments` | `id, observation_id (FK), content, authored_by, authored_at` |
| `relations` | `id, from_entity_id (FK), to_entity_id (FK), relation_type, authored_by, authored_at, superseded_at/by/rationale` + partial unique index on live rows |
| `observations_fts` | FTS5 virtual table on observation content, synced via triggers |

**Pragmas:** `WAL, foreign_keys=ON, busy_timeout=5000, synchronous=NORMAL`

**Soft deletes:** All delete operations stamp `superseded_at` + `superseded_by`. No rows are ever physically removed. Live queries filter with `WHERE superseded_at IS NULL`.

## Test Patterns

All tests use `:memory:` SQLite via `createTestManager()` from `src/__tests__/helpers/test-db.ts`. No mocks, no file I/O.

```typescript
import { createTestManager } from './helpers/test-db.js';

const { manager, storage } = createTestManager();
```

The helper returns a `KnowledgeGraphManager` backed by an in-memory database. Each test gets a fresh DB — no cleanup needed.

**Test suites:**
- `agent-identity.test.ts` — provenance injection on writes
- `agent-identity-integration.test.ts` — full multi-agent lifecycle
- `agent-isolation.test.ts` — tenant isolation (agents see only their own + granted entities)
- `auth.test.ts` — bearer token authentication
- `search-stubs.test.ts` — search ranking and stub format
- `user-isolation.test.ts` — user_id isolation within agents
- `wiki-tools.test.ts` — entity_history, supersede, comments, changes_to_mine
- `write-safety.test.ts` — concurrent writes, soft-delete history

## Wire Compatibility

The server re-injects synthetic observations into Entity arrays for wire compatibility:
- `authored_by:<agentId>`
- `authored_at:<ISO timestamp>`
- `user_id:<userId>` (when present)

These are generated from database columns on read — they do NOT exist as stored observations. The `isSyntheticObservation()` filter strips them from input to prevent duplication.

## Migration

**NDJSON → SQLite** (one-shot, already completed for production):
```bash
npm run migrate    # reads MEMORY_FILE_PATH, writes to DB_PATH
```

The migration script refuses if the target DB already exists. It extracts `authored_by:`, `authored_at:`, `user_id:` from observation strings into proper columns and skips synthetic observations in content. Relations get `authored_by: 'migration'` (NDJSON had no relation provenance).

**Rollback scripts** live in the consuming project (`PRJ-johnny5-memory/scripts/`):
- `migrate-to-sqlite.sh` — backup to Kronos, stop service, migrate, create systemd override, restart
- `undo-sqlite-migration.sh` — restore from backup, remove DB + override, restart

## PR Gate (Non-Negotiable)

**Never push directly to main.** Always branch → PR → CI → review → merge.

This is an engineering constraint, not a preference. The repo has branch protection and OpenSSF Scorecard tracking. Bypassing the gate damages public trust metrics.

The `johnny5-arktechnwa` GitHub account exists as a code review agent for approvals.

## Known Issues

- **ESLint jest env** — `node-lint` fails on test files. No jest env configured. Cosmetic, `allow_failure` in CI. Don't fix during unrelated work.
- **CI version-* jobs** — ci-utils git bug causes failures. Bump `package.json` manually, tag manually.
- **Duplicate Kronos entities in graph** — `Kronos`, `kronos`, `kronos.home.lan` exist as separate entities. Known naming debt. Check before creating new Kronos entities.
