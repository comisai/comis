#!/usr/bin/env node
// Reranker CPU latency harness — THROWAWAY measurement spike.
//
// This is exploratory, throwaway code by intent: it answers ONE feasibility
// question — can a local cross-encoder rerank of ~40 candidates fit a per-turn
// latency budget — and is NOT production code (no RerankerPort, no adapter, no
// config keys; that comes later). It lives under scripts/perf/ (outside the
// production source tree), so the Result-everywhere / port / TDD-RED /
// no-console.log architecture rules do NOT apply: printing parseable stdout is
// the script's job (mirrors the scripts/perf/cli-coldstart.sh precedent).
//
// ZERO NEW DEPENDENCIES: reuses the already-pinned node-llama-cpp@3.18.1
// LlamaRankingContext. Imported dynamically so an absent native
// binary degrades gracefully instead of crashing — the embryo of the
// graceful-degrade-to-fusion-order seam.
//
// CPU FORCED (gpu: false): the production target is CPU Linux; this dev box is
// macOS/Metal, and getLlama defaults to gpu:"auto" → Metal, which would report
// numbers irrelevant to production. Forcing CPU makes the measurement honest.
//
// COLD-LOAD IS EXCLUDED from the per-turn p50/p95: model load +
// createRankingContext is a one-time daemon-startup cost (and a one-time
// ~636 MB GGUF download on the very first run), not a per-turn cost. It is
// measured ONCE, separately, and reported on its own `cold_load_ms=` line.
//
// SECURITY: the harness reranks SYNTHETIC/neutral fixture
// text it generates itself. It NEVER reads the live memory DB, NEVER prints
// candidate content, and NEVER touches secrets or message bodies — only counts,
// scores-shape sanity, and timings are printed. Pino auto-redaction does not
// cover a raw scripts/ file, so content-safety is enforced deliberately here.
//
// Usage:
//   node scripts/perf/reranker-latency.mjs
//
// Env overrides:
//   LLAMA_RERANKER_MODEL_PATH  — hf: URI or local .gguf path (default: bge-reranker-v2-m3 Q8_0)
//   RERANK_THREADS             — ranking-context thread count (default: 4)
//
// Output: parseable plain text on stdout (one line per sweep point + a cold_load
// line); diagnostics + graceful-degrade notices on stderr.

import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

// ---------------------------------------------------------------------------
// Config (overridable via env)
// ---------------------------------------------------------------------------

// Default model: bge-reranker-v2-m3 Q8_0 — the canonical example model in the
// official node-llama-cpp reranking docs, ~636 MB, multilingual. If the slug
// 404s, point LLAMA_RERANKER_MODEL_PATH at an alternate hf: repo
// (pqnet / Felladrin / klnstpr) or a local .gguf file.
const MODEL_URI =
  process.env.LLAMA_RERANKER_MODEL_PATH ??
  "hf:gpustack/bge-reranker-v2-m3-GGUF:bge-reranker-v2-m3-Q8_0.gguf";

// Mirrors the embedding provider's models cache: ~/.comis/models (setup-memory.ts:148).
const MODELS_DIR = path.join(os.homedir(), ".comis", "models");

// Pin the thread count rather than grabbing all cores (avoids thread/CPU
// contention with embeddings). threads:0 would mean "max hardware
// threads"; 4 is a conservative, production-plausible default and bounds CPU.
const THREADS = Number(process.env.RERANK_THREADS ?? 4);

// Warm iterations per sweep point. 30 sorted samples give an honest p50/p95.
const ITERATIONS = 30;

// Candidate-count sweep: shows the latency CURVE so the chosen cap is
// measured-justified, not assumed. Design default is 40 = max(rag.maxResults,
// rerank.maxCandidates).
const CANDIDATE_COUNTS = [20, 40, 60];

// ---------------------------------------------------------------------------
// Fixtures — SYNTHETIC / NEUTRAL text only (security: never real memory content)
// ---------------------------------------------------------------------------

// A single neutral query, the kind of thing a user might ask an assistant.
const QUERY = "What are the user's preferences for how the assistant replies?";

// A pool of synthetic candidate docs at realistic MemoryEntry.content lengths
// (a sentence to a short paragraph each). NEVER real memories, secrets, or
// message bodies — generated entirely from neutral templates.
const FIXTURE_SENTENCES = [
  "The user prefers concise answers and works in timezone UTC+2.",
  "The team standup happens every weekday morning and runs for fifteen minutes.",
  "Project deadlines are tracked in a shared calendar and reviewed on Fridays.",
  "The user likes responses formatted as short bullet lists rather than prose.",
  "A neutral fact about scheduling: meetings are blocked off in the afternoon.",
  "The assistant should avoid emojis and keep a professional, plain tone.",
  "Weekly reports are summarised in a paragraph and shared with the group.",
  "The user reads documentation in English and writes notes in the same language.",
  "Background tasks run overnight and their results are reviewed the next day.",
  "The user prefers metric units and a twenty-four hour clock for all times.",
  "Reminders are set the evening before so the morning starts already planned.",
  "The user values accuracy over speed and asks for sources when relevant.",
  "Code examples should be small, self-contained, and runnable without setup.",
  "The user keeps notes terse and expands them into full sentences only on request.",
  "A synthetic preference: dark themes are easier on the eyes during long sessions.",
  "The assistant should ask one clarifying question before a large change.",
  "Status updates are expected to be brief and to lead with the conclusion first.",
  "The user works across several channels and expects consistent behaviour in each.",
  "Long outputs should be chunked so the most important point appears at the top.",
  "A neutral note: the user prefers examples grounded in everyday office tasks.",
];

/**
 * Build a pool of `count` synthetic candidate docs by cycling the neutral
 * fixture sentences and varying length so the batch resembles real candidate
 * sizes (short-to-medium memory.content) without ever using real content.
 */
function buildCandidatePool(count) {
  const docs = [];
  for (let i = 0; i < count; i++) {
    const base = FIXTURE_SENTENCES[i % FIXTURE_SENTENCES.length];
    // Vary length: roughly every third doc is a short paragraph (two clauses).
    const extra =
      i % 3 === 0
        ? ` This is supporting detail number ${i + 1}, kept neutral and synthetic for the latency measurement.`
        : "";
    docs.push(`${base}${extra}`);
  }
  return docs;
}

// ---------------------------------------------------------------------------
// Percentile (sorted-index; honest and sufficient for ~30 samples)
// ---------------------------------------------------------------------------

function percentile(sortedSamples, p) {
  const idx = Math.min(
    sortedSamples.length - 1,
    Math.ceil((p / 100) * sortedSamples.length) - 1,
  );
  return sortedSamples[idx];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  let llama;
  let model;
  let ctx;

  // --- Cold load (measured SEPARATELY; excluded from per-turn p50/p95) -----
  // Wrapped so an absent binary / 404 / bad path degrades gracefully:
  // print a clear notice to stderr and exit(0) WITHOUT throwing. This is the
  // graceful-degrade seam in embryo.
  try {
    const llamaCpp = await import("node-llama-cpp");

    const coldStart = performance.now();
    // Force CPU — production target is CPU Linux (differs from the embedding
    // provider's gpu:"auto" default).
    llama = await llamaCpp.getLlama({ gpu: false });

    const modelPath = MODEL_URI.startsWith("hf:")
      ? await llamaCpp.resolveModelFile(MODEL_URI, MODELS_DIR) // auto-download on first run
      : MODEL_URI;

    model = await llama.loadModel({ modelPath });
    // Ranking context (NOT embedding context). ONE context, reused across ALL
    // measured iterations and ALL sweep points — per-call context creation is
    // an anti-pattern that would dominate and misrepresent the warm path.
    ctx = await model.createRankingContext({ threads: THREADS });
    const coldLoadMs = performance.now() - coldStart;

    // Reported on its own line — informs daemon-startup cost, NOT per-turn cost.
    console.log(`cold_load_ms=${coldLoadMs.toFixed(1)}`);
    console.log(
      `model=${MODEL_URI} threads=${THREADS} gpu=off iterations=${ITERATIONS}`,
    );
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    process.stderr.write(`RERANK_HARNESS: degraded — ${reason}\n`);
    // Graceful degradation: no throw, no non-zero exit. The harness + decision
    // framework remain the durable deliverable even when the model can't load.
    process.exit(0);
  }

  try {
    // Build the largest pool once; slice [0..count] per sweep point.
    const maxCount = Math.max(...CANDIDATE_COUNTS);
    const pool = buildCandidatePool(maxCount);

    let sanityChecked = false;

    for (const count of CANDIDATE_COUNTS) {
      const docs = pool.slice(0, count);

      // One DISCARDED warm-up: the first eval after load warms llama.cpp's
      // compute buffers and reads as a massive outlier.
      await ctx.rankAll(QUERY, docs);

      const samples = [];
      for (let i = 0; i < ITERATIONS; i++) {
        const t0 = performance.now();
        const scores = await ctx.rankAll(QUERY, docs);
        samples.push(performance.now() - t0);

        // Sanity-assert scores once: confirms the API returns calibrated [0,1]
        // probabilities in input order (no sigmoid needed). Counts/shape only —
        // never the candidate content.
        if (!sanityChecked) {
          sanityChecked = true;
          const okShape =
            Array.isArray(scores) &&
            scores.length === docs.length &&
            scores.every((s) => Number.isFinite(s) && s >= 0 && s <= 1);
          if (!okShape) {
            process.stderr.write(
              `RERANK_HARNESS: WARN unexpected scores (len=${
                Array.isArray(scores) ? scores.length : "n/a"
              } expected=${docs.length})\n`,
            );
          }
        }
      }

      samples.sort((a, b) => a - b);
      const p50 = percentile(samples, 50);
      const p95 = percentile(samples, 95);

      // One parseable line per count (counts/scores/timings only).
      console.log(
        `rerank count=${count} p50=${p50.toFixed(1)}ms p95=${p95.toFixed(
          1,
        )}ms n=${ITERATIONS} threads=${THREADS} gpu=off`,
      );
    }
  } finally {
    // Teardown innermost-first (mirrors embedding-provider-local.ts dispose).
    if (ctx) await ctx.dispose();
    if (model) await model.dispose();
    if (llama) await llama.dispose();
  }
}

main().catch((e) => {
  // Any unexpected error post-load is still surfaced clearly (not silently).
  const reason = e instanceof Error ? e.stack ?? e.message : String(e);
  process.stderr.write(`RERANK_HARNESS: error — ${reason}\n`);
  process.exit(1);
});
