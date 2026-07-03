// SPDX-License-Identifier: Apache-2.0
/**
 * Conversational-breadth LLM-judge fallback — the LEAF for the
 * Verified Learning outcome judge.
 *
 * Extracted to its own leaf (like `setup-learning-corroboration.ts`) so neither
 * `setup-learning.ts` nor `setup-learning-reactions.ts` carries the judge bulk over its
 * 800-line cap. It imports NOTHING from those parents (one-directional — no cycle):
 *  - `setup-learning.ts` imports {@link maybeUpgradeWithJudge} (the resolve-seam upgrade);
 *  - `setup-memory.ts` imports {@link buildOutcomeJudgeWiring} (the daemon construction).
 *
 * Two halves:
 *  1. CONSTRUCTION ({@link buildOutcomeJudgeWiring}) — resolves the cheap `fast`-tier
 *     `outcomeJudge` model + key behind the byte-identity gate and builds the LCD-backed
 *     transcript reader. Mirrors the correction-detector "build only when needed" posture.
 *  2. CONSUME ({@link maybeUpgradeWithJudge}) — the resolve-seam upgrade: an `unknown`
 *     deterministic verdict (a CONVERSATIONAL turn with no tool/pipeline signal) gets ONE
 *     cheap-model judge pass; on a non-`unknown` verdict it `observe()`s a `source:"judge"`
 *     row (reward CODE-capped ≤ 0.7) then RE-RESOLVES. Deterministic tool/pipeline ALWAYS
 *     out-ranks the judge at fusion, so the judge runs ONLY on `unknown` (resolved turns
 *     skip it — bounds cost). NON-FATAL: a judge/observe/re-resolve error keeps the unknown
 *     verdict (WARN, never throws).
 *
 * Counts/ids/closed-enums only ever reach the store; the `source` is set in CODE (never
 * read from the model); the model's self-reported confidence is never trusted (the daemon
 * `observe()`s the seam's already-capped `cappedConfidence`).
 *
 * @module
 */

import {
  KEYLESS_PROVIDER_TYPES,
  KEYLESS_API_KEY_SENTINEL,
  type ClockPort,
  type ComisLogger,
  type ContextStorePort,
  type MemoryConfig,
  type OutcomeSignalPort,
  type ResolvedOutcome,
} from "@comis/core";
import { createOutcomeJudgeSeam, resolveOperationModel, resolveProviderFamily, normalizeOpenAICompatBaseUrl, type CustomCompletionsModelSpec } from "@comis/agent";

/**
 * Provider-config fields {@link buildCustomJudgeModelSpec} reads. `apiKeyName` is
 * declared (though unused here) so the narrower `{ apiKeyName?: string }` shapes
 * the reaction/usefulness containers expose stay assignable — TS's weak-type rule
 * rejects a source that shares NO property with an all-optional target.
 */
export interface JudgeProviderEntry {
  apiKeyName?: string;
  type?: string;
  baseUrl?: string;
  models?: ReadonlyArray<{ id: string; contextWindow?: number; maxTokens?: number; reasoning?: boolean }>;
}

/**
 * Build the custom-provider judge model spec from a provider config entry so the
 * memory/learning judge seams (outcome / correction / usefulness) run on a custom
 * YAML provider (ollama / lm-studio / vLLM / …) whose model is absent from pi-ai's
 * built-in catalog. Returns `undefined` for built-in providers (no baseUrl) — the
 * seam's catalog lookup handles those. Applies the SAME `/v1` normalization
 * `registerCustomProviders` uses, and reads contextWindow/maxTokens/reasoning from
 * the declared model entry. Shared by all three judge resolvers (live 2026-06-20).
 */
export function buildCustomJudgeModelSpec(
  providerEntry: JudgeProviderEntry | undefined,
  provider: string,
  modelId: string,
): CustomCompletionsModelSpec | undefined {
  if (!providerEntry?.baseUrl) return undefined;
  const baseUrl =
    normalizeOpenAICompatBaseUrl(providerEntry.baseUrl, providerEntry.type ?? provider) ??
    providerEntry.baseUrl;
  const modelEntry = providerEntry.models?.find((m) => m.id === modelId);
  return {
    baseUrl,
    contextWindow: modelEntry?.contextWindow,
    maxTokens: modelEntry?.maxTokens,
    reasoning: modelEntry?.reasoning,
  };
}

/** Per-call output bound for the cheap outcome-judge verdict (a tiny JSON shape). */
const OUTCOME_JUDGE_MAX_OUTPUT_TOKENS = 1024;
/** Max recent user/assistant text messages the judge scores per turn (bounds prompt size). */
const JUDGE_TRANSCRIPT_MAX_MESSAGES = 12;

/** The mapped judge seam the resolve consume-seam calls (the verdict's narrow union + the CODE-capped reward). */
export type OutcomeJudge = (
  trajectoryContent: string,
) => Promise<{ outcome: "success" | "failure" | "unknown"; cappedConfidence: number } | undefined>;

/** The resolved scope an upgrade/transcript-read keys on (mirrors the setup-learning OutcomeScope). */
export interface JudgeScope {
  tenantId: string;
  agentId: string;
  sessionId: string;
  trajectoryId: string;
}

// ===========================================================================
// 1. Daemon construction — resolve the cheap model/key + the LCD transcript reader
// ===========================================================================

/** The per-agent config fields the judge wiring reads (a narrow own type — no back-import). */
interface JudgeAgentConfig {
  provider?: string;
  model?: string;
  operationModels?: Record<string, unknown>;
  learningOutcome?: { enabled?: boolean; judge?: { enabled?: boolean } };
}

/** The slice of the daemon container {@link buildOutcomeJudgeWiring} reads (a narrow own type — no back-import). */
export interface OutcomeJudgeWiringContainer {
  config: {
    agents?: Record<string, JudgeAgentConfig | undefined>;
    // The REAL MemoryConfig type (not a loose `{ costFeatures?: { enabled?: boolean } }`)
    // so tsc ENFORCES that the master gate reads `memory.enabled`. A loose optional type would let
    // a wrong/absent key read as `undefined !== false === true` → SILENTLY force-ENABLED (the kill-switch
    // inverts); the real type makes a missed field a compile error, not a fail-open.
    memory?: Pick<MemoryConfig, "enabled">;
    providers?: {
      entries?: Record<
        string,
        | {
            apiKeyName?: string;
            /** Custom-provider type (ollama/lm-studio/…) — drives the /v1 baseUrl normalization. */
            type?: string;
            /** Custom-provider base — when set, the judge can run on this endpoint even if pi-ai's catalog has no entry. */
            baseUrl?: string;
            /** Declared models — read for the judge model's contextWindow/maxTokens/reasoning. */
            models?: ReadonlyArray<{ id: string; contextWindow?: number; maxTokens?: number; reasoning?: boolean }>;
          }
        | undefined
      >;
    };
  };
  secretManager: { get(name: string): string | undefined };
}

/** Result of {@link buildOutcomeJudgeWiring}: the judge fallback deps to thread into wireLearningOutcome. */
export interface OutcomeJudgeWiringResult {
  /** The mapped judge seam — `undefined` when no agent has it on OR no cheap-model key resolves (no-op). */
  outcomeJudge?: OutcomeJudge;
  /** Per-agent judge enable (costFeatures && learningOutcome.enabled && learningOutcome.judge.enabled). */
  learningOutcomeJudgeEnabled: (agentId: string) => boolean;
  /** Read the most-recent user/assistant transcript text for a resolved scope (from the LCD store). */
  readTurnTranscript?: (scope: JudgeScope) => string | undefined;
}

/**
 * Resolve + construct the cheap `fast`-tier outcome judge for one agent (the `outcomeJudge`
 * operation tier). Mirrors `resolveCorrectionDetector`: resolves the provider/modelId by NAME
 * and the API key from the secret manager (KEYLESS sentinel for keyless providers); returns
 * `undefined` on a missing key (a no-op branch — `Defer != Retry`). Maps the seam's full verdict
 * down to the `{ outcome, cappedConfidence }` shape the resolve seam consumes — the daemon
 * `observe()`s the CODE-capped reward, never the model's raw self-report; the verdict's narrow
 * `success|failure|unknown` union is forwarded verbatim (the judge does NOT detect corrections).
 */
function resolveOutcomeJudge(
  agent: JudgeAgentConfig,
  container: OutcomeJudgeWiringContainer,
  agentId: string,
  clock: ClockPort,
  logger: ComisLogger,
): OutcomeJudge | undefined {
  const agentProvider = agent.provider ?? "anthropic";
  const resolved = resolveOperationModel({
    operationType: "outcomeJudge",
    agentProvider,
    agentModel: agent.model ?? "anthropic:claude-sonnet-4-20250514",
    operationModels: (agent.operationModels ?? {}) as never,
    providerFamily: resolveProviderFamily(agentProvider),
  });
  const providerEntry = container.config.providers?.entries?.[resolved.provider];
  const apiKeyName = providerEntry?.apiKeyName || `${resolved.provider.toUpperCase()}_API_KEY`;
  const apiKey =
    container.secretManager.get(apiKeyName) ??
    // Keyless by TYPE, not config NAME — a user-named ollama entry must resolve keyless, else the
    // outcome judge is a silent no-op on a local keyless daemon (package-delivery-20260628). Mirrors
    // setup-dialectic + the completion path. Guarded by test/architecture/keyless-provider-by-type.
    (KEYLESS_PROVIDER_TYPES.has(providerEntry?.type ?? resolved.provider) ? KEYLESS_API_KEY_SENTINEL : "");
  if (!apiKey) return undefined; // no key → no-op judge (Defer != Retry)

  // Custom YAML providers (ollama/lm-studio/…) aren't in pi-ai's catalog, so the
  // seam would skip; build a custom-model spec so the judge runs locally too.
  const customModel = buildCustomJudgeModelSpec(providerEntry, resolved.provider, resolved.modelId);

  const seam = createOutcomeJudgeSeam({
    provider: resolved.provider,
    modelId: resolved.modelId,
    apiKey,
    maxOutputTokens: OUTCOME_JUDGE_MAX_OUTPUT_TOKENS,
    clock,
    logger,
    agentId,
    customModel,
  });
  return async (trajectoryContent: string) => {
    const verdict = await seam(trajectoryContent);
    if (verdict === undefined) return undefined; // model/abort failure → no verdict (non-fatal)
    return { outcome: verdict.outcome, cappedConfidence: verdict.cappedConfidence };
  };
}

/**
 * Construct the conversational-breadth judge fallback daemon-side, behind the
 * byte-identity gate. Mirrors `buildReactionWiringDeps`'s "build only when needed" posture
 * and keeps the bulk OUT of setup-memory.ts.
 *
 * Gates:
 *  - `judgeEnabled(id) = costFeaturesEnabled && learningOutcome.enabled && learningOutcome.judge.enabled`.
 *  - the judge seam is built ONLY when SOME agent has it on AND a cheap-model API key resolves
 *    (a missing key → `undefined`, a no-op branch: `Defer != Retry`).
 *  - `readTurnTranscript` is built ONLY when SOME agent has it on AND an LCD store is present.
 *
 * The transcript reader maps the LCD rows for the resolved sessionId to the most-recent
 * user/assistant TEXT (mirrors review-session-source.ts: the verbatim text rides
 * `part.metadata.raw.text`), capped at {@link JUDGE_TRANSCRIPT_MAX_MESSAGES} to bound prompt size.
 */
export function buildOutcomeJudgeWiring(
  container: OutcomeJudgeWiringContainer,
  clock: ClockPort,
  logger: ComisLogger,
  lcdStore?: Pick<ContextStorePort, "getMessages">,
): OutcomeJudgeWiringResult {
  const costFeaturesEnabled = container.config.memory?.enabled !== false;
  const agents = container.config.agents ?? {};

  // Judge is DEFAULT-ON (opt-out): ON unless learning-outcome OR the judge is EXPLICITLY
  // disabled. Uses `!== false` (NOT `=== true`) because the daemon's config-load does not
  // always MATERIALIZE the nested `judge` default for an explicitly-present-but-partial
  // `learningOutcome` block (e.g. `{enabled:true, correction:{enabled:true}}` leaves `judge`
  // undefined) — so a defaulted/absent `judge.enabled` (the common case) MUST read as ON.
  // The master `memory.enabled` kill-switch still gates everything.
  const learningOutcomeJudgeEnabled = (agentId: string): boolean =>
    costFeaturesEnabled &&
    agents[agentId]?.learningOutcome?.enabled !== false &&
    agents[agentId]?.learningOutcome?.judge?.enabled !== false;

  const someJudgeOn = Object.keys(agents).some((id) => learningOutcomeJudgeEnabled(id));
  if (!someJudgeOn) {
    // Byte-identity: no agent opts in → no seam, no reader (the upgrade path is never entered).
    return { learningOutcomeJudgeEnabled };
  }

  // Resolve the cheap fast-tier model/key for the FIRST judge-enabled agent (the seam is a
  // shared cheap-tier seam; per-agent re-selection is deferred — mirrors the correction detector).
  let outcomeJudge: OutcomeJudge | undefined;
  const firstAgentId = Object.keys(agents).find((id) => learningOutcomeJudgeEnabled(id));
  const agent = firstAgentId !== undefined ? agents[firstAgentId] : undefined;
  if (agent !== undefined) {
    outcomeJudge = resolveOutcomeJudge(agent, container, firstAgentId ?? "default", clock, logger);
  }
  if (outcomeJudge === undefined) {
    logger.warn(
      {
        errorKind: "config" as const,
        hint: "outcome judge enabled but no cheap-model API key resolved; the conversational-turn fallback is a no-op until a key is set",
      },
      "outcome judge unavailable (non-fatal, default-deferred)",
    );
  }

  // The LCD transcript reader — most-recent user/assistant text for the scope's sessionId.
  const readTurnTranscript = lcdStore
    ? (scope: JudgeScope): string | undefined => {
        const messages = lcdStore.getMessages({
          conversationId: scope.sessionId,
          tenantId: scope.tenantId,
          agentId: scope.agentId,
          sessionKey: scope.sessionId,
        });
        if (messages.length === 0) return undefined;
        const lines = messages
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m) => {
            const text = m.parts
              .filter((p) => p.kind === "text")
              .map((p) => {
                const raw = p.metadata?.raw as { text?: unknown } | undefined;
                return typeof raw?.text === "string" ? raw.text : "";
              })
              .filter((t) => t.length > 0)
              .join(" ");
            return text.length > 0 ? `${m.role}: ${text}` : "";
          })
          .filter((l) => l.length > 0);
        if (lines.length === 0) return undefined;
        // Take the most-recent N (bounds prompt size); keep chronological order.
        const recent = lines.slice(-JUDGE_TRANSCRIPT_MAX_MESSAGES);
        return recent.join("\n");
      }
    : undefined;

  return { outcomeJudge, learningOutcomeJudgeEnabled, readTurnTranscript };
}

// ===========================================================================
// 2. Resolve-seam consume — the unknown→judge upgrade
// ===========================================================================

/**
 * The NARROW structural deps {@link maybeUpgradeWithJudge} needs — a subset of
 * `LearningOutcomeWiringDeps` declared HERE so the leaf imports nothing back from
 * `setup-learning.ts` (no cycle). The caller passes its own `deps` (which is a superset).
 */
export interface JudgeUpgradeDeps {
  /** The outcome adapter (the judge observe + the re-resolve target). */
  outcomeStore: Pick<OutcomeSignalPort, "observe" | "resolve">;
  /** Injected clock for `observedAt`. */
  clock: ClockPort;
  /** Structured logger for the non-fatal failure WARN. */
  logger: ComisLogger;
  /** The mapped judge seam — absent ⇒ the upgrade is never entered. */
  outcomeJudge?: OutcomeJudge;
  /** Per-agent judge enable — false ⇒ the upgrade is never entered. */
  learningOutcomeJudgeEnabled?: (agentId: string) => boolean;
  /** The transcript reader — absent ⇒ the upgrade is never entered. */
  readTurnTranscript?: (scope: JudgeScope) => string | undefined;
}

/**
 * Conversational-breadth upgrade — the LLM-judge fallback for an `unknown`
 * deterministic verdict. Returns the (possibly UPGRADED) verdict the rest of the consume
 * chain runs on. Entered ONLY when:
 *  - the deterministic resolve fused to `unknown` (a resolved tool/pipeline turn skips the
 *    judge entirely — bounds cost, AND the deterministic signal always out-ranks the judge
 *    at fusion so re-resolving could never lower it);
 *  - the judge seam + its per-agent enable + the transcript reader are all present.
 * Reads the per-turn transcript, runs ONE cheap-model pass, and on a non-`unknown` verdict
 * `observe()`s a `source: "judge"` row (reward = the CODE-capped `cappedConfidence`, ≤ 0.7,
 * never the model's self-report) then RE-RESOLVES so the fused verdict reflects the new row.
 * The `markTrajectoryResolved` dedup already ran at the top of the resolve chain (this is the
 * SAME chain invocation — no second chain). NON-FATAL: a judge/observe/re-resolve error keeps
 * the original `unknown` verdict (WARN with hint+errorKind, never throws).
 */
export async function maybeUpgradeWithJudge(
  deps: JudgeUpgradeDeps,
  scope: JudgeScope,
  verdict: ResolvedOutcome,
): Promise<ResolvedOutcome> {
  // Only an UNKNOWN deterministic verdict is a candidate (resolved turns skip the judge).
  if (verdict.outcome !== "unknown") return verdict;
  if (deps.outcomeJudge === undefined || deps.readTurnTranscript === undefined) return verdict;
  if (deps.learningOutcomeJudgeEnabled?.(scope.agentId) !== true) return verdict;
  try {
    const text = deps.readTurnTranscript(scope);
    if (text === undefined || text.length === 0) return verdict; // nothing to score → keep unknown
    const jv = await deps.outcomeJudge(text);
    // A model/abort failure (undefined) or a judge abstention (unknown) → keep the
    // unknown verdict; the judge can NEVER inflate failure metrics (BENIGN, Defer ≠ Retry).
    if (jv === undefined || jv.outcome === "unknown") return verdict;
    // Write the judge observation (source set in CODE; reward = the CODE-capped confidence,
    // never the model self-report). Idempotent at the row level; non-fatal at the adapter.
    const obs = await deps.outcomeStore.observe({
      tenantId: scope.tenantId,
      agentId: scope.agentId,
      sessionId: scope.sessionId,
      trajectoryId: scope.trajectoryId,
      outcome: jv.outcome,
      source: "judge",
      confidence: jv.cappedConfidence,
      observedAt: deps.clock.now(),
    });
    if (!obs.ok) return verdict; // observe failed → keep unknown (no re-resolve over a no-op write)
    // RE-RESOLVE so the fused verdict picks up the new judge row. The deterministic tier
    // is still absent here (we only got here on `unknown`), so the judge tier now wins.
    const re = await deps.outcomeStore.resolve(scope.trajectoryId, {
      tenantId: scope.tenantId,
      agentId: scope.agentId,
    });
    return re.ok ? re.value : verdict;
  } catch (e: unknown) {
    deps.logger.warn(
      {
        agentId: scope.agentId,
        source: "judge",
        err: e instanceof Error ? e : new Error(String(e)),
        errorKind: "dependency" as const,
        hint: "outcome judge/observe/re-resolve threw on an unknown verdict; the outcome stays unresolved (benign)",
      },
      "outcome judge upgrade threw (non-fatal)",
    );
    return verdict;
  }
}
