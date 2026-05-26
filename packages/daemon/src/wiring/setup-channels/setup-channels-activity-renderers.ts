// SPDX-License-Identifier: Apache-2.0
/**
 * WIRE-02 (§17.7): build the per-channel activity renderers for the running
 * daemon. For each registered adapter, route its declared `ChannelCapability`
 * to a rendering strategy via `selectStrategy(caps, channelType)` (@comis/core)
 * and construct the matching @comis/channels strategy.
 *
 * Phase 70 wires the registration plumbing generically but only the Echo→TestSink
 * mapping is live end-to-end — TestSink needs no platform `ActivityRenderActions`
 * (send/edit/delete). The EditPlace/DeleteAndRepost/AppendOnly/LinePerEvent/
 * DigestOnly strategies bind their per-channel adapters in Phases 71-72; adding
 * one is a one-line strategy-case change here. The returned map feeds the
 * orchestrator's per-turn `coordinatorFactory` (ExecutionPipelineDeps, WIRE-03),
 * keyed by channelType.
 *
 * Extracted from setup-channels-runtime.ts to keep that composition file within
 * its 600-line subdirectory cap.
 *
 * @module
 */
import type { ChannelPort, ChannelPluginPort, ChannelActivityRenderer } from "@comis/core";
import { selectStrategy } from "@comis/core";
import { createTestSink } from "@comis/channels";
import type { ComisLogger } from "@comis/infra";

/**
 * Select + construct the live per-channel activity renderers, keyed by
 * channelType. Logs the chosen strategy per channel (and whether it is live in
 * Phase 70). Channels with no declared capabilities are skipped.
 */
export function buildActivityRenderers(
  adaptersByType: Map<string, ChannelPort>,
  channelPlugins: Map<string, ChannelPluginPort>,
  logger: ComisLogger,
): Map<string, ChannelActivityRenderer> {
  const activityRenderers = new Map<string, ChannelActivityRenderer>();
  for (const [channelType] of adaptersByType) {
    const caps = channelPlugins.get(channelType)?.capabilities;
    if (!caps) continue;
    const strategy = selectStrategy(caps, channelType);
    if (strategy === "TestSink") {
      activityRenderers.set(channelType, createTestSink());
    }
    logger.debug(
      { channelType, strategy, live: strategy === "TestSink" },
      "Activity renderer selected",
    );
  }
  return activityRenderers;
}
