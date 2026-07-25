// SPDX-License-Identifier: Apache-2.0
/**
 * /export-trajectory slash command handler.
 *
 * Owner-gated bundle export from an authenticated direct-message endpoint.
 *
 * Dispatched from inbound-gate.ts BEFORE the generic handleSlashCommand
 * block, because the handler needs:
 *   - msg.senderId        (for the owner gate)
 *   - isGroupMessage(msg) (for routing decision)
 *   - adapter             (for durable source-endpoint delivery)
 *
 * None of these are exposed through handleSlashCommand(text, sessionKey, agentId).
 *
 * @module
 */

import type { NormalizedMessage, SessionKey, DeliveryAdapter, DeliverToChannelOptions } from "@comis/core";
import { formatSessionKey } from "@comis/core";
import { isGroupMessage } from "@comis/channels";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HandleExportTrajectoryDeps {
  msg: NormalizedMessage;
  sessionKey: SessionKey;
  agentId: string;
  adapter: DeliveryAdapter;
  deliveryOptions: DeliverToChannelOptions;
  deliveryService: {
    deliverToChannel: (
      adapter: DeliveryAdapter,
      channelId: string,
      text: string,
      opts: DeliverToChannelOptions,
    ) => Promise<unknown>;
  };
  exportSessionBundle: (sessionId: string) => Promise<{ bundlePath: string }>;
  logger: {
    error: (obj: unknown, msg?: string) => void;
    info: (obj: unknown, msg?: string) => void;
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handle the /export-trajectory slash command.
 *
 * Always returns `{ action: "handled" }` so inbound-gate short-circuits
 * the pipeline regardless of success or failure. Exceptions from the export
 * DI are caught and reported to the user inline — none bubble up.
 */
export async function handleExportTrajectory(
  deps: HandleExportTrajectoryDeps,
): Promise<{ action: "handled" }> {
  const {
    msg,
    sessionKey,
    adapter,
    deliveryOptions,
    deliveryService,
    exportSessionBundle,
    logger,
  } = deps;

  // ---- Owner gate ----
  // Pattern from inbound-gate.ts:189.
  // Only the session owner may trigger an export (STRIDE mitigation).
  if (msg.senderId !== sessionKey.userId) {
    await deliveryService.deliverToChannel(
      adapter,
      msg.channelId,
      "Access denied: /export-trajectory is owner-only.",
      deliveryOptions,
    );
    return { action: "handled" };
  }

  // ---- Require an authenticated direct-message endpoint ----
  const isGroup = isGroupMessage(msg);
  if (isGroup) {
    await deliveryService.deliverToChannel(
      adapter,
      msg.channelId,
      "For privacy, /export-trajectory is available only in a direct message with the bot.",
      deliveryOptions,
    );
    return { action: "handled" };
  }

  // ---- Derive sessionId from SessionKey ----
  // Uses the same convention as the obs.trace.export RPC handler:
  // formatSessionKey → "tenantId:userId:channelId[:peer:peerId]..."
  const sessionId = formatSessionKey(sessionKey);

  // ---- Export ----
  let result: { bundlePath: string };
  try {
    result = await exportSessionBundle(sessionId);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.error({ err, sessionId, step: "export-trajectory" }, "Bundle export failed");
    await deliveryService.deliverToChannel(
      adapter,
      msg.channelId,
      `Bundle export failed: ${reason}`,
      deliveryOptions,
    );
    return { action: "handled" };
  }

  // ---- Deliver the bundle path ----
  // Privacy reminder is always included to make recipients aware the bundle
  // contains session transcript + tool outputs (STRIDE mitigation).
  const message =
    `Bundle ready: ${result.bundlePath}\n\n` +
    "This bundle contains session data — treat as sensitive. " +
    "Contains session transcript and tool outputs.";

  await deliveryService.deliverToChannel(adapter, msg.channelId, message, deliveryOptions);

  return { action: "handled" };
}
