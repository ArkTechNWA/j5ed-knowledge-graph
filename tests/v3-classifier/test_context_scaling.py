#!/usr/bin/env python3
"""
Test 3: How classification quality and latency change with context size.

Tests the same query with increasing amounts of conversation history
to find the sweet spot between context richness and performance.
"""

import json
import time
import urllib.request

OLLAMA_URL = "http://localhost:11434"
MODEL = "LiquidAI/lfm2.5-1.2b-instruct"

SYSTEM = """You are a memory relevance classifier. Given conversation context and candidate memories, output ONLY a JSON array of relevant candidate numbers. No explanation."""

CANDIDATES = [
    "[0.76] [KG_RECOVERY] Graph wiped — full recovery effort on 2026-05-21",
    "[0.72] [J5_REBUILD] wipe_agent: Ephe (SuperGemma4-26B) via n8n",
    "[0.65] [PFSENSE_LED] IS31FL3199 LED controller on /dev/gpioc2",
    "[0.60] [MOODME_CLEANUP] PENDING: SEO & Meta cleanup",
    "[0.55] [AUTH_V070] Bearer token auth, async write mutex, backup rotation",
    "[0.52] [LINDA_LAPTOP] malware cleaned 2026-06-08",
]

EXPECTED = [1, 2, 5]  # KG recovery, wipe agent, auth (driven by the wipe)

# Progressively longer context about the same topic
CONTEXT_LEVELS = [
    {
        "name": "1 turn (query only)",
        "text": "User: What do you know about the Ephe wipe?",
    },
    {
        "name": "2 turns",
        "text": """User: What do you know about the Ephe wipe?
Assistant: The knowledge graph was wiped on 2026-05-21.""",
    },
    {
        "name": "4 turns",
        "text": """User: What do you know about the Ephe wipe?
Assistant: The knowledge graph was wiped on 2026-05-21 by Ephe, a SuperGemma4-26B agent.
User: How was it recovered?
Assistant: From a Docker shadow copy. 616 entities condensed to 221 during rebuild.""",
    },
    {
        "name": "6 turns",
        "text": """User: What do you know about the Ephe wipe?
Assistant: The knowledge graph was wiped on 2026-05-21 by Ephe, a SuperGemma4-26B agent.
User: How was it recovered?
Assistant: From a Docker shadow copy at ~/.claude-docker/knowledge-graph/memory.json.
User: What changed after that?
Assistant: Auth was added in v0.7.0 — bearer tokens, write mutex, backup rotation. The architecture evolved significantly.""",
    },
    {
        "name": "8 turns",
        "text": """User: What do you know about the Ephe wipe?
Assistant: The knowledge graph was wiped on 2026-05-21 by Ephe, a SuperGemma4-26B agent running via n8n from Kronos.
User: How was it recovered?
Assistant: From a Docker shadow copy at ~/.claude-docker/knowledge-graph/memory.json — a January 2026 pre-taxonomy snapshot.
User: What changed after that?
Assistant: Auth was added in v0.7.0 — bearer tokens, write mutex, backup rotation. The Ephe wipe proved agents must be isolated by default.
User: Tell me about the SQLite migration.
Assistant: PR #23 — NDJSON replaced with SQLite, WAL mode, FTS5 full-text search, wiki-mode tools like supersede and entity_history.""",
    },
    {
        "name": "10 turns + noise",
        "text": """User: What do you know about the Ephe wipe?
Assistant: The knowledge graph was wiped on 2026-05-21 by Ephe, a SuperGemma4-26B agent running via n8n from Kronos.
User: How was it recovered?
Assistant: From a Docker shadow copy at ~/.claude-docker/knowledge-graph/memory.json — a January 2026 pre-taxonomy snapshot.
User: What changed after that?
Assistant: Auth was added in v0.7.0 — bearer tokens, write mutex, backup rotation. The Ephe wipe proved agents must be isolated by default.
User: By the way, what's the pfSense CPU load at?
Assistant: About 5% on the dual-core ARM Cortex-A53. The LED is barely visible.
User: OK back to the wipe — tell me about the SQLite migration.
Assistant: PR #23 — NDJSON replaced with SQLite, WAL mode, FTS5 full-text search, wiki-mode tools like supersede and entity_history.""",
    },
]


def classify(context: str) -> tuple[list[int], float]:
    """Run classifier, return (selection, latency_ms)."""
    import re
    numbered = "\n".join(f"{i+1}. {c}" for i, c in enumerate(CANDIDATES))
    prompt = f"<context>\n{context}\n</context>\n\nCandidates:\n{numbered}\n\nSelect relevant candidates:"

    payload = json.dumps({
        "model": MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": prompt},
        ],
        "stream": False,
        "options": {"num_predict": 50, "temperature": 0.0},
    }).encode()

    req = urllib.request.Request(
        f"{OLLAMA_URL}/api/chat",
        data=payload,
        headers={"Content-Type": "application/json"},
    )

    t0 = time.perf_counter()
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read())
    latency = (time.perf_counter() - t0) * 1000

    response = data.get("message", {}).get("content", "").strip()
    try:
        match = re.search(r'\[[\d\s,]*\]', response)
        return json.loads(match.group()) if match else [], latency
    except Exception:
        return [], latency


def f1(predicted: list[int], expected: list[int]) -> float:
    pred, exp = set(predicted), set(expected)
    if not pred and not exp:
        return 1.0
    tp = len(pred & exp)
    p = tp / len(pred) if pred else 0
    r = tp / len(exp) if exp else 0
    return 2 * p * r / (p + r) if (p + r) else 0


def main():
    print("=" * 70)
    print(f"CONTEXT SCALING TEST — {MODEL}")
    print("=" * 70)
    print(f"Expected selection: {EXPECTED}")
    print(f"Candidates: {len(CANDIDATES)}")

    # Warm up
    print("Warming up...", flush=True)
    classify("test")

    print(f"\n{'Context':<25s} {'Words':>5s} {'Latency':>8s} {'F1':>6s} {'Selection'}")
    print("─" * 70)

    for level in CONTEXT_LEVELS:
        results = []
        for _ in range(3):
            selected, latency = classify(level["text"])
            results.append((selected, latency))

        # Use best F1 result
        best = max(results, key=lambda r: f1(r[0], EXPECTED))
        avg_latency = sum(r[1] for r in results) / len(results)
        words = len(level["text"].split())
        score = f1(best[0], EXPECTED)

        bar = "█" * int(score * 10) + "░" * (10 - int(score * 10))
        print(f"  {level['name']:<23s} {words:>5d} {avg_latency:>7.0f}ms {score:>5.2f} {bar} {best[0]}")

    print(f"\n{'=' * 70}")
    print("Look for: sweet spot where F1 is high and latency is acceptable (<100ms)")
    print("=" * 70)


if __name__ == "__main__":
    main()
