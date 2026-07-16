#!/usr/bin/env python3
"""
Test 2: Classification accuracy on curated test cases.

Each test case has a conversation context, candidate memories, and
expected relevant selections. Measures precision and recall.
"""

import json
import urllib.request

OLLAMA_URL = "http://localhost:11434"
MODEL = "LiquidAI/lfm2.5-1.2b-instruct"

SYSTEM = """You are a memory relevance classifier for an AI assistant's ambient recall system.

Given a conversation context and numbered candidate memories, select ONLY the memories that are directly relevant to the current conversation topic.

Rules:
- Output ONLY a JSON array of numbers, e.g. [1, 3, 5]
- Select memories that would help the assistant answer or understand the current topic
- Reject memories that are topically unrelated even if they scored high on similarity
- When in doubt, reject — precision over recall
- Empty array [] is valid if nothing is relevant"""

TEST_CASES = [
    {
        "name": "Ephe wipe — direct match",
        "context": "User: What happened with the Ephe wipe?",
        "candidates": [
            "[0.76] [KG_RECOVERY] Graph wiped — full recovery effort on 2026-05-21",
            "[0.72] [J5_REBUILD] wipe_agent: Ephe (SuperGemma4-26B) via n8n from 192.168.4.10",
            "[0.70] [J5_REBUILD] wipe_date: 2026-05-21T06:13:00-05:00",
            "[0.65] [PASS_FOR_LLM] Installed 2026-05-28 after a live incident with pass show",
            "[0.60] [MOODME_CLEANUP] PENDING: SEO & Meta cleanup",
            "[0.58] [LINDA_LAPTOP] malware cleaned 2026-06-08, Pokki/SweetLabs",
            "[0.55] [BLUEHOST] brain.json snapshot lost in bulk wipe",
            "[0.52] [ARKTECHNWA_WEBSITE] session sweep completed in one pass",
        ],
        "expected": [1, 2, 3, 7],  # Recovery, agent, date, bluehost snapshot loss
        "rationale": "1-3 are directly about the wipe. 7 mentions the wipe's impact. 4-6,8 are unrelated.",
    },
    {
        "name": "pfSense LEDs — hardware focus",
        "context": "User: Why is my LED not on? The pfSense CPU should be higher than 10%.",
        "candidates": [
            "[0.82] [PFSENSE_LED] IS31FL3199 LED controller on /dev/gpioc2, 3 blue LEDs",
            "[0.75] [PFSENSE_LED] GPIO pins physically reversed: Circle=8, Square=5, Diamond=2",
            "[0.70] [PFSENSE_LED] Duty <50 invisible in daylight — dark at idle is correct",
            "[0.65] [PFSENSE_HW] kern.cp_time idle counter broken on Marvell Armada",
            "[0.60] [KRONOS_PROMETHEUS] Prometheus monitoring on Kronos",
            "[0.55] [BRICK_IDENTITY] 'Load memory and go straight to 12'",
            "[0.52] [AUTHENTIK_SERVICE] OIDC provider for internal services",
        ],
        "expected": [1, 2, 3, 4],  # LED hardware + Marvell quirk
        "rationale": "1-4 are all pfSense/LED relevant. 5-7 are completely unrelated.",
    },
    {
        "name": "Topic shift — from infra to creative",
        "context": """User: Tell me about the MOOD:ME fashion magazine.
Assistant: I'd need to check the knowledge graph for details on that project.""",
        "candidates": [
            "[0.68] [MOODME_STORE] E-commerce platform for MOOD:ME brand",
            "[0.65] [MOODME_BLUE_THORN] Blue Thorn collection design project",
            "[0.62] [PFSENSE_BASELINE] CPU 4-6% typical, 88% idle",
            "[0.60] [KG_HISTORY] SQLite migration PR #23",
            "[0.58] [MOODME_MODEL_1] Build: Slender",
            "[0.55] [NETBIRD_MESH] peer management and ACL policies",
        ],
        "expected": [1, 2, 5],  # MOODME entities only
        "rationale": "1,2,5 are MOOD:ME related. 3-4,6 are infrastructure noise.",
    },
    {
        "name": "Nothing relevant — cold query",
        "context": "User: What's the weather like today?",
        "candidates": [
            "[0.55] [KRONOS_PROMETHEUS] Prometheus monitoring on Kronos",
            "[0.53] [PFSENSE_BASELINE] CPU 4-6% typical",
            "[0.51] [AUTHENTIK_SERVICE] OIDC provider",
            "[0.50] [BRICK_IDENTITY] creative agent identity",
        ],
        "expected": [],  # Nothing is relevant to weather
        "rationale": "None of these memories relate to weather. Classifier should return empty.",
    },
    {
        "name": "Architecture discussion — selective depth",
        "context": """User: I'm thinking about adding a new daemon to the suite. Like Daemon.Authentik.
Assistant: That would handle SSO, OIDC, LDAP, expression policies.""",
        "candidates": [
            "[0.72] [AUTHENTIK_SERVICE] OIDC provider for internal services",
            "[0.68] [DAEMON_PFSENSE_DESIGN] Boot model: JIT cache compilation from KG",
            "[0.65] [PFSENSE_ACCESS_PATH] SSH via Kronos → quota-daemon → pfSense",
            "[0.62] [KG_DAEMON_INDEX] Domain index for Daemon.KnowledgeGraph",
            "[0.58] [NETBIRD_MESH] peer management and ACL policies",
            "[0.55] [MOODME_STORE] E-commerce platform",
        ],
        "expected": [1, 2, 4],  # Authentik + daemon architecture patterns
        "rationale": "1 is directly relevant (Authentik). 2,4 are daemon architecture patterns useful for designing a new daemon. 3 is pfSense-specific access, not generalizable. 5-6 unrelated.",
    },
]


def classify(context: str, candidates: list[str]) -> list[int]:
    """Run the classifier and parse the response."""
    numbered = "\n".join(f"{i+1}. {c}" for i, c in enumerate(candidates))
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

    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read())

    response = data.get("message", {}).get("content", "").strip()

    # Parse JSON array from response
    try:
        # Find the array in the response (model might add text around it)
        import re
        match = re.search(r'\[[\d\s,]*\]', response)
        if match:
            return json.loads(match.group())
        return []
    except (json.JSONDecodeError, ValueError):
        return []


def score(predicted: list[int], expected: list[int]) -> dict:
    """Calculate precision, recall, F1."""
    pred_set = set(predicted)
    exp_set = set(expected)

    if not pred_set and not exp_set:
        return {"precision": 1.0, "recall": 1.0, "f1": 1.0}
    if not pred_set:
        return {"precision": 0.0, "recall": 0.0, "f1": 0.0}
    if not exp_set:
        return {"precision": 0.0 if pred_set else 1.0, "recall": 1.0, "f1": 0.0}

    tp = len(pred_set & exp_set)
    precision = tp / len(pred_set) if pred_set else 0
    recall = tp / len(exp_set) if exp_set else 0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) else 0

    return {"precision": precision, "recall": recall, "f1": f1}


def main():
    print("=" * 70)
    print(f"RELEVANCE TEST — {MODEL}")
    print("=" * 70)

    # Warm up
    print("Warming up model...", flush=True)
    classify("test", ["[0.5] test memory"])

    total_scores = {"precision": 0, "recall": 0, "f1": 0}

    for tc in TEST_CASES:
        predicted = classify(tc["context"], tc["candidates"])
        scores = score(predicted, tc["expected"])
        total_scores["precision"] += scores["precision"]
        total_scores["recall"] += scores["recall"]
        total_scores["f1"] += scores["f1"]

        status = "✓" if predicted == tc["expected"] else "≈" if scores["f1"] > 0.5 else "✗"
        print(f"\n{status} {tc['name']}")
        print(f"  Expected:  {tc['expected']}")
        print(f"  Predicted: {predicted}")
        print(f"  P={scores['precision']:.2f} R={scores['recall']:.2f} F1={scores['f1']:.2f}")
        if predicted != tc["expected"]:
            print(f"  Rationale: {tc['rationale']}")

    n = len(TEST_CASES)
    print(f"\n{'=' * 70}")
    print(f"AVERAGE: P={total_scores['precision']/n:.2f} R={total_scores['recall']/n:.2f} F1={total_scores['f1']/n:.2f}")
    print(f"{'=' * 70}")


if __name__ == "__main__":
    main()
