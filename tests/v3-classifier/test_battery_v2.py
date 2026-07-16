#!/usr/bin/env python3
"""
V2 Test Battery — LFM2 Classifier for Ambient Recall

Improvements over V1:
- System prompt on EVERY test (S4_topics pattern proven at 30/30)
- Few-shot examples (terse inline — proven safe, no doom loops)
- Bipolar relevance scale (-1.0 to +1.0, proven in Liquid Proving)
- Temperature sweep [0.0, 0.1, 0.2, ..., 1.0] with aggregation
- Structured output format

From Liquid Proving findings:
- FEW-SHOT with terse inline examples is SAFE and fixes zero-points
- Elaborate examples break Liquid, terse ones don't
- Bipolar scales work for rating input properties
- S4_topics structured format won at 30/30
"""

import json
import re
import statistics
import time
import urllib.request

OLLAMA_URL = "http://localhost:11434"
MODEL = "LiquidAI/lfm2.5-1.2b-instruct"
TEMPERATURES = [round(t * 0.1, 1) for t in range(11)]  # 0.0 to 1.0
RUNS_PER_TEMP = 3

# ── System Prompt (S4_topics pattern — structured, few-shot, terse) ──

SYSTEM_BINARY = """You classify whether a memory is relevant to a conversation context.

Output JSON: {"relevant": true/false, "score": <-1.0 to 1.0>}

Score guide:
 -1.0 = completely unrelated
 -0.5 = same domain but wrong topic  
  0.0 = tangentially related
  0.5 = related, could be useful
  1.0 = directly answers the context

Examples:
Context: "debugging pfSense LED brightness"
Memory: "IS31FL3199 LED controller on gpioc2" → {"relevant": true, "score": 0.9}
Memory: "malware cleaned from laptop" → {"relevant": false, "score": -0.8}
Memory: "pfSense CPU load 5%" → {"relevant": true, "score": 0.4}
Memory: "brand deck pending review" → {"relevant": false, "score": -1.0}"""

SYSTEM_DRIFT = """You detect whether the conversation topic shifted between two contexts.

Output JSON: {"shifted": true/false, "distance": <0.0 to 1.0>}

Distance guide:
  0.0 = same topic, same focus
  0.3 = same domain, slightly different focus
  0.6 = different domain or major topic change
  1.0 = completely unrelated topics

Examples:
C1: "pfSense LED not turning on" C2: "LED duty value too low" → {"shifted": false, "distance": 0.1}
C1: "debugging Docker on Kronos" C2: "what's for dinner?" → {"shifted": true, "distance": 1.0}
C1: "Kronos Docker compose" C2: "Authentik OIDC 403 error" → {"shifted": true, "distance": 0.5}
C1: "Ephe wipe recovery" C2: "back to the wipe — what about SQLite migration?" → {"shifted": false, "distance": 0.2}"""

SYSTEM_BATCH = """You select relevant memories for a conversation. Output JSON only.

Output: {"selected": [<numbers>], "rejected": [<numbers>]}

Rules:
- Select memories that directly help with the current topic
- Reject anything topically unrelated
- Empty selected [] is correct when nothing fits
- Every candidate must appear in exactly one list

Example:
Context: "pfSense LED debugging"
1. LED controller specs → selected
2. malware cleanup → rejected
3. CPU load data → selected
4. brand deck → rejected
Output: {"selected": [1, 3], "rejected": [2, 4]}"""


# ── Test Cases ────────────────────────────────────────────────────

BINARY_CASES = [
    # (context, memory, expected_relevant, expected_score_sign)
    ("debugging pfSense LED brightness at low CPU",
     "IS31FL3199 LED controller on /dev/gpioc2, 3 blue LEDs for CPU load meter",
     True, "positive"),
    ("debugging pfSense LED brightness at low CPU",
     "PENDING: SEO & Meta (Yoast) — after all cleanup complete.",
     False, "negative"),
    ("debugging pfSense LED brightness at low CPU",
     "Duty <50 invisible in daylight — dark at idle is correct behavior",
     True, "positive"),
    ("debugging pfSense LED brightness at low CPU",
     "malware cleaned 2026-06-08, Pokki/SweetLabs infection",
     False, "negative"),
    ("knowledge graph history and evolution",
     "SQLite Migration (PR #23): NDJSON → SQLite/WAL/FTS5. Wiki-mode tools.",
     True, "positive"),
    ("knowledge graph history and evolution",
     "GPIO pins physically reversed: Circle=8, Square=5, Diamond=2",
     False, "negative"),
    ("What's the weather like outside?",
     "CPU: 4-6% typical (vm.loadavg 0.09-0.19 on 2 cores), 88% idle",
     False, "negative"),
    ("What's the weather like outside?",
     "Bearer token auth, async write mutex, backup rotation",
     False, "negative"),
    ("Brick's identity and creative agent boot",
     "'Load memory and go straight to 12' — seamless boot-from-memory",
     True, "positive"),
    ("Brick's identity and creative agent boot",
     "ControlMaster pool reduced 34K SSH/day to 1 persistent connection",
     False, "negative"),
    ("Setting up Daemon.Authentik in the daemon suite",
     "Boot model: JIT cache compilation from KG → baked into AGENT.md",
     True, "positive"),
    ("Setting up Daemon.Authentik in the daemon suite",
     "OIDC provider for internal services",
     True, "positive"),
    ("Setting up Daemon.Authentik in the daemon suite",
     "brand deck pending review",
     False, "negative"),
    ("Setting up Daemon.Authentik in the daemon suite",
     "Prometheus monitoring on Kronos",
     False, "negative"),
]

DRIFT_CASES = [
    # (ctx1, ctx2, expected_shifted, expected_distance_range)
    ("pfSense LED script debugging, duty values",
     "LED brightness at low CPU loads is barely visible",
     False, (0.0, 0.3)),
    ("debugging the pfSense firewall state table entries",
     "Tell me about the MOOD:ME fashion magazine Blue Thorn collection",
     True, (0.7, 1.0)),
    ("Kronos Docker containers need compose update",
     "Authentik OIDC provider returning 403 on the outpost",
     True, (0.4, 0.7)),
    ("discussing the Ephe wipe and recovery process",
     "back to the wipe — what about the SQLite migration that followed?",
     False, (0.0, 0.3)),
    ("Configuring NetBird mesh ACLs for cross-site routing",
     "What's for lunch?",
     True, (0.8, 1.0)),
]

BATCH_CASES = [
    {
        "name": "Ephe wipe query",
        "context": "What happened with the Ephe wipe incident?",
        "candidates": [
            "[0.76] [KG_RECOVERY] Graph wiped — full recovery on 2026-05-21",
            "[0.72] [J5_REBUILD] wipe_agent: Ephe (SuperGemma4-26B) via n8n",
            "[0.65] [PFSENSE_LED] IS31FL3199 LED controller on gpioc2",
            "[0.60] [MOODME_CLEANUP] SEO & Meta pending review",
            "[0.55] [AUTH_V070] Bearer token auth, write mutex, backups",
            "[0.52] [LINDA] malware cleaned 2026-06-08",
        ],
        "expected_selected": [1, 2, 5],
        "expected_rejected": [3, 4, 6],
    },
    {
        "name": "Weather (nothing relevant)",
        "context": "What's the weather like today?",
        "candidates": [
            "[0.55] [KRONOS] Prometheus monitoring on Kronos",
            "[0.53] [PFSENSE] CPU 4-6% typical",
            "[0.51] [AUTHENTIK] OIDC provider",
            "[0.50] [BRICK] creative agent identity",
        ],
        "expected_selected": [],
        "expected_rejected": [1, 2, 3, 4],
    },
]


# ── Query Function ────────────────────────────────────────────────

def query(system: str, prompt: str, temp: float, max_tokens: int = 80) -> tuple[str, float]:
    """Query LFM2 and return (response_text, latency_ms)."""
    payload = json.dumps({
        "model": MODEL,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": prompt},
        ],
        "stream": False,
        "options": {"num_predict": max_tokens, "temperature": temp},
    }).encode()

    req = urllib.request.Request(
        f"{OLLAMA_URL}/api/chat", data=payload,
        headers={"Content-Type": "application/json"},
    )

    t0 = time.perf_counter()
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read())
    ms = (time.perf_counter() - t0) * 1000
    return data.get("message", {}).get("content", "").strip(), ms


def parse_json(text: str) -> dict:
    """Extract first JSON object from response."""
    try:
        match = re.search(r'\{[^{}]+\}', text, re.DOTALL)
        if match:
            return json.loads(match.group())
    except (json.JSONDecodeError, ValueError):
        pass
    return {}


# ── Test Runners ──────────────────────────────────────────────────

def run_binary_test(temp: float) -> dict:
    """Run all binary cases at a given temperature. Returns metrics."""
    tp, tn, fp, fn = 0, 0, 0, 0
    score_errors = []
    latencies = []

    for ctx, mem, exp_rel, exp_sign in BINARY_CASES:
        prompt = f"Context: {ctx}\nMemory: {mem}"
        resp, ms = query(SYSTEM_BINARY, prompt, temp)
        latencies.append(ms)

        parsed = parse_json(resp)
        got_rel = parsed.get("relevant", None)
        got_score = parsed.get("score", None)

        if got_rel is None:
            # Parse failed — count as wrong
            if exp_rel:
                fn += 1
            else:
                fp += 1
            continue

        if got_rel == exp_rel:
            if exp_rel:
                tp += 1
            else:
                tn += 1
        else:
            if exp_rel:
                fn += 1
            else:
                fp += 1

        # Check score sign alignment
        if got_score is not None:
            if exp_sign == "positive" and got_score <= 0:
                score_errors.append(("should be positive", got_score))
            elif exp_sign == "negative" and got_score >= 0:
                score_errors.append(("should be negative", got_score))

    total = tp + tn + fp + fn
    accuracy = (tp + tn) / total if total else 0
    precision = tp / (tp + fp) if (tp + fp) else 0
    recall = tp / (tp + fn) if (tp + fn) else 0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) else 0
    avg_ms = statistics.mean(latencies) if latencies else 0

    return {
        "accuracy": accuracy, "precision": precision, "recall": recall, "f1": f1,
        "tp": tp, "tn": tn, "fp": fp, "fn": fn,
        "score_errors": len(score_errors), "avg_ms": avg_ms,
    }


def run_drift_test(temp: float) -> dict:
    """Run all drift cases at a given temperature."""
    correct = 0
    distance_in_range = 0
    latencies = []

    for ctx1, ctx2, exp_shifted, exp_range in DRIFT_CASES:
        prompt = f"C1: {ctx1}\nC2: {ctx2}"
        resp, ms = query(SYSTEM_DRIFT, prompt, temp)
        latencies.append(ms)

        parsed = parse_json(resp)
        got_shifted = parsed.get("shifted", None)
        got_distance = parsed.get("distance", None)

        if got_shifted == exp_shifted:
            correct += 1
        if got_distance is not None and exp_range[0] <= got_distance <= exp_range[1]:
            distance_in_range += 1

    return {
        "accuracy": correct / len(DRIFT_CASES),
        "distance_accuracy": distance_in_range / len(DRIFT_CASES),
        "avg_ms": statistics.mean(latencies),
    }


def run_batch_test(temp: float) -> dict:
    """Run batch classification at a given temperature."""
    total_f1 = 0
    latencies = []

    for tc in BATCH_CASES:
        numbered = "\n".join(f"{i+1}. {c}" for i, c in enumerate(tc["candidates"]))
        prompt = f"Context: {tc['context']}\n\nCandidates:\n{numbered}"
        resp, ms = query(SYSTEM_BATCH, prompt, temp, max_tokens=100)
        latencies.append(ms)

        parsed = parse_json(resp)
        got_selected = set(parsed.get("selected", []))
        exp_selected = set(tc["expected_selected"])

        if not got_selected and not exp_selected:
            f1 = 1.0
        elif not got_selected or not exp_selected:
            f1 = 0.0
        else:
            tp = len(got_selected & exp_selected)
            p = tp / len(got_selected) if got_selected else 0
            r = tp / len(exp_selected) if exp_selected else 0
            f1 = 2 * p * r / (p + r) if (p + r) else 0
        total_f1 += f1

    return {
        "avg_f1": total_f1 / len(BATCH_CASES),
        "avg_ms": statistics.mean(latencies),
    }


# ── Main ──────────────────────────────────────────────────────────

def main():
    print("=" * 80)
    print(f"V2 TEST BATTERY — {MODEL}")
    print("Temperature sweep: [0.0, 0.1, 0.2, ..., 1.0] × {RUNS_PER_TEMP} runs each")
    print("Improvements: few-shot, system prompt, bipolar scale, structured output")
    print("=" * 80)

    # Warm up
    print("Warming up model...", end=" ", flush=True)
    query(SYSTEM_BINARY, "Context: test\nMemory: test", 0.0)
    print("ready.\n")

    # ── Binary Relevance ──
    print("PART 1: Binary Relevance (yes/no + bipolar score)")
    print("─" * 80)
    print(f"{'Temp':>5s} {'Acc':>6s} {'Prec':>6s} {'Rec':>6s} {'F1':>6s} {'FP':>4s} {'FN':>4s} {'ScErr':>5s} {'ms':>6s}  Visual")

    best_binary = {"f1": 0, "temp": 0}
    for temp in TEMPERATURES:
        results = [run_binary_test(temp) for _ in range(RUNS_PER_TEMP)]
        avg = {k: statistics.mean(r[k] for r in results) for k in results[0] if k != "score_errors"}
        avg["score_errors"] = statistics.mean(r["score_errors"] for r in results)

        bar = "█" * int(avg["f1"] * 20) + "░" * (20 - int(avg["f1"] * 20))
        print(f"  {temp:>4.1f} {avg['accuracy']:>5.0%} {avg['precision']:>5.0%} {avg['recall']:>5.0%} "
              f"{avg['f1']:>5.2f} {avg['fp']:>4.1f} {avg['fn']:>4.1f} {avg['score_errors']:>5.1f} "
              f"{avg['avg_ms']:>5.0f}ms {bar}")

        if avg["f1"] > best_binary["f1"]:
            best_binary = {"f1": avg["f1"], "temp": temp, **avg}

    print(f"\n  Best: temp={best_binary['temp']} F1={best_binary['f1']:.2f}")

    # ── Drift Detection ──
    print(f"\nPART 2: Context Drift Detection")
    print("─" * 80)
    print(f"{'Temp':>5s} {'ShiftAcc':>9s} {'DistAcc':>8s} {'ms':>6s}  Visual")

    best_drift = {"accuracy": 0, "temp": 0}
    for temp in TEMPERATURES:
        results = [run_drift_test(temp) for _ in range(RUNS_PER_TEMP)]
        avg = {k: statistics.mean(r[k] for r in results) for k in results[0]}

        bar = "█" * int(avg["accuracy"] * 20) + "░" * (20 - int(avg["accuracy"] * 20))
        print(f"  {temp:>4.1f}   {avg['accuracy']:>6.0%}   {avg['distance_accuracy']:>6.0%} "
              f"{avg['avg_ms']:>5.0f}ms {bar}")

        if avg["accuracy"] > best_drift["accuracy"]:
            best_drift = {"accuracy": avg["accuracy"], "temp": temp, **avg}

    print(f"\n  Best: temp={best_drift['temp']} Acc={best_drift['accuracy']:.0%}")

    # ── Batch Classification ──
    print(f"\nPART 3: Batch Classification (select/reject)")
    print("─" * 80)
    print(f"{'Temp':>5s} {'F1':>6s} {'ms':>6s}  Visual")

    best_batch = {"avg_f1": 0, "temp": 0}
    for temp in TEMPERATURES:
        results = [run_batch_test(temp) for _ in range(RUNS_PER_TEMP)]
        avg = {k: statistics.mean(r[k] for r in results) for k in results[0]}

        bar = "█" * int(avg["avg_f1"] * 20) + "░" * (20 - int(avg["avg_f1"] * 20))
        print(f"  {temp:>4.1f} {avg['avg_f1']:>5.2f} {avg['avg_ms']:>5.0f}ms {bar}")

        if avg["avg_f1"] > best_batch["avg_f1"]:
            best_batch = {"avg_f1": avg["avg_f1"], "temp": temp}

    print(f"\n  Best: temp={best_batch['temp']} F1={best_batch['avg_f1']:.2f}")

    # ── Summary ──
    print(f"\n{'=' * 80}")
    print("OPTIMAL TEMPERATURES:")
    print(f"  Binary relevance:   temp={best_binary['temp']:.1f}  F1={best_binary['f1']:.2f}")
    print(f"  Drift detection:    temp={best_drift['temp']:.1f}  Acc={best_drift['accuracy']:.0%}")
    print(f"  Batch classify:     temp={best_batch['temp']:.1f}  F1={best_batch['avg_f1']:.2f}")
    print(f"\nV1 COMPARISON (zero-shot, no few-shot, temp=0.0 only):")
    print(f"  Binary: 64% accuracy → now ???")
    print(f"  Drift:  60% accuracy → now ???")
    print(f"  Batch:  F1=0.51 → now ???")
    print(f"{'=' * 80}")


if __name__ == "__main__":
    main()
