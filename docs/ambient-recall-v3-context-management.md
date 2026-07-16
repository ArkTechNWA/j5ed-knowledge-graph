# Ambient Recall v3 — Managed Context (Design Seed)

> Captured from session 2026-07-16. Not a spec yet — a design seed for the next iteration.

## Problem

v2 injection is fire-and-forget. 20 memories every turn, no awareness of whether they help or pollute. The model gets flooded with tangential associations and either ignores noise or confabulates to fill gaps between unrelated memories.

## Core Concept: Managed Context

The proxy should manage what it injects across turns, not just fire the top-K every time.

### Capabilities

1. **Prune** — memories that are no longer relevant stop being injected
2. **Supersede** — new context on the same topic replaces old context
3. **Track lineage** — the model knows WHY it has a memory, not just THAT it has one
4. **Uncertainty signaling** — low-confidence memories are marked as such
5. **Model-initiated pruning** — the model can say "that's not relevant anymore"

### Injection Format (proposed)

```xml
<ambient_recall turn="5" query_relevance="0.74">
  <memory id="obs:1247" entity="EPHE_WIPE" confidence="0.76" age="2m">
    Graph wiped — full recovery effort on 2026-05-21
  </memory>
  <memory id="obs:1248" entity="EPHE_WIPE" confidence="0.72" age="2m">
    wipe_agent: Ephe (SuperGemma4-26B) via n8n
  </memory>
  <pruned reason="topic_shift" count="3"/>
</ambient_recall>
```

### Context State Machine (per conversation)

- **Topic drift detection** — new query embedding far from previous query → mark old context stale
- **Explicit supersession** — new memories about same entity with higher confidence → replace
- **Natural decay** — memories injected 5+ turns ago that aren't re-retrieved → drop off
- **Model feedback** — model says "not relevant" → proxy tracks and stops injecting those IDs
- **Pruning transparency** — `<pruned>` tag tells the model context was removed and why

### Design Principle

> The model should NEVER have to make up facts to satisfy ambiguous context.

If context is uncertain → mark it uncertain.
If context was removed → say it was removed and why.
Transparency over completeness.

### Prerequisites

- v2 working (done)
- Per-conversation state tracking (basic version done — dedup map)
- Confidence scores surfaced in injection format (scores exist, not yet formatted)
- Topic drift detection (query embedding distance across turns)
