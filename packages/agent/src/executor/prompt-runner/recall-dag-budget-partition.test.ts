// SPDX-License-Identifier: Apache-2.0
/**
 * Characterization (regression-guard) tests for the RECALL ↔ DAG-token-budget
 * partition invariant.
 *
 * WHY THIS EXISTS — the silent coupling between two subsystems:
 *   1. The long-term memory/recall system injects recalled memories into the
 *      prompt as (a) the `## Relevant Memories` block (carried on
 *      `dynamicPreamble`) and (b) a top-1 `inlineMemory` string.
 *   2. The DAG context engine ("DAG memory", the default working-context
 *      manager) budgets conversation history against
 *      H = W - S - O - M - R, where S = systemTokens.
 *
 * The load-bearing fact these tests LOCK: recalled-memory bytes are budgeted
 * as HISTORY (they ride the user-message stream), NOT as system tokens (S).
 * Two source sites encode this and must stay in agreement:
 *   - envelope-wrapper.ts PREPENDS both `dynamicPreamble` and `inlineMemory`
 *     into `messageText` (the outgoing user message), so the bytes live in the
 *     message stream the DAG measures as history.
 *   - executor-tool-assembly.ts computes `cachedSystemTokensEstimate` (= S, the
 *     value the DAG subtracts via getSystemTokensEstimate) from ONLY
 *     `promptResult.systemPrompt` + `toolDefOverheadChars` (via
 *     the shared `estimateSystemTokensFactored` helper — script-aware divisor,
 *     same two inputs) — it EXCLUDES `dynamicPreamble`/`inlineMemory`.
 *
 * THE COUPLING RISK this guards: if a future refactor moves the recalled-memory
 * block out of the dynamic preamble and INTO the frozen system prompt (a
 * tempting cache-stability change), S would silently stop matching the real
 * system content and the DAG would under-budget → prompt overrun. If you make
 * that move, S (executor-tool-assembly.ts) MUST be updated to include it.
 *
 * Source-grep style matches the sibling envelope-wrapper.test.ts: wrapEnvelope
 * has a large RunPromptParams surface, so structural locks pin the two source
 * sites. The behavioral question they raise — is the injected memory budgeted? —
 * was traced to ground: it is absorbed by the token-budget
 * cushion BY DESIGN, and the INVARIANT test below guards that coupling.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { RagConfigSchema } from "@comis/core";
import { CHARS_PER_TOKEN_RATIO, MIN_SAFETY_MARGIN_TOKENS } from "../../context-engine/constants.js";

const here = dirname(fileURLToPath(import.meta.url));
const envelopeSource = readFileSync(resolve(here, "envelope-wrapper.ts"), "utf-8");
const toolAssemblySource = readFileSync(resolve(here, "../executor-tool-assembly.ts"), "utf-8");

describe("recall ↔ DAG-budget partition: recalled memory is budgeted as HISTORY, not system tokens (S)", () => {
  it("envelope-wrapper PREPENDS the dynamic preamble (carries the `## Relevant Memories` block) into the user-message stream", () => {
    // The recalled-memory block rides `dynamicPreamble`; prepending it into
    // `messageText` puts those bytes in the message array the DAG budgets as H.
    expect(envelopeSource).toContain(
      "messageText = `[System context]\\n${fullDynamicPreamble}\\n[End system context]\\n\\n${messageText}`",
    );
    // fullDynamicPreamble is the dynamicPreamble (first element of the concat).
    // The capability-index/deferred components are passed through the
    // tight-window drop first (keptCapabilityIndex/keptDeferred); dynamicPreamble (which
    // carries the recalled-memory block) is ALWAYS the first element and is never dropped,
    // so the recall→H budgeting invariant this test guards is unchanged.
    expect(envelopeSource).toContain(
      "const fullDynamicPreamble = [dynamicPreamble, keptCapabilityIndex, keptDeferred]",
    );
  });

  it("envelope-wrapper PREPENDS the top-1 inlineMemory into the user-message stream", () => {
    // inlineMemory (the highest-scoring recalled memory) is prepended adjacent
    // to the user message → in the message stream → budgeted in H, not S.
    expect(envelopeSource).toContain("messageText = `${inlineMemory}\\n${messageText}`");
  });

  it("S (cachedSystemTokensEstimate) is computed from the frozen system prompt + tool overhead ONLY — it EXCLUDES the recalled-memory preamble", () => {
    // This is the value the DAG subtracts as systemTokens (getSystemTokensEstimate
    // → cachedSystemTokensEstimate). It deliberately does not see the dynamic
    // preamble / inline memory, because those are budgeted as history instead.
    // S is assigned TWICE: a pre-deferral
    // estimate (`let`) and a post-deferral recompute over the tools that
    // actually ship. BOTH sites route through the ONE
    // shared estimateSystemTokensFactored helper — same two inputs (frozen
    // system prompt + aggregate tool-overhead chars), script-aware divisor —
    // so the partition AND the factoring cannot drift between the sites.
    expect(toolAssemblySource).toMatch(
      /let cachedSystemTokensEstimate = estimateSystemTokensFactored\(\s*promptResult\.systemPrompt,\s*toolDefOverheadCharsValue,\s*\)/,
    );
    // Post-deferral recompute site: same helper, re-reduced over the shipped set.
    expect(toolAssemblySource).toMatch(
      /cachedSystemTokensEstimate = estimateSystemTokensFactored\(\s*promptResult\.systemPrompt,\s*toolDefOverheadChars\(mergedCustomTools\),\s*\)/,
    );
    // The helper's body: system prompt (factored effective chars) + flat tool
    // overhead ONLY — the shared tool-overhead.ts reduce.
    expect(toolAssemblySource).toContain(
      "(systemPrompt.length / scriptTokenFactor(systemPrompt) + toolOverheadChars) / CHARS_PER_TOKEN_RATIO",
    );
  });

  it("S does NOT fold the dynamic preamble or inline memory into the system-token estimate", () => {
    // Negative lock scoped to the S-estimate expressions: NO assignment of
    // cachedSystemTokensEstimate (initial `let` or the post-deferral recompute)
    // may reference dynamicPreamble or inlineMemory. (Scoped per statement so
    // it is not perturbed by unrelated occurrences elsewhere.)
    const sites = [...toolAssemblySource.matchAll(/cachedSystemTokensEstimate = estimateSystemTokensFactored\(/g)];
    expect(sites.length).toBeGreaterThanOrEqual(2); // pre-deferral let + post-deferral recompute
    for (const site of sites) {
      const end = toolAssemblySource.indexOf(");", site.index);
      expect(end).toBeGreaterThan(site.index ?? -1);
      const estimateExpr = toolAssemblySource.slice(site.index, end);
      expect(estimateExpr).not.toMatch(/dynamicPreamble|inlineMemory/);
    }
    // And the shared helper body itself: systemPrompt + toolOverheadChars only.
    const helperIdx = toolAssemblySource.indexOf("function estimateSystemTokensFactored(");
    expect(helperIdx).toBeGreaterThan(-1);
    const helperBody = toolAssemblySource.slice(helperIdx, toolAssemblySource.indexOf("}", helperIdx));
    expect(helperBody).not.toMatch(/dynamicPreamble|inlineMemory/);
  });

  // The open behavioral question was traced to ground.
  // The DAG ingestion hook (installDagIngestionHook, dag-reconciliation.ts:353)
  // stores the RAW conversation message — the preamble + inlineMemory are a
  // send-time decoration on the OUTGOING prompt, never persisted — so the
  // injected memory is in NEITHER S NOR the DAG history budget (H). It is instead
  // absorbed by the token-budget cushion (safety margin M + context-rot buffer R,
  // token-budget.ts:52-58), which is precisely the cushion's purpose. That is safe
  // BY DESIGN as long as the recall cap stays under the cushion. The invariant
  // below guards exactly that coupling so it cannot silently regress (e.g. someone
  // raising the maxContextChars default or shrinking the safety-margin floor).
  // (budget-precheck.ts measures the full enveloped prompt, but only vs the operator
  // SPEND budget — it is not a context-window backstop, so the cushion is the guard.)
  it("INVARIANT: the recall injection cap fits within the safety-margin floor (window-independent) → the unaccounted preamble is always absorbed by the budget cushion", () => {
    const ragDefaults = RagConfigSchema.parse({});
    const recallCapTokens = Math.ceil(ragDefaults.maxContextChars / CHARS_PER_TOKEN_RATIO);
    // M (safety margin) has an absolute floor of MIN_SAFETY_MARGIN_TOKENS on ANY
    // window size, and R (context-rot buffer, 25% of window) is additional headroom
    // on top — so fitting under the floor ALONE proves the injection is absorbed for
    // every model, not just large-context ones.
    expect(recallCapTokens).toBeLessThanOrEqual(MIN_SAFETY_MARGIN_TOKENS);
  });
});
