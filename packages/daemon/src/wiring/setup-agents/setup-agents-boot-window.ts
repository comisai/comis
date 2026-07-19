import {
  compareServedWindowForProvider,
  collectAgentBootWindowInfo,
  type createModelRegistryAdapter,
  type AgentBootWindowInfo,
} from "@comis/agent";
import type { PerAgentConfig } from "@comis/core";
import type { SingleAgentDeps } from "./setup-agents-types.js";

type PiModelRegistry = Awaited<ReturnType<typeof createModelRegistryAdapter>>["registry"];
type ConvertTools = NonNullable<AgentBootWindowInfo["convertTools"]>;

/**
 * Served-window comparison + boot-window-info
 * collection beside the per-agent registry — the ONLY seam with the
 * registry-enriched "configured" the executor itself resolves (pi-executor
 * find + `?? 8_192`). Fail-open wholesale: any error
 * is WARN-logged and boot continues; turn-time guards still apply (dag:
 * context-window preflight; pipeline: 85% compaction trigger + reactive
 * classification).
 *
 * `convertTools` MUST be the same closure later bound into
 * `PiExecutorDeps.convertTools` — reference identity is the corpus pin
 * (the boot floor measures the exact description set the turn ships).
 *
 * Extracted from setup-agents-runtime.ts (600-line subdirectory cap split).
 */
export function runBootWindowHonestyChecks(params: {
  agentId: string;
  providerId: string;
  modelId: string;
  container: SingleAgentDeps["container"];
  deps: SingleAgentDeps;
  piModelRegistry: PiModelRegistry;
  providerAliases: Map<string, string>;
  agentLogger: SingleAgentDeps["agentLogger"];
  effectiveConfig: PerAgentConfig;
  convertTools: ConvertTools;
}): void {
  const {
    agentId,
    providerId,
    modelId,
    container,
    deps,
    piModelRegistry,
    providerAliases,
    agentLogger,
    effectiveConfig,
    convertTools,
  } = params;
  try {
    const findModel = (p: string, m: string) => {
      let r = piModelRegistry.find(p, m);
      if (!r) {
        const builtIn = providerAliases.get(p);
        if (builtIn) r = piModelRegistry.find(builtIn, m);
      }
      return r ?? undefined;
    };
    const providerEntry = container.config.providers?.entries?.[providerId];
    const comparison = compareServedWindowForProvider({
      providerId,
      served: deps.servedWindowByProvider?.get(providerId),
      providerEntry,
      findModel,
      logger: agentLogger,
    });
    if (comparison) deps.servedWindowComparisons?.set(comparison.providerId, comparison);
    deps.agentBootWindowInfo?.set(
      agentId,
      collectAgentBootWindowInfo({
        agentId,
        providerId,
        modelId,
        findModel,
        served: deps.servedWindowByProvider?.get(providerId),
        explicitCapabilityClass: providerEntry?.capabilities?.capabilityClass,
        agentConfig: effectiveConfig,
        convertTools,
      }),
    );
  } catch (err) {
    agentLogger.warn(
      {
        err,
        agentId,
        errorKind: "internal" as const,
        hint: "served-window comparison / boot-window collection failed — boot continues (fail-open); turn-time guards still apply (dag: budget preflight; pipeline: 85% compaction trigger + reactive classification)",
      },
      "Boot window honesty checks skipped for agent",
    );
  }
}
