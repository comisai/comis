// SPDX-License-Identifier: Apache-2.0
/**
 * Sub-agent result-processing wiring.
 *
 * Builds the three pieces that turn a finished sub-agent run into something a
 * parent can read: the condenser that bounds an oversized result, the
 * narrative caster that tags it, and the full-output store that keeps the
 * unabridged text retrievable behind a reference.
 *
 * Condensation resolves its own model rather than inheriting the agent's, so a
 * cheap model can summarize for an expensive one; the API key is then read for
 * whichever provider that resolution landed on, which is what lets condensation
 * cross providers.
 *
 * @module
 */
import type { AgentConfig, AppContainer } from "@comis/core";
import { resolveWorkspaceDir } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import {
  createNarrativeCaster,
  createResultCondenser,
  resolveOperationModel,
  resolveProviderFamily,
} from "@comis/agent";
import { createResultRefStore } from "@comis/skills/tools";

/** Silent fallback for test wiring that omits the production logger. */
export const NOOP_LOGGER: ComisLogger = {
  level: "silent",
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  audit: () => {},
  child: () => NOOP_LOGGER,
};

export interface SubAgentResultProcessing {
  resultCondenser: ReturnType<typeof createResultCondenser>;
  narrativeCaster: ReturnType<typeof createNarrativeCaster>;
  materializeFullOutput: (
    content: string,
    ctx: { runId: string; nowMs: number; agentId: string },
  ) => ReturnType<ReturnType<typeof createResultRefStore>["materialize"]>;
  /** Empty when no key resolved; the runner treats that as condensation-off. */
  condenserApiKey: string;
  /** Undefined whenever no key resolved, so the pair stays consistent. */
  condenserModel: unknown | undefined;
}

export function createSubAgentResultProcessing(deps: {
  container: AppContainer;
  logger?: ComisLogger;
}): SubAgentResultProcessing {
  const { container } = deps;
  const subagentCtxConfigForCondenser = container.config.security?.agentToAgent?.subagentContext;
  const defaultAgentConfig = container.config.agents?.["default"];

  const condensationResolution = resolveOperationModel({
    operationType: "condensation",
    agentProvider: defaultAgentConfig?.provider ?? "anthropic",
    agentModel: defaultAgentConfig?.model ?? "default",
    operationModels: defaultAgentConfig?.operationModels ?? {},
    providerFamily: resolveProviderFamily(defaultAgentConfig?.provider ?? "anthropic"),
    agentPromptTimeoutMs: defaultAgentConfig?.promptTimeout?.promptTimeoutMs,
  });

  // Resolved from resolution.provider, not the agent's, so condensation can run
  // on a different provider than the agent it condenses for.
  const condenserProviderEntry = container.config.providers?.entries?.[condensationResolution.provider];
  const condenserApiKeyName = condenserProviderEntry?.apiKeyName
    || `${condensationResolution.provider.toUpperCase()}_API_KEY`;
  const condenserApiKey = container.secretManager?.get(condenserApiKeyName) ?? "";
  const condenserModel = condenserApiKey
    ? { id: condensationResolution.modelId, provider: condensationResolution.provider } as unknown
    : undefined;

  deps.logger?.debug(
    {
      model: condensationResolution.model,
      source: condensationResolution.source,
      provider: condensationResolution.provider,
    },
    "Condensation model resolved",
  );

  const resultCondenser = createResultCondenser({
    maxResultTokens: subagentCtxConfigForCondenser?.maxResultTokens ?? 4000,
    condensationStrategy: subagentCtxConfigForCondenser?.condensationStrategy ?? "auto",
    dataDir: container.config.dataDir || ".",
    logger: deps.logger
      ? {
          info: deps.logger.info.bind(deps.logger),
          warn: deps.logger.warn.bind(deps.logger),
          debug: deps.logger.debug.bind(deps.logger),
        }
      : { info: () => {}, warn: () => {}, debug: () => {} },
  });

  const narrativeCaster = createNarrativeCaster({
    enabled: subagentCtxConfigForCondenser?.narrativeCasting ?? true,
    tagPrefix: subagentCtxConfigForCondenser?.resultTagPrefix ?? "Subagent Result",
  });

  // The runner stays @comis/skills-free by dependency injection, so the daemon
  // owns the store and picks the target workspace. The callback resolves the
  // CHILD's own jailed workspace from ctx.agentId, never the lead's, and the
  // store is additionally safePath-confined to that root — a traversal returns
  // a MaterializeError the runner degrades on. The store's 3-way union
  // (ResultRef | MaterializeError | undefined) is returned UNCHANGED, because
  // that union is the runner's dep contract.
  const resultRefStore = createResultRefStore({
    logger: deps.logger
      ? deps.logger.child({ submodule: "sub-agent-result-ref" })
      : NOOP_LOGGER,
  });

  const materializeFullOutput = (
    content: string,
    ctx: { runId: string; nowMs: number; agentId: string },
  ) => {
    const childAgentConfig = container.config.agents[ctx.agentId]
      ?? container.config.agents["default"]
      ?? ({} as AgentConfig);
    const childWorkspaceDir = resolveWorkspaceDir(
      childAgentConfig,
      ctx.agentId,
      container.config.dataDir || undefined,
    );
    return resultRefStore.materialize(content, "sessions_spawn", {
      workspacePath: childWorkspaceDir,
      runId: ctx.runId,
      nowMs: ctx.nowMs,
    });
  };

  return {
    resultCondenser,
    narrativeCaster,
    materializeFullOutput,
    condenserApiKey,
    condenserModel,
  };
}
