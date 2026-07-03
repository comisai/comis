// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { HEARTBEAT_OK_TOKEN, NO_REPLY_TOKEN, SILENT_PREFIX } from "@comis/shared";
import { parseWakeGateVerdict } from "./wake-gate-verdict.js";
import type { WakeGateRunOutcome } from "./wake-gate-verdict.js";

/**
 * Build a gate run outcome with clean-exit defaults; override per case.
 * Defaults model the happy path: stdout empty, exit clean, no timeout/overflow.
 */
function outcome(partial: Partial<WakeGateRunOutcome> = {}): WakeGateRunOutcome {
  return { stdout: "", exitCode: 0, timedOut: false, overflowed: false, ...partial };
}

describe("parseWakeGateVerdict — JSON verdict on the last non-empty line", () => {
  it("resolves an explicit boolean false verdict to a skip", () => {
    const verdict = parseWakeGateVerdict(outcome({ stdout: '{"wake":false}' }));
    expect(verdict.wake).toBe(false);
    expect(verdict.context).toBeUndefined();
    expect(verdict.deliver).toBeUndefined();
  });

  it("resolves a true verdict and carries its context string", () => {
    const verdict = parseWakeGateVerdict(outcome({ stdout: '{"wake":true,"context":"found X"}' }));
    expect(verdict).toEqual({ wake: true, context: "found X" });
  });

  it("resolves a false verdict and carries its deliver string", () => {
    const verdict = parseWakeGateVerdict(outcome({ stdout: '{"wake":false,"deliver":"backup OK"}' }));
    expect(verdict).toEqual({ wake: false, deliver: "backup OK" });
  });

  it("reads the verdict from the last non-empty line past logs and blank lines", () => {
    const stdout = 'log: starting\nfetched 3 items\n{"wake":false}\n\n  \n';
    const verdict = parseWakeGateVerdict(outcome({ stdout }));
    expect(verdict.wake).toBe(false);
  });

  it("treats a null exit code as a clean exit and honors the JSON verdict", () => {
    const verdict = parseWakeGateVerdict(outcome({ stdout: '{"wake":false}', exitCode: null }));
    expect(verdict.wake).toBe(false);
  });

  it("omits a non-string context from an otherwise valid verdict", () => {
    const verdict = parseWakeGateVerdict(outcome({ stdout: '{"wake":true,"context":123}' }));
    expect(verdict).toEqual({ wake: true });
  });

  it("omits a non-string deliver from an otherwise valid verdict", () => {
    const verdict = parseWakeGateVerdict(outcome({ stdout: '{"wake":false,"deliver":123}' }));
    expect(verdict).toEqual({ wake: false });
  });

  it("bounds an explicit-JSON context to the content-light cap (no unbounded prompt injection)", () => {
    // An explicit {"wake":true,"context":"<huge>"} must honor the SAME 4000-char
    // bound the fail-open tail applies — otherwise up to the runner's 4 MiB stdout
    // cap could enter the agent_turn prompt.
    const bigContext = "C".repeat(5000);
    const verdict = parseWakeGateVerdict(outcome({ stdout: JSON.stringify({ wake: true, context: bigContext }) }));
    expect(verdict.wake).toBe(true);
    expect(verdict.context).toBeDefined();
    expect((verdict.context ?? "").length).toBeLessThanOrEqual(4000);
  });

  it("bounds an explicit-JSON deliver to the content-light cap", () => {
    const bigDeliver = "D".repeat(5000);
    const verdict = parseWakeGateVerdict(outcome({ stdout: JSON.stringify({ wake: false, deliver: bigDeliver }) }));
    expect(verdict.wake).toBe(false);
    expect((verdict.deliver ?? "").length).toBeLessThanOrEqual(4000);
  });
});

describe("parseWakeGateVerdict — malformed verdicts fall through to fail-open wake", () => {
  it("does not treat a non-boolean wake field as a JSON verdict", () => {
    const verdict = parseWakeGateVerdict(outcome({ stdout: '{"wake":"yes"}' }));
    expect(verdict.wake).toBe(true);
  });

  it("does not treat a JSON array as a verdict object", () => {
    const verdict = parseWakeGateVerdict(outcome({ stdout: "[true]" }));
    expect(verdict.wake).toBe(true);
  });

  it("does not treat a bare JSON null literal as a verdict object", () => {
    const verdict = parseWakeGateVerdict(outcome({ stdout: "null" }));
    expect(verdict.wake).toBe(true);
  });

  it("does not treat a bare JSON number literal as a verdict object", () => {
    const verdict = parseWakeGateVerdict(outcome({ stdout: "42" }));
    expect(verdict.wake).toBe(true);
  });
});

describe("parseWakeGateVerdict — silent sentinels on a known non-empty last line", () => {
  it("maps the heartbeat-ok sentinel to a skip with no deliver", () => {
    const verdict = parseWakeGateVerdict(outcome({ stdout: HEARTBEAT_OK_TOKEN }));
    expect(verdict).toEqual({ wake: false });
  });

  it("maps the no-reply sentinel to a skip with no deliver", () => {
    const verdict = parseWakeGateVerdict(outcome({ stdout: NO_REPLY_TOKEN }));
    expect(verdict).toEqual({ wake: false });
  });

  it("maps a silent-prefixed line to a skip carrying the trailing text", () => {
    const verdict = parseWakeGateVerdict(outcome({ stdout: `${SILENT_PREFIX} backup OK` }));
    expect(verdict).toEqual({ wake: false, deliver: "backup OK" });
  });

  it("matches the silent prefix case-insensitively and preserves the text case", () => {
    const verdict = parseWakeGateVerdict(outcome({ stdout: `${SILENT_PREFIX.toLowerCase()} Hi` }));
    expect(verdict).toEqual({ wake: false, deliver: "Hi" });
  });

  it("treats a bare silent prefix with no trailing text as a skip with no deliver", () => {
    const verdict = parseWakeGateVerdict(outcome({ stdout: SILENT_PREFIX }));
    expect(verdict).toEqual({ wake: false });
  });
});

describe("parseWakeGateVerdict — fail-open covers every non-verdict outcome", () => {
  it("wakes on bare non-verdict stdout and passes it through as context", () => {
    const verdict = parseWakeGateVerdict(outcome({ stdout: "still green" }));
    expect(verdict).toEqual({ wake: true, context: "still green" });
  });

  it("wakes on empty stdout after a clean exit without resolving silent", () => {
    const verdict = parseWakeGateVerdict(outcome({ stdout: "" }));
    expect(verdict.wake).toBe(true);
    expect(verdict.deliver).toBeUndefined();
  });

  it("wakes on whitespace-only stdout that has no non-empty line", () => {
    const verdict = parseWakeGateVerdict(outcome({ stdout: "\n  \n" }));
    expect(verdict.wake).toBe(true);
  });

  it("wakes on a non-zero exit even when stdout carries a skip verdict", () => {
    const verdict = parseWakeGateVerdict(outcome({ stdout: '{"wake":false}', exitCode: 1 }));
    expect(verdict.wake).toBe(true);
  });

  it("wakes when the gate run timed out", () => {
    const verdict = parseWakeGateVerdict(outcome({ stdout: "partial", timedOut: true }));
    expect(verdict.wake).toBe(true);
  });

  it("wakes when the gate run overflowed its stdout cap", () => {
    const verdict = parseWakeGateVerdict(outcome({ stdout: "partial", overflowed: true }));
    expect(verdict.wake).toBe(true);
  });

  it("wakes with no context when a failed run produced no stdout", () => {
    const verdict = parseWakeGateVerdict(outcome({ stdout: "", timedOut: true }));
    expect(verdict.wake).toBe(true);
    expect(verdict.context).toBeUndefined();
  });

  it("bounds the context tail to a content-light length on very long stdout", () => {
    const verdict = parseWakeGateVerdict(outcome({ stdout: "A".repeat(5000) }));
    expect(verdict.wake).toBe(true);
    expect(verdict.context).toBeDefined();
    expect((verdict.context ?? "").length).toBeLessThanOrEqual(4000);
  });
});

describe("parseWakeGateVerdict — the empty-case inversion guard, proven both ways", () => {
  it("skips on an explicit false verdict yet wakes on empty output", () => {
    const skip = parseWakeGateVerdict(outcome({ stdout: '{"wake":false}' }));
    const empty = parseWakeGateVerdict(outcome({ stdout: "" }));
    expect(skip.wake).toBe(false);
    expect(empty.wake).toBe(true);
  });
});
