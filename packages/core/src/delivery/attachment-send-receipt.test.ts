// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { createAttachmentSendReceipt } from "./attachment-send-receipt.js";

describe("createAttachmentSendReceipt", () => {
  it("preserves a trimmed real platform message ID as a tracked receipt", () => {
    expect(createAttachmentSendReceipt("  message-123  ")).toEqual({
      kind: "tracked",
      messageId: "message-123",
    });
  });

  it.each([undefined, null, "", "   ", "unknown", "sent", "ok"])(
    "classifies a missing or status-like ID as delivered without tracking: %j",
    (value) => {
      expect(createAttachmentSendReceipt(value)).toEqual({
        kind: "delivered_untracked",
      });
    },
  );
});
