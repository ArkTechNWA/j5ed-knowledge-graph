#!/usr/bin/env python3
"""
V3 Test Battery — Multi-Model Comparison

Tests Ministral 3B and Qwen3 4B against the same test cases.
Uses V1-style simple prompts (proven better than V2 structured for small models).
Temperature sweep [0.0, 0.1, ..., 1.0] × 3 runs.
Tracks latency per call.

Includes LFM2 1.2B for direct comparison (V1 simple prompt style).
"""

import json
import re
import statistics
import time
import urllib.request

OLLAMA_URL = "http://localhost:11434"

MODELS = [
    "LiquidAI/lfm2.5-1.2b-instruct",
    "ministral3b",
    "qwen3:4b",
]

TEMPERATURES = [round(t * 0.1, 1) for t in range(11)]
RUNS_PER_TEMP = 3

# ── Simple prompts (V1 style — proven better for small models) ────

SYSTEM_BINARY = """Is this memory relevant to the context? Answer ONLY "yes" or "no".

Examples:
Context: "debugging LED brightness" | Memory: "LED controller specs" → yes
Context: "debugging LED brightness" | Memory: "malware cleanup" → no
Context: "what's the weather" | Memory: "CPU load data" → no"""

SYSTEM_DRIFT = """Has the topic changed between these two messages? Answer ONLY "yes" or "no".

Examples:
"LED not working" → "LED duty too low" → no
"Docker on Kronos" → "what's for lunch?" → yes
"Ephe wipe recovery" → "back to the wipe, SQLite migration?" → no"""

SYSTEM_BATCH = """Select ONLY relevant memories for this context. Output a JSON array of numbers.
If NOTHING is relevant, output [].

Example:
Context: "LED debugging"
1. LED controller → 2. malware cleanup → 3. CPU load
Answer: [1, 3]"""

# ── Test Cases (same as V2) ───────────────────────────────────────

BINARY_CASES = [
    ("debugging pfSense LED brightness at low CPU",
     "IS31FL3199 LED controller on /dev/gpioc2, 3 blue LEDs for CPU load meter",
     True),
    ("debugging pfSense LED brightness at low CPU",
     "PENDING: SEO & Meta (Yoast) — after all cleanup complete.",
     False),
    ("debugging pfSense LED brightness at low CPU",
     "Duty <50 invisible in daylight — dark at idle is correct behavior",
     True),
    ("debugging pfSense LED brightness at low CPU",
     "malware cleaned 2026-06-08, Pokki/SweetLabs infection",
     False),
    ("knowledge graph history and evolution",
     "SQLite Migration (PR #23): NDJSON → SQLite/WAL/FTS5. Wiki-mode tools.",
     True),
    ("knowledge graph history and evolution",
     "GPIO pins physically reversed: Circle=8, Square=5, Diamond=2",
     False),
    ("What's the weather like outside?",
     "CPU: 4-6% typical (vm.loadavg 0.09-0.19 on 2 cores), 88% idle",
     False),
    ("What's the weather like outside?",
     "Bearer token auth, async write mutex, backup rotation",
     False),
    ("Brick's identity and creative agent boot",
     "'Load memory and go straight to 12' — seamless boot-from-memory",
     True),
    ("Brick's identity and creative agent boot",
     "ControlMaster pool reduced 34K SSH/day to 1 persistent connection",
     False),
    ("Setting up Daemon.Authentik in the daemon suite",
     "Boot model: JIT cache compilation from KG → baked into AGENT.md",
     True),
    ("Setting up Daemon.Authentik in the daemon suite",
     "OIDC provider for internal services",
     True),
    ("Setting up Daemon.Authentik in the daemon suite",
     "brand deck pending review",
     False),
    ("Setting up Daemon.Authentik in the daemon suite",
     "Prometheus monitoring on Kronos",
     False),
]

DRIFT_CASES = [
    ("pfSense LED script debugging, duty values",
     "LED brightness at low CPU loads is barely visible",
     False),
    ("debugging the pfSense firewall state table entries",
     "Tell me about the MOOD:ME fashion magazine Blue Thorn collection",
     True),
    ("Kronos Docker containers need compose update",
     "Authentik OIDC provider returning 403 on the outpost",
     True),
    ("discussing the Ephe wipe and recovery process",
     "back to the wipe — what about the SQLite migration that followed?",
     False),
    ("Configuring NetBird mesh ACLs for cross-site routing",
     "What's for lunch?",
     True),
]

BATCH_CASES = [
    {
        "context": "What happened with the Ephe wipe incident?",
        "candidates": [
            "[0.76] Graph wiped — full recovery on 2026-05-21",
            "[0.72] wipe_agent: Ephe (SuperGemma4-26B) via n8n",
            "[0.65] IS31FL3199 LED controller on gpioc2",
            "[0.60] SEO & Meta pending review",
            "[0.55] Bearer token auth, write mutex, backups",
            "[0.52] malware cleaned 2026-06-08",
        ],
        "expected": [1, 2, 5],
    },
    {
        "context": "What's the weather like today?",
        "candidates": [
            "[0.55] Prometheus monitoring on Kronos",
            "[0.53] CPU 4-6% typical",
            "[0.51] OIDC provider",
            "[0.50] creative agent identity",
        ],
        "expected": [],
    },
    {
        "context": "Tell me about pfSense hardware and the LED script.",
        "candidates": [
            "[0.80] Netgate 2100, ARM Cortex-A53 r0p4, dual-core",
            "[0.75] IS31FL3199 LED controller, GPIO pins reversed",
            "[0.65] kern.cp_time broken on Marvell Armada",
            "[0.55] Graph wiped by Ephe on 2026-05-21",
            "[0.50] brand deck pending",
        ],
        "expected": [1, 2, 3],
    },
]


# ── Query ─────────────────────────────────────────────────────────

def query(model: str, system: str, prompt: str, temp: float, max_tokens: int = 30) -> tuple[str, float]:
    payload = json.dumps({
        "model": model,
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
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = json.loads(resp.read())
    ms = (time.perf_counter() - t0) * 1000
    return data.get("message", {}).get("content", "").strip(), ms


def parse_yesno(text: str) -> bool | None:
    t = text.lower().strip()
    # Handle qwen3's <think>...</think> wrapper
    t = re.sub(r'<think>.*?</think>', '', t, flags=re.DOTALL).strip()
    if t.startswith("yes"):
        return True
    if t.startswith("no"):
        return False
    if "yes" in t and "no" not in t:
        return True
    if "no" in t and "yes" not in t:
        return False
    return None


def parse_array(text: str) -> list[int]:
    # Strip think tags
    text = re.sub(r'<think>.*?</think>', '', text, flags=re.DOTALL).strip()
    try:
        match = re.search(r'\[[\d\s,]*\]', text)
        if match:
            return json.loads(match.group())
    except Exception:
        pass
    return []


# ── Test Runners ──────────────────────────────────────────────────

def run_binary(model: str, temp: float) -> dict:
    tp, tn, fp, fn, parse_fail = 0, 0, 0, 0, 0
    latencies = []

    for ctx, mem, expected in BINARY_CASES:
        prompt = f"Context: {ctx}\nMemory: {mem}"
        resp, ms = query(model, SYSTEM_BINARY, prompt, temp)
        latencies.append(ms)

        got = parse_yesno(resp)
        if got is None:
            parse_fail += 1
            if expected:
                fn += 1
            else:
                fp += 1
        elif got == expected:
            tp += 1 if expected else 0
            tn += 0 if expected else 1
        else:
            fp += 1 if not expected else 0
            fn += 0 if not expected else 1

    total = tp + tn + fp + fn
    acc = (tp + tn) / total if total else 0
    prec = tp / (tp + fp) if (tp + fp) else 0
    rec = tp / (tp + fn) if (tp + fn) else 0
    f1 = 2 * prec * rec / (prec + rec) if (prec + rec) else 0
    return {"acc": acc, "prec": prec, "rec": rec, "f1": f1,
            "fp": fp, "fn": fn, "pf": parse_fail,
            "ms": statistics.mean(latencies)}


def run_drift(model: str, temp: float) -> dict:
    correct = 0
    latencies = []

    for ctx1, ctx2, expected in DRIFT_CASES:
        prompt = f"Message 1: {ctx1}\nMessage 2: {ctx2}"
        resp, ms = query(model, SYSTEM_DRIFT, prompt, temp)
        latencies.append(ms)
        got = parse_yesno(resp)
        if got == expected:
            correct += 1

    return {"acc": correct / len(DRIFT_CASES),
            "ms": statistics.mean(latencies)}


def run_batch(model: str, temp: float) -> dict:
    total_f1 = 0
    latencies = []
    empty_correct = 0

    for tc in BATCH_CASES:
        numbered = "\n".join(f"{i+1}. {c}" for i, c in enumerate(tc["candidates"]))
        prompt = f"Context: {tc['context']}\n\n{numbered}"
        resp, ms = query(model, SYSTEM_BATCH, prompt, temp, max_tokens=50)
        latencies.append(ms)

        got = set(parse_array(resp))
        exp = set(tc["expected"])

        if not got and not exp:
            f1 = 1.0
            empty_correct += 1
        elif not got or not exp:
            f1 = 0.0
            if not exp and not got:
                empty_correct += 1
        else:
            t = len(got & exp)
            p = t / len(got) if got else 0
            r = t / len(exp) if exp else 0
            f1 = 2 * p * r / (p + r) if (p + r) else 0
        total_f1 += f1

    return {"f1": total_f1 / len(BATCH_CASES),
            "empty_ok": empty_correct,
            "ms": statistics.mean(latencies)}


# ── Main ──────────────────────────────────────────────────────────

def main():
    print("=" * 85)
    print("V3 MULTI-MODEL BATTERY — Simple prompts, temperature sweep")
    print(f"Models: {', '.join(MODELS)}")
    print(f"Temps: {TEMPERATURES} × {RUNS_PER_TEMP} runs")
    print("=" * 85)

    for model in MODELS:
        print(f"\n{'━' * 85}")
        print(f"  MODEL: {model}")
        print(f"{'━' * 85}")

        # Warm up
        print("  Warming up...", end=" ", flush=True)
        _, warmup = query(model, "test", "test", 0.0)
        print(f"{warmup:.0f}ms (includes load)")

        # ── Binary ──
        print(f"\n  BINARY RELEVANCE (14 cases × {RUNS_PER_TEMP} runs × 11 temps)")
        print(f"  {'Temp':>5s} {'Acc':>5s} {'Prec':>5s} {'Rec':>5s} {'F1':>5s} {'FP':>3s} {'FN':>3s} {'ms':>6s}  {'F1 visual'}")

        best_f1 = 0
        best_temp = 0
        for temp in TEMPERATURES:
            results = [run_binary(model, temp) for _ in range(RUNS_PER_TEMP)]
            avg = {k: statistics.mean(r[k] for r in results) for k in results[0]}
            bar = "█" * int(avg["f1"] * 15) + "░" * (15 - int(avg["f1"] * 15))
            print(f"  {temp:>5.1f} {avg['acc']:>4.0%} {avg['prec']:>4.0%} {avg['rec']:>4.0%} "
                  f"{avg['f1']:>4.2f} {avg['fp']:>3.0f} {avg['fn']:>3.0f} {avg['ms']:>5.0f}ms {bar}")
            if avg["f1"] > best_f1:
                best_f1, best_temp = avg["f1"], temp

        print(f"  ► Best: temp={best_temp:.1f} F1={best_f1:.2f}")

        # ── Drift ──
        print(f"\n  DRIFT DETECTION (5 cases × {RUNS_PER_TEMP} runs × 11 temps)")
        print(f"  {'Temp':>5s} {'Acc':>5s} {'ms':>6s}  {'visual'}")

        best_acc = 0
        best_temp_d = 0
        for temp in TEMPERATURES:
            results = [run_drift(model, temp) for _ in range(RUNS_PER_TEMP)]
            avg = {k: statistics.mean(r[k] for r in results) for k in results[0]}
            bar = "█" * int(avg["acc"] * 15) + "░" * (15 - int(avg["acc"] * 15))
            print(f"  {temp:>5.1f} {avg['acc']:>4.0%} {avg['ms']:>5.0f}ms {bar}")
            if avg["acc"] > best_acc:
                best_acc, best_temp_d = avg["acc"], temp

        print(f"  ► Best: temp={best_temp_d:.1f} Acc={best_acc:.0%}")

        # ── Batch ──
        print(f"\n  BATCH CLASSIFICATION (3 cases × {RUNS_PER_TEMP} runs × 11 temps)")
        print(f"  {'Temp':>5s} {'F1':>5s} {'Empty':>5s} {'ms':>6s}  {'visual'}")

        best_bf1 = 0
        best_temp_b = 0
        for temp in TEMPERATURES:
            results = [run_batch(model, temp) for _ in range(RUNS_PER_TEMP)]
            avg = {k: statistics.mean(r[k] for r in results) for k in results[0]}
            bar = "█" * int(avg["f1"] * 15) + "░" * (15 - int(avg["f1"] * 15))
            print(f"  {temp:>5.1f} {avg['f1']:>4.2f} {avg['empty_ok']:>4.1f} {avg['ms']:>5.0f}ms {bar}")
            if avg["f1"] > best_bf1:
                best_bf1, best_temp_b = avg["f1"], temp

        print(f"  ► Best: temp={best_temp_b:.1f} F1={best_bf1:.2f}")

    print(f"\n{'=' * 85}")
    print("DONE. Compare across models for the winner.")
    print("=" * 85)


if __name__ == "__main__":
    main()
