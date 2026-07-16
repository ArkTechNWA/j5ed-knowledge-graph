#!/usr/bin/env python3
"""
Test 1: Raw inference latency across models and context sizes.

Measures how fast each model responds with varying input lengths.
The classifier needs to respond in <100ms to not add noticeable latency.
"""

import json
import time
import urllib.request

OLLAMA_URL = "http://localhost:11434"

MODELS = [
    "LiquidAI/lfm2.5-1.2b-instruct",
    "hf.co/LiquidAI/LFM2-1.2B-Extract-GGUF",
    "ministral3b",
    "gemma4b",
]

# Classifier prompt template
SYSTEM = """You are a memory relevance classifier. Given a conversation context and candidate memories, output ONLY a JSON array of the relevant candidate numbers. No explanation.

Example: [1, 3, 5]"""

# Context sizes to test (simulating different amounts of conversation history)
CONTEXTS = {
    "minimal": "User asks about pfSense LED configuration.",
    "short": """User: What do you know about the Ephe wipe?
Assistant: I recall the knowledge graph was wiped on 2026-05-21.""",
    "medium": """User: What do you know about the Ephe wipe?
Assistant: I recall the knowledge graph was wiped on 2026-05-21. The recovery involved...
User: How was it recovered?
Assistant: From a Docker shadow copy at ~/.claude-docker/knowledge-graph/memory.json.
User: What changed after that?""",
    "long": """User: What do you know about the Ephe wipe?
Assistant: The knowledge graph was wiped on 2026-05-21 by Ephe (SuperGemma4-26B) via n8n.
User: How was it recovered?
Assistant: From a Docker shadow copy. 616 entities recovered, condensed to 221 during rebuild.
User: What changed architecturally after that?
Assistant: Auth was added (v0.7.0), write mutex for concurrency safety, backup rotation.
User: Tell me about the SQLite migration.
Assistant: PR #23 — the biggest change. NDJSON replaced with SQLite, WAL mode, FTS5, wiki tools.
User: What about the public release?
Assistant: v1.0.0 on npm, OpenSSF Scorecard 5.0, 80 tests. Personal data stripped.""",
}

CANDIDATES = """Candidates:
1. [0.74] [KNOWLEDGE_GRAPH_RECOVERY] Graph wiped — full recovery effort on 2026-05-21
2. [0.68] [BRICK_IDENTITY] 'Load memory and go straight to 12' — seamless boot
3. [0.65] [WINCHESTER_AUDIT] ghost cleanup session on Kronos
4. [0.62] [J5_GRAPH_REBUILD_VICTORY] wipe_agent: Ephe (SuperGemma4-26B) via n8n
5. [0.58] [NVIROCLEAN_DECK] brand deck pending review
6. [0.55] [PFSENSE_LED_HARDWARE] IS31FL3199 LED controller on /dev/gpioc2
7. [0.53] [LINDA_LAPTOP] malware cleaned 2026-06-08
8. [0.51] [AUTH_WRITE_SAFETY_V070] Bearer token auth, async write mutex"""


def query_model(model: str, context: str, max_tokens: int = 50) -> tuple[str, float]:
    """Query Ollama and return (response, latency_ms)."""
    prompt = f"<context>\n{context}\n</context>\n\n{CANDIDATES}\n\nSelect relevant candidates:"

    payload = json.dumps({
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": prompt},
        ],
        "stream": False,
        "options": {"num_predict": max_tokens, "temperature": 0.0},
    }).encode()

    req = urllib.request.Request(
        f"{OLLAMA_URL}/api/chat",
        data=payload,
        headers={"Content-Type": "application/json"},
    )

    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read())
        latency = (time.perf_counter() - t0) * 1000
        response = data.get("message", {}).get("content", "")
        return response, latency
    except Exception as e:
        latency = (time.perf_counter() - t0) * 1000
        return f"ERROR: {e}", latency


def main():
    print("=" * 70)
    print("LATENCY TEST — Local LLM Classifier for Ambient Recall")
    print("=" * 70)

    for model in MODELS:
        print(f"\n{'─' * 70}")
        print(f"Model: {model}")
        print(f"{'─' * 70}")

        # Warm up (first inference loads the model)
        print("  Warming up...", end=" ", flush=True)
        _, warmup_ms = query_model(model, CONTEXTS["minimal"])
        print(f"{warmup_ms:.0f}ms (includes model load)")

        for ctx_name, ctx_text in CONTEXTS.items():
            times = []
            responses = []
            for _ in range(3):  # 3 runs per context size
                resp, ms = query_model(model, ctx_text)
                times.append(ms)
                responses.append(resp)

            avg = sum(times) / len(times)
            mn = min(times)
            mx = max(times)
            ctx_tokens = len(ctx_text.split())

            print(f"  {ctx_name:10s} ({ctx_tokens:3d} words) | avg={avg:6.0f}ms  min={mn:6.0f}ms  max={mx:6.0f}ms | {responses[0][:60]}")

    print(f"\n{'=' * 70}")
    print("Target: <100ms average for classification to be viable in the proxy")
    print("=" * 70)


if __name__ == "__main__":
    main()
