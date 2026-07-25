// SPDX-License-Identifier: Apache-2.0
/**
 * Neighbor tests for the LLM-judge conversational-breadth fallback
 * (`maybeUpgradeWithJudge`), extracted into its own leaf to keep setup-learning.ts /
 * setup-learning-reactions.ts under the 800-line cap. Pins: upgrade-on-unknown,
 * skip-on-resolved, byte-identical-when-disabled/absent, and non-fatal-on-throw.
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("@comis/agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@comis/agent")>();
  return {
    ...actual,
    resolveProviderApiKey: vi.fn(async () => "oauth-access-token"),
    createOutcomeJudgeSeam: vi.fn(() =>
      vi.fn(async () => ({
        outcome: "unknown" as const,
        confidence: 0,
        cappedConfidence: 0,
        source: "judge" as const,
      })),
    ),
  };
});

import { createOutcomeJudgeSeam, resolveProviderApiKey } from "@comis/agent";
import { createConversationLocator } from "@comis/core";
import { ok } from "@comis/shared";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { bindLearningOAuthCredentialResolver, buildOutcomeJudgeWiring, createLateBoundLearningCredentialResolver, maybeUpgradeWithJudge } from "./setup-learning-judge.js";

const NOW = 1_700_000_000_000;
const TENANT = "tenant-x";
const TRACE = "trace-judge-001";
const JUDGE_CONVERSATION = createConversationLocator({
  tenantId: TENANT,
  agentId: "a1",
  partition: { kind: "principal", principalId: "judge-user" },
});
if (!JUDGE_CONVERSATION.ok) throw JUDGE_CONVERSATION.error;

const SCOPE = { tenantId: "t", agentId: "a", sessionId: "s", trajectoryId: "traj" };
const noopLogger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } as never;
const clock = { now: () => 1000 } as never;
const UNKNOWN = { outcome: "unknown" as const, confidence: 0, sources: [], recalledIds: [], usedSkillIds: [] };
const judgeVerdict = (outcome: "success" | "failure" | "unknown", cappedConfidence: number) => ({
  outcome,
  confidence: cappedConfidence,
  cappedConfidence,
  source: "judge" as const,
  judgeModel: "example/judge",
  rubricHash: "a".repeat(64),
  evidenceRefs: ["b".repeat(64)],
});

describe("late-bound learning credential resolution", () => {
  it("delegates to the agent credential resolver after agent setup binds it", async () => {
    const holder = createLateBoundLearningCredentialResolver();
    expect(await holder.resolve("a1", "openai-codex")).toBeUndefined();

    const resolver = vi.fn(async () => "oauth-access-token");
    holder.bind(resolver);

    expect(await holder.resolve("a1", "openai-codex")).toBe("oauth-access-token");
    expect(resolver).toHaveBeenCalledWith("a1", "openai-codex");
  });

  it("binds OAuth resolution to the agent runtime credential storage", async () => {
    const holder = createLateBoundLearningCredentialResolver();
    const warn = vi.fn();
    const oauthManager = { getApiKey: vi.fn() };
    const authStorage = { getApiKey: vi.fn(), setRuntimeApiKey: vi.fn() };
    bindLearningOAuthCredentialResolver({
      bind: holder.bind,
      oauthManagers: new Map([["a1", oauthManager as never]]),
      authStorages: new Map([["a1", authStorage as never]]),
      agents: { a1: { provider: "openai-codex", model: "gpt-5.6-sol" } as never },
      providers: { entries: {} },
      logger: { ...createMockLogger(), warn } as never,
    });

    expect(await holder.resolve("a1", "openai-codex")).toBe("oauth-access-token");
    expect(resolveProviderApiKey).toHaveBeenCalledWith(
      "openai-codex",
      expect.objectContaining({ authStorage, oauthManager }),
    );
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("maybeUpgradeWithJudge — conversational-breadth fallback", () => {
  it("upgrades an UNKNOWN verdict to the judge's success (observe source:judge + re-resolve)", async () => {
    const observe = vi.fn(async () => ({ ok: true as const, value: undefined }));
    const resolve = vi.fn(async () => ({ ok: true as const, value: { outcome: "success" as const, confidence: 0.7, sources: ["judge" as const], recalledIds: [], usedSkillIds: [] } }));
    const outcomeJudge = vi.fn(async () => judgeVerdict("success", 0.7));
    const r = await maybeUpgradeWithJudge(
      { outcomeStore: { observe, resolve } as never, clock, logger: noopLogger, outcomeJudge: outcomeJudge as never, learningOutcomeJudgeEnabled: () => true, readTurnTranscript: () => "user asked X; assistant satisfied it" },
      SCOPE,
      UNKNOWN,
    );
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({ source: "judge", outcome: "success", confidence: 0.7 }));
    expect(outcomeJudge).toHaveBeenCalledWith({
      agentId: SCOPE.agentId,
      trajectoryContent: "user asked X; assistant satisfied it",
    });
    expect(resolve).toHaveBeenCalled();
    expect(r.outcome).toBe("success");
  });

  it("records content-free judge provenance for the evaluated agent and policy snapshot", async () => {
    const info = vi.fn();
    const policyHash = "a".repeat(64);
    const rubricHash = "b".repeat(64);
    const evidenceRefs = ["c".repeat(64)];
    await maybeUpgradeWithJudge(
      {
        outcomeStore: {
          observe: vi.fn(async () => ({ ok: true as const, value: undefined })),
          resolve: vi.fn(async () => ({ ok: true as const, value: UNKNOWN })),
        } as never,
        clock,
        logger: { ...noopLogger, info } as never,
        outcomeJudge: vi.fn(async () => ({
          outcome: "success" as const,
          cappedConfidence: 0.7,
          policyHash,
          judgeModel: "anthropic/claude-haiku-4-5-20251001",
          rubricHash,
          evidenceRefs,
        })) as never,
        learningOutcomeJudgeEnabled: () => true,
        readTurnTranscript: () => "private transcript body",
      },
      { ...SCOPE, workspacePolicyHash: policyHash },
      UNKNOWN,
    );

    expect(info).toHaveBeenCalledWith({
      agentId: SCOPE.agentId,
      trajectoryId: SCOPE.trajectoryId,
      outcome: "success",
      workspacePolicyHash: policyHash,
      judgeModel: "anthropic/claude-haiku-4-5-20251001",
      rubricHash,
      evidenceRefs,
      durationMs: 0,
      step: "outcome-judge",
    }, "Outcome judge verdict recorded");
    expect(JSON.stringify(info.mock.calls)).not.toContain("private transcript body");
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
      { outcomeStore: { observe, resolve: vi.fn() } as never, clock, logger: noopLogger, outcomeJudge: (async () => judgeVerdict("success", 0.7)) as never, learningOutcomeJudgeEnabled: () => false, readTurnTranscript: () => "x" },
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
    const outcomeJudge = vi.fn(async () => judgeVerdict("success", 0.7));
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
      { outcomeStore: { observe, resolve } as never, clock, logger: noopLogger, outcomeJudge: (async () => judgeVerdict("unknown", 0)) as never, learningOutcomeJudgeEnabled: () => true, readTurnTranscript: () => "x" },
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
      { outcomeStore: { observe, resolve } as never, clock, logger: noopLogger, outcomeJudge: (async () => judgeVerdict("success", 0.7)) as never, learningOutcomeJudgeEnabled: () => true, readTurnTranscript: () => "x" },
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

describe("buildOutcomeJudgeWiring — daemon construction behind the byte-identity gate", () => {
  function makeContainer(over: { agents?: Record<string, unknown>; costFeatures?: boolean; dataDir?: string; secrets?: Record<string, string>; entries?: Record<string, unknown>; workspacePolicyPort?: unknown } = {}) {
    const secrets = over.secrets ?? {};
    return {
      config: {
        agents: over.agents ?? {},
        dataDir: over.dataDir ?? "",
        // The master kill-switch is `memory.enabled`.
        memory: { enabled: over.costFeatures ?? true },
        providers: { entries: over.entries ?? {} },
      },
      secretManager: { get: (name: string): string | undefined => secrets[name] },
      workspacePolicyPort: over.workspacePolicyPort,
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

  it("KEYLESS-CUSTOM-NAME: a custom-NAMED keyless provider (type: ollama) BUILDS the judge keyless (not a no-op)", () => {
    // A local keyless daemon (e.g. qwen3.6:35b) exposes the bug: keyless was checked by provider NAME,
    // but KEYLESS_PROVIDER_TYPES holds TYPEs. A user-named ollama entry failed the check → no apiKey →
    // resolveOutcomeJudge returned undefined → the outcome judge was a silent no-op on a local keyless
    // daemon. The completion path keys keyless-ness off entry.type, so this must too.
    const built = buildOutcomeJudgeWiring(
      makeContainer({
        agents: { default: { provider: "local-ollama", model: "qwen3.6:35b", learningOutcome: { enabled: true, judge: { enabled: true } } } },
        entries: { "local-ollama": { type: "ollama", baseUrl: "http://localhost:11434", models: [{ id: "qwen3.6:35b" }] } },
        secrets: {},
      }),
      createFakeClock(NOW),
      createMockLogger(),
      makeLcdStore(),
    );
    expect(built.outcomeJudge).toBeDefined(); // keyless-by-name would leave this undefined → the silent no-op
  });

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

  it("builds the outcome judge from a late-bound OAuth credential when no static API key exists", async () => {
    const resolveCredential = vi.fn(async () => "oauth-access-token");
    const seam = vi.fn(async () => judgeVerdict("success", 0.7));
    vi.mocked(createOutcomeJudgeSeam).mockReturnValueOnce(seam as never);

    const built = buildOutcomeJudgeWiring(
      makeContainer({
        agents: {
          a1: {
            provider: "openai-codex",
            model: "gpt-5.6-sol",
            oauthProfiles: { "openai-codex": "openai-codex:test@example.com" },
            learningOutcome: { enabled: true, judge: { enabled: true } },
          },
        },
        secrets: {},
      }),
      createFakeClock(NOW),
      createMockLogger(),
      makeLcdStore(),
      resolveCredential,
    );

    expect(built.outcomeJudge).toBeDefined();
    await built.outcomeJudge!({ agentId: "a1", trajectoryContent: "bounded transcript" });
    expect(resolveCredential).toHaveBeenCalledWith("a1", "openai-codex");
    expect(createOutcomeJudgeSeam).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai-codex",
        modelId: "gpt-5.4-mini",
        apiKey: "oauth-access-token",
        agentId: "a1",
      }),
    );
    expect(seam).toHaveBeenCalledTimes(1);
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
    const transcript = built.readTurnTranscript!({ tenantId: TENANT, agentId: "a1", sessionId: "sess-1", trajectoryId: TRACE, conversationRef: JUDGE_CONVERSATION.value.conversationRef });
    expect(lcd.getMessages).toHaveBeenCalledWith({ conversationRef: JUDGE_CONVERSATION.value.conversationRef, tenantId: TENANT, agentId: "a1", sessionKey: "sess-1" });
    expect(transcript).toBe("user: please summarize\nassistant: here is the summary");
  });

  it("passes the exact previously loaded policy snapshot instead of rereading workspace files", async () => {
    const policySnapshot = {
      agentId: "default",
      combinedHash: "a".repeat(64),
      sections: [{
        id: "workspace:role",
        sourceKind: "operator" as const,
        trust: "trusted" as const,
        stability: "stable" as const,
        content: "Configured operator policy.",
        contentHash: "b".repeat(64),
        maxChars: 20_000,
      }],
    };
    const get = vi.fn(() => ok(policySnapshot));
    const seam = vi.fn(async () => ({
      outcome: "unknown" as const,
      confidence: 0,
      cappedConfidence: 0,
      source: "judge" as const,
    }));
    vi.mocked(createOutcomeJudgeSeam).mockReturnValueOnce(seam as never);

    const built = buildOutcomeJudgeWiring(
      makeContainer({
        agents: { default: { provider: "anthropic", learningOutcome: { enabled: true, judge: { enabled: true } } } },
        secrets: { ANTHROPIC_API_KEY: "test-key" },
        workspacePolicyPort: { get, load: vi.fn() },
      }),
      createFakeClock(NOW),
      createMockLogger(),
      makeLcdStore(),
    );

    await built.outcomeJudge?.({
      agentId: "default",
      trajectoryContent: "turn transcript",
      workspacePolicyHash: policySnapshot.combinedHash,
    });
    expect(get).toHaveBeenCalledWith(policySnapshot.combinedHash);
    expect(seam).toHaveBeenLastCalledWith({
      policySnapshot,
      trajectoryContent: "turn transcript",
    });
  });

  it("preserves judge provenance when mapping the per-agent seam", async () => {
    const provenance = {
      outcome: "success" as const,
      confidence: 0.6,
      cappedConfidence: 0.6,
      source: "judge" as const,
      policyHash: "a".repeat(64),
      judgeModel: "anthropic/claude-haiku-4-5-20251001",
      rubricHash: "b".repeat(64),
      evidenceRefs: ["c".repeat(64)],
    };
    vi.mocked(createOutcomeJudgeSeam).mockReturnValueOnce(vi.fn(async () => provenance));
    const built = buildOutcomeJudgeWiring(
      makeContainer({
        agents: { default: { provider: "anthropic", learningOutcome: { enabled: true } } },
        secrets: { ANTHROPIC_API_KEY: "test-key" },
      }),
      createFakeClock(NOW),
      createMockLogger(),
      makeLcdStore(),
    );

    await expect(built.outcomeJudge?.({
      agentId: "default",
      trajectoryContent: "turn transcript",
    })).resolves.toEqual(provenance);
  });

  it("resolves the judge model independently for each evaluated agent", () => {
    vi.mocked(createOutcomeJudgeSeam).mockClear();
    buildOutcomeJudgeWiring(
      makeContainer({
        agents: {
          agent_a: { provider: "provider-a", model: "provider-a:model-a", learningOutcome: { enabled: true } },
          agent_b: { provider: "provider-b", model: "provider-b:model-b", learningOutcome: { enabled: true } },
        },
        secrets: { "PROVIDER-A_API_KEY": "test-key", "PROVIDER-B_API_KEY": "test-key" },
      }),
      createFakeClock(NOW),
      createMockLogger(),
      makeLcdStore(),
    );
    expect(vi.mocked(createOutcomeJudgeSeam).mock.calls.map(([deps]) => deps.agentId))
      .toEqual(["agent_a", "agent_b"]);
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
  // The master kill-switch `memory.enabled` MUST NOT silently invert the gate.
  // A LOOSE local slice type (e.g. `memory?: { costFeatures?: { enabled?: boolean } }`)
  // would let a config carrying ONLY `memory.enabled:false` read a missing key as
  // `undefined !== false === true` → FORCE-ENABLED (the kill-switch inverts), and
  // tsc would NOT catch it (a loose optional type tolerates the missing key). This
  // test pins the correct behavior (force-DISABLE on memory.enabled:false); the
  // local slice points at the real MemoryConfig type so tsc enforces it, and this
  // explicit guard is the belt.
  // -------------------------------------------------------------------------
  it("memory.enabled:false (the master kill-switch) force-DISABLES the judge for every agent", () => {
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
    // (A loose slice type would misread this as force-ENABLED — the fail-open this guards against.)
    expect(built.learningOutcomeJudgeEnabled("a1")).toBe(false);
    // And byte-identity: no seam/reader is constructed when the master switch is off.
    expect(built.outcomeJudge).toBeUndefined();
    expect(built.readTurnTranscript).toBeUndefined();
  });
});
