# V3 Classifier Tests

Benchmarks for using a local LLM (LiquidAI LFM2 via Ollama) as an ambient recall classifier.

## Purpose

Test whether a small local model can make better relevance decisions than
cosine similarity alone. The classifier sees candidate memories + conversation
context and decides which memories to inject.

## Tests

1. `test_latency.py` — Raw inference speed across context sizes
2. `test_relevance.py` — Classification accuracy on curated test cases
3. `test_context_scaling.py` — How quality/latency changes with more/less context

## Models Under Test

- `LiquidAI/lfm2.5-1.2b-instruct` (0.7GB) — primary candidate
- `hf.co/LiquidAI/LFM2-1.2B-Extract-GGUF` (0.7GB) — extraction variant
- `ministral3b` (2.1GB) — comparison baseline
- `gemma4b` (2.5GB) — comparison baseline

## Running

```bash
cd tests/v3-classifier
python3 test_latency.py
python3 test_relevance.py
python3 test_context_scaling.py
```
