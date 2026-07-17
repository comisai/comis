// SPDX-License-Identifier: Apache-2.0
import type { AttachmentSendReceipt } from "../ports/channel.js";

const INVALID_MESSAGE_ID_SENTINELS = new Set(["ok", "sent", "unknown"]);

/**
 * Convert a completed platform attachment send into its truthful receipt.
 * A missing/status-like ID loses attribution, but does not turn the completed
 * send into a retryable failure.
 */
export function createAttachmentSendReceipt(
  platformMessageId: unknown,
): AttachmentSendReceipt {
  if (typeof platformMessageId !== "string") {
    return { kind: "delivered_untracked" };
  }

  const messageId = platformMessageId.trim();
  if (
    messageId.length === 0 ||
    INVALID_MESSAGE_ID_SENTINELS.has(messageId.toLowerCase())
  ) {
    return { kind: "delivered_untracked" };
  }

  return { kind: "tracked", messageId };
}
