// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the account a halted sub-agent hands its parent in place of silence.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { buildHaltedAccount } from "./halted-account.js";

// ---------------------------------------------------------------------------
// Halted sub-agent: an empty return must not read as "nothing was found"
// ---------------------------------------------------------------------------

/**
 * A halted sub-agent returns only its final assistant text. When it is killed before composing
 * one, that text is empty — and an empty return is indistinguishable, to the parent, from a
 * sub-task that ran fine and found nothing.
 *
 * Ground truth from a live run (rig session file, 9 records): a child completed a full ranking —
 * 188 subjects, coverage proven, present INLINE at 6369 bytes with no offload marker — then a
 * sibling call timed out, two narrowed retries followed, and the last two records are assistant
 * messages carrying `thinking` content and no text. The child was killed mid-retry. The parent,
 * handed an empty string, told the user there were no valid results to report. Nothing had
 * discarded the work and the model had not declined to report it: the parent was reasoning over
 * silence.
 *
 * This builds the account that replaces that silence. It carries only facts the runner already
 * holds — the abort category, its hint, and the step count — and deliberately does NOT attempt to
 * salvage the child's tool output: the runner does not hold the child's session path, and
 * hand-building one is the documented bug class. So the account makes the loss VISIBLE and
 * actionable without inventing a recovery it cannot honour, and states plainly that it is not a
 * result, so a parent cannot relay it as one.
 */
describe("halted sub-agent account", () => {
  it("states that the run was halted rather than finished", () => {
    const account = buildHaltedAccount({
      finishReason: "prompt_timeout",
      stepsExecuted: 4,
      category: "timeout",
      hint: "raise the prompt stall budget",
    });

    expect(account.toLowerCase()).toContain("halted");
    // The parent is an LLM reading this as a tool result; it must not be able to relay it as an
    // answer, which is the failure this replaces.
    expect(account.toLowerCase()).toContain("not a result");
  });

  it("reports how much work completed before the halt", () => {
    const account = buildHaltedAccount({
      finishReason: "prompt_timeout",
      stepsExecuted: 4,
      category: "timeout",
    });

    // "4 steps completed" is the difference between "found nothing" and "was cut off mid-task",
    // which is what the user actually needed to be told.
    expect(account).toContain("4");
  });

  it("says the sub-task's findings were not returned", () => {
    const account = buildHaltedAccount({
      finishReason: "max_steps",
      stepsExecuted: 12,
      category: "step_limit",
    });

    expect(account.toLowerCase()).toContain("not returned");
  });

  it("names the abort category and hint when the classifier supplied them", () => {
    const account = buildHaltedAccount({
      finishReason: "prompt_timeout",
      stepsExecuted: 1,
      category: "timeout",
      hint: "raise the prompt stall budget",
    });

    expect(account).toContain("timeout");
    expect(account).toContain("raise the prompt stall budget");
  });

  it("omits the hint cleanly when the classifier had none", () => {
    const account = buildHaltedAccount({
      finishReason: "unknown_reason",
      stepsExecuted: 0,
      category: "unknown",
    });

    expect(account).not.toContain("undefined");
    expect(account.trim()).toBe(account);
  });

  it("stays bounded so a halt account cannot crowd out the parent's context", () => {
    const account = buildHaltedAccount({
      finishReason: "prompt_timeout",
      stepsExecuted: 7,
      category: "timeout",
      hint: "x".repeat(5000),
    });

    expect(account.length).toBeLessThanOrEqual(1000);
  });
});
