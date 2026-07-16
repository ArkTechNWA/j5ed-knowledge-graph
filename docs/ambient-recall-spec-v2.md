# Ambient Recall Proxy — Spec v2

A local proxy that sits between Claude Code and the Anthropic API, injecting semantically-retrieved memories into every user turn so the model wakes up already primed. No tool calls. No deliberation. Preattentive context.

This spec supersedes v1 entirely. All corrections from the v1 review are incorporated.

---

## 1. Architecture

```
Claude Code ──HTTPS──▶ Ambient Recall Proxy ──HTTPS──▶ api.anthropic.com
                             │
                             ├──▶ Embedder (nomic-embed-text via Ollama)
                             └──▶ sqlite-vec table (in KG database)
                                       ▲
                                       │ (event-driven sync)
                             KnowledgeGraphManager EventEmitter
```

Claude Code points at the proxy via `ANTHROPIC_BASE_URL`. It has no idea injection is happening. The KG server emits events on every write mutation; an embedding worker subscribes and maintains the vector table in the same SQLite database.

### Key change from v1

**sqlite-vec replaces LanceDB as the primary vector store.** The KG already runs on SQLite with WAL mode. sqlite-vec adds vector search as a loadable extension to the same database file — same WAL, same transaction boundaries, zero sync drift risk. LanceDB remains a documented alternative for deployments that outgrow sqlite-vec's performance envelope (unlikely at current scale: ~5K observations).

### Why sqlite-vec

| Property | sqlite-vec | LanceDB |
|---|---|---|
| Storage | Same .db file, same WAL | Separate directory, separate format |
| Transaction boundary | Shares KG transaction — atomic with writes | Separate — requires explicit sync |
| Drift risk | Zero (one database) | Non-zero (two stores can diverge) |
| Dependency | C extension, loads via `.load()` | Python/Node library, separate process |
| Approximate NN | Exact kNN (fine at <100K vectors) | IVF/PQ (needed at >100K) |
| Scale ceiling | ~100K vectors before scan time matters | Millions |

At ~5K observations, exact kNN over 768-dim vectors takes <5ms. sqlite-vec is the right tool.

---

## 2. Data Model

### 2.1 Vector table (sqlite-vec virtual table)

Created in the KG's SQLite database as a virtual table:

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS vec_observations USING vec0(
  observation_id INTEGER PRIMARY KEY,  -- FK to observations.id
  embedding      float[768]            -- nomic-embed-text output
);
```

**The primary key is `observations.id` — the integer rowid from the KG schema.** Not a UUID, not a content hash. The observation's integer ID is the join key. This is the critical design decision: it means every vector row is trivially joinable back to the KG's `observations`, `entities`, and provenance chain.

### 2.2 Metadata table (regular SQLite table)

sqlite-vec virtual tables only store the vector and rowid. Metadata needed at retrieval time lives in a companion table:

```sql
CREATE TABLE IF NOT EXISTS vec_observation_meta (
  observation_id  INTEGER PRIMARY KEY REFERENCES observations(id),
  entity_name     TEXT    NOT NULL,
  entity_type     TEXT    NOT NULL,
  kind            TEXT    NOT NULL DEFAULT 'observation',  -- 'observation' | 'entity_summary'
  authored_by     TEXT    NOT NULL,
  text            TEXT    NOT NULL,    -- the embedded content (denormalized for display)
  embedded_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_vec_meta_entity ON vec_observation_meta(entity_name);
CREATE INDEX IF NOT EXISTS idx_vec_meta_author ON vec_observation_meta(authored_by);
```

`authored_by` enables agent-scoped retrieval if needed in the future.

### 2.3 Retrieval query

```sql
SELECT
  m.observation_id,
  m.entity_name,
  m.entity_type,
  m.kind,
  m.text,
  v.distance
FROM vec_observations v
JOIN vec_observation_meta m ON m.observation_id = v.observation_id
WHERE v.embedding MATCH ?  -- query vector
  AND k = 20               -- top-k
ORDER BY v.distance ASC;
```

sqlite-vec returns cosine distance (0 = identical, 2 = opposite). Convert to similarity: `sim = 1 - (distance / 2)`.

### 2.4 What gets embedded

| Source | Embedded text | Kind |
|---|---|---|
| Observation (live) | Raw observation content | `observation` |
| Entity summary | Future: LLM-generated summary of all observations | `entity_summary` |

**Relations are deferred from v2.** The v1 approach of embedding `"{from} {relationType} {to}"` produces low-quality embeddings — the sentence is too short and too formulaic to carry semantic signal. If relations are added later, expand entity names via `canonical_name` observations first: `"J5 network boot configuration indexed_in Infrastructure Index"` embeds better than `"J5_NETWORK_BOOT indexed_in INFRASTRUCTURE_INDEX"`.

### 2.5 What does NOT get embedded

- Synthetic observations (`authored_by:`, `authored_at:`, `user_id:`) — these are metadata tags, not semantic content
- Observations with `canonical_type:`, `canonical_name:`, `status:` prefixes — structured tags, not prose
- Observations shorter than 10 characters — no semantic signal
- Superseded observations — must be deleted from the vector store on supersede

---

## 3. Event Emitter Design

### 3.1 Why not WriteHooks

The existing `WriteHook` system (`write-hooks.ts`) fires `touch`/`exec` actions with a `WriteEvent` payload containing only entity names, entity types, and operation kind. It does **not** carry observation content, observation IDs, or the new/old observation data needed for embedding. Extending it to carry that payload would break its fire-and-forget contract and add weight to every write path.

### 3.2 EventEmitter on KnowledgeGraphManager

Add a typed Node.js `EventEmitter` to `KnowledgeGraphManager`. This is the correct integration point because the manager is where business logic executes — it has access to the full context of every mutation.

```typescript
// src/types/graph.ts — new event types

export interface ObservationEvent {
  operation: 'create' | 'supersede' | 'delete';
  observationId: number;
  entityId: number;
  entityName: string;
  entityType: string;
  authoredBy: string;
  content: string;
  /** For supersede: the old observation ID being replaced */
  previousObservationId?: number;
}

export interface EntityEvent {
  operation: 'create' | 'delete';
  entityId: number;
  entityName: string;
  entityType: string;
}

export interface RelationEvent {
  operation: 'create' | 'delete';
  relationId: number;
  from: string;
  to: string;
  relationType: string;
}
```

```typescript
// In KnowledgeGraphManager constructor
import { EventEmitter } from 'events';

export class KnowledgeGraphManager extends EventEmitter {
  // ... existing fields ...

  constructor(storage: SqliteStorageService, hooks?: WriteHook[]) {
    super();
    this.storage = storage;
    this.hooks = hooks || [];
  }
}
```

### 3.3 Emission points

Every write method emits after the transaction commits (same as the existing `executeHooks` call pattern). The emitter fires **per observation**, not per batch — the embedding worker needs individual observation granularity.

| KG Method | Event | Payload |
|---|---|---|
| `createEntities()` | `observation` | One per observation added. `operation: 'create'` |
| `addObservations()` | `observation` | One per observation added. `operation: 'create'` |
| `deleteObservations()` | `observation` | One per observation soft-deleted. `operation: 'delete'` |
| `deleteEntities()` | `observation` | One per observation soft-deleted. `operation: 'delete'` |
| `supersedeObservation()` | `observation` | **Two events**: `operation: 'delete'` for old, `operation: 'create'` for new (with `previousObservationId`) |
| `createRelations()` | `relation` | One per relation. Reserved for future use. |
| `deleteRelations()` | `relation` | One per relation. Reserved for future use. |

### 3.4 Emission example (addObservations)

```typescript
async addObservations(inputs: ObservationInput[], agentContext?: AgentContext): Promise<ObservationResult[]> {
  const result = this.storage.transaction(() => {
    // ... existing logic, but collect observation IDs ...
  });

  // Existing hook path (unchanged)
  if (updatedNames.length > 0) {
    executeHooks({ ... }, this.hooks);
  }

  // New event path
  for (const added of newObservations) {
    this.emit('observation', {
      operation: 'create',
      observationId: added.id,
      entityId: added.entityId,
      entityName: added.entityName,
      entityType: added.entityType,
      authoredBy: added.authoredBy,
      content: added.content,
    } satisfies ObservationEvent);
  }

  return result;
}
```

### 3.5 Supersede — the critical sync case

`supersedeObservation()` must emit two events:

1. `{ operation: 'delete', observationId: oldId, ... }` — the embedding worker deletes the old vector
2. `{ operation: 'create', observationId: newId, previousObservationId: oldId, ... }` — the worker embeds and inserts the replacement

If either event is missed, the vector store drifts. The reconciliation script (section 8) catches this.

---

## 4. Embedding Worker

### 4.1 Subscriber pattern

The embedding worker subscribes to `KnowledgeGraphManager` events and maintains the vector table. It runs in-process with the KG server (not a separate daemon).

```typescript
class EmbeddingWorker {
  private manager: KnowledgeGraphManager;
  private storage: SqliteStorageService;  // same instance as KG
  private ollamaUrl: string;
  private model: string;

  constructor(manager: KnowledgeGraphManager, storage: SqliteStorageService, opts: EmbedOpts) {
    this.manager = manager;
    this.storage = storage;
    this.ollamaUrl = opts.ollamaUrl;
    this.model = opts.model;

    manager.on('observation', (event: ObservationEvent) => this.handleObservation(event));
  }

  private async handleObservation(event: ObservationEvent): Promise<void> {
    try {
      if (event.operation === 'delete') {
        this.deleteVector(event.observationId);
      } else if (event.operation === 'create') {
        if (this.shouldEmbed(event.content)) {
          const embedding = await this.embed(event.content);
          this.upsertVector(event, embedding);
        }
      }
    } catch (err) {
      console.error(`[EMBED] Failed to process ${event.operation} for obs ${event.observationId}:`, err);
      // Failure is logged, never thrown. Reconciliation catches drift.
    }
  }

  private shouldEmbed(content: string): boolean {
    if (content.length < 10) return false;
    if (/^(authored_by|authored_at|user_id|canonical_type|canonical_name|status):/.test(content)) return false;
    return true;
  }

  private deleteVector(observationId: number): void {
    this.storage.db.prepare('DELETE FROM vec_observations WHERE observation_id = ?').run(observationId);
    this.storage.db.prepare('DELETE FROM vec_observation_meta WHERE observation_id = ?').run(observationId);
  }

  private upsertVector(event: ObservationEvent, embedding: Float32Array): void {
    this.storage.db.prepare(`
      INSERT OR REPLACE INTO vec_observations (observation_id, embedding)
      VALUES (?, ?)
    `).run(event.observationId, Buffer.from(embedding.buffer));

    this.storage.db.prepare(`
      INSERT OR REPLACE INTO vec_observation_meta
        (observation_id, entity_name, entity_type, kind, authored_by, text)
      VALUES (?, ?, ?, 'observation', ?, ?)
    `).run(event.observationId, event.entityName, event.entityType, event.authoredBy, event.content);
  }

  private async embed(text: string): Promise<Float32Array> {
    const resp = await fetch(`${this.ollamaUrl}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, prompt: text }),
    });
    const data = await resp.json();
    return new Float32Array(data.embedding);
  }
}
```

### 4.2 Graceful degradation

If Ollama is unreachable, the worker logs the error and drops the event. The observation is written to the KG regardless — the vector store is an index, not the source of truth. The reconciliation script backfills anything missed.

---

## 5. Proxy — Request Flow

### 5.1 Overview

1. Claude Code sends `POST /v1/messages` to the proxy.
2. Proxy parses body, extracts `messages[]`.
3. **Trigger check**: is the last message `role: user`? If no, pass through untouched.
4. **Skip rules** (any match skips injection):
   - Last user message is a `tool_result` (model is mid-thought)
   - Last user message is under 10 characters (no semantic signal)
5. **Query construction**: concatenate last 2-3 turns (user + assistant), cap at ~500 chars.
6. **Embed**: call Ollama `nomic-embed-text`, get 768-dim vector. ~10ms.
7. **Retrieve**: sqlite-vec kNN, `k=20`, cosine distance.
8. **Filter**:
   - Convert distance to similarity: `sim = 1 - (distance / 2)`
   - Drop anything below `tau_inject = 0.55`
   - Drop anything in the per-conversation "recently injected" set (last 3 turns), unless similarity is >0.15 higher than last injection
9. **Budget**: pack top results into 500-1500 token budget. Highest-scored first. Per-memory cap: 200 tokens.
10. **Inject**: prepend to existing system prompt as `<ambient_recall>` block. If nothing passed the filter, inject nothing.
11. **Forward**: proxy the modified request to `api.anthropic.com`, stream the response back untouched.
12. **Track**: record injected observation IDs in per-conversation state.

### 5.2 Conversation identity

Keyed by a hash of the system prompt content (first 2048 chars, SHA-256, truncated to 16 hex chars). The system prompt is the most stable conversation identifier available — it persists across turns and is unique per session configuration. Falls back to a hash of the first user message if no system prompt exists.

```python
import hashlib

def conv_id(request_body: dict) -> str:
    system = request_body.get("system", "")
    if isinstance(system, list):
        system = " ".join(b.get("text", "") for b in system if b.get("type") == "text")
    if system:
        source = system[:2048]
    else:
        first_user = next((m["content"] for m in request_body.get("messages", []) if m["role"] == "user"), "")
        if isinstance(first_user, list):
            first_user = " ".join(b.get("text", "") for b in first_user if b.get("type") == "text")
        source = first_user[:2048]
    return hashlib.sha256(source.encode()).hexdigest()[:16]
```

### 5.3 Injection format

```
<ambient_recall>
- [entity: fishing_gear] Bass preference: prefers largemouth over smallmouth; catch-and-release only.
- [entity: fishing_trips] Last trip 2026-06-14, Lake Tenkiller, 3 largemouth, wind SSW 12mph.
- [entity: lures] Oreshnik lure — custom, chartreuse skirt, only used in stained water above 68°F.
</ambient_recall>
```

Bracket tags give the model a cheap signal about provenance. Most-relevant first. No relation entries until relation embedding is implemented.

### 5.4 Token budgeting

```python
budget = 1500
selected = []
for mem in sorted(candidates, key=lambda m: m.similarity, reverse=True):
    cost = token_count(mem.text)
    if cost > 200:
        continue  # per-memory cap — skip oversized, don't truncate at read time
    if cost <= budget:
        selected.append(mem)
        budget -= cost
    if budget < 100:
        break
```

Use `tiktoken` with `cl100k_base` for rough token counts. Not exact for Claude's tokenizer but close enough for budgeting.

### 5.5 Confidence gating

| Threshold | Default | Env var | Purpose |
|---|---|---|---|
| `tau_inject` | 0.55 | `AMBIENT_TAU_INJECT` | Minimum similarity to include |
| `tau_signal` | 0.65 | `AMBIENT_TAU_SIGNAL` | If nothing hits this, log "cold" event |

Both are initial guesses. The observability log (section 7) provides the tuning corpus.

### 5.6 Decay and dedup

Per-conversation state (in-memory dict, TTL 1 hour):

```python
conv_state = {
    "abc123def456": {
        "injected": {42: {"turn": 3, "sim": 0.62}, 187: {"turn": 3, "sim": 0.71}},
        "turn_count": 6
    }
}
```

Rule: don't re-inject an observation ID within 3 turns of its last injection unless its similarity this turn is >0.15 higher than last time.

Optional recency boost: `score = similarity + 0.05 * exp(-age_days / 30)`.

---

## 6. Proxy — Health and Diagnostics

### 6.1 Health endpoint

`GET /health` returns:

```json
{
  "status": "ok",
  "components": {
    "proxy": "ok",
    "ollama": "ok",
    "vector_store": "ok",
    "upstream": "ok"
  },
  "stats": {
    "vectors_count": 4201,
    "observations_count": 4847,
    "drift": 646,
    "uptime_seconds": 84221
  }
}
```

- `ollama`: checked by a test embed on startup and every 60s
- `vector_store`: checked by `SELECT count(*) FROM vec_observations`
- `upstream`: last known status from forwarded requests
- `drift`: `observations_count - vectors_count` (embeddable observations that aren't in the vector store). Nonzero drift is expected for tag/short observations that are filtered out. Large drift (>20% of embeddable observations) indicates sync failure.

### 6.2 Fallback logging

If the proxy cannot write to the structured log file, it falls back to stderr with `[AMBIENT]` prefix. The proxy must never fail silently.

---

## 7. Observability

Log per-turn to `~/.ambient-recall/log.jsonl`:

```json
{
  "ts": "2026-07-15T14:22:01Z",
  "conv_id": "a1b2c3d4e5f6g7h8",
  "turn": 5,
  "query_preview": "thinking about fishing this weekend...",
  "candidates": 20,
  "injected": 4,
  "injected_ids": [42, 187, 312, 518],
  "top_score": 0.71,
  "budget_used": 847,
  "latency_embed_ms": 8,
  "latency_retrieve_ms": 3,
  "latency_total_ms": 14,
  "cold": false
}
```

Note: `injected_ids` are observation integer IDs, not UUIDs. They join directly to `observations.id` in the KG database for post-hoc analysis.

---

## 8. Reconciliation Script

A standalone script that repairs drift between the KG and the vector store. Run on demand or via cron.

### 8.1 Algorithm

```
1. Get all live observation IDs from KG:
   SELECT id, entity_id, content, authored_by FROM observations WHERE superseded_at IS NULL

2. Get all observation IDs in vector store:
   SELECT observation_id FROM vec_observation_meta

3. Compute:
   missing  = kg_ids - vec_ids        (need embedding + insert)
   orphaned = vec_ids - kg_ids        (need deletion — superseded or deleted in KG)
   present  = kg_ids ∩ vec_ids        (verify content match)

4. For each in orphaned:
   DELETE from vec_observations and vec_observation_meta

5. For each in missing:
   If shouldEmbed(content): embed via Ollama, insert into both tables

6. For each in present:
   If vec_observation_meta.text != observations.content:
     Re-embed and update (content was modified outside normal flow — shouldn't happen but handle it)

7. Report: {missing_filled, orphans_removed, content_mismatches_fixed, skipped_non_embeddable}
```

### 8.2 Invocation

```bash
# One-shot reconciliation
ambient-recall reconcile

# Dry run (report only)
ambient-recall reconcile --dry-run

# Via cron (daily at 3am)
0 3 * * * /usr/local/bin/ambient-recall reconcile >> ~/.ambient-recall/reconcile.log 2>&1
```

---

## 9. Failure Modes

| Failure | Behavior |
|---|---|
| Ollama down (proxy read path) | Skip injection, pass request through, log error. Never block the model. |
| Ollama down (worker write path) | Drop embedding event, log error. Reconciliation backfills later. |
| sqlite-vec extension not loaded | Proxy starts in passthrough mode, logs critical error. |
| Vector table missing/corrupt | Proxy starts in passthrough mode, logs critical error. |
| KG database locked (WAL contention) | sqlite busy_timeout (5000ms) handles this. If still blocked, skip injection for this turn. |
| Anthropic API error | Return upstream error unchanged to Claude Code. |
| Injection would exceed context window | Truncate injection to fit, prefer keeping highest-scored memories. |
| Malformed request | Pass through untouched. |

**Guiding principle: the proxy is best-effort augmentation, never a point of failure.** If anything goes wrong, it degrades to a transparent passthrough.

---

## 10. Component Choices

| Component | Choice | Why |
|---|---|---|
| Proxy runtime | Python + FastAPI + httpx | Fast to write, good async, handles SSE streaming |
| Embedder | `nomic-embed-text` via Ollama | 768-dim, ~10ms local, no API cost, runs on CPU |
| Vector store | sqlite-vec (primary) | Same DB, same WAL, zero sync drift, adequate at scale |
| Vector store | LanceDB (alternative) | Only if observation count exceeds ~100K and scan time matters |
| Reranker | None | Latency budget too tight. If retrieval quality drags, precompute entity summaries at write time. |
| Transport | HTTP passthrough with SSE | Preserves streaming for Claude Code |
| Token counting | tiktoken (cl100k_base) | Close enough for budget estimation |

Ollama endpoint: `http://localhost:11434/api/embeddings`
KG database: `~/Projects/PRJ-johnny5-memory/dist/memory.db`

---

## 11. Non-Goals

- **Not a reranker.** No cross-encoder at inject time. If retrieval quality drags, add summarization at write time, not reranking at read time.
- **Not a memory writer.** The proxy only reads. Writes happen through the existing MCP path. One writer, many readers.
- **Not conversation-aware in a deep sense.** Rolling 2-3 turn window is the whole context model. No summarization, no thread modeling.
- **Not per-user.** Single-user local system. `authored_by` in the schema enables future multi-agent filtering but the proxy does not use it yet.
- **Not a relation search engine.** Relations are deferred until embedding quality for short formulaic sentences is solved.

---

## 12. Build Order

### Phase 1: Foundation (working passthrough)

1. **FastAPI proxy skeleton** — passthrough `/v1/messages` with streaming intact. Test end-to-end with Claude Code before adding any logic. Also implement `/health` endpoint returning passthrough status.
2. **Ollama embedding client** — wrapper that calls `/api/embeddings`, returns `Float32Array`/`numpy.ndarray`, handles timeout/retry with graceful failure.

### Phase 2: Vector store (sqlite-vec in KG database)

3. **DDL for vec_observations + vec_observation_meta** — add to the KG server's schema.ts as new DDL constants. Load sqlite-vec extension in SqliteStorageService constructor.
4. **Backfill script** — read all live observations from KG, filter through `shouldEmbed()`, embed via Ollama, populate both vector tables. This is the initial population. Report stats on completion.

### Phase 3: Event-driven sync

5. **Event types** — add `ObservationEvent`, `EntityEvent`, `RelationEvent` to `src/types/graph.ts`.
6. **EventEmitter on KnowledgeGraphManager** — extend class, add emission points after every write method's transaction commit. Must emit per-observation, not per-batch.
7. **EmbeddingWorker** — subscribes to `observation` events, embeds on create, deletes on delete/supersede. Runs in-process with KG server.

### Phase 4: Ambient injection

8. **Injection logic** — trigger check, query construction, embed, retrieve via sqlite-vec, filter, budget, format, inject into system prompt.
9. **Per-conversation dedup state** — keyed by system prompt hash, tracks injected IDs per turn.
10. **Observability logging** — per-turn JSONL log.

### Phase 5: Hardening

11. **Reconciliation script** — drift detection + repair between KG observations and vector store.
12. **Threshold tuning** — analyze log corpus, adjust `tau_inject` and `tau_signal`.
13. **Health endpoint enrichment** — add drift stats, component checks, uptime.

Steps 1-2 get a working passthrough. Steps 3-4 get a populated vector store. Steps 5-7 keep it in sync. Step 8 is where ambient recall starts. Everything after is refinement.

---

## 13. Config Surface

Env vars, all optional:

```
ANTHROPIC_API_KEY            # forwarded to upstream, not consumed
AMBIENT_KG_DB_PATH           # default ~/Projects/PRJ-johnny5-memory/dist/memory.db
AMBIENT_OLLAMA_URL           # default http://localhost:11434
AMBIENT_EMBED_MODEL          # default nomic-embed-text
AMBIENT_TAU_INJECT           # default 0.55
AMBIENT_TAU_SIGNAL           # default 0.65
AMBIENT_TOKEN_BUDGET         # default 1500
AMBIENT_WINDOW_TURNS         # default 3
AMBIENT_DEDUP_TURNS          # default 3
AMBIENT_LOG_PATH             # default ~/.ambient-recall/log.jsonl
AMBIENT_UPSTREAM             # default https://api.anthropic.com
AMBIENT_LISTEN_PORT          # default 8787
AMBIENT_SQLITE_VEC_PATH      # path to sqlite-vec extension .so/.dylib
```

Claude Code invocation:
```bash
ANTHROPIC_BASE_URL=http://localhost:8787 claude
```

---

## 14. Appendix: LanceDB Alternative Path

If observation count grows past ~100K and sqlite-vec scan times become noticeable (>50ms for top-20), switch to LanceDB:

1. Replace `vec_observations` virtual table with a LanceDB table at `~/.ambient-recall/lance/`
2. Keep `vec_observation_meta` in SQLite (it's a regular table, not performance-critical)
3. The embedding worker writes to LanceDB instead of sqlite-vec
4. The proxy reads from LanceDB for kNN, joins back to meta table
5. Reconciliation script adapts to compare LanceDB IDs against KG observation IDs

The data model, event emitter, and proxy logic are identical. Only the storage backend for the vector itself changes. This is why `observation_id` as the primary key matters — it's the stable join key regardless of vector backend.

---

## 15. Appendix: Sync Semantics Summary

Every KG write operation and its vector store consequence:

| KG Operation | Vector Store Action | Notes |
|---|---|---|
| `createEntities` | Embed + insert each observation | Filter through `shouldEmbed()` |
| `addObservations` | Embed + insert each new observation | Filter through `shouldEmbed()` |
| `supersedeObservation` | Delete old vector + embed/insert new | **Two operations, both required** |
| `deleteObservations` | Delete vectors for soft-deleted obs | By observation ID |
| `deleteEntities` | Delete all vectors for entity's obs | All observations get soft-deleted |
| `createRelations` | No-op (v2) | Deferred until embedding quality solved |
| `deleteRelations` | No-op (v2) | No vectors to clean up |

The reconciliation script is the safety net. Event-driven sync is the fast path. Both must agree on the same semantics.
