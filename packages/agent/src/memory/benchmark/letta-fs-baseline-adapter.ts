// SPDX-License-Identifier: Apache-2.0
/**
 * The letta-fs-baseline adapter (the honesty anchor) — the keyless
 * Letta-style filesystem-tool CONTROL, wrapping the existing pure
 * `formatFilesystemContext` full-haystack formatter as a {@link CompetitorAdapter}.
 *
 * WHAT IT IS (the honesty control): a deliberately-trivial
 * no-memory baseline. Instead of Comis's ranked recall (a top-5
 * `MemorySearchResult[]`), it dumps the ENTIRE conversation haystack — every doc,
 * in deterministic `createdAt` order, NO relevance scoring, NO top-k truncation —
 * and lets the SAME answer + judge models grade it. If a full-dump baseline
 * ties/beats Comis's ranked recall on a benchmark, the *benchmark* is weak, not
 * Comis (Letta's filesystem agent scored 74.0% on LoCoMo, above Mem0's
 * self-reported 68.5%).
 *
 * THE CONTROL-LABEL DISCIPLINE: this adapter carries
 * `isControl: true` and its result's `manifestRef` embeds the explicit
 * {@link LETTA_FS_BASELINE_CONTROL_LABEL}, so it is STRUCTURALLY distinguishable
 * from a Comis cell and can NEVER be mistaken for Comis's headline score. The
 * `BenchmarkControl` shape (qa-report.ts:128) records it under that same label.
 *
 * KEYLESS at $0: no env read, no key, no provider call — the formatter is pure.
 * This is the ONLY competitor adapter that actually runs in the keyless CI (the
 * mem0/zep/hindsight/mnemosyne skeletons skip-with-disclosure).
 *
 * SECURITY — prototype-pollution discipline (inherited from
 * `formatFilesystemContext`): the doc `content` strings come from the UNTRUSTED
 * dataset haystack. The dump is built by string concatenation only; doc content
 * is NEVER used as an object key, so a `"__proto__"` / `"constructor"` content
 * value becomes ordinary rendered text and can never mutate `Object.prototype`.
 * The per-cell `docs` are read from {@link AdapterConfig} through a TOTAL coercion
 * that validates each entry's shape with literal-key reads only (no spread of an
 * untrusted object into a key position).
 *
 * ARCHITECTURE: imports ONLY the in-package `./filesystem-baseline.js`
 * (the adapter body) + the `./competitor-adapter.js` types — no @comis/memory
 * (the agent↛memory cut). The live store + recall wiring lives ONLY in the gated
 * `.bench.test.ts` (the single cut escape).
 *
 * @module
 */

import { formatFilesystemContext } from "./filesystem-baseline.js";
import type {
  AdapterConfig,
  AdapterResult,
  CompetitorAdapter,
} from "./competitor-adapter.js";

/**
 * The explicit control label for the letta-fs-baseline row — mirrors
 * `BenchmarkControl.label` (qa-report.ts:129). It is recorded ONLY under this
 * label so it can never be mistaken for Comis's own score.
 */
export const LETTA_FS_BASELINE_CONTROL_LABEL =
  "filesystem-baseline-full-context-control";

/** One ingestable dated document — the `{content, createdAt}` shape the loaders emit. */
interface HaystackDoc {
  content: string;
  createdAt: number;
}

/**
 * TOTAL coercion of the per-cell `docs` carried on the open {@link AdapterConfig}
 * into a typed, validated `HaystackDoc[]`. Reads only literal keys off each
 * candidate (never spreads an untrusted object into a key position) and drops any
 * entry that is not `{ content: string, createdAt: number }`. Never throws — an
 * absent / malformed `docs` yields an empty haystack (the formatter then returns
 * the empty sentinel), keeping the adapter total.
 */
function coerceDocs(config: AdapterConfig): HaystackDoc[] {
  const raw = (config as { docs?: unknown }).docs;
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: HaystackDoc[] = [];
  for (const candidate of raw) {
    if (candidate === null || typeof candidate !== "object") {
      continue;
    }
    const content = (candidate as { content?: unknown }).content;
    const createdAt = (candidate as { createdAt?: unknown }).createdAt;
    if (typeof content === "string" && typeof createdAt === "number") {
      out.push({ content, createdAt });
    }
  }
  return out;
}

/**
 * The letta-fs-baseline adapter surface — the uniform {@link CompetitorAdapter}
 * plus the directly-callable {@link formatControlContext} (the full-haystack dump
 * the harness records as the control context for one question).
 */
export interface LettaFsBaselineAdapter extends CompetitorAdapter {
  readonly isControl: true;
  /**
   * Format the FULL haystack as the Letta-style control context — every doc, in
   * deterministic `createdAt` order, no top-k. Pure (delegates to
   * `formatFilesystemContext`); prototype-pollution-safe.
   */
  formatControlContext(docs: ReadonlyArray<HaystackDoc>): string;
}

/**
 * Build the keyless letta-fs-baseline control adapter. Its `run` reads the
 * per-cell haystack from `config.docs`, formats the full-dump control context via
 * the pure `formatFilesystemContext`, and returns a `ran:true` result with
 * `isControl:true`, a control-labelled `manifestRef`, and `contextChars` — the
 * OBSERVED char length of the rendered context, which makes the format
 * call load-bearing rather than discarded. It runs keyless at $0 — no env, no
 * key, no provider call.
 */
export function createLettaFsBaselineAdapter(): LettaFsBaselineAdapter {
  return {
    system: "letta-fs-baseline",
    isControl: true,
    formatControlContext(docs: ReadonlyArray<HaystackDoc>): string {
      // The adapter body IS the existing pure full-haystack formatter.
      return formatFilesystemContext(docs);
    },
    async run(tier: string, config: AdapterConfig): Promise<AdapterResult> {
      const docs = coerceDocs(config);
      // Format the full-dump control context (the real work this adapter does).
      // Keyless and pure — no env, no key, no provider. The formatted string is the
      // context the harness feeds to the SAME answer+judge models; the resulting
      // accuracy is recorded under the control label in the committed manifest
      // (read back from disk before it is ever quoted — the honesty protocol).
      // We OBSERVE the formatted context (record its char length on the
      // result) so this call is LOAD-BEARING — a faithful $0 control execution
      // whose work cannot be deleted as dead code without a behavioural change.
      const context = this.formatControlContext(docs);
      const contextChars = context.length;
      // The cell -> manifest link, tagged with the explicit control label and the
      // tier so it is structurally a control row, never Comis's headline. The
      // result carries the manifest link + the observed context length, NOT a score
      // (the number lives in the committed manifest the harness writes + reads back
      // before quoting).
      const manifestRef = `control://${LETTA_FS_BASELINE_CONTROL_LABEL}/${tier}`;
      return {
        ran: true,
        system: "letta-fs-baseline",
        isControl: true,
        manifestRef,
        contextChars,
      };
    },
  };
}
