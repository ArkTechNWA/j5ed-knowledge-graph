# Changelog

All notable changes to this project are documented here.

This project follows [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-06-24

First public release. Forked from [@modelcontextprotocol/server-memory](https://github.com/modelcontextprotocol/servers/tree/main/src/memory) and significantly evolved over 53 commits of private development.

### Added

#### Multi-Agent Tenant Isolation
- Automatic `authored_by:<agentId>` provenance injection on all writes
- Agent-scoped reads — agents only see entities they authored
- Agent-scoped deletes — agents can only delete their own entities
- Cross-agent read grants via `AGENT_READ_GRANTS` environment variable
- Audit logging for all write operations (creates, deletes, blocked attempts)

#### User-Level Isolation
- Two-dimensional filtering: agent scope + user scope
- `X-User-Id` header support on HTTP transport
- `user_id:<userId>` tagging on writes when userId is present
- Users see shared agent memory (no user_id tag) plus their own private entities
- Other users' private entities are invisible

#### Authentication
- Bearer token authentication for HTTP and SSE transports
- `AGENT_CREDENTIALS` environment variable: comma-separated `agentId:token` pairs
- Auth enforced when credentials are configured, open when not (backwards compatible)
- Token-to-agent mapping with O(1) lookup

#### Index-First Navigation
- `read_graph()` returns lightweight index stubs by default instead of the full graph
- Index stubs include: name, type, canonicalName, summary (~200 tokens total)
- `force: true` parameter for full graph dump when needed
- Index entities detected by entityType containing "index" or name ending with `_INDEX`
- `open_nodes()` on index entities returns inbound `indexed_in` relations (table of contents)

#### Tiered Search
- Multi-word queries tokenized and matched independently
- Results grouped into tiers by token match count (broadest first, most specific last)
- Field-priority ranking within tiers: index entities (+1000), name match (+30), type match (+20), observation match (+10)
- Per-tier caps prevent noise (single-token: 20, multi-token: scales with match count)
- Lightweight stubs returned (name, type, matchedIn, optional snippet) — not full entities
- Snippet included only for observation-only matches, truncated to 120 chars

#### Write Safety
- Async mutex serializes all mutating operations — no lost writes under concurrency
- Backup rotation: last 5 copies of the graph file kept on every save

#### Three Transport Modes
- **stdio** — local MCP connections (default, no auth needed)
- **SSE** — network MCP via Server-Sent Events (`--sse --port 3100`)
- **Streamable HTTP** — modern MCP protocol (`--http --port 3100`)
- Session management with TTL cleanup (10-minute timeout, 5-minute sweep)
- Health check endpoint on HTTP/SSE (`/health`)

#### Robustness
- Graceful handling of double-serialized JSON parameters from flaky MCP clients
- `ensureArray<T>()` accepts both parsed arrays and JSON strings
- NDJSON storage format (newline-delimited JSON) — one record per line
- Directory auto-creation for memory file path

#### Testing
- 7 test suites, 80 tests
- `auth.test.ts` — credential parsing, bearer token validation
- `agent-identity.test.ts` — provenance injection on creates, observations, relations
- `agent-identity-integration.test.ts` — full multi-agent lifecycle round-trip
- `agent-isolation.test.ts` — read/write/delete isolation between agents
- `user-isolation.test.ts` — two-dimensional user filtering
- `search-stubs.test.ts` — stub building, tiered search, index stubs, tier caps
- `write-safety.test.ts` — concurrent write serialization, backup rotation

#### Security & CI
- `SECURITY.md` with vulnerability disclosure policy and severity model
- Private vulnerability reporting enabled on GitHub
- GitHub Actions CI: build + test on Node 18, 20, 22
- CodeQL static analysis (weekly + on push)
- OpenSSF Scorecard (weekly + on push)
- npm publish workflow with provenance attestation
- All GitHub Actions pinned to immutable commit SHAs
- Dependabot configured for npm and GitHub Actions updates
- Branch protection: required PR reviews, required CI, no force pushes

#### Configuration
- `MEMORY_FILE_PATH` — custom graph file location
- `DEFAULT_AGENT_ID` — agent identity for stdio and unauthenticated connections (default: `default`)
- `AGENT_CREDENTIALS` — bearer auth token mapping
- `AGENT_READ_GRANTS` — cross-agent read visibility

### Changed (vs. upstream)
- `read_graph()` returns index summary by default instead of full graph
- `search_nodes()` returns tiered stubs instead of flat entity list with relations
- `open_nodes()` returns inbound relations to index entities for navigation
- All write methods accept optional `AgentContext` parameter
- All read methods apply tenant isolation when `AgentContext` is present
- Package renamed from `@modelcontextprotocol/server-memory` to `j5ed-knowledge-graph`

[1.0.0]: https://github.com/ArkTechNWA/j5ed-knowledge-graph/releases/tag/v1.0.0
