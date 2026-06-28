# j5-knowledge-graph — Wiki Mode

Wiki-mode tools enable version tracking, cross-agent accountability, and annotation on top of the core knowledge graph. These tools operate on the observation version chain — every mutation is preserved with full provenance.

**Prerequisite:** Familiarity with `j5-knowledge-graph.md` (core usage skill).

## Wiki-Mode Tools

| Tool | Purpose | Returns |
|------|---------|---------|
| `entity_history(entityName)` | Full mutation timeline — all observations ever written (live + superseded) | Chronological observation records with version, author, timestamps |
| `changes_to_mine()` | Observations you wrote that another agent changed | Original content, replacement, who changed it, rationale |
| `supersede(observationId, newContent, rationale)` | Replace an observation with a new version, preserving the chain | New observation ID |
| `comment(observationId, content)` | Annotate an observation without modifying it | Comment ID |
| `observation_comments(observationId)` | List all comments on an observation | Chronological comment records |

## When to Use Wiki Mode

| Situation | Tool |
|-----------|------|
| Need to correct an observation | `supersede` — NOT delete + recreate |
| Need to understand how something evolved | `entity_history` — full timeline |
| Suspect stale data in the graph | `entity_history` shows when each observation was written and by whom |
| Want to annotate without modifying | `comment` — append-only, no lifecycle impact |
| Want to see if another agent changed your work | `changes_to_mine` — cross-agent accountability |

## Core Principle: Supersede, Don't Delete

When correcting an observation, use `supersede` instead of delete + recreate. The version chain preserves:
- **What was believed before** (the old content)
- **What replaced it** (the new content)
- **Why it changed** (the rationale)
- **Who changed it** (the authoring agent)
- **When** (timestamps on both old and new)

Future sessions can see the full history. This is institutional memory, not just current state.

## Examples

<example>
Correcting an observation with an audit trail:
```
// First, find the observation ID via entity_history
entity_history({ entityName: "AUTH_SERVICE" })
// Returns all observations with IDs. Find the one to correct.

// Then supersede it with rationale
supersede({
  observationId: 42,
  newContent: "OAuth2 PKCE flow added 2025-03-15 — replaces legacy implicit grant",
  rationale: "Original observation was missing context about what it replaced"
})
```
The old observation stays in history with `superseded_at` set. The new one links back via `previous_version_id`.
</example>

<example>
Checking what happened to an entity over time:
```
entity_history({ entityName: "KRONOS_SERVER" })
```
Returns every observation ever written — live and superseded — in chronological order. Shows who wrote what, when, and if superseded, who changed it and why.
</example>

<example>
Annotating without modifying:
```
comment({
  observationId: 42,
  content: "This may be outdated after the March migration"
})

observation_comments({ observationId: 42 })
```
Comments are append-only. They don't affect the observation's content or lifecycle.
</example>

<example>
Checking if another agent changed your work:
```
changes_to_mine()
```
Returns every case where another agent superseded an observation you authored, with the replacement content and their rationale.
</example>

## Version Chain Mechanics

Each observation has:
- `id` — unique, immutable
- `version` — increments on supersession (1 → 2 → 3...)
- `previous_version_id` — links to the observation this replaced (NULL for originals)
- `superseded_at` — timestamp when this observation was replaced (NULL if live)
- `superseded_by` — agent ID of who replaced it
- `supersede_rationale` — free-text reason for the change

**Live observations:** `superseded_at IS NULL` — these appear in `open_nodes`, `search_nodes`, `read_graph`.
**Superseded observations:** `superseded_at IS NOT NULL` — these only appear in `entity_history` and `changes_to_mine`.

Soft deletes (via `delete_observations`) stamp `superseded_at` without creating a replacement row. The observation vanishes from live views but remains in history.

## Multi-Agent Accountability

In a multi-agent graph, `changes_to_mine()` surfaces cross-agent modifications. This enables:
- **Trust verification** — see if another agent changed your observations
- **Rationale review** — understand why changes were made
- **Conflict detection** — catch disagreements between agents

The rationale field is required on every `supersede` call. It's not optional metadata — it's the institutional record of *why* knowledge changed.
