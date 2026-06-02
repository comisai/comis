#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""
PROVE2 (Phase 114) competitor runner — mem0.

Reads the EXACT sampled items exported by the prove2-qa-lift bench harness
(prove2-sample.json: a list of {docs:[{content,createdAt}], questions:[...]}),
ingests each item's docs into a FRESH mem0 instance, retrieves per question, and
emits per-question recalled contexts keyed by questionId — so the Comis harness
grades mem0's recall through the SAME answer + judges (apples-to-apples).

SUPPLY-CHAIN: this is out-of-repo operator tooling. mem0 is installed in an
isolated venv (~/.comis/prove-venv) and is NEVER a Comis dependency. This script
imports nothing from Comis.

HONESTY: if mem0 fails on an item/question, that question simply gets NO context
in the output — the Comis harness then has no mem0 row for it (a skip), never a
fabricated number. A fully-failed run emits an empty {"mem0": {}} (the harness
records mem0 as contributing zero gradeable cells).

Cost: mem0 does LLM fact-extraction at INGEST (the differentiator we measure —
Comis recall is LLM-free). Uses the operator's OpenAI key (gpt-4o-mini extractor
+ text-embedding-3-small) via env. Bound the run with MEM0_LIMIT.

Usage:
  ~/.comis/prove-venv/bin/python scripts/prove/mem0-runner.py \
      --sample ~/.comis/bench-data/prove2-sample.json \
      --out    ~/.comis/bench-data/mem0-contexts.json \
      [--limit N] [--top-k 5]

Env: OPENAI_API_KEY (required — mem0's LLM + embedder).
"""
import argparse
import json
import os
import sys
import time
import traceback


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def build_memory():
    """A fresh in-memory mem0 instance (no external Qdrant server needed)."""
    from mem0 import Memory
    from qdrant_client import QdrantClient

    key = os.environ.get("OPENAI_API_KEY", "")
    if not key:
        log("FATAL: OPENAI_API_KEY unset — mem0 needs it for its LLM + embedder.")
        sys.exit(2)
    # A pre-built TRUE in-memory Qdrant client (location ":memory:") passed via the
    # `client` field mem0 allows — each item gets an independent, ephemeral store with
    # no /tmp path, no cross-item lock, and no server. text-embedding-3-small = 1536 dims.
    client = QdrantClient(location=":memory:")
    config = {
        "llm": {"provider": "openai", "config": {"model": "gpt-4o-mini", "api_key": key}},
        "embedder": {
            "provider": "openai",
            "config": {"model": "text-embedding-3-small", "api_key": key},
        },
        "vector_store": {
            "provider": "qdrant",
            "config": {"collection_name": "prove2", "client": client, "embedding_model_dims": 1536},
        },
    }
    return Memory.from_config(config)


def format_context(results):
    """Format mem0's retrieved memories as a plain recalled-context string."""
    mems = results.get("results", []) if isinstance(results, dict) else results
    lines = []
    for i, r in enumerate(mems or [], 1):
        text = r.get("memory") if isinstance(r, dict) else str(r)
        if text:
            lines.append(f"[{i}] {text}")
    return "\n".join(lines) if lines else "(no relevant memories found)"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sample", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--limit", type=int, default=0, help="cap items (0 = all)")
    ap.add_argument("--top-k", type=int, default=5)
    args = ap.parse_args()

    with open(args.sample, "r") as f:
        items = json.load(f)
    if args.limit > 0:
        items = items[: args.limit]

    contexts = {}
    n_q = 0
    n_fail_items = 0
    t0 = time.time()

    def write_out():
        """Write the contexts file (called incrementally so a kill keeps partials)."""
        out = {"mem0": contexts}
        blob = json.dumps(out)
        import re

        if re.search(r"sk-[A-Za-z0-9_-]{16,}|Bearer [A-Za-z0-9._-]+", blob):
            log("FATAL: a credential shape reached the mem0 contexts — refusing to write.")
            sys.exit(3)
        with open(args.out, "w") as f:
            f.write(blob)

    for idx, item in enumerate(items):
        docs = item.get("docs", [])
        questions = item.get("questions", [])
        uid = f"item-{idx}"
        try:
            mem = build_memory()
            # Ingest each doc as a user message (mem0 extracts facts itself).
            for d in docs:
                content = d.get("content", "")
                if not content:
                    continue
                mem.add(content, user_id=uid)
            for q in questions:
                qid = q.get("questionId")
                query = q.get("query", "")
                if not qid:
                    continue
                try:
                    res = mem.search(query, filters={"user_id": uid}, limit=args.top_k)
                    contexts[qid] = format_context(res)
                    n_q += 1
                except Exception as e:  # per-question failure -> skip (no fabricated row)
                    log(f"  item {idx} q {qid}: search failed: {e}")
        except Exception as e:
            n_fail_items += 1
            log(f"item {idx}: mem0 failed ({e}); skipping its questions.")
            log(traceback.format_exc())
        write_out()  # incremental — partial results survive a kill
        log(f"  item {idx + 1}/{len(items)}: {len(questions)} q, cumulative graded {n_q}, {time.time() - t0:.0f}s")

    write_out()
    log(
        f"DONE: {n_q} questions, {len(items) - n_fail_items}/{len(items)} items ok, "
        f"{time.time() - t0:.0f}s -> {args.out}"
    )


if __name__ == "__main__":
    main()
