#!/usr/bin/env python3
"""
Backfill + reconciliation script for ambient recall embeddings.

Embeds all live observations that don't yet have a vec_observations entry.
With --reconcile: also removes orphaned vec rows and fixes superseded leaks.

Idempotent — safe to re-run at any time.

Usage:
  python3 scripts/backfill-embeddings.py [--reconcile] [--db PATH] [--ollama URL] [--model NAME] [--dim N] [--batch N]
"""

import argparse
import json
import sqlite3
import struct
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path


def embed_batch(texts: list[str], url: str, model: str, dim: int) -> list[bytes]:
    """Call Ollama /api/embed with a batch of texts. Returns list of float32 buffers."""
    payload = json.dumps({"model": model, "input": texts}).encode()
    req = urllib.request.Request(
        f"{url}/api/embed",
        data=payload,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read())
    except urllib.error.URLError as e:
        print(f"  ERROR: Ollama unreachable: {e}", file=sys.stderr)
        sys.exit(1)

    embeddings = data.get("embeddings", [])
    if len(embeddings) != len(texts):
        print(f"  ERROR: Expected {len(texts)} embeddings, got {len(embeddings)}", file=sys.stderr)
        sys.exit(1)

    result = []
    for emb in embeddings:
        if len(emb) != dim:
            print(f"  ERROR: Expected {dim}-dim, got {len(emb)}", file=sys.stderr)
            sys.exit(1)
        result.append(struct.pack(f"{dim}f", *emb))
    return result


def is_synthetic(content: str) -> bool:
    """Skip metadata observations that don't carry semantic content."""
    return any(content.startswith(p) for p in (
        "authored_by:", "authored_at:", "user_id:",
        "canonical_type:", "status:",
    ))


def backfill(db_path: str, ollama_url: str, model: str, dim: int, batch_size: int):
    """Embed all live observations missing from vec_observations."""
    db = sqlite3.connect(db_path)

    # Check if vec tables exist
    tables = [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
    if "vec_metadata" not in tables:
        print("ERROR: vec_metadata table not found. Start the KG server with EMBED_ENABLED=true first.")
        db.close()
        sys.exit(1)

    # Find observations missing embeddings
    rows = db.execute("""
        SELECT o.id, o.content, e.name AS entity_name, o.authored_by
        FROM observations o
        JOIN entities e ON e.id = o.entity_id
        WHERE o.superseded_at IS NULL
          AND o.id NOT IN (SELECT observation_id FROM vec_metadata)
        ORDER BY o.id
    """).fetchall()

    # Filter out synthetic
    rows = [(oid, content, ename, author) for oid, content, ename, author in rows
            if not is_synthetic(content)]

    total = len(rows)
    if total == 0:
        print("All observations already embedded. Nothing to do.")
        db.close()
        return

    print(f"Backfilling {total} observations (batch size {batch_size})...")

    embedded = 0
    failed = 0
    start = time.time()

    for i in range(0, total, batch_size):
        batch = rows[i:i + batch_size]
        texts = [r[1] for r in batch]

        try:
            buffers = embed_batch(texts, ollama_url, model, dim)
        except Exception as e:
            print(f"  Batch {i//batch_size + 1} failed: {e}")
            failed += len(batch)
            continue

        for j, (oid, content, ename, author) in enumerate(batch):
            db.execute(
                "INSERT OR REPLACE INTO vec_observations(rowid, embedding) VALUES (CAST(? AS INTEGER), ?)",
                (oid, buffers[j]),
            )
            db.execute(
                "INSERT OR REPLACE INTO vec_metadata(observation_id, entity_name, authored_by) VALUES (?, ?, ?)",
                (oid, ename, author),
            )
            embedded += 1

        db.commit()
        elapsed = time.time() - start
        rate = embedded / elapsed if elapsed > 0 else 0
        print(f"  {embedded}/{total} ({rate:.0f}/s)", end="\r", flush=True)

    elapsed = time.time() - start
    print(f"\nBackfill complete: {embedded} embedded, {failed} failed, {elapsed:.1f}s")
    db.close()


def reconcile(db_path: str):
    """Fix drift: remove orphaned vec rows, remove superseded leaks."""
    db = sqlite3.connect(db_path)

    # 1. Remove vec entries for superseded observations
    superseded = db.execute("""
        SELECT vm.observation_id
        FROM vec_metadata vm
        JOIN observations o ON o.id = vm.observation_id
        WHERE o.superseded_at IS NOT NULL
    """).fetchall()

    if superseded:
        print(f"Removing {len(superseded)} superseded embeddings...")
        for (oid,) in superseded:
            db.execute("DELETE FROM vec_observations WHERE rowid = ?", (oid,))
            db.execute("DELETE FROM vec_metadata WHERE observation_id = ?", (oid,))
        db.commit()

    # 2. Remove vec entries with no matching observation
    orphaned = db.execute("""
        SELECT vm.observation_id
        FROM vec_metadata vm
        LEFT JOIN observations o ON o.id = vm.observation_id
        WHERE o.id IS NULL
    """).fetchall()

    if orphaned:
        print(f"Removing {len(orphaned)} orphaned embeddings...")
        for (oid,) in orphaned:
            db.execute("DELETE FROM vec_observations WHERE rowid = ?", (oid,))
            db.execute("DELETE FROM vec_metadata WHERE observation_id = ?", (oid,))
        db.commit()

    if not superseded and not orphaned:
        print("No drift detected. Vec store is consistent.")

    # Stats
    vec_count = db.execute("SELECT COUNT(*) FROM vec_metadata").fetchone()[0]
    live_count = db.execute(
        "SELECT COUNT(*) FROM observations WHERE superseded_at IS NULL"
    ).fetchone()[0]
    print(f"Vec embeddings: {vec_count} | Live observations: {live_count}")

    db.close()


def main():
    parser = argparse.ArgumentParser(description="Backfill + reconcile ambient recall embeddings")
    parser.add_argument("--db", default=str(Path.home() / "Projects/PRJ-johnny5-memory/dist/memory.db"),
                       help="Path to KG SQLite database")
    parser.add_argument("--ollama", default="http://localhost:11434",
                       help="Ollama API URL")
    parser.add_argument("--model", default="nomic-embed-text",
                       help="Embedding model name")
    parser.add_argument("--dim", type=int, default=768,
                       help="Embedding dimension")
    parser.add_argument("--batch", type=int, default=50,
                       help="Batch size for embedding calls")
    parser.add_argument("--reconcile", action="store_true",
                       help="Also fix drift (superseded leaks, orphaned vec rows)")
    args = parser.parse_args()

    if args.reconcile:
        print(f"Reconciling vec store in {args.db}...")
        reconcile(args.db)
        print()

    print(f"Backfilling embeddings from {args.db}...")
    print(f"  Model: {args.model} ({args.dim}-dim)")
    print(f"  Ollama: {args.ollama}")
    backfill(args.db, args.ollama, args.model, args.dim, args.batch)


if __name__ == "__main__":
    main()
