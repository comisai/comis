// SPDX-License-Identifier: Apache-2.0
/** Exact-route recipient guard for forwarded correspondence. */

export interface OutboundRecipientEvidence {
  /** Structured recent-context guard for delivery target substitution. */
  readonly forwardedContextActive?: boolean;
  readonly currentRoute?: {
    readonly channelType: string;
    readonly channelId: string;
  };
  readonly onRecipientBlocked?: () => void;
}

export function outboundRecipientAuthorityVerdict(
  context: unknown,
  evidence?: OutboundRecipientEvidence,
): { block: true; reason: string } | undefined {
  if (
    evidence?.forwardedContextActive !== true
    || evidence.currentRoute === undefined
    || context === null
    || typeof context !== "object"
  ) return undefined;
  const call = context as { toolCall?: { name?: string }; args?: unknown };
  if (call.toolCall?.name !== "message" || call.args === null || typeof call.args !== "object") {
    return undefined;
  }
  const args = call.args as {
    action?: unknown;
    channel_type?: unknown;
    channel_id?: unknown;
  };
  if (
    args.action !== "send"
    || args.channel_type !== evidence.currentRoute.channelType
    || args.channel_id !== evidence.currentRoute.channelId
  ) return undefined;
  evidence.onRecipientBlocked?.();
  return {
    block: true,
    reason:
      "Forwarded-context delivery blocked: the current route is not the exact recipient "
      + "for the forwarded correspondence. Report that it was not sent and ask for the "
      + "exact recipient and delivery authority.",
  };
}
