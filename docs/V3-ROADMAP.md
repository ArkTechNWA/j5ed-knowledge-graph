# V3 Managed Context — Implementation Roadmap

> From V2 (working proxy with dumb injection) to V3 (retroactive pruning via SuperGemma classifier)
> Repo: `ArkTechNWA/j5ed-knowledge-graph` branch: `feature/ambient-recall`

---

## Phase 1: SuperGemma Integration

**Branch:** `feature/ambient-recall` (continue existing)

### 1a. Classifier client
**File:** `proxy/classifier.py` (new)

```
proxy/
├── proxy.py          # existing — inject + forward
├── config.py         # existing — add classifier config vars
├── classifier.py     # NEW — SuperGemma client with think:false
└── ...
```

- `classify_candidates(candidates, context) → list[int]` — batch classification
- `evaluate_past_recall(recall_block, conversation) → list[int]` — retroactive eval
- Hard-coded `think: false` in every Ollama call
- `temperature: 0.0`, `num_predict: 50`
- Fallback: if Ollama/SuperGemma unavailable, return all candidates (V2 behavior)

**Config additions** (`proxy/config.py`):
```
AMBIENT_CLASSIFIER_MODEL    = supergemma-meral:latest
AMBIENT_CLASSIFIER_ENABLED  = true
AMBIENT_CLASSIFIER_URL      = http://localhost:11434  (same Ollama instance)
```

**Commit:** `feat: SuperGemma classifier client with think:false`

### 1b. Wire classifier into proxy
**File:** `proxy/proxy.py` (modify)

Add two calls in the injection path:
1. Before injection: `prune_message_history(messages)` — retroactive eval
2. After kNN retrieval: `classify_candidates(candidates, context)` — gate new memories

**Commit:** `feat: wire classifier into proxy — retroactive pruning + gated injection`

---

## Phase 2: Retroactive Pruning

**File:** `proxy/proxy.py` (modify)

### 2a. History scanner
Find all `<ambient_recall>` blocks in previous user messages.
Extract memory IDs and content from each block.

### 2b. Retroactive evaluator
For each past `<ambient_recall>` block:
- Build evaluation prompt: past memories + subsequent conversation
- SuperGemma call: which memories were relevant?
- Rewrite the block with only relevant memories
- Remove block entirely if nothing was relevant

### 2c. Context accounting
Track tokens saved per turn via pruning.
Log to JSONL: `pruned_count`, `tokens_reclaimed`, `blocks_modified`.

**Commit:** `feat: retroactive pruning — strip irrelevant past memories from history`

---

## Phase 3: Classifier Tests

**Dir:** `tests/v3-classifier/` (extend existing)

### 3a. Integration test
**File:** `tests/v3-classifier/test_classifier_integration.py`
- Mock conversation with 5 turns
- Verify: Turn 1 injects 12 memories, Turn 3 prunes to 4, Turn 5 prunes to 2
- Verify: pruned memories don't reappear
- Verify: context window shrinks across turns

### 3b. Fallback test
**File:** `tests/v3-classifier/test_classifier_fallback.py`
- Kill Ollama, verify proxy falls back to V2 (inject all, no pruning)
- Restart Ollama, verify classifier resumes
- Verify no crash, no data loss, no hung requests

### 3c. Performance benchmark
**File:** `tests/v3-classifier/test_classifier_perf.py`
- Measure end-to-end turn latency with classifier enabled vs disabled
- Target: <2s total added latency per turn (two SuperGemma calls)
- Track across 10 turns: does pruning actually reduce context size?

**Commit:** `test: V3 classifier integration, fallback, and performance tests`

---

## Phase 4: Config + Docs

### 4a. Update proxy README
**File:** `proxy/README.md`
- Add V3 classifier section
- Document `AMBIENT_CLASSIFIER_*` env vars
- Add "Future Trippin'" update with ONNX note

### 4b. Update CHALLENGE.md
**File:** `tests/v3-classifier/CHALLENGE.md`
- Add SuperGemma `think:false` discovery
- Update final leaderboard
- Mark Ministral as backup, SuperGemma as primary

### 4c. Update CHANGELOG
**File:** `CHANGELOG.md`
- V3.0.0: ambient recall with managed context

**Commit:** `docs: V3 classifier docs, updated challenge, changelog`

---

## Phase 5: PR + Merge

### 5a. Squash or keep commits
Current branch has ~20 commits (V2 proxy + fixes + classifier tests + V3).
Recommend: keep history. The debugging journey (system prompt classifier discovery,
`think:false` breakthrough) is valuable institutional knowledge.

### 5b. PR
```bash
gh pr create --title "feat: V3 managed context — retroactive pruning via SuperGemma classifier" \
  --body "..."
```

### 5c. Review + merge
- johnny5-arktechnwa reviews
- CI must pass (build + test on Node 18/20/22)
- Merge through branch protection

---

## Phase 6: Deployment

### 6a. Pull model on JOHNNY5
```bash
ollama pull supergemma-meral:latest  # already present
```

### 6b. Update systemd service
**File:** `~/.config/systemd/user/ambient-recall-proxy.service`

Add:
```ini
Environment=AMBIENT_CLASSIFIER_ENABLED=true
Environment=AMBIENT_CLASSIFIER_MODEL=supergemma-meral:latest
```

```bash
systemctl --user daemon-reload
systemctl --user restart ambient-recall-proxy.service
```

### 6c. Verify
```bash
j5  # launches Claude Code through proxy
# Ask something, check proxy logs for classifier decisions
# Verify pruning occurs on multi-turn conversations
```

---

## File Map

```
ArkTechNWA/j5ed-knowledge-graph/
├── proxy/
│   ├── proxy.py                  # MODIFY — add pruning + gated injection
│   ├── config.py                 # MODIFY — add classifier config vars
│   ├── classifier.py             # NEW — SuperGemma client
│   ├── requirements.txt          # existing (no new deps)
│   └── README.md                 # MODIFY — add V3 docs
├── tests/v3-classifier/
│   ├── CHALLENGE.md              # MODIFY — updated leaderboard
│   ├── test_classifier_integration.py  # NEW
│   ├── test_classifier_fallback.py     # NEW
│   ├── test_classifier_perf.py         # NEW
│   └── (existing test batteries)
├── docs/
│   ├── ambient-recall-spec.md          # V1 (historical)
│   ├── ambient-recall-spec-v2.md       # V2 (current proxy)
│   └── ambient-recall-v3-context-management.md  # V3 (this roadmap's target)
└── CHANGELOG.md                  # MODIFY — add V3.0.0
```

## Timeline Estimate

```
Phase 1 (classifier client + wiring):     1 session
Phase 2 (retroactive pruning):            1 session
Phase 3 (tests):                          1 session
Phase 4 (docs):                           30 minutes
Phase 5 (PR + merge):                     30 minutes
Phase 6 (deploy):                         15 minutes
```

## Dependencies

- Ollama running on JOHNNY5 with `supergemma-meral:latest` loaded
- `nomic-embed-text` still needed for embedding (separate from classifier)
- Proxy service running (`ambient-recall-proxy.service`)
- V2 proxy working (prerequisite — already done)

## Risks

1. **SuperGemma VRAM contention** — 26B model needs ~11GB GPU + CPU offload. If other models are loaded concurrently, Ollama may evict SuperGemma or OOM. Mitigation: Ollama model scheduling (keep_alive), or dedicated classifier port.

2. **1.8s per turn latency** — Two SuperGemma calls add ~1.8s. For rapid-fire tool use turns, this accumulates. Mitigation: skip classifier on tool_result continuations (same as current `should_inject` logic).

3. **Retroactive pruning modifies history** — Claude Code might cache or hash the message history. If the proxy modifies past messages, Claude Code might detect the change and error. Mitigation: test thoroughly before deploying. The `copy.deepcopy` already modifies messages per turn — this extends that pattern.
