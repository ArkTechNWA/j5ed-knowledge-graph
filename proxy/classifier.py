"""
SuperGemma-Meral classifier for ambient recall V3.

Uses a rating-based approach: each memory gets scored 0-10 for relevance
to the current context. Threshold determines keep/drop.

CRITICAL: think=false in every Ollama call. Without it, SuperGemma
scores 0% — burns all output tokens on reasoning before answering.
"""

import json
import re
import urllib.request

import config as cfg

# ── System prompt ─────────────────────────────────────────────────

_SYSTEM = (
    "Rate memory relevance to the current context. "
    "Output ONLY JSON: {1: score, 2: score, ...}. "
    "Scores 0-10. 0=irrelevant, 10=critical."
)


# ── Ollama call ───────────────────────────────────────────────────

def _call_supergemma(prompt: str, num_items: int = 10) -> dict | None:
    """Send a rating prompt to SuperGemma via Ollama.

    Returns a dict of {item_number: score} or None on failure.
    num_items scales num_predict to fit the response.
    """
    # ~6 tokens per item (number, colon, score, comma, space)
    num_predict = max(100, num_items * 8 + 20)

    payload = json.dumps({
        "model": cfg.CLASSIFIER_MODEL,
        "system": _SYSTEM,
        "prompt": prompt,
        "stream": False,
        "think": False,
        "options": {
            "temperature": 0.0,
            "num_predict": num_predict,
        },
    }).encode()

    req = urllib.request.Request(
        f"{cfg.CLASSIFIER_URL}/api/generate",
        data=payload,
        headers={"Content-Type": "application/json"},
    )

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read())
    except Exception as e:
        print(f"[AMBIENT] classifier error: {e}", flush=True)
        return None

    raw = data.get("response", "")
    result = _parse_json_scores(raw, num_items)
    if result is None and raw:
        print(f"[AMBIENT] classifier unparseable: {raw[:200]!r}", flush=True)
    return result


def _parse_json_scores(text: str, expected_items: int = 0) -> dict | None:
    """Extract a JSON dict of {int: int} scores from model output.

    Handles:
    - Unquoted keys: {1: 10, 2: 0}
    - Markdown wrappers: ```json ... ```
    - Truncated output: {1: 10, 2: 5, 3:  (missing closing brace)
    """
    # Strip markdown code blocks
    text = re.sub(r'```json\s*', '', text)
    text = re.sub(r'```\s*', '', text)
    text = text.strip()

    # Try complete JSON first
    m = re.search(r'\{[^}]+\}', text)
    if m:
        try:
            fixed = re.sub(r'(\d+)\s*:', r'"\1":', m.group())
            result = json.loads(fixed)
            return {int(k): int(v) for k, v in result.items()}
        except (json.JSONDecodeError, TypeError, ValueError):
            pass

    # Handle truncated output — extract all key:value pairs we can find
    pairs = re.findall(r'["\']?(\d+)["\']?\s*:\s*(\d+)', text)
    if pairs:
        return {int(k): int(v) for k, v in pairs}

    return None


# ── Prompt builder ────────────────────────────────────────────────

def _build_prompt(context: str, items: list[str]) -> str:
    """Build a compact rating prompt."""
    numbered = "\n".join(f"{i+1}. {item}" for i, item in enumerate(items))
    return f'Context: "{context}"\n{numbered}\nAnswer:'


# ── Public API ────────────────────────────────────────────────────

def classify_candidates(
    candidates: list[dict],
    context: str,
) -> list[int]:
    """Gate new kNN candidates before injection.

    Returns list of 0-indexed positions into candidates that scored
    above threshold. On failure, returns all indices (V2 fallback).
    """
    if not cfg.CLASSIFIER_ENABLED or not candidates:
        return list(range(len(candidates)))

    items = [f"[{c['entity_name']}] {c['content']}" for c in candidates]
    prompt = _build_prompt(context, items)
    scores = _call_supergemma(prompt, len(items))

    if scores is None:
        return list(range(len(candidates)))

    # Return 0-indexed positions of items scoring above threshold
    return [i for i in range(len(candidates))
            if scores.get(i + 1, 0) >= cfg.CLASSIFIER_THRESHOLD]


def evaluate_past_recall(
    memories_text: str,
    subsequent_conversation: str,
) -> list[int] | None:
    """Retroactively rate which injected memories are still relevant.

    Returns list of 1-indexed memory numbers that scored above threshold.
    Returns None if classifier unavailable (signals: skip pruning).
    """
    if not cfg.CLASSIFIER_ENABLED:
        return None

    # Extract items from the ambient_recall block
    lines = [
        line.strip("- ") for line in memories_text.split("\n")
        if line.strip().startswith("- [entity:") or
           (line.strip() and line.strip()[0].isdigit() and ". [" in line)
    ]
    if not lines:
        return None

    # Clean up — lines might already be numbered from the pruner
    items = []
    for line in lines:
        cleaned = re.sub(r'^\d+\.\s*', '', line)
        items.append(cleaned)

    prompt = _build_prompt(subsequent_conversation[:300], items)
    scores = _call_supergemma(prompt, len(items))

    if scores is None:
        return None

    # Return 1-indexed numbers that scored above threshold
    return [i for i in range(1, len(items) + 1)
            if scores.get(i, 0) >= cfg.CLASSIFIER_THRESHOLD]
