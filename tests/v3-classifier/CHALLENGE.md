# V3 Classifier Challenge Document

> Testing local LLMs as classifiers for ambient recall context management.
> Created: 2026-07-16

## Goal

Replace dumb heuristics (similarity threshold + token budget) with intelligent
classification: topic drift detection, relevance scoring, abstention ("nothing fits").

## Models Tested

| Model | Size | Source |
|-------|------|--------|
| LFM2 1.2B instruct | 0.7GB | LiquidAI via Ollama |
| LFM2 1.2B extract | 0.7GB | LiquidAI via Ollama |
| Ministral 3B | 2.1GB | Mistral via Ollama |
| Qwen3 4B | 2.5GB | Qwen via Ollama |
| Gemma 4B | 2.5GB | Google via Ollama |
| SuperGemma-Meral 26B | 16.8GB | 0xIbra uncensored via Ollama |

## Final Results

```
┌──────────────────┬───────┬────────┬────────┬────────┬──────────────────┐
│ Model            │ Size  │Binary  │ Drift  │ Batch  │ Latency          │
│                  │       │ F1     │ Acc    │ F1     │ (per call)       │
├──────────────────┼───────┼────────┼────────┼────────┼──────────────────┤
│ LFM2 1.2B        │ 0.7GB │ 0.50   │  40%   │ 0.67   │  38-90ms        │
│ Ministral 3B  ★  │ 2.1GB │ 0.54   │  87%   │ 0.73   │  82-360ms       │
│ Qwen3 4B         │ 2.5GB │ 0.00   │   0%   │ 0.33   │ 276-438ms       │
│ Gemma 4B         │ 2.5GB │  —     │   —    │  —     │ 253-452ms       │
│ SuperGemma 26B   │  17GB │ 0.00   │   0%   │ 0.33   │ 1500-2500ms     │
└──────────────────┴───────┴────────┴────────┴────────┴──────────────────┘
```

★ Ministral 3B is the winner. Best temp: 0.7-0.8.

## Key Findings

### 1. Bigger ≠ Better for classification

Qwen3 4B and SuperGemma 26B scored 0% on binary and drift detection.
Both generate verbose output (thinking tags, explanations, caveats) that
exceeds `num_predict` before producing the actual yes/no answer.

**Classification needs instruction following, not raw intelligence.**
A model that says "yes" in 1 token beats a model that writes a paragraph.

### 2. Temperature matters for Ministral, not for LFM2

LFM2: <5% variation across 0.0-1.0. Logits too flat at 1.2B.
Ministral: 0% at temp=0.0, 87% at temp=0.8. Needs warmth to perform.

### 3. The "yes" bias is structural at 1.2B

LFM2 has 100% recall (never misses relevant) but 50-55% precision
(always over-selects). This held across ALL prompt variations:
- Zero-shot, few-shot, structured output, bipolar scale
- V1 simple prompts, V2 complex prompts
- All 11 temperature levels

Few-shot examples did NOT fix it. Bipolar scales did NOT fix it.
Temperature variation did NOT fix it. It's a capacity limit.

### 4. V2 prompts (structured output) made things WORSE

| Task | V1 (simple) | V2 (structured) |
|------|-------------|-----------------|
| Binary | 64% | 64% (same) |
| Drift | 60% | 47% (worse) |
| Batch | F1=0.51 | F1=0.32 (much worse) |

More structure = more ways to fail for small models.

### 5. LFM2 hard limits (confirmed across 715+ calls)

- Cannot self-assess confidence (pegs to 0.92-0.98)
- Cannot say "no" / abstain (binary test: 5-6 false positives always)
- Cannot detect topic shifts (40% flat, inverted on obvious drifts)
- Context threshold: needs ~129 words to activate, binary off/on behavior

## Test Battery

| File | What it tests |
|------|---------------|
| `test_latency.py` | Raw inference speed across context sizes |
| `test_relevance.py` | V1 classification accuracy (zero-shot) |
| `test_context_scaling.py` | Quality vs context length |
| `test_adjacent_assessment.py` | Reframed binary/drift/activation |
| `test_battery_v2.py` | Few-shot + bipolar + temp sweep (LFM2) |
| `test_battery_v3_multimodel.py` | LFM2 vs Ministral vs Qwen3 |
| `test_battery_supergemma.py` | SuperGemma-Meral 26B |

## Paths Forward

### A. Use Ministral 3B as the V3 classifier
- Binary: 82ms, drift: 87% at temp=0.8
- Batch latency (300ms) acceptable if run once per turn
- Could pipeline: embed kNN (10ms) → Ministral classify (85ms) = ~100ms

### B. Fine-tune LFM2 on binary classification
- Speed is unbeatable (38ms)
- Collect classification logs from real usage (JSONL exists)
- Train on binary relevant/not-relevant per candidate
- Sidestep abstention (handle at aggregation layer)

### C. Skip LLM classification entirely
- Topic clustering via embedding centroids
- Decay heuristics (turn distance, topic drift distance)
- Score distribution analysis (if top < τ AND no outlier → inject nothing)
- Zero inference cost. Deterministic. No model dependency.
- The embedding already IS a classifier — just refine scoring.

### D. Hybrid
- Embedding kNN for candidates
- LFM2 as fast pre-filter (drop obvious noise)
- Ministral for borderline cases only (triggered when score spread is ambiguous)
