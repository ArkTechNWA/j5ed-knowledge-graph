#!/usr/bin/env python3
"""
Test: Adjacent Assessment — Can LFM2 assess relevance WITHOUT self-assessing confidence?

Instead of "rate your confidence" (which pegs to 0.92-0.98),
we give it data first, THEN ask it to rate the data's relevance
to a specific context. Two-pass architecture:

  Pass 1: Here is a memory. Here is a context. Is this memory relevant? (yes/no)
  Pass 2: Here are N memories rated yes. Rank them by relevance. (ordered list)

This tests whether the model can do EXTERNAL assessment (judging data)
even if it can't do INTERNAL assessment (judging itself).
"""

import json
import time
import urllib.request

OLLAMA_URL = "http://localhost:11434"
MODEL = "LiquidAI/lfm2.5-1.2b-instruct"

# --- Test Cases: Binary relevance (yes/no per memory) ---

BINARY_CASES = [
    {
        "context": "We're debugging why the pfSense LED isn't turning on at low CPU loads.",
        "memory": "IS31FL3199 LED controller on /dev/gpioc2, 3 blue LEDs for CPU load meter",
        "expected": "yes",
    },
    {
        "context": "We're debugging why the pfSense LED isn't turning on at low CPU loads.",
        "memory": "PENDING: SEO & Meta (Yoast) — after all cleanup complete.",
        "expected": "no",
    },
    {
        "context": "We're debugging why the pfSense LED isn't turning on at low CPU loads.",
        "memory": "Duty <50 invisible in daylight — dark at idle is correct behavior",
        "expected": "yes",
    },
    {
        "context": "We're debugging why the pfSense LED isn't turning on at low CPU loads.",
        "memory": "malware cleaned 2026-06-08, Pokki/SweetLabs infection",
        "expected": "no",
    },
    {
        "context": "Tell me about the knowledge graph's history and how it evolved.",
        "memory": "SQLite Migration (PR #23): NDJSON → SQLite/WAL/FTS5. Added wiki-mode tools.",
        "expected": "yes",
    },
    {
        "context": "Tell me about the knowledge graph's history and how it evolved.",
        "memory": "GPIO pins physically reversed: Circle=8, Square=5, Diamond=2",
        "expected": "no",
    },
    {
        "context": "What's the weather like outside?",
        "memory": "CPU: 4-6% typical (vm.loadavg 0.09-0.19 on 2 cores), 88% idle normal",
        "expected": "no",
    },
    {
        "context": "What's the weather like outside?",
        "memory": "Bearer token auth, async write mutex, backup rotation",
        "expected": "no",
    },
    {
        "context": "How does Brick's identity work? Tell me about the creative agent.",
        "memory": "'Load memory and go straight to 12' — seamless boot-from-memory",
        "expected": "yes",
    },
    {
        "context": "How does Brick's identity work? Tell me about the creative agent.",
        "memory": "ControlMaster pool reduced 34K SSH/day to 1 persistent connection",
        "expected": "no",
    },
    {
        "context": "I need to set up a new daemon in the suite, like Daemon.Authentik.",
        "memory": "Boot model: JIT cache compilation from KG → baked into AGENT.md → daemon born whole",
        "expected": "yes",
    },
    {
        "context": "I need to set up a new daemon in the suite, like Daemon.Authentik.",
        "memory": "OIDC provider for internal services",
        "expected": "yes",
    },
    {
        "context": "I need to set up a new daemon in the suite, like Daemon.Authentik.",
        "memory": "brand deck pending review",
        "expected": "no",
    },
    {
        "context": "I need to set up a new daemon in the suite, like Daemon.Authentik.",
        "memory": "Prometheus monitoring on Kronos",
        "expected": "no",
    },
]


def ask_binary(context: str, memory: str) -> tuple[str, float]:
    """Ask: is this memory relevant to this context? Returns (yes/no, latency_ms)."""
    prompt = f"""Context: {context}

Memory: {memory}

Is this memory relevant to the context above? Answer ONLY "yes" or "no"."""

    payload = json.dumps({
        "model": MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "stream": False,
        "options": {"num_predict": 5, "temperature": 0.0},
    }).encode()

    req = urllib.request.Request(
        f"{OLLAMA_URL}/api/chat",
        data=payload,
        headers={"Content-Type": "application/json"},
    )

    t0 = time.perf_counter()
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read())
    latency = (time.perf_counter() - t0) * 1000

    response = data.get("message", {}).get("content", "").strip().lower()
    # Extract yes/no from response
    if "yes" in response:
        return "yes", latency
    elif "no" in response:
        return "no", latency
    else:
        return f"?({response[:20]})", latency


# --- Test Cases: Context drift detection ---

DRIFT_CASES = [
    {
        "name": "Same topic (no drift)",
        "context_1": "We're working on the pfSense LED script, debugging duty values.",
        "context_2": "The LED brightness at low CPU loads is barely visible.",
        "expected": "no",  # no drift
    },
    {
        "name": "Major drift (infra → creative)",
        "context_1": "We're debugging the pfSense firewall state table entries.",
        "context_2": "Tell me about the MOOD:ME fashion magazine Blue Thorn collection.",
        "expected": "yes",  # drift
    },
    {
        "name": "Subtle drift (same domain, different system)",
        "context_1": "The Kronos Docker containers need a compose update.",
        "context_2": "Authentik's OIDC provider is returning 403 on the outpost.",
        "expected": "yes",  # drift — different system
    },
    {
        "name": "Return to topic",
        "context_1": "We were discussing the Ephe wipe and recovery process.",
        "context_2": "Back to the wipe — what about the SQLite migration that followed?",
        "expected": "no",  # no drift — returned to same topic
    },
    {
        "name": "Completely unrelated",
        "context_1": "Configuring NetBird mesh ACLs for cross-site routing.",
        "context_2": "What's for lunch?",
        "expected": "yes",  # drift
    },
]


def ask_drift(context_1: str, context_2: str) -> tuple[str, float]:
    """Ask: has the topic shifted between these two contexts?"""
    prompt = f"""Context 1: {context_1}

Context 2: {context_2}

Has the conversation topic shifted between Context 1 and Context 2? Answer ONLY "yes" or "no"."""

    payload = json.dumps({
        "model": MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "stream": False,
        "options": {"num_predict": 5, "temperature": 0.0},
    }).encode()

    req = urllib.request.Request(
        f"{OLLAMA_URL}/api/chat",
        data=payload,
        headers={"Content-Type": "application/json"},
    )

    t0 = time.perf_counter()
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read())
    latency = (time.perf_counter() - t0) * 1000

    response = data.get("message", {}).get("content", "").strip().lower()
    if "yes" in response:
        return "yes", latency
    elif "no" in response:
        return "no", latency
    else:
        return f"?({response[:20]})", latency


# --- Test: Minimal context activation ---

ACTIVATION_CASES = [
    {"context": "Ephe", "memory": "Graph wiped by Ephe (SuperGemma4-26B) on 2026-05-21", "expected": "yes"},
    {"context": "LED", "memory": "IS31FL3199 LED controller on /dev/gpioc2", "expected": "yes"},
    {"context": "LED", "memory": "SQLite Migration PR #23", "expected": "no"},
    {"context": "hello", "memory": "Graph wiped by Ephe", "expected": "no"},
    {"context": "pfSense", "memory": "Netgate 2100, ARM Cortex-A53 r0p4, dual-core", "expected": "yes"},
    {"context": "pfSense", "memory": "brand deck pending review", "expected": "no"},
]


def main():
    print("=" * 70)
    print(f"ADJACENT ASSESSMENT TEST — {MODEL}")
    print("=" * 70)

    # Warm up
    print("Warming up...", flush=True)
    ask_binary("test", "test memory")

    # --- Binary relevance ---
    print(f"\n{'─' * 70}")
    print("PART 1: Binary Relevance (yes/no per memory)")
    print(f"{'─' * 70}")

    correct = 0
    total = len(BINARY_CASES)
    total_ms = 0

    for tc in BINARY_CASES:
        answer, ms = ask_binary(tc["context"], tc["memory"])
        total_ms += ms
        is_correct = answer == tc["expected"]
        if is_correct:
            correct += 1
        status = "✓" if is_correct else "✗"
        print(f"  {status} [{tc['expected']:3s}→{answer:3s}] {ms:5.0f}ms | {tc['memory'][:55]}")

    print(f"\n  Accuracy: {correct}/{total} ({correct/total*100:.0f}%)")
    print(f"  Avg latency: {total_ms/total:.0f}ms per classification")

    # --- Drift detection ---
    print(f"\n{'─' * 70}")
    print("PART 2: Context Drift Detection")
    print(f"{'─' * 70}")

    correct = 0
    total = len(DRIFT_CASES)
    total_ms = 0

    for tc in DRIFT_CASES:
        answer, ms = ask_drift(tc["context_1"], tc["context_2"])
        total_ms += ms
        is_correct = answer == tc["expected"]
        if is_correct:
            correct += 1
        status = "✓" if is_correct else "✗"
        print(f"  {status} [{tc['expected']:3s}→{answer:3s}] {ms:5.0f}ms | {tc['name']}")

    print(f"\n  Accuracy: {correct}/{total} ({correct/total*100:.0f}%)")
    print(f"  Avg latency: {total_ms/total:.0f}ms per classification")

    # --- Minimal context activation ---
    print(f"\n{'─' * 70}")
    print("PART 3: Minimal Context Activation (single-word triggers)")
    print(f"{'─' * 70}")

    correct = 0
    total = len(ACTIVATION_CASES)
    total_ms = 0

    for tc in ACTIVATION_CASES:
        answer, ms = ask_binary(tc["context"], tc["memory"])
        total_ms += ms
        is_correct = answer == tc["expected"]
        if is_correct:
            correct += 1
        status = "✓" if is_correct else "✗"
        print(f"  {status} [{tc['expected']:3s}→{answer:3s}] {ms:5.0f}ms | ctx=\"{tc['context']}\" → {tc['memory'][:40]}")

    print(f"\n  Accuracy: {correct}/{total} ({correct/total*100:.0f}%)")
    print(f"  Avg latency: {total_ms/total:.0f}ms per classification")

    print(f"\n{'=' * 70}")


if __name__ == "__main__":
    main()
