# j5-knowledge-graph — Core Usage

Three primitives: **Entities** (named nodes with observations), **Observations** (versioned facts on entities), **Relations** (directed typed edges between entities). Storage is SQLite with WAL mode — crash-safe, concurrent reads, FTS5 full-text search.

**Core principle: always supersede, never delete.** Every mutation is preserved. Deletes are soft — observations and relations get a `superseded_at` timestamp and disappear from live views, but remain in history.

## Core Tools

| Tool | Purpose | Returns |
|------|---------|---------|
| `read_graph()` | Index stubs for navigation | Stub array (name, type, summary) |
| `open_nodes(names)` | Full entities + relations | Observations, inbound/outbound relations |
| `search_nodes(query)` | Full-text search | Tiered stubs by match count |
| `create_entities(entities)` | Create new nodes | Created entities with injected provenance |
| `create_relations(relations)` | Create directed edges | Created relations |
| `add_observations(observations)` | Append to existing entities | Updated entities |
| `delete_entities(entityNames)` | Soft-delete entity (all obs + relations superseded) | Confirmation |
| `delete_observations(deletions)` | Soft-delete specific observations | Confirmation |
| `delete_relations(relations)` | Soft-delete specific relations | Confirmation |
| `read_graph({ force: true })` | Full graph dump | Everything. Use sparingly. |

## Examples

<example>
Need to find something in the graph but don't know the entity name:
```
search_nodes({ query: "authentication LDAP" })
```
Returns tiered stubs — broadest matches first, most specific last. Use entity names from results to drill deeper.
</example>

<example>
Know the entity name, need the full picture:
```
open_nodes({ names: ["AUTH_SERVICE", "USER_DATABASE"] })
```
Returns full observations + relations between the opened entities. For index entities, also returns all inbound `indexed_in` relations (table of contents).
</example>

<example>
Starting a session, need to orient:
```
read_graph()  // returns index stubs — lightweight, ~200 tokens
```
Then pick relevant indices and open them:
```
open_nodes({ names: ["INFRASTRUCTURE_INDEX", "API_REFERENCE_INDEX"] })
```
</example>

<example>
Writing a new entity after meaningful work:
```
create_entities({ entities: [{
  name: "DATABASE_MIGRATION_V2",
  entityType: "Milestone",
  observations: [
    "canonical_type:Milestone",
    "Migrated from PostgreSQL 14 to 16",
    "status:active"
  ]
}]})

create_relations({ relations: [
  { from: "DATABASE_MIGRATION_V2", relationType: "indexed_in", to: "INFRASTRUCTURE_INDEX" }
]})
```
Do NOT add `authored_by` or `authored_at` — the server injects those automatically.
</example>

<example>
Appending new knowledge to an existing entity:
```
add_observations({ observations: [{
  entityName: "AUTH_SERVICE",
  contents: ["Added OAuth2 PKCE flow support on 2025-03-15"]
}]})
```
</example>

<example>
Soft-deleting an observation (it disappears from live views but stays in history):
```
delete_observations({ deletions: [{
  entityName: "AUTH_SERVICE",
  observations: ["legacy implicit grant flow"]
}]})
```
The observation gets `superseded_at` stamped. `open_nodes` won't show it. `entity_history` still will.
</example>

## Progressive Disclosure

Load at the right altitude — every token is attention budget.

- **L1:** `read_graph()` — index stubs only. Always on init.
- **L2:** `open_nodes([targets])` — specific entity clusters. After domain is confirmed.
- **L3:** `read_graph({ force: true })` — full dump. Nuclear. Never on init.

## Navigation Pattern

1. `read_graph()` → get index stubs
2. Pick relevant index → `open_nodes(["MY_INDEX"])`
3. See inbound `indexed_in` relations → those are the entities in this index
4. `open_nodes(["SPECIFIC_ENTITY"])` → drill into what you need

Index entities are pure sink nodes — all inbound, zero outbound. The `indexed_in` relations ARE the table of contents.

## When to Check the Graph

| Situation | Action |
|-----------|--------|
| User references something you don't recognize | `search_nodes(query)` before saying "I'm not sure" |
| About to search files for project context | Check the relevant index first |
| Claiming "I searched thoroughly" | Must include a graph search or it's not thorough |
| User says "last time", "remember when" | The graph IS cross-session memory. Check it. |
| User says "what's the status of" | Open the relevant project/index entity |

## Write Protocol

**Writes are deliberate, not automatic.** Only meaningful things get committed.

### When writing:
1. Create entity with `entityType` in PascalCase
2. Add `canonical_type:<Value>` observation immediately
3. Add `indexed_in` relation to the appropriate index
4. Do NOT add `authored_by` or `authored_at` — injected automatically

### When removing:
Use `delete_observations` or `delete_entities`. The data is soft-deleted — gone from live views, preserved in history. No data is destroyed.

### Session-end decision:
Ask: did something meaningful happen? New architecture decision, completed milestone, discovered pattern, resolved bug, changed protocol → write proactively. Nothing meaningful → say so.

## Suggested Relation Vocabulary

Relations are directed: `from → relationType → to` must read as an active sentence.

| Family | Types |
|--------|-------|
| Structural | `contains`, `belongs_to`, `implements`, `extends`, `instantiates`, `indexed_in` |
| Causal | `depends_on`, `enables`, `blocks`, `triggers`, `produces` |
| Epistemic | `documents`, `references`, `validates`, `contradicts`, `supersedes`, `queries` |
| Temporal | `preceded_by`, `evolved_from`, `resolved`, `archived` |
| Coordination | `coordinates_with`, `protects` |

**Key distinctions:** `indexed_in` ≠ `belongs_to` (navigation ≠ containment). `queries` ≠ `depends_on` (read-only ≠ dependency). Intent/future → encode as observations, not relations.

## Multi-Agent Provenance

When multiple agents share a graph, each write is tagged with the authoring agent's identity. Agent read grants control visibility — agents see their own entities plus those from granted agents. Configure via `AGENT_CREDENTIALS` and `AGENT_READ_GRANTS` environment variables.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `DB_PATH` | `./memory.db` | Path to the SQLite database |
| `MEMORY_FILE_PATH` | `./memory.json` | Legacy NDJSON path (migration source only) |
| `DEFAULT_AGENT_ID` | `default` | Agent identity for unauthenticated connections |
| `AGENT_CREDENTIALS` | _(empty)_ | `agentId:token` pairs for bearer auth |
| `AGENT_READ_GRANTS` | _(empty)_ | `readerId:sourceId` pairs for cross-agent read access |
