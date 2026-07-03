// SPDX-License-Identifier: Apache-2.0
/**
 * `setup-tools-orchestrate-repair` — the class-gated, keyless-safe resolver that
 * mints the daemon-side one-shot orchestrate repair seam per agent.
 *
 * {@link buildOrchestrateRepairResolver} returns a per-agent resolver the tool
 * wiring calls once per assembly. Given an agent config + its effective
 * capability class, it returns an {@link OrchestrateRepairSeam} closure ONLY when:
 *  1. the class is repair-eligible (`autoRepairForClass` — small/nano ON,
 *     frontier/mid OFF). The class-gate is checked FIRST, so a stronger model
 *     resolves no model and no key (the cost axis stays off for the classes that
 *     do not benefit — the resolver returns before any lookup).
 *  2. a utility model + key resolve. It mirrors `resolveOutcomeJudge` verbatim:
 *     the cheap `outcomeJudge` operation tier, the provider/model by NAME, the API
 *     key from the secret manager (the keyless sentinel for keyless provider
 *     types), and `buildCustomJudgeModelSpec` so a custom/local YAML provider
 *     (ollama / lm-studio / …) whose model is absent from the pi-ai catalog still
 *     resolves. A missing key → `undefined` (a no-op branch: Defer != Retry).
 *
 * The seam is built via `createOrchestrateRepairSeam` (from `@comis/agent`), so
 * `@comis/skills` never imports the model layer — the daemon mints the closure and
 * the runner only receives it (mirrors the `mintRunLease` seam). Auto-repair is a
 * pure class-gate off the model profile: there is NO config toggle.
 *
 * @module
 */

import {
  KEYLESS_PROVIDER_TYPES,
  KEYLESS_API_KEY_SENTINEL,
  type ClockPort,
  type ComisLogger,
} from "@comis/core";
import {
  autoRepairForClass,
  createOrchestrateRepairSeam,
  resolveOperationModel,
  resolveProviderFamily,
  type CapabilityClass,
  type OrchestrateRepairSeam,
} from "@comis/agent";
import { buildCustomJudgeModelSpec, type JudgeProviderEntry } from "./setup-learning-judge.js";

/**
 * Per-call output bound for one repair completion. Bounded (the cost axis — the
 * seam issues exactly one completion), yet large enough to regenerate a complete
 * corrected script rather than a truncated fragment.
 */
const ORCHESTRATE_REPAIR_MAX_OUTPUT_TOKENS = 4096;

/** The per-agent config fields the repair resolver reads (a narrow own type — no back-import). */
export interface RepairAgentConfig {
  provider?: string;
  model?: string;
  operationModels?: Record<string, unknown>;
}

/** The slice of daemon deps the repair resolver reads (providers.entries is the model/key source). */
export interface OrchestrateRepairResolverDeps {
  config: {
    providers?: {
      entries?: Record<string, JudgeProviderEntry | undefined>;
    };
  };
  /** The secret manager — resolves the utility-model API key by NAME (keyless sentinel for keyless types). */
  secretManager: { get(name: string): string | undefined };
  /** Injected clock — the per-message timestamp for the one repair completion. */
  clock: ClockPort;
  /** Counts/ids-only logger threaded into the seam (a repair failure logs a hint + errorKind, never the script). */
  logger: ComisLogger;
}

/** The per-agent resolver signature: (agentConfig, agentId, class) → a repair seam, or undefined (ineligible / no key). */
export type OrchestrateRepairResolver = (
  agentConfig: RepairAgentConfig | undefined,
  agentId: string,
  capabilityClass: CapabilityClass,
) => OrchestrateRepairSeam | undefined;

/**
 * Build the per-agent class-gated repair-seam resolver. Mirrors
 * `resolveOutcomeJudge`: the class-gate runs FIRST (no model resolve for
 * frontier/mid), then the cheap `outcomeJudge`-tier model + key + customModel
 * resolve exactly as the judge does; a missing key returns `undefined`. On a
 * repair-eligible class with a resolvable model it returns the
 * `createOrchestrateRepairSeam` closure the orchestrate runner invokes at most
 * once per run.
 */
export function buildOrchestrateRepairResolver(
  deps: OrchestrateRepairResolverDeps,
): OrchestrateRepairResolver {
  return (agentConfig, agentId, capabilityClass) => {
    // Class-gate FIRST — a repair-ineligible class (frontier/mid) resolves no
    // model and no key, so the cost axis stays off for a stronger model before
    // any lookup runs.
    if (!autoRepairForClass(capabilityClass)) return undefined;

    const agent = agentConfig ?? {};
    const agentProvider = agent.provider ?? "anthropic";
    const resolved = resolveOperationModel({
      operationType: "outcomeJudge",
      agentProvider,
      agentModel: agent.model ?? "anthropic:claude-sonnet-4-20250514",
      operationModels: (agent.operationModels ?? {}) as never,
      providerFamily: resolveProviderFamily(agentProvider),
    });
    const providerEntry = deps.config.providers?.entries?.[resolved.provider];
    const apiKeyName = providerEntry?.apiKeyName || `${resolved.provider.toUpperCase()}_API_KEY`;
    const apiKey =
      deps.secretManager.get(apiKeyName) ??
      // Keyless by TYPE, not config NAME — a user-named ollama/lm-studio entry must
      // resolve keyless, else repair is a silent no-op on a local keyless daemon
      // (the very small models this targets). Mirrors the outcome judge.
      (KEYLESS_PROVIDER_TYPES.has(providerEntry?.type ?? resolved.provider)
        ? KEYLESS_API_KEY_SENTINEL
        : "");
    if (!apiKey) return undefined; // no key → no repair (Defer != Retry)

    // Custom YAML providers (ollama/lm-studio/…) are absent from pi-ai's catalog,
    // so build a custom-model spec (the normalized `/v1` baseUrl) — repair runs locally too.
    const customModel = buildCustomJudgeModelSpec(providerEntry, resolved.provider, resolved.modelId);

    return createOrchestrateRepairSeam({
      provider: resolved.provider,
      modelId: resolved.modelId,
      apiKey,
      maxOutputTokens: ORCHESTRATE_REPAIR_MAX_OUTPUT_TOKENS,
      clock: deps.clock,
      logger: deps.logger,
      agentId,
      customModel,
    });
  };
}
