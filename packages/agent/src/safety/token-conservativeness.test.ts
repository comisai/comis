// SPDX-License-Identifier: Apache-2.0
/**
 * The offline token-estimate conservativeness suite.
 *
 * "No factor ships unmeasured": every committed ground-truth fixture entry
 * (packages/core/src/text/__fixtures__/token-counts.json — generated ONCE by
 * the operator-run scripts/token-fixtures/ toolkit against >= 2 real
 * tokenizers, never by CI) must satisfy, through the REAL agent estimator
 * root:
 *
 *     estimateMessageTokens({ role: "user", content: entry.text })
 *       >= entry.maxTokenCount   (the worst MEASURED tokenizer count)
 *
 * offline, forever. CI never networks — the fixture JSON is repo-tracked and
 * read with a plain fs read (no fetch anywhere in this file).
 *
 * Single-leg note: the committed corpus has
 * the qwen leg measured (node-llama-cpp x qwen3-coder:30b) and the anthropic
 * leg pending the operator's `./run.sh --leg anthropic` (fields null until
 * then). `maxTokenCount` = max over MEASURED legs, so the assertion stays
 * honest with one leg and AUTOMATICALLY tightens when the operator leg lands
 * (the completeness gate below validates anthropic values whenever non-null).
 *
 * The suite lives agent-side: the assertion runs over `estimateMessageTokens`
 * — an agent symbol — so it reads the core-owned fixtures cross-package via
 * import.meta.url.
 *
 * Same-commit factor-lowering rule: any non-latin entry violating the
 * assertion lowers that script's row tokenFactor in
 * packages/core/src/text/script-classes.ts in the SAME commit that touches
 * this suite. Shipped derivations: cyrillic 0.59 (13 ru violations, worst
 * ru_chat_14 implied 0.598) and hebrew letters 0.50 (he_mixed_04,
 * harmonic-blend bound 0.5016 with latin locked at 1.0).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import type { Message } from "@earendil-works/pi-ai";
import { estimateMessageTokens } from "./token-estimator.js";

// ---------------------------------------------------------------------------
// Fixture load (offline fs read — packages/agent/src/safety -> up to
// packages/ -> core/src/text/__fixtures__; CI never networks).
// ---------------------------------------------------------------------------

interface FixtureEntry {
  readonly id: string;
  readonly script: string;
  readonly category: string;
  readonly text: string;
  readonly anthropicTokens: number | null;
  readonly qwenTokens: number | null;
  readonly maxTokenCount: number;
}

interface FixtureFile {
  readonly generatedAt: string;
  readonly anthropicModel: string | null;
  readonly qwenGguf: string | null;
  readonly entries: readonly FixtureEntry[];
}

const fixtures: FixtureFile = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../core/src/text/__fixtures__/token-counts.json", import.meta.url)),
    "utf8",
  ),
) as FixtureFile;

/** The MEASURED tokenizer legs of one entry (null = leg not yet operator-run). */
function measuredLegs(entry: FixtureEntry): number[] {
  return [entry.anthropicTokens, entry.qwenTokens].filter(
    (v): v is number => typeof v === "number",
  );
}

const EXPECTED_SCRIPTS = ["he", "ar", "ru", "zh", "ja", "el", "th", "hi", "en"] as const;

// ---------------------------------------------------------------------------
// Completeness gates — the ">= 2 tokenizers" pin, loud not silent.
// ---------------------------------------------------------------------------

describe("fixture corpus completeness (the >= 2 tokenizers pin, loud not silent)", () => {
  it("carries at least 180 entries spanning all 9 script corpora", () => {
    expect(fixtures.entries.length).toBeGreaterThanOrEqual(180);
    const present = new Set(fixtures.entries.map((e) => e.script));
    for (const script of EXPECTED_SCRIPTS) {
      expect(present.has(script), `script corpus missing: ${script}`).toBe(true);
    }
  });

  it("every entry carries both tokenizer-leg fields with maxTokenCount = max over the MEASURED legs", () => {
    for (const entry of fixtures.entries) {
      // Both leg FIELDS present on every entry (a stripped field is a schema
      // break, loud). A null leg is the documented un-run state: the
      // generator's merge-by-id fills it on the operator run and maxTokenCount
      // is recomputed over PRESENT legs after every merge.
      expect("anthropicTokens" in entry, `${entry.id}: anthropicTokens field missing`).toBe(true);
      expect("qwenTokens" in entry, `${entry.id}: qwenTokens field missing`).toBe(true);
      // The qwen leg is the committed measured leg: integer >= 1, always.
      expect(Number.isInteger(entry.qwenTokens), `${entry.id}: qwenTokens not an integer`).toBe(true);
      expect(entry.qwenTokens as number, `${entry.id}: qwenTokens < 1`).toBeGreaterThanOrEqual(1);
      // The anthropic leg tightens automatically once the operator runs it:
      // null (pending) OR an integer >= 1 — never 0/NaN/garbage.
      if (entry.anthropicTokens !== null) {
        expect(Number.isInteger(entry.anthropicTokens), `${entry.id}: anthropicTokens not an integer`).toBe(true);
        expect(entry.anthropicTokens, `${entry.id}: anthropicTokens < 1`).toBeGreaterThanOrEqual(1);
      }
      const legs = measuredLegs(entry);
      expect(legs.length, `${entry.id}: no measured tokenizer leg at all`).toBeGreaterThanOrEqual(1);
      expect(entry.maxTokenCount, `${entry.id}: maxTokenCount != max(measured legs)`).toBe(
        Math.max(...legs),
      );
    }
  });

  it("carries top-level generation provenance (generatedAt + per-leg tokenizer ids)", () => {
    expect(typeof fixtures.generatedAt).toBe("string");
    expect(fixtures.generatedAt.length).toBeGreaterThan(0);
    // The qwen leg is measured -> its GGUF provenance must be present.
    expect(typeof fixtures.qwenGguf).toBe("string");
    expect((fixtures.qwenGguf as string).length).toBeGreaterThan(0);
    // The anthropic model id field exists (null until the operator leg runs;
    // once anthropic counts exist the model id must be recorded too).
    expect("anthropicModel" in fixtures).toBe(true);
    const anyAnthropic = fixtures.entries.some((e) => e.anthropicTokens !== null);
    if (anyAnthropic) {
      expect(typeof fixtures.anthropicModel).toBe("string");
    }
  });
});

// ---------------------------------------------------------------------------
// THE assertion: estimate >= worst measured tokenizer count, per entry.
// ---------------------------------------------------------------------------

describe("offline conservativeness: estimateMessageTokens >= maxTokenCount for EVERY committed fixture", () => {
  it("no committed fixture entry under-counts against the worst measured tokenizer leg", () => {
    const violations: string[] = [];
    for (const entry of fixtures.entries) {
      const estimate = estimateMessageTokens({
        role: "user",
        content: entry.text,
        timestamp: 0,
      } as Message);
      if (estimate < entry.maxTokenCount) {
        violations.push(
          `${entry.id} (${entry.script}/${entry.category}): estimate ${estimate} < measured ${entry.maxTokenCount}`,
        );
      }
    }
    // Per the same-commit factor-lowering rule, a violation here means that
    // script's row tokenFactor must be LOWERED in
    // packages/core/src/text/script-classes.ts in the SAME commit (latin/en is
    // LOCKED at 1.0 — Latin byte-identity — so an en violation is surfaced to
    // the operator instead, never silently excluded).
    expect(violations, `factor table under-counts ground truth:\n${violations.join("\n")}`).toEqual([]);
  });

  it("teeth control: at least one non-latin fixture VIOLATES the flat chars/4 baseline", () => {
    // Embedded negative control: proving (a) a flat chars/4 estimate IS blind
    // to this ground truth and (b) the suite is not vacuous. If this control
    // ever fails, the corpus no longer exercises the under-count defect class
    // the script-aware factors exist to close.
    const flatBaselineViolated = fixtures.entries.some(
      (e) => e.script !== "en" && Math.ceil(e.text.length / 4) < e.maxTokenCount,
    );
    expect(flatBaselineViolated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Provenance audit: every shipped factor row carries measurement provenance;
// only `other` ships unmeasured (commented as structurally unmeasurable).
// ---------------------------------------------------------------------------

describe("provenance audit: every non-other SCRIPT_CLASSES row carries measured provenance", () => {
  const classesSource = readFileSync(
    fileURLToPath(new URL("../../../core/src/text/script-classes.ts", import.meta.url)),
    "utf8",
  );

  it("each table row's vicinity names its measurement (date + measured/probe); the other row says unmeasurable", () => {
    const tableStart = classesSource.indexOf("export const SCRIPT_CLASSES");
    expect(tableStart).toBeGreaterThanOrEqual(0);
    const tableEnd = classesSource.indexOf("];", tableStart);
    expect(tableEnd).toBeGreaterThan(tableStart);
    const tableSource = classesSource.slice(tableStart, tableEnd);
    // Each row opens with `  {` at one indent level; the leading provenance
    // comment lives INSIDE the row braces, so every chunk carries its own.
    const rowChunks = tableSource.split(/\n {2}\{/).slice(1);
    expect(rowChunks.length).toBeGreaterThanOrEqual(11); // the 11-row probe-informed table
    for (const chunk of rowChunks) {
      const classMatch = /class:\s*"([a-z]+)"/.exec(chunk);
      expect(classMatch, `row chunk without a class discriminator: ${chunk.slice(0, 60)}`).not.toBeNull();
      const cls = classMatch?.[1] ?? "?";
      if (cls === "other") {
        expect(chunk, "the other row must be commented as structurally unmeasurable").toMatch(
          /unmeasurable/,
        );
      } else {
        expect(chunk, `${cls} row vicinity missing a measurement date (2026-…)`).toMatch(/2026-/);
        expect(chunk, `${cls} row vicinity missing the word measured/probe`).toMatch(
          /measured|probe/,
        );
      }
    }
  });
});
