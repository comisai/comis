// SPDX-License-Identifier: Apache-2.0
/**
 * Architecture guard for the window-isolation invariant (the "long-running
 * coordinator" case).
 *
 * The invariant: a spawned `sessions_spawn` child runs an ISOLATED context loop
 * whose transcript NEVER re-enters the parent (lead) window. The child gets its
 * own fresh step budget + its own ephemeral session (its OWN message list, not
 * the parent's), returns a bounded summary-scale shape (never a `messages[]`
 * transcript), and the runner injects ONLY a single bounded announcement built
 * from the condensed summary — with `includeParentHistory` defaulting to
 * `"none"` so the child does not inherit the parent window either. So a
 * megabyte child grows the lead's window by a summary, not by the child's whole
 * conversation: `main_context ≈ Σ(child summaries)`, roughly flat across N
 * tasks.
 *
 * This is asserted STRUCTURALLY, never numerically. A token-magnitude test
 * (`expect(parentTokens).toBeLessThan(Σ child work)`) is non-deterministic
 * (LLM output varies) and would flake. The
 * deterministic, testable form is the STRUCTURE: the child-return type is the
 * bounded `{response, tokensUsed, cost, ...}` object with no `messages:` key,
 * and the only parent-injection site is the bounded announcement.
 *
 * "Built but not wired" — or here, "implicitly true, then silently regressed" —
 * has been this program's #1 recurring blocker (per
 * `sandbox-no-downgrade.test.ts:14`). Window isolation is currently *implicit*:
 * it works because nobody appends the child transcript to the parent. This is a
 * shrink-only SOURCE GUARD (no allowlist, mirroring
 * `sandbox-no-downgrade.test.ts`): a comment-stripped source-grep pins the
 * isolated child loop in `setup-cross-session-graph.ts` and the single bounded
 * injection site + `includeParentHistory` default in `sub-agent-runner.ts` — so
 * a refactor cannot leak the transcript into the lead window without turning
 * this test RED.
 *
 * Discriminating power (the one-line edits that flip each assertion to RED):
 *   - Removing `createStepCounter(...)` (child reuses the parent step
 *     budget) or `createEphemeralComisSessionManager(...)` (child shares the
 *     parent message list) fails the isolation grep.
 *   - Adding `messages: result.messages` (or `messages:
 *     result.transcript`) to `buildExecuteSubAgent`'s bounded return — i.e.
 *     returning the child transcript to the parent — fails the no-leak grep.
 *   - Replacing `condensedResult.result.summary` with `result.response`
 *     (injecting the raw child output) or flipping the
 *     `includeParentHistory ?? "none"` default to `"summary"` fails.
 *
 * The behavioral companion (the parent session grows by exactly one
 * announcement, not by the child's step count) lives next to the real runner in
 * `packages/agent/src/spawn/sub-agent-runner.test.ts`. This architecture test
 * deliberately stays source-grep only (the file's documented invariant: don't
 * alias-route heavy packages to dist/ when a source guard suffices).
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { formatViolations, type ViolationCitation } from "../support/architecture-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");

/** The in-process isolated child loop: fresh step counter, ephemeral session,
 *  the bounded child→parent return shape. */
const CHILD_LOOP_TS = resolve(
  REPO_ROOT,
  "packages/daemon/src/wiring/setup-cross-session/setup-cross-session-graph.ts",
);
/** The runner: the single bounded announcement site + the includeParentHistory
 *  default. */
const RUNNER_TS = resolve(REPO_ROOT, "packages/agent/src/spawn/sub-agent-runner.ts");

const DESIGN_REF = "the long-running coordinator window-isolation invariant";

/** Strip line + block comments so a token inside a comment cannot satisfy (or
 *  defeat) a structural assertion — a comment naming `messages:` is NOT a
 *  transcript leak. Copied verbatim from sandbox-no-downgrade.test.ts:48. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .split(/\r?\n/)
    .map((l) => {
      const t = l.trim();
      return t.startsWith("//") || t.startsWith("*") ? "" : l;
    })
    .join("\n");
}

/**
 * The bounded child→parent return block in `buildExecuteSubAgent`. Anchored on
 * the `response: result.response` field (the first member of the real return)
 * so it captures EXACTLY the child-completion return — not the unrelated inline
 * `promptTimeout` IIFE return, and not the `loadByFormattedKey` type signature.
 * `[^}]*` before the anchor keeps the match from spanning across an earlier
 * closing brace. A file-wide `/return[\s\S]{0,200}messages:/` was rejected: once
 * comments are stripped it bridges the early `return "long";` to the
 * `{ messages: unknown[] }` type signature — a false positive (the regex must be
 * tuned to the final source).
 */
function extractChildReturnBlock(stripped: string): string | undefined {
  const m = stripped.match(/return\s*\{[^}]*response:\s*result\.response[\s\S]*?\};/);
  return m?.[0];
}

describe("window-isolation invariant — the child loop never writes the parent window", () => {
  it("verifies the child loop runs an isolated context with its own step budget + ephemeral session", () => {
    const src = stripComments(readFileSync(CHILD_LOOP_TS, "utf8"));
    // Fresh per-spawn step budget — the child cannot draw down the parent's
    // step counter (isolated spawn, not fork-mode).
    expect(src).toMatch(/createStepCounter\s*\(/);
    // The child runs on its OWN ephemeral session adapter — its own message
    // list, not the parent's. (Reuse/persistent spawns are disk-backed; the
    // default isolated spawn is ephemeral.)
    expect(src).toMatch(/createEphemeralComisSessionManager\s*\(/);
  });

  it("verifies buildExecuteSubAgent returns a summary-scale shape, never the child transcript or the parent message list", () => {
    const src = stripComments(readFileSync(CHILD_LOOP_TS, "utf8"));
    const childReturn = extractChildReturnBlock(src);

    // The bounded child→parent return must exist and must be summary-scale.
    expect(
      childReturn,
      `Could not locate buildExecuteSubAgent's bounded child→parent return (anchored on "response: result.response"). If the return shape was renamed, retune extractChildReturnBlock — but the child must still return a summary-scale object, never a transcript. See: ${DESIGN_REF}`,
    ).toBeDefined();
    const block = childReturn ?? "";
    // Positive: the bounded fields are present (response + the metrics, not a
    // transcript). This pins the shape so a refactor cannot quietly swap it.
    expect(block).toMatch(/response:\s*result\.response/);

    // Negative (the load-bearing leak guard): the child→parent return carries NO
    // `messages:` key. Returning `messages: result.messages` (the child's
    // transcript) would let a megabyte child blow up the lead window — the exact
    // regression this guard fails on.
    const violations: ViolationCitation[] = /\bmessages\b\s*:/.test(block)
      ? [
          {
            file: "packages/daemon/src/wiring/setup-cross-session/setup-cross-session-graph.ts",
            line: 0,
            snippet:
              "buildExecuteSubAgent's child→parent return includes a `messages:` key — the child transcript is leaking into the lead window.",
          },
        ]
      : [];
    expect(
      violations,
      formatViolations({
        description:
          "The isolated child loop returns its transcript / message list to the parent — Information Disclosure + context-exhaustion DoS.",
        violations,
        suggestedFix:
          "buildExecuteSubAgent must return ONLY the bounded summary-scale shape ({ response, tokensUsed, cost, finishReason, stepsExecuted, toolCallHistory }). Never add a `messages:`/transcript field — the parent receives the condensed summary via the runner's announcement, not the child's raw conversation.",
        designRef: DESIGN_REF,
      }),
    ).toEqual([]);
  });

  it("verifies the runner injects ONLY a bounded summary into the parent (single injection site, includeParentHistory defaults to none)", () => {
    const src = stripComments(readFileSync(RUNNER_TS, "utf8"));
    // The parent-facing announcement is built from the BOUNDED condensed
    // summary — not the raw child response. This is the single injection site
    // that grows the lead window.
    expect(src).toMatch(/condensedResult\.result\.summary/);
    // The child does not inherit the parent window by default either:
    // includeParentHistory defaults to "none" (opt-in "summary" only).
    expect(src).toMatch(/includeParentHistory[\s\S]{0,40}\?\?[\s\S]{0,10}"none"/);

    // STRUCTURAL only — explicitly NOT a token-magnitude assertion: a numeric
    // main_context ≈ Σ test would flake.
  });
});
