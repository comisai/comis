// SPDX-License-Identifier: Apache-2.0
/**
 * Neighbor tests for the OUTCOME-04 LLM-judge conversational-breadth fallback
 * (`maybeUpgradeWithJudge`), extracted into its own leaf to keep setup-learning.ts /
 * setup-learning-reactions.ts under the 800-line cap. Pins: upgrade-on-unknown,
 * skip-on-resolved, byte-identical-when-disabled/absent, and non-fatal-on-throw.
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { buildOutcomeJudgeWiring, maybeUpgradeWithJudge } from "./setup-learning-judge.js";

const NOW = 1_700_000_000_000;
const TENANT = "tenant-x";
const TRACE = "trace-judge-001";

const SCOPE = { tenantId: "t", agentId: "a", sessionId: "s", trajectoryId: "traj" };
const noopLogger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } as never;
const clock = { now: () => 1000 } as never;
const UNKNOWN = { outcome: "unknown" as const, confidence: 0, sources: [], recalledIds: [], usedSkillIds: [] };

describe("maybeUpgradeWithJudge — OUTCOME-04 conversational-breadth fallback", () => {
  it("upgrades an UNKNOWN verdict to the judge's success (observe source:judge + re-resolve)", async () => {
    const observe = vi.fn(async () => ({ ok: true as const, value: undefined }));
    const resolve = vi.fn(async () => ({ ok: true as const, value: { outcome: "success" as const, confidence: 0.7, sources: ["judge" as const], recalledIds: [], usedSkillIds: [] } }));
    const outcomeJudge = vi.fn(async () => ({ outcome: "success" as const, cappedConfidence: 0.7 }));
    const r = await maybeUpgradeWithJudge(
      { outcomeStore: { observe, resolve } as never, clock, logger: noopLogger, outcomeJudge: outcomeJudge as never, learningOutcomeJudgeEnabled: () => true, readTurnTranscript: () => "user asked X; assistant satisfied it" },
      SCOPE,
      UNKNOWN,
    );
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({ source: "judge", outcome: "success", confidence: 0.7 }));
    expect(resolve).toHaveBeenCalled();
    expect(r.outcome).toBe("success");
  });

  it("does NOT run the judge for an already-resolved (non-unknown) verdict", async () => {
    const outcomeJudge = vi.fn();
    const r = await maybeUpgradeWithJudge(
      { outcomeStore: { observe: vi.fn(), resolve: vi.fn() } as never, clock, logger: noopLogger, outcomeJudge: outcomeJudge as never, learningOutcomeJudgeEnabled: () => true, readTurnTranscript: () => "x" },
      SCOPE,
      { ...UNKNOWN, outcome: "success" as const },
    );
    expect(outcomeJudge).not.toHaveBeenCalled();
    expect(r.outcome).toBe("success");
  });

  it("is byte-identical (keeps unknown, no observe) when the judge is disabled or absent", async () => {
    const observe = vi.fn();
    const disabled = await maybeUpgradeWithJudge(
      { outcomeStore: { observe, resolve: vi.fn() } as never, clock, logger: noopLogger, outcomeJudge: (async () => ({ outcome: "success" as const, cappedConfidence: 0.7 })) as never, learningOutcomeJudgeEnabled: () => false, readTurnTranscript: () => "x" },
      SCOPE,
      UNKNOWN,
    );
    expect(disabled.outcome).toBe("unknown");
    const absent = await maybeUpgradeWithJudge({ outcomeStore: { observe, resolve: vi.fn() } as never, clock, logger: noopLogger }, SCOPE, UNKNOWN);
    expect(absent.outcome).toBe("unknown");
    expect(observe).not.toHaveBeenCalled();
  });

  it("keeps unknown + WARNs (non-fatal) when the judge throws", async () => {
    const warn = vi.fn();
    const r = await maybeUpgradeWithJudge(
      { outcomeStore: { observe: vi.fn(), resolve: vi.fn() } as never, clock, logger: { ...noopLogger, warn } as never, outcomeJudge: (async () => { throw new Error("model down"); }) as never, learningOutcomeJudgeEnabled: () => true, readTurnTranscript: () => "x" },
      SCOPE,
      UNKNOWN,
    );
    expect(r.outcome).toBe("unknown");
    expect(warn).toHaveBeenCalled();
  });

  it("an empty transcript → the judge never runs, verdict stays unknown", async () => {
    const outcomeJudge = vi.fn(async () => ({ outcome: "success" as const, cappedConfidence: 0.7 }));
    const r = await maybeUpgradeWithJudge(
      { outcomeStore: { observe: vi.fn(), resolve: vi.fn() } as never, clock, logger: noopLogger, outcomeJudge: outcomeJudge as never, learningOutcomeJudgeEnabled: () => true, readTurnTranscript: () => "" },
      SCOPE,
      UNKNOWN,
    );
    expect(outcomeJudge).not.toHaveBeenCalled();
    expect(r.outcome).toBe("unknown");
  });

  it("a judge abstention (unknown) → no observe, no re-resolve, verdict stays unknown", async () => {
    const observe = vi.fn();
    const resolve = vi.fn();
    const r = await maybeUpgradeWithJudge(
      { outcomeStore: { observe, resolve } as never, clock, logger: noopLogger, outcomeJudge: (async () => ({ outcome: "unknown" as const, cappedConfidence: 0 })) as never, learningOutcomeJudgeEnabled: () => true, readTurnTranscript: () => "x" },
      SCOPE,
      UNKNOWN,
    );
    expect(observe).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(r.outcome).toBe("unknown");
  });

  it("an observe that returns err → keep unknown, no re-resolve (no fusion over a no-op write)", async () => {
    const observe = vi.fn(async () => ({ ok: false as const, error: new Error("db locked") }));
    const resolve = vi.fn();
    const r = await maybeUpgradeWithJudge(
      { outcomeStore: { observe, resolve } as never, clock, logger: noopLogger, outcomeJudge: (async () => ({ outcome: "success" as const, cappedConfidence: 0.7 })) as never, learningOutcomeJudgeEnabled: () => true, readTurnTranscript: () => "x" },
      SCOPE,
      UNKNOWN,
    );
    expect(observe).toHaveBeenCalledTimes(1);
    expect(resolve).not.toHaveBeenCalled();
    expect(r.outcome).toBe("unknown");
  });
});

// ===========================================================================
// buildOutcomeJudgeWiring — daemon construction behind the byte-identity gate
// ===========================================================================

describe("buildOutcomeJudgeWiring — daemon construction behind the byte-identity gate (OUTCOME-04)", () => {
  function makeContainer(over: { agents?: Record<string, unknown>; costFeatures?: boolean; secrets?: Record<string, string> } = {}) {
    const secrets = over.secrets ?? {};
    return {
      config: {
        agents: over.agents ?? {},
        memory: { costFeatures: { enabled: over.costFeatures ?? true } },
        providers: { entries: {} },
      },
      secretManager: { get: (name: string): string | undefined => secrets[name] },
    } as never;
  }

  /** A stub LCD store returning one user + one assistant text message for any scope. */
  function makeLcdStore() {
    return {
      getMessages: vi.fn(() => [
        { role: "user", parts: [{ kind: "text", metadata: { raw: { text: "please summarize" } } }] },
        { role: "assistant", parts: [{ kind: "text", metadata: { raw: { text: "here is the summary" } } }] },
      ]),
    } as never;
  }

  it("byte-identity: NO agent has the judge on → outcomeJudge + readTurnTranscript are undefined (no construction)", () => {
    const built = buildOutcomeJudgeWiring(
      makeContainer({ agents: { a1: { learningOutcome: { enabled: true, judge: { enabled: false } } } } }),
      createFakeClock(NOW),
      createMockLogger(),
      makeLcdStore(),
    );
    expect(built.outcomeJudge).toBeUndefined();
    expect(built.readTurnTranscript).toBeUndefined();
    expect(built.learningOutcomeJudgeEnabled("a1")).toBe(false);
  });

  it("the judge gate requires learningOutcome.enabled AND judge.enabled AND the master cost switch", () => {
    const offOutcome = buildOutcomeJudgeWiring(
      makeContainer({ agents: { a1: { learningOutcome: { enabled: false, judge: { enabled: true } } } } }),
      createFakeClock(NOW),
      createMockLogger(),
    );
    expect(offOutcome.learningOutcomeJudgeEnabled("a1")).toBe(false);
    const costOff = buildOutcomeJudgeWiring(
      makeContainer({ agents: { a1: { learningOutcome: { enabled: true, judge: { enabled: true } } } }, costFeatures: false }),
      createFakeClock(NOW),
      createMockLogger(),
    );
    expect(costOff.learningOutcomeJudgeEnabled("a1")).toBe(false);
  });

  it("is DEFAULT-ON (opt-out): a present-but-partial learningOutcome with NO judge field still enables + builds the judge", () => {
    // live-2026-06-18: the daemon config-load does not materialize the nested `judge`
    // default for an explicit `{enabled:true}` learningOutcome (judge stays undefined),
    // so the gate must read undefined as ON (`!== false`). With the old `=== true` gate
    // this was false and the judge never fired by default — the regression this pins.
    const built = buildOutcomeJudgeWiring(
      makeContainer({ agents: { a1: { learningOutcome: { enabled: true } } }, secrets: { ANTHROPIC_API_KEY: "sk-test" } }),
      createFakeClock(NOW),
      createMockLogger(),
      makeLcdStore(),
    );
    expect(built.learningOutcomeJudgeEnabled("a1")).toBe(true);
    expect(built.outcomeJudge).toBeDefined();
    expect(built.readTurnTranscript).toBeDefined();
  });

  it("opt-out: an EXPLICIT judge.enabled:false disables it even when learningOutcome is on", () => {
    const built = buildOutcomeJudgeWiring(
      makeContainer({ agents: { a1: { learningOutcome: { enabled: true, judge: { enabled: false } } } }, secrets: { ANTHROPIC_API_KEY: "sk-test" } }),
      createFakeClock(NOW),
      createMockLogger(),
      makeLcdStore(),
    );
    expect(built.learningOutcomeJudgeEnabled("a1")).toBe(false);
  });

  it("the judge seam is UNDEFINED when judge.enabled but the cheap-model API key is missing (Defer != Retry)", () => {
    const built = buildOutcomeJudgeWiring(
      makeContainer({
        agents: { a1: { provider: "anthropic", learningOutcome: { enabled: true, judge: { enabled: true } } } },
        secrets: {},
      }),
      createFakeClock(NOW),
      createMockLogger(),
      makeLcdStore(),
    );
    expect(built.outcomeJudge).toBeUndefined();
    expect(built.learningOutcomeJudgeEnabled("a1")).toBe(true);
  });

  it("the judge seam is BUILT and readTurnTranscript reads the LCD transcript when judge.enabled AND a cheap-model key resolves", () => {
    const lcd = makeLcdStore();
    const built = buildOutcomeJudgeWiring(
      makeContainer({
        agents: { a1: { provider: "anthropic", learningOutcome: { enabled: true, judge: { enabled: true } } } },
        secrets: { ANTHROPIC_API_KEY: "sk-test-key" },
      }),
      createFakeClock(NOW),
      createMockLogger(),
      lcd,
    );
    expect(typeof built.outcomeJudge).toBe("function");
    expect(typeof built.readTurnTranscript).toBe("function");
    const transcript = built.readTurnTranscript!({ tenantId: TENANT, agentId: "a1", sessionId: "sess-1", trajectoryId: TRACE });
    expect(lcd.getMessages).toHaveBeenCalledWith({ conversationId: "sess-1", tenantId: TENANT, agentId: "a1", sessionKey: "sess-1" });
    expect(transcript).toBe("user: please summarize\nassistant: here is the summary");
  });

  it("readTurnTranscript returns undefined for a conversation with no messages (the judge then never runs)", () => {
    const emptyLcd = { getMessages: vi.fn(() => []) } as never;
    const built = buildOutcomeJudgeWiring(
      makeContainer({
        agents: { a1: { provider: "anthropic", learningOutcome: { enabled: true, judge: { enabled: true } } } },
        secrets: { ANTHROPIC_API_KEY: "sk-test-key" },
      }),
      createFakeClock(NOW),
      createMockLogger(),
      emptyLcd,
    );
    expect(built.readTurnTranscript!({ tenantId: TENANT, agentId: "a1", sessionId: "sess-1", trajectoryId: TRACE })).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // H-1 (Phase 226): the master-kill-switch rename `memory.costFeatures.enabled`
  // → `memory.enabled` MUST NOT silently invert the gate. The reader here once
  // declared a LOOSE local type `memory?: { costFeatures?: { enabled?: boolean } }`
  // and gated on `memory?.costFeatures?.enabled !== false`. After the schema
  // collapse deletes `costFeatures`, a config carrying ONLY `memory.enabled:false`
  // (the NEW shape) would read `undefined !== false === true` → FORCE-ENABLED (the
  // kill-switch inverts), and tsc does NOT catch it (the loose optional type
  // tolerates the missing key). This test pins the CORRECT post-rename behavior
  // (force-DISABLE on memory.enabled:false) — it fails RED against the pre-rename
  // loose reader. The fix re-points the local slice to the real MemoryConfig type
  // (tsc then enforces the rename) AND this explicit guard is the belt.
  // -------------------------------------------------------------------------
  it("H-1: memory.enabled:false (the renamed master kill-switch) force-DISABLES the judge for every agent", () => {
    const built = buildOutcomeJudgeWiring(
      // The NEW shape: memory.enabled is the master gate; NO costFeatures key exists.
      {
        config: {
          agents: { a1: { learningOutcome: { enabled: true, judge: { enabled: true } } } },
          memory: { enabled: false },
          providers: { entries: {} },
        },
        secretManager: { get: (): string | undefined => undefined },
      } as never,
      createFakeClock(NOW),
      createMockLogger(),
      makeLcdStore(),
    );
    // The master kill-switch is OFF → the judge gate must be closed for every agent.
    // (Pre-rename: reads costFeatures (absent) → undefined !== false === true → force-ENABLED → RED.)
    expect(built.learningOutcomeJudgeEnabled("a1")).toBe(false);
    // And byte-identity: no seam/reader is constructed when the master switch is off.
    expect(built.outcomeJudge).toBeUndefined();
    expect(built.readTurnTranscript).toBeUndefined();
  });
});
