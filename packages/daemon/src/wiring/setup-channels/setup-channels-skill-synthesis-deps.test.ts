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

/** A minimal EmbeddingPort double (returns a deterministic vector per text). */
function makeEmbedder(over: Record<string, unknown> = {}) {
  return {
    provider: "test",
    modelId: "test-embed",
    dimensions: 3,
    embed: vi.fn(async (_t: string) => ({ ok: true as const, value: [1, 0, 0] })),
    // distinct vector per text so cosine clustering is meaningful in downstream tests
    embedBatch: vi.fn(async (texts: string[]) => ({ ok: true as const, value: texts.map((t) => [t.length, t.includes("X") ? 1 : 0, 0]) })),
    ...over,
  };
}

function makeInput(over: Partial<SkillSynthesisDepsInput> = {}, embedder?: unknown): SkillSynthesisDepsInput {
  return {
    container: { config: { tenantId: "t", agents: { "agent-1": { skills: { toolPolicy: { profile: "full", allow: [], deny: [] } } } } } } as any,
    tenantId: "t",
    assembleToolsForAgent: vi.fn(async () => [{ name: "read" }]) as any,
    sessionStore: { listDetailed: vi.fn(() => []), loadByFormattedKey: vi.fn(() => undefined) } as any,
    outcomeStore: { resolve: vi.fn(), observe: vi.fn(), prune: vi.fn() } as any,
    learnedSkillStore: { admit: vi.fn() } as any,
    approvalGate: { requestApproval: vi.fn(async () => ({ approved: false })) } as any,
    // RC-1: the embedder is threaded explicitly (NOT read off container — it's kept off
    // AppContainer, the agent-accessible path). Pass via the 2nd arg in the embedding tests.
    ...(embedder !== undefined ? { embeddingPort: embedder as any } : {}),
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

  // ── EMBEDDING INJECTION (RC-1 / SYNTH-EMBED-DEAD, live incident 2026-06-25) ──
  // The synthesis CLUSTER step groups trajectories by cosine similarity of their
  // `embedding`; a trajectory with NO embedding is a singleton, so `maxClusterCardinality`
  // is ALWAYS 1 and nothing is ever admitted. Pre-fix the daemon source builder emitted
  // `{trajectoryId, sessionId, sender, text}` with NO embedding → skill synthesis was
  // DEAD in production regardless of corroboration. The fix reads the container's
  // embedder (`container.cachedPort`, the cached+circuit-broken EmbeddingPort already used
  // for recall) and attaches an embedding per trajectory. Reading the always-present
  // container field (not a separately-threaded param) makes the built-but-not-wired class
  // structurally impossible here.
  const SESSION_ONE_TURN = (over: Record<string, unknown> = {}) => ({
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

  it("attaches an embedding to each source trajectory when the container has an embedder (RC-1 fix)", async () => {
    const embedder = makeEmbedder();
    const bundle = buildSkillSynthesisCronDeps(makeInput(SESSION_ONE_TURN(), embedder))!;
    const trajectories = await bundle.buildSourceTrajectories("agent-1", "t");
    expect(trajectories).toHaveLength(1);
    // RED pre-fix: embedding is always undefined (the daemon never embeds) → singleton → admit:0 forever.
    expect(trajectories[0].embedding).toBeDefined();
    expect(Array.isArray(trajectories[0].embedding)).toBe(true);
    expect(embedder.embedBatch).toHaveBeenCalledOnce();
  });

  it("omits the embedding (non-fatal) and still emits trajectories when no embedder is configured", async () => {
    const bundle = buildSkillSynthesisCronDeps(makeInput(SESSION_ONE_TURN()))!; // no embedder on the container
    const trajectories = await bundle.buildSourceTrajectories("agent-1", "t");
    expect(trajectories).toHaveLength(1);
    expect(trajectories[0].embedding).toBeUndefined(); // graceful degradation = today's singleton behaviour
  });

  it("degrades gracefully (no embedding, no throw) when embedBatch errors — the cron must never break", async () => {
    const embedder = makeEmbedder({ embedBatch: vi.fn(async () => ({ ok: false as const, error: new Error("breaker open") })) });
    const bundle = buildSkillSynthesisCronDeps(makeInput(SESSION_ONE_TURN(), embedder))!;
    const trajectories = await bundle.buildSourceTrajectories("agent-1", "t");
    expect(trajectories).toHaveLength(1); // still emitted
    expect(trajectories[0].embedding).toBeUndefined(); // fell back to singleton, non-fatal
  });

  it("dedupes embedding work across trajectories that share a session transcript", async () => {
    const embedder = makeEmbedder();
    // two per-turn ids in the SAME session → one transcript → embedBatch should be called with 1 unique text
    const over = {
      sessionStore: {
        listDetailed: vi.fn(() => [{ sessionKey: "s1", userId: "u1", tenantId: "t", channelId: "c", metadata: null, createdAt: 1, updatedAt: 2, messageCount: 2 }]),
        loadByFormattedKey: vi.fn(() => ({ messages: [{ role: "user", content: "do X" }], metadata: {}, createdAt: 1, updatedAt: 2 })),
      } as any,
      outcomeStore: {
        observe: vi.fn(), prune: vi.fn(), resolve: vi.fn(),
        listTrajectoryIds: vi.fn(async () => ({ ok: true as const, value: [{ trajectoryId: "turn-1", sessionId: "s1" }, { trajectoryId: "turn-2", sessionId: "s1" }] })),
      } as any,
    };
    const bundle = buildSkillSynthesisCronDeps(makeInput(over, embedder))!;
    const trajectories = await bundle.buildSourceTrajectories("agent-1", "t");
    expect(trajectories).toHaveLength(2);
    expect(embedder.embedBatch).toHaveBeenCalledOnce();
    expect((embedder.embedBatch.mock.calls[0][0] as string[]).length).toBe(1); // one unique transcript embedded
    // both trajectories carry the (same) embedding
    expect(trajectories[0].embedding).toBeDefined();
    expect(trajectories[1].embedding).toEqual(trajectories[0].embedding);
  });

  // ── TASK-SIGNATURE CLUSTERING (RC-2, live incident 2026-06-25) ──
  // Embedding the RAW TRANSCRIPT is too sensitive to agent-response wording: two
  // analogous successful tasks (even with IDENTICAL user requests) get slightly
  // different agent responses → full-transcript cosine < 0.82 → they DON'T cluster
  // → no corroboration → admit:0. The fix embeds a STABLE task SIGNATURE (the user
  // request — the intent the user controls), NOT the variable agent prose. The full
  // transcript is still kept as `text` (the LLM distills the skill BODY from it).
  it("embeds a stable task SIGNATURE (user request), not the variable agent response, so analogous tasks cluster (RC-2)", async () => {
    const embedder = makeEmbedder();
    const sessionStore = {
      listDetailed: vi.fn(() => [
        { sessionKey: "sA", userId: "uA", tenantId: "t", channelId: "c", metadata: null, createdAt: 1, updatedAt: 2, messageCount: 2 },
        { sessionKey: "sB", userId: "uB", tenantId: "t", channelId: "c", metadata: null, createdAt: 1, updatedAt: 2, messageCount: 2 },
      ]),
      // SAME user request, DIFFERENT agent responses (the real-world case that broke clustering).
      loadByFormattedKey: vi.fn((k: string) =>
        k === "sA"
          ? { messages: [{ role: "user", content: "deliver a package to Acme, give the full procedure" }, { role: "assistant", content: "RESPONSEVARIANTAAAA alpha unique phrasing one" }], metadata: {}, createdAt: 1, updatedAt: 2 }
          : { messages: [{ role: "user", content: "deliver a package to Acme, give the full procedure" }, { role: "assistant", content: "RESPONSEVARIANTBBBB beta totally different words two" }], metadata: {}, createdAt: 1, updatedAt: 2 }),
    };
    const outcomeStore = {
      observe: vi.fn(), prune: vi.fn(), resolve: vi.fn(),
      listTrajectoryIds: vi.fn(async () => ({ ok: true as const, value: [{ trajectoryId: "tA", sessionId: "sA" }, { trajectoryId: "tB", sessionId: "sB" }] })),
    };
    const bundle = buildSkillSynthesisCronDeps(makeInput({ sessionStore: sessionStore as any, outcomeStore: outcomeStore as any }, embedder))!;
    const trajectories = await bundle.buildSourceTrajectories("agent-1", "t");
    expect(trajectories).toHaveLength(2);
    // The CLUSTERING embedding input is the SIGNATURE (the shared user request), so both
    // sessions embed the SAME text → one unique input → they will cosine-cluster (cardinality 2).
    const embedded = embedder.embedBatch.mock.calls[0][0] as string[];
    expect(embedded).toHaveLength(1); // RED pre-fix: 2 divergent transcripts (the agent responses differ)
    expect(embedded[0]).toContain("deliver a package to Acme");
    expect(embedded[0]).not.toContain("RESPONSEVARIANT"); // the variable agent prose is NOT in the signature
    // …but the full transcript is STILL the synthesis input (the skill body is distilled from it).
    expect(trajectories[0].text).toContain("RESPONSEVARIANTAAAA");
    expect(trajectories[1].text).toContain("RESPONSEVARIANTBBBB");
    // both sessions get the same (signature) embedding → they cluster
    expect(trajectories[0].embedding).toEqual(trajectories[1].embedding);
  });

  it("falls back to the full text for the signature when a session has no user-role message", async () => {
    const embedder = makeEmbedder();
    const sessionStore = {
      listDetailed: vi.fn(() => [{ sessionKey: "s1", userId: "u1", tenantId: "t", channelId: "c", metadata: null, createdAt: 1, updatedAt: 2, messageCount: 1 }]),
      loadByFormattedKey: vi.fn(() => ({ messages: [{ role: "assistant", content: "only an assistant turn here" }], metadata: {}, createdAt: 1, updatedAt: 2 })),
    };
    const outcomeStore = {
      observe: vi.fn(), prune: vi.fn(), resolve: vi.fn(),
      listTrajectoryIds: vi.fn(async () => ({ ok: true as const, value: [{ trajectoryId: "turn-1", sessionId: "s1" }] })),
    };
    const bundle = buildSkillSynthesisCronDeps(makeInput({ sessionStore: sessionStore as any, outcomeStore: outcomeStore as any }, embedder))!;
    const trajectories = await bundle.buildSourceTrajectories("agent-1", "t");
    expect(trajectories).toHaveLength(1);
    expect(trajectories[0].embedding).toBeDefined(); // signature fell back to the full text → still embedded
    expect((embedder.embedBatch.mock.calls[0][0] as string[])[0]).toContain("only an assistant turn");
  });

  // ── ENVELOPE STRIPPING (RC-2, live test-vs-prod divergence 2026-06-25) ──
  // LIVE the stored "user message" is wrapped by the executor envelope:
  //   [System context]\n<preamble incl. a VOLATILE timestamp>\n[End system context]\n\n[telegram] <id> (<time>):\n<actual request>
  // Both the preamble AND the channel header carry a per-turn timestamp, so two
  // IDENTICAL requests stored at different times produce DIFFERENT message text → the
  // signature differed → no clustering (the live failure this strip fixes).
  it("strips the [System context] envelope + channel header so two identical requests at different times get the SAME signature (RC-2 live shape)", async () => {
    const embedder = makeEmbedder();
    const wrap = (ts: string, time: string, req: string) =>
      `[System context]\n## Current Date & Time\n${ts}\n## Other dynamic stuff\nblah\n[End system context]\n\n[telegram] 678314278 (${time}):\n${req}`;
    const REQ = "deliver a package to Acme, give the full step-by-step procedure";
    const sessionStore = {
      listDetailed: vi.fn(() => [
        { sessionKey: "sA", userId: "uA", tenantId: "t", channelId: "c", metadata: null, createdAt: 1, updatedAt: 2, messageCount: 2 },
        { sessionKey: "sB", userId: "uB", tenantId: "t", channelId: "c", metadata: null, createdAt: 1, updatedAt: 2, messageCount: 2 },
      ]),
      loadByFormattedKey: vi.fn((k: string) =>
        k === "sA"
          ? { messages: [{ role: "user", content: wrap("2026-06-25T17:20:34Z", "5:20 PM", REQ) }, { role: "assistant", content: "step one alpha" }], metadata: {}, createdAt: 1, updatedAt: 2 }
          : { messages: [{ role: "user", content: wrap("2026-06-25T17:20:48Z", "5:21 PM", REQ) }, { role: "assistant", content: "step one beta" }], metadata: {}, createdAt: 1, updatedAt: 2 }),
    };
    const outcomeStore = {
      observe: vi.fn(), prune: vi.fn(), resolve: vi.fn(),
      listTrajectoryIds: vi.fn(async () => ({ ok: true as const, value: [{ trajectoryId: "tA", sessionId: "sA" }, { trajectoryId: "tB", sessionId: "sB" }] })),
    };
    const bundle = buildSkillSynthesisCronDeps(makeInput({ sessionStore: sessionStore as any, outcomeStore: outcomeStore as any }, embedder))!;
    const trajectories = await bundle.buildSourceTrajectories("agent-1", "t");
    expect(trajectories).toHaveLength(2);
    // The volatile envelope (timestamps) is stripped → both signatures collapse to the
    // SAME raw request → ONE unique embed input → they cosine-cluster (cardinality 2).
    const embedded = embedder.embedBatch.mock.calls[0][0] as string[];
    expect(embedded).toHaveLength(1); // RED pre-strip: 2 distinct (timestamps differ)
    expect(embedded[0]).toBe(REQ); // exactly the raw request — no [System context], no channel header, no timestamp
    expect(trajectories[0].embedding).toEqual(trajectories[1].embedding);
  });
});
