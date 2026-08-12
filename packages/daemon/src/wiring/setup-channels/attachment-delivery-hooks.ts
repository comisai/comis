// SPDX-License-Identifier: Apache-2.0
/** Publish every successful ChannelPort attachment through after_delivery hooks. */
import {
  createConversationRef,
  sanitizeLogString,
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
    logger: Pick<ComisLogger, "warn">;
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
          ...(authority ?? {}),
        },
      ));
      if (!hookResult.ok) {
        deps.logger.warn({
          channelType: adapter.channelType,
          channelId,
          err: sanitizeLogString(hookResult.error.message),
          errorKind: "dependency" as const,
          hint: "Check after_delivery hook health and delivery-mirror storage before the next attachment",
        }, "Attachment delivery hook failed");
      }
      return boundary.value;
    };
  }
}
