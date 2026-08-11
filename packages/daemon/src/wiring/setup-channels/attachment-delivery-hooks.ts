// SPDX-License-Identifier: Apache-2.0
/** Publish attributable ChannelPort attachment deliveries through after_delivery hooks. */
import {
  createConversationRef,
  tryGetContext,
  type ChannelPort,
  type ClockPort,
  type ComisLogger,
  type HookRunner,
} from "@comis/core";
import { err, fromPromise } from "@comis/shared";

export function instrumentAttachmentDeliveries(
  adaptersByType: Map<string, ChannelPort>,
  deps: {
    hookRunner: Pick<HookRunner, "runAfterDelivery">;
    logger: Pick<ComisLogger, "warn" | "debug">;
    clock: ClockPort;
  },
): void {
  for (const adapter of adaptersByType.values()) {
    const original = adapter.sendAttachment?.bind(adapter);
    if (original === undefined) continue;

    adapter.sendAttachment = async (channelId, attachment, options) => {
      const startedAt = deps.clock.now();
      const boundary = await fromPromise(original(channelId, attachment, options));
      if (!boundary.ok) return err(boundary.error);
      if (!boundary.value.ok) return boundary.value;

      const context = tryGetContext();
      const endpoint = context?.turnScope?.endpoint;
      const endpointMatches = endpoint !== undefined
        && endpoint.channelType === adapter.channelType
        && endpoint.channelInstanceId === adapter.channelId
        && endpoint.conversationId === channelId
        && endpoint.threadId === options?.threadId;
      const conversationRef = endpointMatches && context?.turnScope !== undefined
        ? createConversationRef(context.turnScope.conversation)
        : undefined;
      const authority = endpointMatches
        && endpoint !== undefined
        && context?.agentId !== undefined
        && conversationRef?.ok
        ? {
            deliveryAuthority: {
              tenantId: context.tenantId,
              agentId: context.agentId,
              conversationRef: conversationRef.value,
            },
            destinationEndpoint: endpoint,
          }
        : undefined;
      // Off-turn senders (the video poller resolves these same adapter objects
      // from the channel registry and ticks with no ALS frame) carry no turn
      // scope, so no delivery can be attributed to a conversation. Publishing
      // the hook anyway made every SUCCESSFUL off-turn attachment emit a
      // precondition WARN from the mirror handler — routine-event noise that
      // inflates the system-health warning counts. Off-turn paths that need
      // mirroring supply an explicit authority the way the delivery queue drain
      // does, from their persisted row.
      if (authority === undefined) {
        deps.logger.debug({
          channelType: adapter.channelType,
          channelId,
          step: "attachment-delivery-hook",
          hint: "Off-turn attachment delivery carries no conversation authority; no delivery-mirror entry is recorded",
        }, "Attachment delivery hook skipped without a resolved turn scope");
        return boundary.value;
      }
      const hookResult = await fromPromise(deps.hookRunner.runAfterDelivery(
        {
          text: attachment.caption ?? "",
          mediaUrls: [attachment.url],
          channelType: adapter.channelType,
          channelId,
          result: boundary.value.value,
          durationMs: deps.clock.now() - startedAt,
          origin: "channel:attachment",
        },
        {
          sessionKey: context?.sessionKey,
          agentId: context?.agentId,
          traceId: context?.traceId,
          ...authority,
        },
      ));
      if (!hookResult.ok) {
        deps.logger.warn({
          channelType: adapter.channelType,
          channelId,
          errorKind: "dependency" as const,
          hint: "Check after_delivery hook health and delivery-mirror storage before the next attachment",
        }, "Attachment delivery hook failed");
      }
      return boundary.value;
    };
  }
}
