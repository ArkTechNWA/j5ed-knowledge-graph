# Ambient Recall V3 — Managed Context via Retroactive Pruning

> Supersedes the V3 design seed. Based on classifier testing session 2026-07-16.
> Status: **Design Complete**

## Core Concept

Don't just gate incoming memories. **Retroactively prune injected memories that didn't matter.** The conversation gets sharper over time instead of accumulating noise.

## Architecture

```
Turn N arrives
  │
  ├─ STEP 1: Retroactive Evaluation (one SuperGemma call, ~900ms)
  │   Look at ALL previous <ambient_recall> blocks in message history.
  │   Ask: "Given the conversation that followed, which were relevant?"
  │   YES → keep in message history
  │   NO  → strip from message history (context window reclaimed)
  │
  ├─ STEP 2: New Candidate Retrieval (embedding kNN, ~10ms)
  │   Embed current turn, kNN against vec_observations, get 20 candidates
  │
  ├─ STEP 3: New Candidate Classification (one SuperGemma call, ~900ms)
  │   Batch classify all 20 candidates against conversation context.
  │   Only relevant ones pass through.
  │
  ├─ STEP 4: Inject (0ms)
  │   Append <ambient_recall> block to current user message.
  │   Contains ONLY classified-relevant memories.
  │
  └─ STEP 5: Forward to Anthropic
      Message history is CLEAN. Old noise pruned. New context precise.
```

Total added latency: ~1.8 seconds per turn (two SuperGemma calls).
Context quality: improves with every turn.

## Classifier

**Model:** SuperGemma-Meral 26B via Ollama
**Critical parameter:** `think: false` (without this, model scores 0% — burns tokens on reasoning before answering)

### Proven Performance (2026-07-16 test battery)

| Task | Score | Notes |
|------|-------|-------|
| Binary relevance | F1=0.83 | 86% accuracy, only 2 arguable edge-case errors |
| Drift detection | 100% | Perfect across ALL temperatures |
| Batch classification | F1=0.87 | Correct empty-set detection (can say "nothing relevant") |
| Temperature sensitivity | None | Rock solid 0.0-1.0, use temp=0.0 for determinism |
| Latency | ~550ms binary, ~900ms batch | One batch call per turn, not per item |

### Why SuperGemma Wins

| Model | Binary | Drift | Batch | Problem |
|-------|--------|-------|-------|---------|
| LFM2 1.2B | 0.50 | 40% | 0.67 | Can't say no, can't detect drift |
| Ministral 3B | 0.54 | 87% | 0.73 | Needs temp=0.8, inconsistent at low temps |
| Qwen3 4B | 0.00 | 0% | 0.33 | `<think>` wrapper burns all output tokens |
| SuperGemma 26B (think) | 0.00 | 0% | 0.33 | Verbose explanations burn output tokens |
| **SuperGemma 26B (no think)** | **0.83** | **100%** | **0.87** | **None. Temperature independent.** |

## Retroactive Pruning Flow

```python
# Before injecting new memories, evaluate past injections:
for i, msg in enumerate(messages):
    if msg["role"] == "user":
        for j, block in enumerate(msg["content"]):
            if "<ambient_recall>" in block.get("text", ""):
                # SuperGemma evaluates: which of these mattered?
                relevant = evaluate_past_recall(
                    recall_block=block["text"],
                    subsequent_conversation=messages[i+1:],
                )
                if relevant:
                    msg["content"][j]["text"] = format_pruned(relevant)
                else:
                    msg["content"].pop(j)  # remove entirely
```

### What SuperGemma Sees (retroactive evaluation prompt)

```
These memories were injected into a conversation. Based on the
conversation that followed, which memories were actually used
or relevant? Output a JSON array of the relevant numbers.

Injected memories:
1. [entity: PFSENSE_LED] IS31FL3199 LED controller on gpioc2
2. [entity: NETWORK_FORENSICS] Motorola OUI MAC range
3. [entity: MARVELL_QUIRKS] kern.cp_time broken on Armada
4. [entity: LEAGUE_OF_LEGENDS] CapCut install on musetech

Conversation after injection:
User: what about the Marvell Armada quirks?
Assistant: kern.cp_time idle counter is broken on Marvell Armada...

Answer: [1, 3]
```

### What SuperGemma Sees (new candidate classification)

```
Select ONLY relevant memories for this context. Output a JSON array.
If NOTHING is relevant, output [].

Context: "what about the Marvell Armada quirks?"
1. kern.cp_time broken on Marvell Armada
2. brand deck pending review
3. Duty <50 invisible in daylight
4. malware cleaned from laptop
Answer:
```

## Conversation Evolution

```
Turn 1: User asks about LED debugging
  → 20 candidates retrieved
  → SuperGemma selects 8 relevant
  → 8 memories injected

Turn 2: User asks about Armada quirks
  → SuperGemma evaluates Turn 1's 8 memories: 3 were relevant
  → Turn 1's <ambient_recall> pruned to 3 memories (5 removed)
  → 20 new candidates retrieved
  → SuperGemma selects 5 relevant
  → 5 new memories injected

Turn 3: Topic shifts to daemon architecture
  → SuperGemma detects drift (100% accuracy)
  → Turn 1's remaining 3 memories: 0 still relevant → removed entirely
  → Turn 2's 5 memories: 1 still relevant → pruned to 1
  → 20 new candidates retrieved (daemon-related)
  → SuperGemma selects 6 relevant
  → 6 new memories injected

Result: By Turn 3, only 7 memories exist in the message history
  (1 from Turn 2 + 6 from Turn 3). All relevant. Zero noise.
  Context window savings: ~13 pruned memories × ~50 tokens = ~650 tokens reclaimed.
```

## System Prompt Classifier Prompt

```
SYSTEM: You classify memory relevance for an AI assistant's context system.
Answer with ONLY a JSON array of numbers. If nothing is relevant, output [].

Examples:
Context: "LED debugging" | 1. LED specs 2. malware cleanup 3. CPU load → [1, 3]
Context: "weather outside" | 1. CPU data 2. auth system 3. DNS config → []
```

**Parameters:**
- `think: false` (CRITICAL — model scores 0% without this)
- `temperature: 0.0` (deterministic, no accuracy loss)
- `num_predict: 50` (enough for JSON array, not enough for verbose output)

## Token Budget

- Retroactive evaluation: ~200 tokens input (past recall + conversation summary), ~20 tokens output
- New classification: ~300 tokens input (candidates + context), ~20 tokens output
- Net context savings per turn: 50-500 tokens (pruned irrelevant memories)
- By turn 5+: net positive — pruning saves more than classification costs

## Implementation Location

All in `proxy/proxy.py`. No KG server changes needed. The proxy already:
- Has per-conversation state (`_conv_state`, `_conv_turns`)
- Does `copy.deepcopy(body)` on the message body
- Can modify any message in the history
- Has access to Ollama for SuperGemma calls
- Logs per-turn decisions to JSONL

New additions:
- `evaluate_past_recall(block, conversation)` — SuperGemma call for retroactive eval
- `prune_message_history(messages)` — strip irrelevant past recalls
- `classify_candidates(candidates, context)` — SuperGemma call for new candidates
- Config: `AMBIENT_CLASSIFIER_MODEL`, `AMBIENT_CLASSIFIER_ENABLED`

## Open Questions

1. **Should pruning happen every turn or every N turns?** Every turn is most accurate but adds ~900ms. Every 3 turns saves latency but allows noise accumulation.
2. **Should pruned memories be logged?** Yes — the JSONL log should record what was pruned and why, for tuning the classifier.
3. **Memory pinning:** Should the user/model be able to say "keep this memory" to prevent pruning? Useful for session-long reference context.
4. **Classifier fallback:** If SuperGemma/Ollama is down, fall back to V2 behavior (inject all, no pruning). Best-effort augmentation, never a point of failure.
