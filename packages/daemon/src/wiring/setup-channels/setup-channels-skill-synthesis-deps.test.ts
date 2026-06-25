// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for buildReflectionCronDeps — the closed-graph REFLECTION bundle assembler
 * (v2.31 Reflection, Phase 223 Plan 05, REFLECT-01/02 — the reflect-engine
 * replacement for the deleted buildSkillSynthesisCronDeps). The daemon is the SOLE
 * composition root joining @comis/memory (the mental-model + outcome stores) +
 * @comis/agent (the reflection job); this helper builds the bundle the `__REFLECT__`
 * sentinel injects.
 *
 * What CHANGED from the synthesis deps tests (delete-order step 2): the embedding-
 * clustering attach (`attachClusteringEmbeddings`), the sandbox validation adapter,
 * and the approval gate are GONE — those describes are removed. The enumerate-then-
 * resolve source builder is KEPT, now emitting `{ trajectoryId, sessionId, sender,
 * text, signature, trustedOrigin }` (NO embedding). NEW: the daemon-derived
 * `trustedOrigin` (INV-5/D-04) is proven BOTH directions, including deny-on-unknown.
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";

import { buildReflectionCronDeps, type ReflectionDepsInput } from "./setup-channels-skill-synthesis-deps.js";

function makeInput(over: Partial<ReflectionDepsInput> = {}): ReflectionDepsInput {
  return {
    container: { config: { tenantId: "t", agents: { "agent-1": {} } } } as any,
    tenantId: "t",
    sessionStore: { listDetailed: vi.fn(() => []), loadByFormattedKey: vi.fn(() => undefined) } as any,
    outcomeStore: { resolve: vi.fn(), observe: vi.fn(), prune: vi.fn() } as any,
    learnedSkillStore: { get: vi.fn(), admit: vi.fn() } as any,
    ...over,
  };
}

describe("buildReflectionCronDeps", () => {
  it("returns undefined when the mental-model store is absent (the sentinel then reports not-wired)", () => {
    expect(buildReflectionCronDeps(makeInput({ learnedSkillStore: undefined }))).toBeUndefined();
  });

  it("returns undefined when the outcome store is absent", () => {
    expect(buildReflectionCronDeps(makeInput({ outcomeStore: undefined }))).toBeUndefined();
  });

  it("injects the mental-model store + the outcome success gate (the closed-graph adapters)", () => {
    const input = makeInput();
    const bundle = buildReflectionCronDeps(input)!;
    expect(bundle).toBeDefined();
    expect(bundle.learnedSkillStore).toBe(input.learnedSkillStore);
    expect(bundle.outcomeSignal).toBe(input.outcomeStore);
    // No approvalGate / buildValidationAdapter on the reflect bundle (an advisory doc
    // carries no executable surface; the JOB's static validateLearnedDocBody is all).
    expect((bundle as Record<string, unknown>).approvalGate).toBeUndefined();
    expect((bundle as Record<string, unknown>).buildValidationAdapter).toBeUndefined();
  });

  it("emits one source trajectory per resolvable PER-TURN traceId, with the session transcript as text + a user-role signature (buildSourceTrajectories)", async () => {
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
    // u1 is a TRUSTED sender via senderTrustMap → trustedOrigin true.
    const container = { config: { tenantId: "t", agents: { "agent-1": { elevatedReply: { senderTrustMap: { u1: "verified" }, defaultTrustLevel: "external" } } } } };
    const bundle = buildReflectionCronDeps(makeInput({ sessionStore: sessionStore as any, outcomeStore: outcomeStore as any, container: container as any }))!;
    const trajectories = await bundle.buildSourceTrajectories("agent-1", "t");
    expect(trajectories).toHaveLength(1);
    expect(trajectories[0].trajectoryId).toBe("turn-1"); // the per-turn traceId resolve() keys on, NOT the sessionKey
    expect(trajectories[0].sessionId).toBe("s1");
    expect(trajectories[0].sender).toBe("u1");
    expect(trajectories[0].text).toContain("do X");
    expect(trajectories[0].text).toContain("did X");
    // The topicKey signature is the user-role text (the JOB normalizes it).
    expect(trajectories[0].signature).toBe("do X");
    // No clustering embedding on the reflect source (group-by topicKey replaces it).
    expect((trajectories[0] as Record<string, unknown>).embedding).toBeUndefined();
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
    const bundle = buildReflectionCronDeps(makeInput({ sessionStore: sessionStore as any, outcomeStore: outcomeStore as any }))!;
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
    const bundle = buildReflectionCronDeps(makeInput({ sessionStore: sessionStore as any, outcomeStore: outcomeStore as any }))!;
    expect(await bundle.buildSourceTrajectories("agent-1", "t")).toHaveLength(0);
  });

  // ── REGRESSION (live VPS incident 2026-06-18): trajectory-identity mismatch ──
  // The SELECT step resolves each source trajectory's `trajectoryId` against the
  // outcome signal. Outcomes are keyed by the PER-TURN traceId, not the sessionKey —
  // so the source must emit a traceId that resolves. Pre-fix it emitted the sessionKey
  // → resolve()=`unknown` → `selected:0` forever. (Carried over from the synthesis
  // deps suite — the reflection SELECT inherits the identity contract verbatim.)
  it("emits a trajectoryId the outcome signal can resolve (the §3 identity mismatch — FIXED)", async () => {
    const SESSION_KEY = "default:openai-api:openai";
    const TURN_TRACE_ID = "942cc2e5-48e9-434e-8d1d-aa55fb1f06d6"; // the per-turn id outcomes are keyed on
    const sessionStore = {
      listDetailed: vi.fn(() => [{ sessionKey: SESSION_KEY, userId: "u1", tenantId: "t", channelId: "openai", metadata: null, createdAt: 1, updatedAt: 2, messageCount: 2 }]),
      loadByFormattedKey: vi.fn(() => ({ messages: [{ role: "user", content: "scaffold a python module and run it" }, { role: "assistant", content: "done, output 7" }], metadata: {}, createdAt: 1, updatedAt: 2 })),
    };
    const outcomeStore = {
      observe: vi.fn(),
      prune: vi.fn(),
      listTrajectoryIds: vi.fn(async () => ({ ok: true as const, value: [{ trajectoryId: TURN_TRACE_ID, sessionId: SESSION_KEY }] })),
      resolve: vi.fn(async (id: string) =>
        id === TURN_TRACE_ID
          ? { ok: true as const, value: { outcome: "success" as const, confidence: 0.9, sources: ["tool" as const], recalledIds: [], usedSkillIds: [] } }
          : { ok: true as const, value: { outcome: "unknown" as const, confidence: 0, sources: [], recalledIds: [], usedSkillIds: [] } }),
    };
    const bundle = buildReflectionCronDeps(makeInput({ sessionStore: sessionStore as any, outcomeStore: outcomeStore as any }))!;
    const trajectories = await bundle.buildSourceTrajectories("agent-1", "t");
    expect(trajectories).toHaveLength(1);
    expect(trajectories[0].trajectoryId).toBe(TURN_TRACE_ID);
    const resolved = await bundle.outcomeSignal.resolve(trajectories[0].trajectoryId, { tenantId: "t", agentId: "agent-1" });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.outcome).toBe("success");
  });

  // ── TRUSTED-ORIGIN DERIVATION (INV-5/D-04, M-1) — daemon-side, deny-on-unknown ──
  // `ResolvedOutcome` does NOT carry sender_trust (Research A2), so the daemon derives
  // trust here from the per-agent elevatedReply.senderTrustMap + defaultTrustLevel.
  // The JOB FILTERS on the resulting `trustedOrigin` (reflection-job.ts SELECT, RED both
  // directions in Plan 04); these tests pin the DERIVATION feeding it. CRITICAL: an
  // unknown/unmapped sender must be `false` (deny-on-unknown) — never trusted.
  describe("trustedOrigin derivation (INV-5/D-04 — deny-on-unknown)", () => {
    const ONE_TURN = (over: Record<string, unknown> = {}) => ({
      sessionStore: {
        listDetailed: vi.fn(() => [{ sessionKey: "s1", userId: "u1", tenantId: "t", channelId: "c", metadata: null, createdAt: 1, updatedAt: 2, messageCount: 2 }]),
        loadByFormattedKey: vi.fn(() => ({ messages: [{ role: "user", content: "do X" }, { role: "assistant", content: "did X" }], metadata: {}, createdAt: 1, updatedAt: 2 })),
      } as any,
      outcomeStore: {
        observe: vi.fn(), prune: vi.fn(), resolve: vi.fn(),
        listTrajectoryIds: vi.fn(async () => ({ ok: true as const, value: [{ trajectoryId: "turn-1", sessionId: "s1" }] })),
      } as any,
      ...over,
    });

    function withAgentTrust(elevatedReply: unknown) {
      return { config: { tenantId: "t", agents: { "agent-1": { elevatedReply } } } } as any;
    }

    it("a sender mapped to a NON-external tier is a trusted origin (trustedOrigin: true)", async () => {
      const container = withAgentTrust({ senderTrustMap: { u1: "verified" }, defaultTrustLevel: "external" });
      const bundle = buildReflectionCronDeps(makeInput({ ...ONE_TURN(), container }))!;
      const traj = await bundle.buildSourceTrajectories("agent-1", "t");
      expect(traj[0].trustedOrigin).toBe(true);
    });

    it("a sender explicitly mapped to the external tier is NOT trusted (trustedOrigin: false)", async () => {
      const container = withAgentTrust({ senderTrustMap: { u1: "external" }, defaultTrustLevel: "verified" });
      const bundle = buildReflectionCronDeps(makeInput({ ...ONE_TURN(), container }))!;
      const traj = await bundle.buildSourceTrajectories("agent-1", "t");
      expect(traj[0].trustedOrigin).toBe(false);
    });

    it("DENY-ON-UNKNOWN: an UNMAPPED sender with the default 'external' tier is NOT trusted (the M-1 guard)", async () => {
      // No senderTrustMap entry for u1, default is the external tier ⇒ deny.
      const container = withAgentTrust({ senderTrustMap: {}, defaultTrustLevel: "external" });
      const bundle = buildReflectionCronDeps(makeInput({ ...ONE_TURN(), container }))!;
      const traj = await bundle.buildSourceTrajectories("agent-1", "t");
      expect(traj[0].trustedOrigin).toBe(false);
    });

    it("DENY-ON-UNKNOWN: an agent with NO elevatedReply config at all denies an unmapped sender (schema-default external)", async () => {
      // elevatedReply absent ⇒ {} + "external" default ⇒ every unmapped sender denied.
      const container = { config: { tenantId: "t", agents: { "agent-1": {} } } } as any;
      const bundle = buildReflectionCronDeps(makeInput({ ...ONE_TURN(), container }))!;
      const traj = await bundle.buildSourceTrajectories("agent-1", "t");
      expect(traj[0].trustedOrigin).toBe(false);
    });

    it("DENY-ON-UNKNOWN: an empty sender id is NOT trusted regardless of an over-permissive default", async () => {
      // A session with no resolvable userId ⇒ sender "" ⇒ cannot establish trust ⇒ deny,
      // even if the operator set a trusted default.
      const noSender = {
        sessionStore: {
          listDetailed: vi.fn(() => [{ sessionKey: "s1", userId: "", tenantId: "t", channelId: "c", metadata: null, createdAt: 1, updatedAt: 2, messageCount: 2 }]),
          loadByFormattedKey: vi.fn(() => ({ messages: [{ role: "user", content: "do X" }], metadata: {}, createdAt: 1, updatedAt: 2 })),
        } as any,
        outcomeStore: {
          observe: vi.fn(), prune: vi.fn(), resolve: vi.fn(),
          listTrajectoryIds: vi.fn(async () => ({ ok: true as const, value: [{ trajectoryId: "turn-1", sessionId: "s1" }] })),
        } as any,
      };
      const container = withAgentTrust({ senderTrustMap: {}, defaultTrustLevel: "verified" });
      const bundle = buildReflectionCronDeps(makeInput({ ...noSender, container }))!;
      const traj = await bundle.buildSourceTrajectories("agent-1", "t");
      expect(traj[0].sender).toBe("");
      expect(traj[0].trustedOrigin).toBe(false);
    });
  });
});
