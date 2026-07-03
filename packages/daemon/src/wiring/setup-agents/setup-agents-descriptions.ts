// SPDX-License-Identifier: Apache-2.0
/**
 * Pre-resolved lean tool descriptions for a single agent runtime.
 *
 * Extracted from {@link setupSingleAgent} (setup-agents-runtime.ts) to keep
 * that file under the per-subdirectory size cap. Pure mechanical move — the
 * behavior (description resolution + the "Tool descriptions resolved" INFO)
 * is unchanged.
 *
 * @module
 */

import {
  LEAN_TOOL_DESCRIPTIONS,
  resolveDescription,
  type AgentBootWindowInfo,
  type ToolDescriptionContext,
} from "@comis/agent";
import type { PerAgentConfig } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import { agentToolsToToolDefinitions } from "@comis/skills";

/**
 * Resolve every lean tool description once at agent setup time.
 *
 * channelType is unavailable at agent setup time; the message tool resolves to
 * the "chat" fallback. Per-channel resolution is deferred to runtime. The
 * setup-time modelTier only affects lean description text (e.g. the admin
 * suffix) — capability class is resolved per-execution in pi-executor via
 * resolveModelProfile().
 *
 * Emits one INFO ("Tool descriptions resolved") with count/token/over-limit
 * telemetry. `logger` is the per-agent child logger (agentId already bound —
 * not duplicated here).
 */
export function resolveLeanDescriptionsForAgent(
  agentConfig: PerAgentConfig,
  logger: ComisLogger,
): Record<string, string> {
  const descriptionContext: ToolDescriptionContext = {
    channelType: undefined,
    trustLevel: "default", // Trust comes from token/context at message time, not config
    modelTier: agentConfig.bootstrap?.promptMode === "minimal" ? "small" : "large",
  };
  const resolvedDescriptions: Record<string, string> = {};
  let dynamicCount = 0;
  for (const name of Object.keys(LEAN_TOOL_DESCRIPTIONS)) {
    const raw = LEAN_TOOL_DESCRIPTIONS[name];
    if (typeof raw === "function") dynamicCount++;
    resolvedDescriptions[name] = resolveDescription(
      { name },
      LEAN_TOOL_DESCRIPTIONS,
      descriptionContext,
    );
  }
  const totalDescriptionTokens = Object.values(resolvedDescriptions)
    .reduce((sum, d) => sum + Math.ceil(d.length / 4), 0);
  const overLimitCount = Object.values(resolvedDescriptions)
    .filter((d) => d.length > 300).length;
  logger.info(
    {
      descriptionCount: Object.keys(resolvedDescriptions).length,
      tokenCount: totalDescriptionTokens,
      dynamicCount,
      overLimitCount,
      // Setup-time modelTier for lean description selection (per-execution tier may differ)
      modelTier: descriptionContext.modelTier,
    },
    "Tool descriptions resolved",
  );
  return resolvedDescriptions;
}

/** AgentBootWindowInfo's convertTools slot — the shared closure's signature. */
type FloorConvertTools = NonNullable<AgentBootWindowInfo["convertTools"]>;

/**
 * Build the ONE tool-conversion closure shared by BOTH consumers —
 * PiExecutorDeps.convertTools (turn-time S corpus) AND
 * AgentBootWindowInfo.convertTools (boot corpus). setupSingleAgent
 * calls this once per agent and binds the single returned reference into both:
 * that reference identity is the corpus-identity pin (the boot floor must
 * measure the exact description set the turn ships). Cast safe: the adapter
 * reads only schema fields at conversion time; execute is lazy.
 */
export function buildSharedConvertTools(resolvedDescriptions: Record<string, string>) {
  return (tools: Parameters<FloorConvertTools>[0]) =>
    agentToolsToToolDefinitions(
      tools as unknown as Parameters<typeof agentToolsToToolDefinitions>[0],
      resolvedDescriptions,
    );
}
