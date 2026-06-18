// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for buildSkillSynthesisCronDeps — the closed-graph skill-synthesis bundle
 * assembler (SKILL-08/09, Plan 07). The daemon is the SOLE composition root joining
 * @comis/memory (the learned-skill + outcome stores) + @comis/skills (the validation
 * adapter) + @comis/agent (the job); this helper builds the bundle the __SKILL_SYNTHESIS__
 * sentinel injects. createSandboxSkillValidationAdapter is mocked (no real bwrap).
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";

const mockCreateSandboxSkillValidationAdapter = vi.hoisted(() => vi.fn(() => ({ validate: vi.fn() })));
vi.mock("@comis/skills", () => ({
  createSandboxSkillValidationAdapter: mockCreateSandboxSkillValidationAdapter,
}));

import { buildSkillSynthesisCronDeps, type SkillSynthesisDepsInput } from "./setup-channels-skill-synthesis-deps.js";

function makeInput(over: Partial<SkillSynthesisDepsInput> = {}): SkillSynthesisDepsInput {
  return {
    container: { config: { tenantId: "t", agents: { "agent-1": { skills: { toolPolicy: { profile: "full", allow: [], deny: [] } } } } } } as any,
    tenantId: "t",
    assembleToolsForAgent: vi.fn(async () => [{ name: "read" }]) as any,
    sessionStore: { listDetailed: vi.fn(() => []), loadByFormattedKey: vi.fn(() => undefined) } as any,
    outcomeStore: { resolve: vi.fn(), observe: vi.fn(), prune: vi.fn() } as any,
    learnedSkillStore: { admit: vi.fn() } as any,
    approvalGate: { requestApproval: vi.fn(async () => ({ approved: false })) } as any,
    ...over,
  };
}

describe("buildSkillSynthesisCronDeps", () => {
  it("returns undefined when the learned-skill store is absent (the sentinel then reports not-wired)", () => {
    expect(buildSkillSynthesisCronDeps(makeInput({ learnedSkillStore: undefined }))).toBeUndefined();
  });

  it("returns undefined when the outcome store is absent", () => {
    expect(buildSkillSynthesisCronDeps(makeInput({ outcomeStore: undefined }))).toBeUndefined();
  });

  it("injects the learned-skill store + the outcome success gate + the approval gate (the closed-graph adapters)", () => {
    const input = makeInput();
    const bundle = buildSkillSynthesisCronDeps(input)!;
    expect(bundle).toBeDefined();
    expect(bundle.learnedSkillStore).toBe(input.learnedSkillStore);
    expect(bundle.outcomeSignal).toBe(input.outcomeStore);
    expect(bundle.approvalGate).toBe(input.approvalGate);
  });

  it("falls back to a deny-all approval gate when none is wired (a mutating candidate is then never admitted)", async () => {
    const bundle = buildSkillSynthesisCronDeps(makeInput({ approvalGate: undefined }))!;
    const r = await bundle.approvalGate.requestApproval({ toolName: "x", action: "y", params: {}, agentId: "a", sessionKey: "s", trustLevel: "learned" });
    expect(r.approved).toBe(false);
  });

  it("constructs the @comis/skills validation adapter with the agent's tool list + policy (buildValidationAdapter)", async () => {
    const input = makeInput();
    const bundle = buildSkillSynthesisCronDeps(input)!;
    await bundle.buildValidationAdapter("agent-1");
    expect(input.assembleToolsForAgent).toHaveBeenCalledWith("agent-1");
    expect(mockCreateSandboxSkillValidationAdapter).toHaveBeenCalledOnce();
    const arg = mockCreateSandboxSkillValidationAdapter.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.allTools).toEqual([{ name: "read" }]);
    expect(arg.policy).toEqual({ profile: "full", allow: [], deny: [] });
  });

  it("emits one source trajectory per resolvable PER-TURN traceId, with the session transcript as text (buildSourceTrajectories)", async () => {
    const sessionStore = {
      listDetailed: vi.fn(() => [{ sessionKey: "s1", userId: "u1", tenantId: "t", channelId: "c", metadata: null, createdAt: 1, updatedAt: 2, messageCount: 2 }]),
      loadByFormattedKey: vi.fn(() => ({ messages: [{ role: "user", content: "do X" }, { role: "assistant", content: "did X" }], metadata: {}, createdAt: 1, updatedAt: 2 })),
    };
    // The outcome ledger holds the per-turn traceId(s) for session s1 — the source
    // must emit THOSE (resolvable), not the sessionKey.
    const outcomeStore = {
      observe: vi.fn(), prune: vi.fn(), resolve: vi.fn(),
      listTrajectoryIds: vi.fn(async () => ({ ok: true as const, value: [{ trajectoryId: "turn-1", sessionId: "s1" }] })),
    };
    const bundle = buildSkillSynthesisCronDeps(makeInput({ sessionStore: sessionStore as any, outcomeStore: outcomeStore as any }))!;
    const trajectories = await bundle.buildSourceTrajectories("agent-1", "t");
    expect(trajectories).toHaveLength(1);
    expect(trajectories[0].trajectoryId).toBe("turn-1"); // the per-turn traceId resolve() keys on, NOT the sessionKey
    expect(trajectories[0].sessionId).toBe("s1");
    expect(trajectories[0].sender).toBe("u1");
    expect(trajectories[0].text).toContain("do X");
    expect(trajectories[0].text).toContain("did X");
  });

  it("skips a session that loads no text — no empty trajectory (buildSourceTrajectories)", async () => {
    const sessionStore = {
      listDetailed: vi.fn(() => [{ sessionKey: "s1", userId: "u1", tenantId: "t", channelId: "c", metadata: null, createdAt: 1, updatedAt: 2, messageCount: 0 }]),
      loadByFormattedKey: vi.fn(() => ({ messages: [], metadata: {}, createdAt: 1, updatedAt: 2 })),
    };
    const outcomeStore = {
      observe: vi.fn(), prune: vi.fn(), resolve: vi.fn(),
      listTrajectoryIds: vi.fn(async () => ({ ok: true as const, value: [{ trajectoryId: "turn-1", sessionId: "s1" }] })),
    };
    const bundle = buildSkillSynthesisCronDeps(makeInput({ sessionStore: sessionStore as any, outcomeStore: outcomeStore as any }))!;
    const trajectories = await bundle.buildSourceTrajectories("agent-1", "t");
    expect(trajectories).toHaveLength(0);
  });

  it("fails closed to empty when the outcome store cannot enumerate ids (no non-resolvable fallback)", async () => {
    const sessionStore = {
      listDetailed: vi.fn(() => [{ sessionKey: "s1", userId: "u1", tenantId: "t", channelId: "c", metadata: null, createdAt: 1, updatedAt: 2, messageCount: 2 }]),
      loadByFormattedKey: vi.fn(() => ({ messages: [{ role: "user", content: "do X" }], metadata: {}, createdAt: 1, updatedAt: 2 })),
    };
    // listTrajectoryIds absent ⇒ must NOT fall back to emitting the sessionKey (the pre-fix bug).
    const outcomeStore = { observe: vi.fn(), prune: vi.fn(), resolve: vi.fn() };
    const bundle = buildSkillSynthesisCronDeps(makeInput({ sessionStore: sessionStore as any, outcomeStore: outcomeStore as any }))!;
    expect(await bundle.buildSourceTrajectories("agent-1", "t")).toHaveLength(0);
  });

  // ── REGRESSION (live VPS incident 2026-06-18): trajectory-identity mismatch ──
  // The synthesis SELECT step resolves each source trajectory's `trajectoryId`
  // against the outcome signal. The outcome signal keys outcome_events by the
  // PER-TURN traceId (setup-learning.ts:146 `trajectoryId = payload.traceId`); the
  // sessionKey lives only in the `session_id` column. But buildSourceTrajectories
  // emits `trajectoryId = sessionKey` (setup-channels-skill-synthesis-deps.ts:101).
  // So resolve(sessionKey) finds ZERO rows → `unknown` → fail-closed skip → no skill
  // can EVER be synthesized on the single-agent/chat-API path. Live: 11 resolved
  // success trajectories, 3 synthesis runs, every run `candidates:1, selected:0`.
  // REGRESSION GUARD (live VPS incident 2026-06-18, FIXED): the synthesis SELECT
  // step resolves each source trajectory's `trajectoryId`. Outcomes are keyed by the
  // PER-TURN traceId, not the sessionKey — so the source must emit a traceId that
  // resolves. Pre-fix it emitted the sessionKey → resolve()=`unknown` → `selected:0`
  // forever. This test FAILED on the pre-fix code (`expected 'unknown' to be 'success'`);
  // the per-turn-source fix makes it pass. See gap analysis §3/§9.
  it("emits a trajectoryId the outcome signal can resolve (the §3 identity mismatch — FIXED)", async () => {
    const SESSION_KEY = "default:openai-api:openai";
    const TURN_TRACE_ID = "942cc2e5-48e9-434e-8d1d-aa55fb1f06d6"; // the per-turn id outcomes are keyed on
    const sessionStore = {
      listDetailed: vi.fn(() => [{ sessionKey: SESSION_KEY, userId: "u1", tenantId: "t", channelId: "openai", metadata: null, createdAt: 1, updatedAt: 2, messageCount: 2 }]),
      loadByFormattedKey: vi.fn(() => ({ messages: [{ role: "user", content: "scaffold a python module and run it" }, { role: "assistant", content: "done, output 7" }], metadata: {}, createdAt: 1, updatedAt: 2 })),
    };
    // Fake outcome store modelling the REAL invariant: the success is keyed by the
    // per-turn traceId — NOT the sessionKey. listTrajectoryIds surfaces it; resolve()
    // matches trajectory_id.
    const outcomeStore = {
      observe: vi.fn(),
      prune: vi.fn(),
      listTrajectoryIds: vi.fn(async () => ({ ok: true as const, value: [{ trajectoryId: TURN_TRACE_ID, sessionId: SESSION_KEY }] })),
      resolve: vi.fn(async (id: string) =>
        id === TURN_TRACE_ID
          ? { ok: true as const, value: { outcome: "success" as const, confidence: 0.9, sources: ["tool" as const], recalledIds: [], usedSkillIds: [] } }
          : { ok: true as const, value: { outcome: "unknown" as const, confidence: 0, sources: [], recalledIds: [], usedSkillIds: [] } }),
    };
    const bundle = buildSkillSynthesisCronDeps(makeInput({ sessionStore: sessionStore as any, outcomeStore: outcomeStore as any }))!;
    const trajectories = await bundle.buildSourceTrajectories("agent-1", "t");
    expect(trajectories).toHaveLength(1);
    expect(trajectories[0].trajectoryId).toBe(TURN_TRACE_ID);
    // The SELECT step does exactly this resolve — the emitted id MUST resolve to the
    // real outcome, otherwise synthesis is starved (selected:0) forever.
    const resolved = await bundle.outcomeSignal.resolve(trajectories[0].trajectoryId, { tenantId: "t", agentId: "agent-1" });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.outcome).toBe("success");
  });
});
