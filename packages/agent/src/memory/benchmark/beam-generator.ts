// SPDX-License-Identifier: Apache-2.0
/**
 * Deterministic seeded BEAM haystack generator — the
 * synthetic long-context scale probe. Produces a reproducible ~N-token haystack of
 * filler docs with per-ability needles planted into it (a doc whose content uniquely
 * answers a generated query) plus a resolvable gold map.
 *
 * THE HAYSTACK IS NEVER COMMITTED: at the harness scale (~1M / ~10M tokens) it is
 * megabytes of text generated AT RUN TIME from the seed. Only this generator + the
 * seed are committed; a run regenerates the identical haystack from the seed.
 *
 * DETERMINISM: a tiny inline mulberry32 PRNG seeded from `seed` (NO `Math.random` —
 * the globals rule bans it in src/**), so two calls with the same
 * `{approxTokens, seed, abilities}` are byte-identical (the load-bearing
 * reproducibility property). `createdAt` are seeded deterministic epoch-ms; doc ids
 * are seeded deterministic strings (NOT randomUUID — that would break determinism).
 *
 * PURE: no clock read (no `Date.now`/`new Date`), no I/O, no @comis/memory import —
 * mirrors filesystem-baseline.ts / suite-scenario.ts. The live ingest + recall +
 * scoring wiring lives in the gated beam-harness.bench.test.ts (the single cut escape).
 *
 * SECURITY — prototype-pollution discipline: all generated
 * content + ability names are VALUES only, never used as object keys for writes, so
 * no generated string can reach Object.prototype.
 *
 * @module
 */

/**
 * The per-ability classes the BEAM probe stresses (the comparability anchor). Each
 * is a long-context retrieval ability the suite exposes; needles are planted one (or
 * more) per ability so per-ability recall@k is measurable.
 */
export type BeamAbility = "single-fact" | "multi-hop" | "temporal" | "aggregation";

/** The fixed ability order — the first `abilities` entries are used. */
const ALL_ABILITIES: readonly BeamAbility[] = [
  "single-fact",
  "multi-hop",
  "temporal",
  "aggregation",
];

/** One ingestable dated document. `id` is a seeded deterministic id (NOT a uuid). */
export interface BeamDoc {
  /** Seeded deterministic doc id (the gold-map key; need not be a uuid). */
  id: string;
  /** The document content (rendered/ingested verbatim; never used as an object key). */
  content: string;
  /** Seeded deterministic event time as positive epoch-ms (the dated anchor). */
  createdAt: number;
}

/** One planted per-ability needle: the probe query + the gold doc that answers it. */
export interface BeamNeedle {
  /** The ability class this needle exercises. */
  ability: BeamAbility;
  /** The probe query whose unique answer lives in `goldDocId`. */
  query: string;
  /** The id (in `docs`) of the doc that uniquely answers `query`. */
  goldDocId: string;
}

/** The generated synthetic haystack: docs + planted needles + a token estimate. */
export interface BeamHaystack {
  /** The filler + needle docs, in deterministic order. */
  docs: BeamDoc[];
  /** The planted per-ability needles (>= 1 per ability). */
  needles: BeamNeedle[];
  /** The approximate token count (cumulative content chars / ~4). */
  approxTokens: number;
}

/** Generator options. */
export interface BeamHaystackOptions {
  /** Target haystack size in tokens (the harness passes ~1M / ~10M; tests pass 50k). */
  approxTokens: number;
  /** PRNG seed — the determinism anchor (same seed → byte-identical output). */
  seed: number;
  /** Number of distinct per-ability classes to plant (1..4; default 4). */
  abilities?: number;
}

/** ~4 chars per token — the standard rough estimate used to size filler. */
const CHARS_PER_TOKEN = 4;

/** Fixed deterministic base epoch (2023-01-01 UTC) — NOT a clock read. */
const BASE_EPOCH = Date.UTC(2023, 0, 1, 0, 0, 0);
/** One day in ms — for spreading `createdAt` deterministically. */
const DAY_MS = 86_400_000;

/**
 * mulberry32 — a tiny deterministic 32-bit PRNG. Pure arithmetic over a seeded
 * state; NO `Math.random` (the globals ban). Returns a function yielding floats in
 * [0, 1). Standard public-domain algorithm.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A fixed lexicon — filler is assembled from these tokens (seeded selection). */
const LEXICON: readonly string[] = [
  "the", "team", "reviewed", "a", "report", "about", "the", "quarterly", "roadmap",
  "and", "noted", "several", "follow", "ups", "for", "the", "next", "sprint",
  "meeting", "notes", "covered", "the", "deployment", "pipeline", "status",
  "an", "update", "on", "the", "service", "metrics", "dashboard", "was", "shared",
  "the", "on", "call", "rotation", "schedule", "remained", "unchanged", "this", "week",
  "a", "retro", "highlighted", "the", "shipping", "cadence", "felt", "healthy",
  "context", "around", "the", "launch", "included", "three", "open", "questions",
];

/** A single needle template per ability — the planted unique fact + its query. */
const NEEDLE_TEMPLATES: Record<BeamAbility, { content: string; query: string }> = {
  "single-fact": {
    content: "Planted fact: the project codename for the BEAM probe is Heliotrope.",
    query: "What is the project codename for the BEAM probe?",
  },
  "multi-hop": {
    content:
      "Planted fact: the Heliotrope codename was chosen by the platform lead, who reports to the VP of Engineering.",
    query: "Who does the person that chose the Heliotrope codename report to?",
  },
  temporal: {
    content: "Planted fact: the BEAM probe milestone was scheduled for the third week of March.",
    query: "When was the BEAM probe milestone scheduled?",
  },
  aggregation: {
    content:
      "Planted fact: across all three regions the BEAM probe recorded a total of forty-two distinct needle hits.",
    query: "What was the total number of distinct needle hits across all regions?",
  },
};

/** Build a deterministic filler sentence of ~`targetChars` from the seeded PRNG. */
function fillerSentence(rng: () => number, targetChars: number): string {
  const words: string[] = [];
  let len = 0;
  // `idx` is always a valid in-range index: `Math.floor(rng()*N) % N` ∈ [0, N) for
  // rng() ∈ [0, 1). LEXICON is read by NUMERIC index only — never an object-key write.
  // The project does not set noUncheckedIndexedAccess, so `LEXICON[idx]` is a defined
  // string (no dead `?? fallback` branch to leave untested).
  while (len < targetChars) {
    const idx = Math.floor(rng() * LEXICON.length) % LEXICON.length;
    const w = LEXICON[idx];
    words.push(w);
    len += w.length + 1;
  }
  return words.join(" ") + ".";
}

/**
 * Generate a deterministic synthetic BEAM haystack with planted per-ability needles.
 *
 * Pads filler docs (seeded from `seed`) until the cumulative content length ≈
 * `approxTokens * CHARS_PER_TOKEN`, then plants one needle per requested ability. The
 * output is byte-identical across runs for a fixed `{approxTokens, seed, abilities}`.
 *
 * Pure + prototype-pollution-safe: content/ability strings are values only, never
 * object keys for writes.
 */
export function generateBeamHaystack(opts: BeamHaystackOptions): BeamHaystack {
  const abilityCount = Math.max(1, Math.min(ALL_ABILITIES.length, opts.abilities ?? 4));
  const rng = mulberry32(opts.seed);
  const targetChars = Math.max(1, opts.approxTokens) * CHARS_PER_TOKEN;
  // Reserve a deterministic chunk of the budget for filler; needles add a little more.
  const docs: BeamDoc[] = [];
  let cumChars = 0;
  let docIdx = 0;

  // Each filler doc is ~800 chars; pad until the target is reached.
  const fillerDocChars = 800;
  while (cumChars < targetChars) {
    const content = fillerSentence(rng, fillerDocChars);
    const id = `beam-${opts.seed}-filler-${docIdx}`;
    const createdAt = BASE_EPOCH + docIdx * DAY_MS;
    docs.push({ id, content, createdAt });
    cumChars += content.length;
    docIdx += 1;
  }

  // Plant one needle per ability. The needle doc id + createdAt are deterministic.
  const needles: BeamNeedle[] = [];
  for (let i = 0; i < abilityCount; i++) {
    // ALL_ABILITIES is read by NUMERIC index only — never an object-key write.
    const ability = ALL_ABILITIES[i] as BeamAbility;
    const tmpl = NEEDLE_TEMPLATES[ability];
    const goldDocId = `beam-${opts.seed}-needle-${ability}`;
    const createdAt = BASE_EPOCH + (docIdx + i) * DAY_MS;
    docs.push({ id: goldDocId, content: tmpl.content, createdAt });
    cumChars += tmpl.content.length;
    needles.push({ ability, query: tmpl.query, goldDocId });
  }

  return {
    docs,
    needles,
    approxTokens: Math.round(cumChars / CHARS_PER_TOKEN),
  };
}
