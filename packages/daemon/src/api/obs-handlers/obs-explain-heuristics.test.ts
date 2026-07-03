// SPDX-License-Identifier: Apache-2.0
/**
 * `obs-explain-heuristics` — deterministic root-cause registry tests.
 *
 * Pins the ORDERING that makes BOTH frozen incident fixtures pass:
 *   - 678 signals carry hasMisclassificationSignal AND hasDoNotRetrySignal AND a
 *     breakerOpenedTool (the breaker tripped on the misclassified successes) →
 *     content_heuristic_misclassification wins (it is the ROOT; the breaker is
 *     downstream).
 *   - 503 signals carry ONLY the breaker/repeated-failure signal (no
 *     misclassification — a real transport failure) → breaker_opened_repeated_failure.
 *
 * Plus the three insurance codes (exec_dependency / provider_timeout /
 * context_bloat) and the no-match null. Every RootCause is fully populated
 * (code + detail + non-empty suggestedNextSteps:string[]).
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import type { IncidentSignals } from "@comis/core";
import { HEURISTICS, rootCause } from "./obs-explain-heuristics.js";

/** Build a minimal IncidentSignals with only the fields a test cares about. */
function makeSignals(overrides?: Partial<IncidentSignals>): IncidentSignals {
  return {
    sessionKey: "test-session",
    toolStats: {},
    failures: [],
    breakerEvents: [],
    offloads: [],
    hasDoNotRetrySignal: false,
    repeatedFailureCount: {},
    hasMisclassificationSignal: false,
    ...overrides,
  };
}

describe("obs-explain-heuristics", () => {
  // ------------------------------------------------------------------------
  // The frozen-fixture ordering: misclassification (root) over breaker (symptom).
  // ------------------------------------------------------------------------

  it("678: misclassification+breaker both present → content_heuristic_misclassification (root over symptom)", () => {
    const r = rootCause(
      makeSignals({
        hasMisclassificationSignal: true,
        misclassifiedTool: "web_fetch",
        misclassifiedToken: "403",
        hasDoNotRetrySignal: true,
        breakerOpenedTool: "web_fetch",
        repeatedFailureCount: { web_fetch: 14 },
        mostFailedTool: "web_fetch",
      }),
    );
    expect(r).not.toBeNull();
    expect(r!.code).toBe("content_heuristic_misclassification");
    expect(r!.detail).toMatch(/web_fetch/);
    expect(r!.detail).toMatch(/403|status|token/);
    expect(Array.isArray(r!.suggestedNextSteps)).toBe(true);
    expect(r!.suggestedNextSteps.length).toBeGreaterThan(0);
  });

  it("503: breaker signal, no misclassification → breaker_opened_repeated_failure (+toolName)", () => {
    const r = rootCause(
      makeSignals({
        hasMisclassificationSignal: false,
        hasDoNotRetrySignal: true,
        breakerOpenedTool: "web_fetch",
        repeatedFailureCount: { web_fetch: 5 },
        mostFailedTool: "web_fetch",
      }),
    );
    expect(r).not.toBeNull();
    expect(r!.code).toBe("breaker_opened_repeated_failure");
    expect(r!.detail).toMatch(/web_fetch/);
    expect(r!.suggestedNextSteps.length).toBeGreaterThan(0);
  });

  it("503 via repeated-failure only (no breaker event, no DO NOT retry) → breaker_opened_repeated_failure", () => {
    const r = rootCause(
      makeSignals({
        hasMisclassificationSignal: false,
        breakerOpenedTool: undefined,
        hasDoNotRetrySignal: false,
        repeatedFailureCount: { web_fetch: 6 },
        mostFailedTool: "web_fetch",
      }),
    );
    expect(r).not.toBeNull();
    expect(r!.code).toBe("breaker_opened_repeated_failure");
    expect(r!.detail).toMatch(/web_fetch/);
  });

  it("repeated-failure BELOW BREAKER_N (and no breaker/DO-NOT-retry) does NOT trip the breaker rule", () => {
    const r = rootCause(
      makeSignals({
        hasMisclassificationSignal: false,
        breakerOpenedTool: undefined,
        hasDoNotRetrySignal: false,
        repeatedFailureCount: { web_fetch: 2 },
        mostFailedTool: "web_fetch",
      }),
    );
    // 2 < BREAKER_N(5), no breaker event, no DO NOT retry → breaker rule must not fire.
    expect(r?.code).not.toBe("breaker_opened_repeated_failure");
  });

  // ------------------------------------------------------------------------
  // Insurance codes (low-risk corpus coverage).
  // ------------------------------------------------------------------------

  it("insurance: exec_dependency (errorKind dependency + ModuleNotFoundError in preview)", () => {
    const r = rootCause(
      makeSignals({
        failures: [
          {
            seq: 0,
            toolName: "code_exec",
            classifiedFailureBy: "",
            transportOk: false,
            errorKind: "dependency",
            resultDigest: "abc",
            resultBytes: 10,
            errorPreview: "Traceback: ModuleNotFoundError: No module named 'numpy'",
          },
        ],
      }),
    );
    expect(r).not.toBeNull();
    expect(r!.code).toBe("exec_dependency");
    expect(r!.suggestedNextSteps.length).toBeGreaterThan(0);
  });

  it("insurance: exec_dependency also matches 'Cannot find module'", () => {
    const r = rootCause(
      makeSignals({
        failures: [
          {
            seq: 0,
            toolName: "shell",
            classifiedFailureBy: "",
            transportOk: false,
            errorKind: "dependency",
            resultDigest: "abc",
            resultBytes: 10,
            errorPreview: "Error: Cannot find module 'left-pad'",
          },
        ],
      }),
    );
    expect(r?.code).toBe("exec_dependency");
  });

  it("insurance: provider_timeout (errorKind timeout)", () => {
    const r = rootCause(
      makeSignals({
        failures: [
          {
            seq: 0,
            toolName: "llm_call",
            classifiedFailureBy: "",
            transportOk: false,
            errorKind: "timeout",
            resultDigest: "abc",
            resultBytes: 10,
            errorPreview: "request timed out after 60000ms",
          },
        ],
      }),
    );
    expect(r).not.toBeNull();
    expect(r!.code).toBe("provider_timeout");
    expect(r!.suggestedNextSteps.length).toBeGreaterThan(0);
  });

  it("insurance: context_bloat (offloads ≥ N + token spike)", () => {
    const r = rootCause(
      makeSignals({
        offloads: [
          { seq: 0, toolName: "web_fetch", originalChars: 53095, pointer: "x" },
          { seq: 1, toolName: "web_fetch", originalChars: 41000, pointer: "y" },
          { seq: 2, toolName: "read_file", originalChars: 22000, pointer: "z" },
        ],
      }),
    );
    expect(r).not.toBeNull();
    expect(r!.code).toBe("context_bloat");
    expect(r!.suggestedNextSteps.length).toBeGreaterThan(0);
  });

  // ------------------------------------------------------------------------
  // context_exhausted / output_starved — the two NAMED degradation causes
  // surface as likelyRootCause. Keyed on the (metadata-derived) endReason,
  // lowest priority (a tool-failure cause out-ranks them — they explain the
  // terminal state, not a tool crash).
  // ------------------------------------------------------------------------

  it("endReason=context_exhausted (no tool-failure signal) → context_exhausted root cause", () => {
    const r = rootCause(makeSignals({ endReason: "context_exhausted" }));
    expect(r).not.toBeNull();
    expect(r!.code).toBe("context_exhausted");
    // The hint names the actionable lever (summarizer spend / compaction floor).
    expect(r!.detail).toMatch(/context/i);
    expect(r!.suggestedNextSteps.length).toBeGreaterThan(0);
    expect(r!.suggestedNextSteps.some((s) => /summariz|compact|context/i.test(s))).toBe(true);
  });

  it("endReason=output_starved (no tool-failure signal) → output_starved root cause", () => {
    const r = rootCause(makeSignals({ endReason: "output_starved" }));
    expect(r).not.toBeNull();
    expect(r!.code).toBe("output_starved");
    expect(r!.detail).toMatch(/output|truncat/i);
    expect(r!.suggestedNextSteps.length).toBeGreaterThan(0);
    expect(r!.suggestedNextSteps.some((s) => /maxTokens|output|truncat/i.test(s))).toBe(true);
  });

  it("endReason=spend_exceeded (no tool-failure signal) → spend_exceeded root cause naming observability.spend.*", () => {
    // A spend-killed session used to root-cause to NOTHING (the deterministic
    // verdict had no spend_exceeded case) — so the platform could not diagnose
    // its own dollars kill-switch firing in ONE `comis explain` call.
    // END_REASON_MAP resolves finishReason:"spend_exceeded" → the assembler
    // threads endReason:"spend_exceeded" onto the signals → this NAMED
    // terminal-band verdict fires (same additive mold as the
    // context_exhausted/output_starved rules).
    const r = rootCause(makeSignals({ endReason: "spend_exceeded" }));
    expect(r).not.toBeNull();
    expect(r!.code).toBe("spend_exceeded");
    expect(r!.detail).toMatch(/spend (ceiling|cap)/i);
    // The hint NAMES the exact knob family the operator turns (the §2.7 doctrine:
    // a verdict must name WHICH KNOB, not just WHAT happened).
    expect(r!.suggestedNextSteps.length).toBeGreaterThan(0);
    expect(r!.suggestedNextSteps.some((s) => /observability\.spend\./.test(s))).toBe(true);
  });

  it("a per-ROOT autonomy.budget abort names autonomy.budget.<limb> + the numbers, NOT observability.spend ceilings", () => {
    // The per-root meter (token / wall-clock / aggregateUsd) is a DIFFERENT knob tree
    // than the priced observability.spend ceiling — pointing the operator at
    // observability.spend.* misdirects them. The terminal execution.aborted
    // record carries the tripped limb + numbers, so the verdict names the
    // RIGHT knob in one `explain` call.
    const r = rootCause(
      makeSignals({
        endReason: "spend_exceeded",
        perRootBudget: { limb: "tokens", spent: 30640, cap: 60000, unit: "tokens" },
      }),
    );
    expect(r).not.toBeNull();
    expect(r!.code).toBe("spend_exceeded");
    expect(r!.detail).toMatch(/autonomy\.budget/);
    expect(r!.detail).toContain("tokens");
    expect(r!.detail).toContain("30640");
    expect(r!.detail).toContain("60000");
    expect(r!.suggestedNextSteps.some((s) => /autonomy\.budget\.tokens/.test(s))).toBe(true);
  });

  it("the frozen misclassification verdict OUT-RANKS the spend_exceeded cause (the one signal above spend)", () => {
    // A spend-killed session that ALSO carries the content_heuristic_misclassification
    // signal still reports misclassification: spend_exceeded ranks above the
    // breaker/dependency/timeout tool-failure heuristics (see test above)
    // but stays BELOW the single frozen misclassification verdict,
    // the one specific Comis-defect indicator that keeps top billing.
    const r = rootCause(
      makeSignals({
        endReason: "spend_exceeded",
        hasMisclassificationSignal: true,
        misclassifiedTool: "web_fetch",
        misclassifiedToken: "403",
      }),
    );
    expect(r!.code).toBe("content_heuristic_misclassification");
  });

  it("when the spend kill-switch aborts at admission it out-ranks chronic breaker noise", () => {
    // Live VPS incident: a long-lived chat-API session carried 8 chronic exec
    // failures from PRIOR turns (the per-tool breaker had tripped). It then hit
    // the configured spend ceiling, so the kill-switch aborted the turn at
    // ADMISSION (endReason spend_exceeded). `comis explain` reported
    // breaker_opened_repeated_failure — the chronic noise — masking the
    // administrative kill that is now blocking EVERY new turn (the operator
    // would chase exec failures and never learn their ceiling fired). Tool
    // FAILURES (~0 bytes, ~$0) cannot drive cumulative spend; the ceiling is
    // causally INDEPENDENT of them, so the kill-switch is the acute terminal
    // cause and must out-rank the breaker/dependency/timeout tool-failure
    // heuristics (it still defers to the single frozen misclassification
    // verdict — the one specific Comis-defect indicator; see test above).
    const r = rootCause(
      makeSignals({
        endReason: "spend_exceeded",
        hasDoNotRetrySignal: true,
        breakerOpenedTool: "exec",
        repeatedFailureCount: { exec: 8 },
        mostFailedTool: "exec",
      }),
    );
    expect(r!.code).toBe("spend_exceeded");
  });

  it("a tool-failure cause OUT-RANKS the endReason cause (the new heuristics are lowest priority)", () => {
    // A misclassified-tool session that ALSO ended context_exhausted must still
    // report the upstream tool cause — the endReason heuristic is the fallback.
    const r = rootCause(
      makeSignals({
        endReason: "context_exhausted",
        hasMisclassificationSignal: true,
        misclassifiedTool: "web_fetch",
        misclassifiedToken: "403",
      }),
    );
    expect(r!.code).toBe("content_heuristic_misclassification");
  });

  it("a clean endReason (success) does NOT trip the named-cause heuristics", () => {
    // success / end_turn / a non-cause endReason must NOT produce a verdict from
    // the terminal-state rules (no false degradation cause on a healthy session).
    expect(rootCause(makeSignals({ endReason: "success" }))).toBeNull();
    // endReason ALONE (no tool failures in the signals) names no cause — the
    // catch-all keys on actual failures, not the terminal label.
    expect(rootCause(makeSignals({ endReason: "completed_with_tool_errors" }))).toBeNull();
  });

  // ------------------------------------------------------------------------
  // terminal_drive_opened_without_task — the unattended abandoned-drive case,
  // grounded in a live incident: the agent opened a coding-CLI terminal
  // drive (terminal_session_create) but never delivered a task
  // (terminal_session_send_text), so the build never started. Without this
  // verdict `explain` root-causes NOTHING (endReason:success → null verdict) —
  // the 5-source hand-join that surfaced it is exactly the gap it closes.
  // ------------------------------------------------------------------------

  it("fires when terminal_session_create succeeded but no terminal_session_send_text (drive opened, never tasked)", () => {
    const r = rootCause(
      makeSignals({
        toolStats: {
          terminal_session_create: { ok: 1, failed: 0 },
          terminal_session_wait: { ok: 2, failed: 0 },
          terminal_session_read: { ok: 1, failed: 0 },
        },
        endReason: "success",
      }),
    );
    expect(r).not.toBeNull();
    expect(r!.code).toBe("terminal_drive_opened_without_task");
    expect(r!.suggestedNextSteps.some((s) => /send_text/.test(s))).toBe(true);
  });

  it("OUT-RANKS the completed_with_tool_errors catch-all (a stray failure during the stall is incidental)", () => {
    // Live incident: the agent opened the coding CLI, never sent the task, and
    // a `read` of a directory EISDIR'd. The no-task diagnosis is the root; the
    // stray failure is noise.
    const r = rootCause(
      makeSignals({
        toolStats: {
          terminal_session_create: { ok: 1, failed: 0 },
          read: { ok: 0, failed: 1 },
        },
        failures: [{ toolName: "read", errorKind: "validation" }] as unknown as IncidentSignals["failures"],
        endReason: "completed_with_tool_errors",
      }),
    );
    expect(r!.code).toBe("terminal_drive_opened_without_task");
  });

  it("does NOT fire when a task WAS delivered (send_text succeeded) — the drive ran", () => {
    expect(
      rootCause(
        makeSignals({
          toolStats: {
            terminal_session_create: { ok: 1, failed: 0 },
            terminal_session_send_text: { ok: 1, failed: 0 },
          },
          endReason: "success",
        }),
      ),
    ).toBeNull();
  });

  it("does NOT fire when no terminal drive was opened (no terminal_session_create)", () => {
    expect(
      rootCause(makeSignals({ toolStats: { web_fetch: { ok: 1, failed: 0 } }, endReason: "success" })),
    ).toBeNull();
  });

  it("cites the backgrounding reason in the detail when the drive was promoted to background", () => {
    const r = rootCause(
      makeSignals({
        toolStats: { terminal_session_create: { ok: 1, failed: 0 } },
        terminalDrivePromoted: { reason: "mode_detached", count: 1 },
        endReason: "success",
      }),
    );
    expect(r!.code).toBe("terminal_drive_opened_without_task");
    expect(r!.detail).toMatch(/backgrounded|mode_detached/);
  });

  // ------------------------------------------------------------------------
  // terminal_drive_evicted — the idle/lifetime-reap case, grounded in a live
  // incident where a durable autonomous drive was idle-reaped by the terminal
  // reaper. Without this verdict the eviction is a daemon WARN only —
  // `explain` can't see it, so a reaper-killed drive root-causes NOTHING.
  // The observability completion of the producing-drive keep-alive fix:
  // an idle-reap of a drive that HAD been producing is exactly the canary a
  // keep-alive regression would trip, now a one-call verdict.
  // ------------------------------------------------------------------------

  it("fires on an idle eviction and names it terminal_drive_evicted", () => {
    const r = rootCause(makeSignals({ terminalDriveEvicted: { reason: "idle", idleMs: 1_800_000, wasProducing: false }, endReason: "success" }));
    expect(r).not.toBeNull();
    expect(r!.code).toBe("terminal_drive_evicted");
    expect(r!.detail).toMatch(/idle/);
  });

  it("flags the ACUTE producing-drive idle-reap in the detail (the keep-alive regression canary)", () => {
    const r = rootCause(
      makeSignals({
        // tasked (send_text succeeded) so the no-task verdict does NOT shadow this
        toolStats: { terminal_session_create: { ok: 1, failed: 0 }, terminal_session_send_text: { ok: 1, failed: 0 } },
        terminalDriveEvicted: { reason: "idle", idleMs: 900_000, wasProducing: true },
        endReason: "success",
      }),
    );
    expect(r!.code).toBe("terminal_drive_evicted");
    expect(r!.detail).toMatch(/produc/i); // it names that the drive had been producing when reaped
  });

  it("fires on a wall_clock (lifetime-cap) eviction", () => {
    const r = rootCause(makeSignals({ terminalDriveEvicted: { reason: "wall_clock", idleMs: 7_200_000, wasProducing: true }, endReason: "success" }));
    expect(r!.code).toBe("terminal_drive_evicted");
  });

  it("does NOT fire on a max_sessions eviction (benign LRU to make room — not a drive-cut-short cause)", () => {
    expect(rootCause(makeSignals({ terminalDriveEvicted: { reason: "max_sessions", idleMs: 5_000, wasProducing: false }, endReason: "success" }))).toBeNull();
  });

  it("does NOT fire on a max_interactions eviction (a deliberate turn-budget cap, not a TTL reap)", () => {
    expect(rootCause(makeSignals({ terminalDriveEvicted: { reason: "max_interactions", idleMs: 5_000, wasProducing: false }, endReason: "success" }))).toBeNull();
  });

  it("does NOT fire when no eviction was recorded (cannot regress the frozen non-terminal fixtures)", () => {
    expect(rootCause(makeSignals({ toolStats: { web_fetch: { ok: 1, failed: 0 } }, endReason: "success" }))).toBeNull();
  });

  it("the no-task verdict OUT-RANKS eviction (a drive opened, never tasked, THEN idle-reaped — no-task is the root)", () => {
    const r = rootCause(
      makeSignals({
        toolStats: { terminal_session_create: { ok: 1, failed: 0 } }, // created, never send_text'd
        terminalDriveEvicted: { reason: "idle", idleMs: 1_800_000, wasProducing: false },
        endReason: "success",
      }),
    );
    expect(r!.code).toBe("terminal_drive_opened_without_task");
  });

  it("a degraded session with tool failures and no named cause gets a catch-all tool-failure verdict", () => {
    // Live finding: an induced 2-tool-failure session
    // (memory_get + image_analyze, errorKind dependency, endReason
    // completed_with_tool_errors) fell through all 9 named rules to a NULL
    // verdict — comis explain captured the data but root-caused nothing.
    const r = rootCause(
      makeSignals({
        endReason: "completed_with_tool_errors",
        toolStats: {
          memory_get: { ok: 0, failed: 1, topErrorKind: "dependency" },
          image_analyze: { ok: 0, failed: 1, topErrorKind: "dependency" },
        },
        failures: [
          { seq: 8, toolName: "image_analyze", classifiedFailureBy: "sdk_iserror", transportOk: false, errorKind: "dependency", resultDigest: "d", resultBytes: 0, errorPreview: "" },
          { seq: 7, toolName: "memory_get", classifiedFailureBy: "sdk_iserror", transportOk: false, errorKind: "dependency", resultDigest: "d", resultBytes: 0, errorPreview: "" },
        ],
      }),
    );
    expect(r).not.toBeNull();
    expect(r!.code).toBe("completed_with_tool_errors");
    // Names the failed tools so the operator knows WHERE to look.
    expect(r!.detail).toContain("image_analyze");
    expect(r!.detail).toContain("memory_get");
    expect(r!.suggestedNextSteps.length).toBeGreaterThan(0);
  });

  it("the catch-all never fires on a clean session (no failures)", () => {
    expect(rootCause(makeSignals({ endReason: "success", toolStats: { web_fetch: { ok: 3, failed: 0 } } }))).toBeNull();
  });

  // ------------------------------------------------------------------------
  // The recall_miss verdict.
  // ------------------------------------------------------------------------

  const allMissRecall = { recalls: 2, zeroHits: 2, lastLanes: 3, lastFinalCount: 0, rerankerAvailable: false };

  it("a DEGRADED session whose recalls ALL missed (no tool/context cause) → recall_miss", () => {
    // Grounded in live Hebrew-language runs where recall silently returned
    // nothing and comis explain root-caused nothing.
    const r = rootCause(makeSignals({ endReason: "error", degraded: true, recall: allMissRecall }));
    expect(r).not.toBeNull();
    expect(r!.code).toBe("recall_miss");
    expect(r!.detail).toContain("all 2 recall");
    expect(r!.detail).toContain("lanes=3");
    expect(r!.detail).toContain("reranker absent");
    // Points at the two real gaps from the live runs: scope + non-Latin lanes.
    expect(r!.suggestedNextSteps.join(" ")).toMatch(/scope/i);
    expect(r!.suggestedNextSteps.join(" ")).toMatch(/trigram|non-Latin/i);
  });

  it("a zero-hit recall on a HEALTHY (non-degraded) turn is benign → no verdict", () => {
    // The agent simply didn't need memory. degraded=false must never name a cause.
    expect(rootCause(makeSignals({ endReason: "success", degraded: false, recall: allMissRecall }))).toBeNull();
    // Defensive: degraded absent entirely is also benign.
    expect(rootCause(makeSignals({ recall: allMissRecall }))).toBeNull();
  });

  it("a degraded session where SOME recalls hit does not fire recall_miss", () => {
    const r = rootCause(
      makeSignals({
        endReason: "error",
        degraded: true,
        recall: { recalls: 3, zeroHits: 1, lastLanes: 4, lastFinalCount: 5, rerankerAvailable: true },
      }),
    );
    expect(r).toBeNull();
  });

  it("recall_miss yields to the tool-failure catch-all (mutually exclusive — failures present)", () => {
    // A degraded session with BOTH zero-hit recalls AND tool failures is a
    // tool-failure session; recall_miss requires failures.length===0 so the
    // catch-all wins and the operator is pointed at the failing tool.
    const r = rootCause(
      makeSignals({
        endReason: "completed_with_tool_errors",
        degraded: true,
        recall: allMissRecall,
        toolStats: { web_fetch: { ok: 0, failed: 1, topErrorKind: "dependency" } },
        failures: [
          { seq: 1, toolName: "web_fetch", classifiedFailureBy: "sdk_iserror", transportOk: false, errorKind: "dependency", resultDigest: "d", resultBytes: 0, errorPreview: "" },
        ],
      }),
    );
    expect(r).not.toBeNull();
    expect(r!.code).toBe("completed_with_tool_errors");
  });

  // ------------------------------------------------------------------------
  // No-match + populated-shape invariants.
  // ------------------------------------------------------------------------

  it("clean signals → rootCause returns null", () => {
    expect(rootCause(makeSignals())).toBeNull();
  });

  it("every RootCause a rule can emit is fully populated (code + detail + string[] steps)", () => {
    // Drive each rule with a signal that trips it, then assert the shape.
    const trippers: IncidentSignals[] = [
      makeSignals({ hasMisclassificationSignal: true, misclassifiedTool: "web_fetch", misclassifiedToken: "403" }),
      makeSignals({ breakerOpenedTool: "web_fetch", hasDoNotRetrySignal: true, mostFailedTool: "web_fetch", repeatedFailureCount: { web_fetch: 5 } }),
      makeSignals({ offloads: [
        { seq: 0, toolName: "t", originalChars: 53095, pointer: "p" },
        { seq: 1, toolName: "t", originalChars: 41000, pointer: "p" },
        { seq: 2, toolName: "t", originalChars: 22000, pointer: "p" },
      ] }),
      makeSignals({ failures: [{ seq: 0, toolName: "x", classifiedFailureBy: "", transportOk: false, errorKind: "dependency", resultDigest: "d", resultBytes: 1, errorPreview: "ModuleNotFoundError: nope" }] }),
      makeSignals({ failures: [{ seq: 0, toolName: "x", classifiedFailureBy: "", transportOk: false, errorKind: "timeout", resultDigest: "d", resultBytes: 1, errorPreview: "timed out" }] }),
    ];
    for (const s of trippers) {
      const r = rootCause(s);
      expect(r).not.toBeNull();
      expect(typeof r!.code).toBe("string");
      expect(r!.code.length).toBeGreaterThan(0);
      expect(typeof r!.detail).toBe("string");
      expect(r!.detail.length).toBeGreaterThan(0);
      expect(Array.isArray(r!.suggestedNextSteps)).toBe(true);
      expect(r!.suggestedNextSteps.length).toBeGreaterThan(0);
      expect(r!.suggestedNextSteps.every((x) => typeof x === "string" && x.length > 0)).toBe(true);
    }
  });

  it("HEURISTICS is a non-empty ordered ReadonlyArray of predicate functions", () => {
    expect(Array.isArray(HEURISTICS)).toBe(true);
    expect(HEURISTICS.length).toBeGreaterThanOrEqual(5);
    for (const h of HEURISTICS) expect(typeof h).toBe("function");
  });

  // ------------------------------------------------------------------------
  // The outcome_unresolved verdict — BENIGN, lowest priority
  // (Defer ≠ Retry). Fires on a finished trajectory whose learning shadow saw
  // the turn but resolved no outcome; ranks BELOW every acute tool-failure cause.
  // ------------------------------------------------------------------------

  const UNRESOLVED_LEARNING: IncidentSignals["learning"] = {
    outcomeResolved: false,
    sources: ["tool"],
    skillsUsed: [],
    skillFailures: [],
    synthesisAbstained: false,
  };

  it("an unresolved learning signal with NO acute failure → outcome_unresolved", () => {
    const r = rootCause(makeSignals({ learning: UNRESOLVED_LEARNING }));
    expect(r).not.toBeNull();
    expect(r!.code).toBe("outcome_unresolved");
    expect(r!.detail).toMatch(/no.*resolvable outcome/i);
    // The hint points at the judge fallback (the shadow-mode coverage lever).
    expect(r!.suggestedNextSteps.join(" ")).toMatch(/learningOutcome\.judge\.enabled/);
    expect(r!.suggestedNextSteps).toContain("obs.explain depth=full");
  });

  it("outcome_unresolved ranks BELOW an acute tool failure (Defer ≠ Retry)", () => {
    // The SAME unresolved-learning signal, now with a real tool failure, must
    // report the upstream tool cause — the unresolved outcome is benign and
    // never masks an acute error.
    const r = rootCause(
      makeSignals({
        learning: UNRESOLVED_LEARNING,
        endReason: "completed_with_tool_errors",
        toolStats: { web_fetch: { ok: 0, failed: 1, topErrorKind: "dependency" } },
        failures: [
          { seq: 1, toolName: "web_fetch", classifiedFailureBy: "sdk_iserror", transportOk: false, errorKind: "dependency", resultDigest: "d", resultBytes: 0, errorPreview: "" },
        ],
      }),
    );
    expect(r).not.toBeNull();
    expect(r!.code).toBe("completed_with_tool_errors");
  });

  it("a named acute cause (misclassification) out-ranks outcome_unresolved", () => {
    const r = rootCause(
      makeSignals({
        learning: UNRESOLVED_LEARNING,
        hasMisclassificationSignal: true,
        misclassifiedTool: "web_fetch",
        misclassifiedToken: "403",
      }),
    );
    expect(r!.code).toBe("content_heuristic_misclassification");
  });

  it("a RESOLVED learning outcome (outcomeResolved:true) names NO cause", () => {
    // A resolved outcome (incl. an explicit `unknown` resolution would set
    // outcomeResolved per the assembler) is not a degradation — no verdict.
    const r = rootCause(
      makeSignals({
        learning: { outcomeResolved: true, outcome: "success", sources: ["tool"], skillsUsed: [], skillFailures: [], synthesisAbstained: false },
      }),
    );
    expect(r).toBeNull();
  });

  it("an absent learning block names no cause (clean session)", () => {
    expect(rootCause(makeSignals())).toBeNull();
  });

  it("the frozen 678/503 fixtures are UNCHANGED (they carry no learning block)", () => {
    const r678 = rootCause(
      makeSignals({
        hasMisclassificationSignal: true,
        misclassifiedTool: "web_fetch",
        misclassifiedToken: "403",
        hasDoNotRetrySignal: true,
        breakerOpenedTool: "web_fetch",
        repeatedFailureCount: { web_fetch: 14 },
        mostFailedTool: "web_fetch",
      }),
    );
    expect(r678!.code).toBe("content_heuristic_misclassification");
    const r503 = rootCause(
      makeSignals({
        hasDoNotRetrySignal: true,
        breakerOpenedTool: "web_fetch",
        repeatedFailureCount: { web_fetch: 5 },
        mostFailedTool: "web_fetch",
      }),
    );
    expect(r503!.code).toBe("breaker_opened_repeated_failure");
  });

  // ------------------------------------------------------------------------
  // The two BENIGN procedural-skill verdicts —
  // synthesis_abstained_low_capability + learned_skill_failing. Both dead-last
  // (after the catch-all tool-failure rule); Defer ≠ Retry — an abstain never
  // ranks as an acute failure.
  // ------------------------------------------------------------------------

  const ABSTAINED_LEARNING: IncidentSignals["learning"] = {
    outcomeResolved: false,
    sources: ["pipeline"],
    skillsUsed: [],
    skillFailures: [],
    synthesisAbstained: true,
  };

  it("synthesisAbstained:true with no acute cause → synthesis_abstained_low_capability", () => {
    const r = rootCause(makeSignals({ learning: ABSTAINED_LEARNING }));
    expect(r).not.toBeNull();
    expect(r!.code).toBe("synthesis_abstained_low_capability");
    expect(r!.detail).toMatch(/abstain/i);
    expect(r!.detail).toMatch(/benign|defer/i);
    expect(r!.suggestedNextSteps.length).toBeGreaterThan(0);
  });

  it("synthesis_abstained is BENIGN — it ranks BELOW an acute tool failure (Defer ≠ Retry)", () => {
    const r = rootCause(
      makeSignals({
        learning: ABSTAINED_LEARNING,
        endReason: "completed_with_tool_errors",
        failures: [
          { seq: 1, toolName: "web_fetch", classifiedFailureBy: "sdk_iserror", transportOk: false, errorKind: "dependency", resultDigest: "d", resultBytes: 0, errorPreview: "" },
        ],
      }),
    );
    expect(r!.code).toBe("completed_with_tool_errors");
  });

  it("skillFailures non-empty (no acute cause) → learned_skill_failing", () => {
    const r = rootCause(
      makeSignals({
        learning: { outcomeResolved: true, outcome: "corrected", sources: ["correction"], skillsUsed: ["flaky"], skillFailures: ["flaky"], synthesisAbstained: false },
      }),
    );
    expect(r).not.toBeNull();
    expect(r!.code).toBe("learned_skill_failing");
    expect(r!.suggestedNextSteps.join(" ")).toMatch(/comis memory skills/);
  });

  it("learned_skill_failing fires on a REPEATEDLY-failing procedure with an ACTIONABLE demote hint", () => {
    // A procedure used across several failed/corrected trajectories (the
    // repeatedly-failing case): the verdict surfaces every implicated skill id.
    // The resolve-seam loop makes the hint's "the procedure will demote on
    // continued failure" promise actionable — it demotes a corroborated+weakening
    // surfaced skill (active→stale, then evict→archived), which drops it from
    // the read-only surface. The verdict itself stays BENIGN and counts/ids-only
    // — this asserts the actionable hint.
    const r = rootCause(
      makeSignals({
        learning: { outcomeResolved: true, outcome: "failure", sources: ["tool", "correction"], skillsUsed: ["flaky", "shaky"], skillFailures: ["flaky", "shaky"], synthesisAbstained: false },
      }),
    );
    expect(r).not.toBeNull();
    expect(r!.code).toBe("learned_skill_failing");
    // Names the failing skill ids (content-free) and points at the funnel + obs.explain.
    expect(r!.detail).toContain("flaky");
    expect(r!.detail).toContain("shaky");
    expect(r!.suggestedNextSteps.join(" ")).toMatch(/comis memory skills/);
    // The hint's demote promise (fulfilled by the resolve-seam loop).
    expect(r!.suggestedNextSteps.join(" ")).toMatch(/demote on continued failure/);
  });

  it("learned_skill_failing ranks BELOW an acute tool failure", () => {
    const r = rootCause(
      makeSignals({
        learning: { outcomeResolved: false, outcome: "failure", sources: ["tool"], skillsUsed: ["flaky"], skillFailures: ["flaky"], synthesisAbstained: false },
        failures: [
          { seq: 1, toolName: "web_fetch", classifiedFailureBy: "sdk_iserror", transportOk: false, errorKind: "dependency", resultDigest: "d", resultBytes: 0, errorPreview: "" },
        ],
      }),
    );
    expect(r!.code).toBe("completed_with_tool_errors");
  });

  it("neither skill verdict fires on an absent learning block (no fixture regression)", () => {
    expect(rootCause(makeSignals())).toBeNull();
    // A resolved, no-skill learning block fires NEITHER skill verdict.
    expect(
      rootCause(
        makeSignals({ learning: { outcomeResolved: true, outcome: "success", sources: ["tool"], skillsUsed: [], skillFailures: [], synthesisAbstained: false } }),
      ),
    ).toBeNull();
  });

  it("detail strings never contain a literal '${' (interpolation-bug guard)", () => {
    const r = rootCause(
      makeSignals({ breakerOpenedTool: "web_fetch", hasDoNotRetrySignal: true, mostFailedTool: "web_fetch", repeatedFailureCount: { web_fetch: 5 } }),
    );
    expect(r!.detail).not.toContain("${");
    expect(r!.suggestedNextSteps.join(" ")).not.toContain("${");
  });
});

// ---------------------------------------------------------------------------
// Budget-evidence-specific context_exhausted verdict. The generic
// summarizer-speculation text actively misdirected a live incident (the real
// cause was the small-class window cap + tool-schema dominance —
// summarizerSpend would have done nothing).
// ---------------------------------------------------------------------------

describe("context_exhausted with budget evidence", () => {
  const BUDGET = {
    windowTokens: 32_000,
    rawContextWindowTokens: 131_072,
    windowCapSource: "effectiveContextCapSmall" as const,
    systemTokens: 25_694,
    freshTailTokens: 5_272,
    budgetedHistoryTokens: 0,
    keptCount: 0,
    assembledInputTokens: 31_572,
    outputHeadroom: 768,
    verdict: "exhausted" as const,
  };

  it("names the assembled/window numbers, the raw window, the system share, and kept history in the detail", () => {
    const r = rootCause(makeSignals({ endReason: "context_exhausted", contextBudget: BUDGET }));
    expect(r).not.toBeNull();
    expect(r!.code).toBe("context_exhausted");
    expect(r!.detail).toContain("31572");
    expect(r!.detail).toContain("32000");
    expect(r!.detail).toContain("131072");
    expect(r!.detail).toContain("80%");
    expect(r!.detail).toContain("history kept: 0");
  });

  it("suggests raising the named cap knob and reducing the tool surface when capped and schema-dominated", () => {
    const r = rootCause(makeSignals({ endReason: "context_exhausted", contextBudget: BUDGET }));
    const steps = r!.suggestedNextSteps.join(" | ");
    expect(steps).toContain("contextEngine.budget.effectiveContextCapSmall");
    expect(steps).toContain("tool");
  });

  it("uncapped budget evidence does not point at a cap knob", () => {
    const r = rootCause(
      makeSignals({
        endReason: "context_exhausted",
        contextBudget: { ...BUDGET, rawContextWindowTokens: 32_000, windowCapSource: "none" as const },
      }),
    );
    expect(r!.code).toBe("context_exhausted");
    expect(r!.suggestedNextSteps.join(" | ")).not.toContain("effectiveContextCapSmall");
  });

  it("falls back to the generic terminal verdict when no budget evidence exists (no contextBudget signal)", () => {
    const r = rootCause(makeSignals({ endReason: "context_exhausted" }));
    expect(r!.code).toBe("context_exhausted");
    expect(r!.detail).toContain("context exhausted");
    expect(r!.suggestedNextSteps.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Served-bound context_exhausted verdict. The cap branch templates
// `contextEngine.budget.${windowCapSource}` — for the "served" member that
// renders the NONSENSE knob `contextEngine.budget.served` (it is not a config
// key; the real knobs are Ollama's OLLAMA_CONTEXT_LENGTH env / Modelfile
// PARAMETER num_ctx). Both template sites must branch by source.
// ---------------------------------------------------------------------------

describe("context_exhausted with served-bound budget evidence", () => {
  const SERVED_BUDGET = {
    windowTokens: 8_192,
    rawContextWindowTokens: 131_072,
    windowCapSource: "served" as const,
    systemTokens: 5_000,
    freshTailTokens: 1_000,
    budgetedHistoryTokens: 1_500,
    keptCount: 3,
    assembledInputTokens: 7_500,
    outputHeadroom: 1_792,
    verdict: "exhausted" as const,
  };

  it("a served-bound verdict names the Ollama knobs + the configured number and NEVER renders contextEngine.budget.served", () => {
    const r = rootCause(makeSignals({ endReason: "context_exhausted", contextBudget: SERVED_BUDGET }));
    expect(r).not.toBeNull();
    expect(r!.code).toBe("context_exhausted");
    // The detail names the TRUE configured window and the served-bound class.
    expect(r!.detail).toMatch(/model contextWindow 131072 but Ollama served a smaller window/);
    // The steps name the REAL knobs with the configured number.
    const steps = r!.suggestedNextSteps.join("\n");
    expect(steps).toMatch(/OLLAMA_CONTEXT_LENGTH=131072/);
    expect(steps).toMatch(/PARAMETER num_ctx 131072/);
    // The nonsense knob must never render anywhere in the verdict.
    expect(r!.detail).not.toMatch(/contextEngine\.budget\.served/);
    expect(steps).not.toMatch(/contextEngine\.budget\.served/);
  });

  it("the effectiveContextCapSmall verdict wording is pinned byte-for-byte (served branch cannot perturb it)", () => {
    // The frozen cap-branch fixture — pins the EXACT strings so the served
    // branch cannot perturb the cap-knob wording.
    const CAP_BUDGET = {
      windowTokens: 32_000,
      rawContextWindowTokens: 131_072,
      windowCapSource: "effectiveContextCapSmall" as const,
      systemTokens: 25_694,
      freshTailTokens: 5_272,
      budgetedHistoryTokens: 0,
      keptCount: 0,
      assembledInputTokens: 31_572,
      outputHeadroom: 768,
      verdict: "exhausted" as const,
    };
    const r = rootCause(makeSignals({ endReason: "context_exhausted", contextBudget: CAP_BUDGET }));
    expect(r!.detail).toBe(
      "context exhausted — the pre-flight guard aborted before the model could run: assembled 31572 tokens of effective window 32000 (model contextWindow 131072 capped by contextEngine.budget.effectiveContextCapSmall); system prompt + tool schemas = 25694 tokens (80% of the window); history kept: 0",
    );
    expect(r!.suggestedNextSteps).toEqual([
      "raise contextEngine.budget.effectiveContextCapSmall (0 = uncapped) — the model declares 131072 tokens but the effective window was 32000",
      "reduce the active tool surface (disable unused builtin tool groups / MCP servers) — tool schemas dominate the window",
      "obs.explain depth=full",
    ]);
  });

  it("a capabilityClass-bound verdict names the pin lever and NEVER the inert budget knob nor a templated contextEngine.budget.capabilityClass", () => {
    // The executor's DEFAULT_EFFECTIVE_CAP_BY_CLASS cap (from the operator's
    // providers.entries.<id>.capabilities.capabilityClass pin) bound the window
    // upstream — raising contextEngine.budget.effectiveContextCapSmall (or
    // setting 0) changes NOTHING on this branch; suggesting it is exactly the
    // dead-knob misdirection this verdict exists to prevent.
    const PIN_BUDGET = {
      windowTokens: 32_000,
      rawContextWindowTokens: 131_072,
      windowCapSource: "capabilityClass" as const,
      systemTokens: 25_694,
      freshTailTokens: 5_272,
      budgetedHistoryTokens: 0,
      keptCount: 0,
      assembledInputTokens: 31_572,
      outputHeadroom: 768,
      verdict: "exhausted" as const,
    };
    const r = rootCause(makeSignals({ endReason: "context_exhausted", contextBudget: PIN_BUDGET }));
    expect(r).not.toBeNull();
    expect(r!.code).toBe("context_exhausted");
    // The detail names the pin as the clamp.
    expect(r!.detail).toMatch(
      /model contextWindow 131072 capped by the providers\.entries\.<id>\.capabilities\.capabilityClass pin/,
    );
    const steps = r!.suggestedNextSteps.join("\n");
    // The step names the working lever (the pin) with both numbers.
    expect(steps).toMatch(/providers\.entries\.<id>\.capabilities\.capabilityClass/);
    expect(steps).toMatch(/131072/);
    expect(steps).toMatch(/32000/);
    // The dead/nonsense knobs must never render anywhere in the verdict.
    expect(r!.detail).not.toMatch(/contextEngine\.budget\.capabilityClass/);
    expect(steps).not.toMatch(/contextEngine\.budget\.capabilityClass/);
    expect(steps).not.toMatch(/raise contextEngine\.budget\.effectiveContextCapSmall/);
  });
});

// ---------------------------------------------------------------------------
// tool_schema_unsupported — an acute, deterministic provider-schema rejection
// (grammar-compile/unmarshal 400). Placement is the ordering contract: AFTER
// the two frozen-fixture codes (the frozen 678/503 fixtures carry no
// schema-rejection records, so they cannot regress), BEFORE the insurance
// codes, and out-ranking the terminal-state explainers. Fires only when the
// one-shot strip-retry did NOT recover — a recovered repair is evidence, not
// a verdict.
// ---------------------------------------------------------------------------

describe("tool_schema_unsupported", () => {
  const UNRECOVERED = {
    toolNames: ["schedule_task"],
    strippedKeywords: ["pattern", "format"],
    retried: true,
    succeeded: false,
  };

  it("an unrecovered strip-retry names the tool, the attempted strip-retry, and the toolSchemaProfile knob", () => {
    const r = rootCause(makeSignals({ toolSchemaUnsupported: UNRECOVERED }));
    expect(r).not.toBeNull();
    expect(r!.code).toBe("tool_schema_unsupported");
    expect(r!.detail).toContain("schedule_task");
    expect(r!.detail).toContain("strip-pattern/format-retry");
    expect(r!.suggestedNextSteps[0]).toContain("comisCompat.toolSchemaProfile");
  });

  it("a RECOVERED repair (succeeded:true) does not fire — the repair is evidence, not the session's root cause", () => {
    const r = rootCause(makeSignals({ toolSchemaUnsupported: { ...UNRECOVERED, succeeded: true } }));
    expect(r).toBeNull();
  });

  it("retried:false explains that nothing was strippable so no retry was attempted", () => {
    const r = rootCause(makeSignals({ toolSchemaUnsupported: { ...UNRECOVERED, retried: false } }));
    expect(r).not.toBeNull();
    expect(r!.code).toBe("tool_schema_unsupported");
    expect(r!.detail).toContain("nothing strippable");
  });

  // Gate-closed and nothing-to-strip terminals used to
  // emit indistinguishable payloads — with last-record-wins, a session that
  // healed once and then hit the gate produced a verdict claiming "nothing
  // strippable so no retry was attempted" when stripping WAS performed and a
  // retry WAS attempted earlier in the session. The reason discriminator
  // branches the detail.
  it("reason gate_closed says the strip-retry was already attempted earlier this session — never 'nothing strippable'", () => {
    const r = rootCause(
      makeSignals({
        toolSchemaUnsupported: {
          toolNames: [],
          strippedKeywords: [],
          retried: false,
          succeeded: false,
          reason: "gate_closed",
        },
      }),
    );
    expect(r).not.toBeNull();
    expect(r!.code).toBe("tool_schema_unsupported");
    expect(r!.detail).toContain("already attempted earlier this session");
    expect(r!.detail).not.toContain("nothing strippable");
  });

  it("reason nothing_to_strip keeps the nothing-strippable explanation", () => {
    const r = rootCause(
      makeSignals({
        toolSchemaUnsupported: {
          toolNames: [],
          strippedKeywords: [],
          retried: false,
          succeeded: false,
          reason: "nothing_to_strip",
        },
      }),
    );
    expect(r).not.toBeNull();
    expect(r!.detail).toContain("nothing strippable");
  });

  it("an absent reason discriminator falls back to the retried-based wording", () => {
    const r = rootCause(makeSignals({ toolSchemaUnsupported: { ...UNRECOVERED, retried: false } }));
    expect(r).not.toBeNull();
    expect(r!.detail).toContain("nothing strippable");
    const retriedForm = rootCause(makeSignals({ toolSchemaUnsupported: UNRECOVERED }));
    expect(retriedForm!.detail).toContain("strip-pattern/format-retry");
  });

  it("PRIORITY: the misclassification signal out-ranks tool_schema_unsupported (frozen code #1 stays first)", () => {
    const r = rootCause(
      makeSignals({
        toolSchemaUnsupported: UNRECOVERED,
        hasMisclassificationSignal: true,
        misclassifiedTool: "web_fetch",
        misclassifiedToken: "403",
      }),
    );
    expect(r!.code).toBe("content_heuristic_misclassification");
  });

  it("PRIORITY: the breaker rule out-ranks tool_schema_unsupported (frozen code #2 stays ahead)", () => {
    const r = rootCause(
      makeSignals({
        toolSchemaUnsupported: UNRECOVERED,
        hasDoNotRetrySignal: true,
        breakerOpenedTool: "web_fetch",
        repeatedFailureCount: { web_fetch: 5 },
        mostFailedTool: "web_fetch",
      }),
    );
    expect(r!.code).toBe("breaker_opened_repeated_failure");
  });

  it("PRIORITY: tool_schema_unsupported out-ranks the terminal-state explainer (acute cause over endReason)", () => {
    const r = rootCause(
      makeSignals({ toolSchemaUnsupported: UNRECOVERED, endReason: "context_exhausted" }),
    );
    expect(r!.code).toBe("tool_schema_unsupported");
  });

  it("PRIORITY: tool_schema_unsupported out-ranks the insurance codes (sits before provider_timeout)", () => {
    const r = rootCause(
      makeSignals({
        toolSchemaUnsupported: UNRECOVERED,
        failures: [
          {
            seq: 0,
            toolName: "llm_call",
            classifiedFailureBy: "",
            transportOk: false,
            errorKind: "timeout",
            resultDigest: "d",
            resultBytes: 1,
            errorPreview: "timed out",
          },
        ],
      }),
    );
    expect(r!.code).toBe("tool_schema_unsupported");
  });

  it("empty toolNames degrades the detail to [unknown] instead of an empty bracket pair", () => {
    const r = rootCause(makeSignals({ toolSchemaUnsupported: { ...UNRECOVERED, toolNames: [] } }));
    expect(r).not.toBeNull();
    expect(r!.code).toBe("tool_schema_unsupported");
    expect(r!.detail).toContain("[unknown]");
  });
});

// ---------------------------------------------------------------------------
// prompt_timeout — the NAMED terminal latency cause, keyed on endReason
// "timeout" (resolved via the END_REASON_MAP entry). Without it, a
// timeout-heavy session with clean tools gets NO verdict at all (rule
// 6 provider_timeout requires a TOOL failure); the terminal-band rule closes
// exactly that gap. Placement: BELOW every tool-failure cause
// (chronic-vs-acute ordering); the frozen 678/503 fixtures carry no
// prompt_timeout records and no endReason "timeout", so they cannot regress
// (the same no-regression argument as tool_schema_unsupported).
// ---------------------------------------------------------------------------

describe("prompt_timeout terminal verdict", () => {
  const STALL_TIMEOUT = {
    timeoutMs: 180_000,
    durationMs: 195_000,
    limit: "stall" as const,
    source: "agent_config",
    bindingKnob: "agents.my-agent.promptTimeout.promptTimeoutMs",
    stallBudgetMs: 180_000,
    makespanMs: 1_800_000,
  };

  it("the stall verdict names the budget, the elapsed time, and the binding knob with the ACTUAL numbers", () => {
    const r = rootCause(
      makeSignals({ endReason: "timeout", agentId: "my-agent", promptTimeout: STALL_TIMEOUT }),
    );
    expect(r).not.toBeNull();
    expect(r!.code).toBe("prompt_timeout");
    expect(r!.detail).toMatch(/stall budget 180000ms exceeded/);
    expect(r!.detail).toMatch(/195000ms/);
    expect(r!.suggestedNextSteps[0]).toMatch(
      /raise agents\.my-agent\.promptTimeout\.promptTimeoutMs/,
    );
    expect(r!.suggestedNextSteps[0]).toContain("180000");
    expect(r!.suggestedNextSteps).toContain("obs.explain depth=full");
  });

  it("the makespan verdict names the ceiling and stallCeilingMultiplier (streaming runaway — never a stall framing)", () => {
    const r = rootCause(
      makeSignals({
        endReason: "timeout",
        agentId: "my-agent",
        promptTimeout: {
          timeoutMs: 1_800_000,
          durationMs: 1_805_000,
          limit: "makespan" as const,
          source: "agent_config",
          bindingKnob: "agents.my-agent.promptTimeout.promptTimeoutMs",
          stallBudgetMs: 180_000,
          makespanMs: 1_800_000,
        },
      }),
    );
    expect(r).not.toBeNull();
    expect(r!.code).toBe("prompt_timeout");
    expect(r!.detail).toMatch(/makespan ceiling 1800000ms/);
    expect(r!.detail).toMatch(/streaming runaway/);
    expect(r!.suggestedNextSteps.join("\n")).toMatch(/stallCeilingMultiplier/);
  });

  it("a terminal whole-turn retry kill (limit ABSENT) renders retry framing + the retryPromptTimeoutMs knob — never the stall framing or the stall knob", () => {
    // The terminal record is a rotation/fallback/short-retry kill: 60_000ms
    // whole-turn window, no stallBudgetMs, limit undefined ('LAST record
    // wins' makes the retry kill terminal after a primary stall-kill). The
    // row deliberately carries a wrong-knob bindingKnob value — the branch
    // must not echo it: the lever for a whole-turn retry kill is
    // retryPromptTimeoutMs (the same branch the agent-side classify hint
    // takes).
    const r = rootCause(
      makeSignals({
        endReason: "timeout",
        agentId: "my-agent",
        promptTimeout: {
          timeoutMs: 60_000,
          durationMs: 241_000,
          source: "agent_config",
          bindingKnob: "agents.my-agent.promptTimeout.promptTimeoutMs",
        },
      }),
    );
    expect(r).not.toBeNull();
    expect(r!.code).toBe("prompt_timeout");
    // The wrong output would be 'stall budget 60000ms exceeded ... with no
    // stream/tool activity' — wrong framing (not a stall kill), wrong knob
    // (the lever is retryPromptTimeoutMs), the 60000 retry value
    // misattributed to the 180000 promptTimeoutMs knob.
    expect(r!.detail).toMatch(/whole-turn retry timeout 60000ms/);
    expect(r!.detail).toMatch(/241000ms/);
    // The stall FRAMING ("stall budget Xms exceeded ... no stream/tool
    // activity") must not appear — the contrast clause "not the stall
    // budget" is the honest framing and is allowed.
    expect(r!.detail).not.toMatch(/stall budget \d+ms exceeded/);
    expect(r!.detail).not.toMatch(/no stream\/tool activity/);
    expect(r!.suggestedNextSteps[0]).toBe(
      "raise agents.my-agent.promptTimeout.retryPromptTimeoutMs (currently 60000)",
    );
    expect(r!.suggestedNextSteps.join("\n")).not.toMatch(/promptTimeout\.promptTimeoutMs/);
    expect(r!.suggestedNextSteps).toContain("obs.explain depth=full");
  });

  it("a timeout session with no enriched signal still gets the verdict with a generic knob suggestion and NO invented numbers", () => {
    const r = rootCause(makeSignals({ endReason: "timeout" }));
    expect(r).not.toBeNull();
    expect(r!.code).toBe("prompt_timeout");
    expect(r!.suggestedNextSteps[0]).toMatch(/agents\.<id>\.promptTimeout\.promptTimeoutMs/);
    // No numbers invented anywhere in the verdict (the session carried none).
    expect(r!.detail).not.toMatch(/\d+ms/);
    expect(r!.suggestedNextSteps[0]).not.toMatch(/\d/);
  });

  it("a TOOL timeout failure out-ranks the terminal rule (provider_timeout wins — insurance-band ordering)", () => {
    // Guard pin: the terminal rule sits BELOW the tool-failure rules; an
    // acute tool-failure cause is upstream of the terminal state
    // (chronic-vs-acute misattribution guard).
    const r = rootCause(
      makeSignals({
        endReason: "timeout",
        promptTimeout: STALL_TIMEOUT,
        failures: [
          {
            seq: 0,
            toolName: "llm_call",
            classifiedFailureBy: "",
            transportOk: false,
            errorKind: "timeout",
            resultDigest: "d",
            resultBytes: 1,
            errorPreview: "timed out",
          },
        ],
      }),
    );
    expect(r!.code).toBe("provider_timeout");
  });

  it("a timeout-heavy session with CLEAN tools gets the prompt_timeout verdict (no tool failure required)", () => {
    const r = rootCause(
      makeSignals({
        endReason: "timeout",
        agentId: "my-agent",
        toolStats: { web_fetch: { ok: 4, failed: 0 } },
        failures: [],
        promptTimeout: STALL_TIMEOUT,
      }),
    );
    expect(r).not.toBeNull();
    expect(r!.code).toBe("prompt_timeout");
  });

  it("the frozen 678/503 fixture verdicts are UNCHANGED (no prompt_timeout records, no endReason timeout)", () => {
    // The frozen-fixture no-regression argument, re-pinned for this rule.
    const r678 = rootCause(
      makeSignals({
        hasMisclassificationSignal: true,
        misclassifiedTool: "web_fetch",
        misclassifiedToken: "403",
        hasDoNotRetrySignal: true,
        breakerOpenedTool: "web_fetch",
        repeatedFailureCount: { web_fetch: 14 },
        mostFailedTool: "web_fetch",
      }),
    );
    expect(r678!.code).toBe("content_heuristic_misclassification");
    const r503 = rootCause(
      makeSignals({
        hasMisclassificationSignal: false,
        hasDoNotRetrySignal: true,
        breakerOpenedTool: "web_fetch",
        repeatedFailureCount: { web_fetch: 5 },
        mostFailedTool: "web_fetch",
      }),
    );
    expect(r503!.code).toBe("breaker_opened_repeated_failure");
  });
});
