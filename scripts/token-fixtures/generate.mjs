// SPDX-License-Identifier: Apache-2.0
/**
 * Multilingual token-fixture ground-truth generator (TOK-02 —
 * design/multilingual-excellence.md §4).
 *
 * Measures the committed corpus (corpus.mjs) against >=2 REAL tokenizers and
 * writes packages/core/src/text/__fixtures__/token-counts.json. Operator-run
 * ONCE per leg; the committed JSON is the durable deliverable. CI and
 * `pnpm validate` never run this script and never touch the network.
 *
 * Modes:
 *   node generate.mjs --dry             corpus composition audit (offline —
 *                                       no network, no model load) and exit
 *   node generate.mjs --leg qwen        local llama.cpp qwen-class leg only
 *   node generate.mjs --leg anthropic   Anthropic count_tokens leg only
 *   node generate.mjs [--leg both]      both legs (default)
 *
 * Merge semantics: an existing token-counts.json is loaded and only the
 * requested leg's fields are (re)filled by entry id, so the two legs can run
 * at different times / on different machines. Carried-forward counts are kept
 * ONLY when the entry's committed text still equals the corpus text (review
 * WR-04: counts measured against an older revision of an entry must never
 * silently attach to edited text — the conservativeness suite would then
 * assert against corrupted ground truth); on a text change the stale counts
 * are dropped with a WARN and the entry must be re-measured. maxTokenCount is
 * recomputed as the max over the PRESENT legs after every merge; an un-run
 * leg stays null.
 *
 * Config via env (see token-fixtures.env.example):
 *   ANTHROPIC_API_KEY      leg A credential — never printed, never committed
 *   ANTHROPIC_COUNT_MODEL  CURRENT-tokenizer model id (older ids use the old
 *                          tokenizer and under-measure by ~30% — Pitfall 7)
 *   QWEN_GGUF_PATH         local qwen-class GGUF for leg B (see README.md for
 *                          the `ollama show ... --modelfile` discovery trick;
 *                          only its BASENAME is recorded in the output)
 * @module
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CORPUS } from "./corpus.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = join(HERE, "../../packages/core/src/text/__fixtures__/token-counts.json");

const SCRIPTS = ["he", "ar", "ru", "zh", "ja", "el", "th", "hi", "en"];
const ANTHROPIC_SLEEP_MS = 700; // stays well under the tier-1 100 RPM limit

// ── CLI ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const dry = args.includes("--dry");
const legIdx = args.indexOf("--leg");
const leg = legIdx >= 0 ? (args[legIdx + 1] ?? "") : "both";
if (!["qwen", "anthropic", "both"].includes(leg)) {
  console.error(`ERROR: unknown --leg "${leg}" (expected qwen | anthropic | both).`);
  process.exit(1);
}

// ── Corpus audit (also the --dry output; verify gate reads the tail) ─────────
function auditCorpus() {
  const ids = new Set();
  for (const e of CORPUS) {
    if (ids.has(e.id)) {
      console.error(`ERROR: duplicate corpus id "${e.id}".`);
      process.exit(1);
    }
    ids.add(e.id);
  }
  console.log("Corpus audit (offline — no network, no model load):");
  for (const script of SCRIPTS) {
    const list = CORPUS.filter((e) => e.script === script);
    const byCat = new Map();
    for (const e of list) byCat.set(e.category, (byCat.get(e.category) ?? 0) + 1);
    const cats = [...byCat.entries()].map(([c, n]) => `${c}=${n}`).join(", ");
    console.log(`  ${script}: ${list.length} entries (${cats})`);
  }
  console.log(`  TOTAL: ${CORPUS.length} entries across ${SCRIPTS.length} scripts`);
}

if (dry) {
  auditCorpus();
  process.exit(0);
}

// ── Load + merge against an existing fixture file ────────────────────────────
const existing = existsSync(OUTPUT_PATH) ? JSON.parse(readFileSync(OUTPUT_PATH, "utf8")) : null;
const existingById = new Map((existing?.entries ?? []).map((e) => [e.id, e]));
const entries = CORPUS.map((c) => {
  const prev = existingById.get(c.id);
  // Review WR-04: a merge by id alone silently attaches counts measured
  // against an OLDER text revision to edited corpus text — corrupted ground
  // truth the conservativeness suite then asserts against (can false-pass on
  // shortened text, false-fail on lengthened). The fixture stores the full
  // text, so direct equality decides whether prior counts are still valid.
  const prevTextMatches = prev !== undefined && prev.text === c.text;
  if (prev !== undefined && !prevTextMatches) {
    console.warn(
      `WARN: corpus text changed for id "${c.id}" — dropping its previously measured counts; re-run the legs to re-measure this entry.`,
    );
  }
  return {
    id: c.id,
    script: c.script,
    category: c.category,
    text: c.text,
    anthropicTokens: prevTextMatches && typeof prev.anthropicTokens === "number" ? prev.anthropicTokens : null,
    qwenTokens: prevTextMatches && typeof prev.qwenTokens === "number" ? prev.qwenTokens : null,
    maxTokenCount: null, // recomputed after the requested legs run
  };
});
let anthropicModel = existing?.anthropicModel ?? null;
let qwenGguf = existing?.qwenGguf ?? null;

// ── Leg A: Anthropic count_tokens (network; operator-run) ────────────────────
async function countTokensOnce(apiKey, model, text) {
  const res = await fetch("https://api.anthropic.com/v1/messages/count_tokens", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model, messages: [{ role: "user", content: text }] }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error(`ERROR: Anthropic count_tokens failed: HTTP ${res.status}`);
    console.error(body);
    console.error(
      "Check ANTHROPIC_API_KEY and ANTHROPIC_COUNT_MODEL (copy token-fixtures.env.example " +
        "to token-fixtures.env and fill both), then re-run: ./run.sh --leg anthropic",
    );
    process.exit(1);
  }
  const json = await res.json();
  return json.input_tokens;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runAnthropicLeg() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model = process.env.ANTHROPIC_COUNT_MODEL;
  if (!apiKey) {
    console.error("ERROR: ANTHROPIC_API_KEY is not set (required for --leg anthropic/both).");
    console.error("Copy token-fixtures.env.example to token-fixtures.env and fill it, then ./run.sh --leg anthropic");
    process.exit(1);
  }
  if (!model) {
    console.error("ERROR: ANTHROPIC_COUNT_MODEL is not set — use a CURRENT-tokenizer model id (see token-fixtures.env.example).");
    process.exit(1);
  }
  // Baseline-delta (Pitfall 7): the endpoint counts the WHOLE request (role
  // wrapper + system additions). Count a 1-char marker once and subtract the
  // overhead from every measurement so short strings are not inflated.
  const markerCount = await countTokensOnce(apiKey, model, "a");
  const overhead = markerCount - 1;
  console.log(`Anthropic leg: model=${model}, request overhead=${overhead} tokens (marker=${markerCount})`);
  let done = 0;
  for (const e of entries) {
    await sleep(ANTHROPIC_SLEEP_MS);
    const raw = await countTokensOnce(apiKey, model, e.text);
    e.anthropicTokens = Math.max(1, raw - overhead);
    done += 1;
    if (done % 20 === 0) console.log(`  ...${done}/${entries.length} counted`);
  }
  anthropicModel = model;
}

// ── Leg B: local llama.cpp qwen-class tokenizer (no GPU, no network) ─────────
async function runQwenLeg() {
  const ggufPath = process.env.QWEN_GGUF_PATH;
  if (!ggufPath || !existsSync(ggufPath)) {
    console.error("ERROR: QWEN_GGUF_PATH is unset or not a file (required for --leg qwen/both).");
    console.error("Discover the local Ollama blob with: ollama show qwen3-coder:30b --modelfile | grep '^FROM'");
    console.error("(see README.md — the qwen3.6/qwen35-arch blobs do NOT load in node-llama-cpp 3.18.1).");
    process.exit(1);
  }
  // Resolve node-llama-cpp from the packages/memory pin — NO new dependency
  // anywhere (179-RESEARCH Code Example 3, verified working 2026-06-12).
  const req = createRequire(new URL("../../packages/memory/package.json", import.meta.url).pathname);
  const { getLlama } = await import("file://" + req.resolve("node-llama-cpp"));
  console.log("Qwen leg: loading llama.cpp (first gpu:false run may compile a CPU addon, ~2 min)...");
  const llama = await getLlama({ gpu: false }); // tokenize needs no GPU
  const model = await llama.loadModel({ modelPath: ggufPath, gpuLayers: 0 });
  for (const e of entries) {
    e.qwenTokens = model.tokenize(e.text).length;
  }
  await model.dispose();
  qwenGguf = basename(ggufPath); // basename ONLY — no absolute paths/usernames in committed JSON
  console.log(`Qwen leg: tokenized ${entries.length} entries against ${qwenGguf}`);
}

// ── Run requested legs ───────────────────────────────────────────────────────
if (leg === "qwen" || leg === "both") await runQwenLeg();
if (leg === "anthropic" || leg === "both") await runAnthropicLeg();

// Recompute maxTokenCount over the PRESENT legs (un-run leg stays null).
for (const e of entries) {
  const present = [e.anthropicTokens, e.qwenTokens].filter((v) => typeof v === "number");
  e.maxTokenCount = present.length > 0 ? Math.max(...present) : null;
}

const doc = {
  generatedAt: new Date().toISOString(),
  anthropicModel,
  qwenGguf,
  entries,
};
mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
writeFileSync(OUTPUT_PATH, JSON.stringify(doc, null, 2) + "\n", "utf8");
console.log(`\nWrote ${entries.length} entries -> ${OUTPUT_PATH}`);

// Per-script summary — counts and chars/token only, never credentials.
console.log("Per-script summary:");
for (const script of SCRIPTS) {
  const list = entries.filter((e) => e.script === script);
  const qwenMeasured = list.filter((e) => typeof e.qwenTokens === "number");
  const anthMeasured = list.filter((e) => typeof e.anthropicTokens === "number");
  const cpt =
    qwenMeasured.length > 0
      ? (
          qwenMeasured.reduce((s, e) => s + e.text.length, 0) /
          qwenMeasured.reduce((s, e) => s + e.qwenTokens, 0)
        ).toFixed(2)
      : "n/a";
  console.log(
    `  ${script}: qwen ${qwenMeasured.length}/${list.length}, anthropic ${anthMeasured.length}/${list.length}, qwen chars/token=${cpt}`,
  );
}
