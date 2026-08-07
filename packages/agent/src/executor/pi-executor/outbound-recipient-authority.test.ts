// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { outboundRecipientAuthorityVerdict } from "../outbound-recipient-authority.js";

describe("outboundRecipientAuthorityVerdict", () => {
  it("denies current-route substitution for forwarded correspondence", () => {
    const onRecipientBlocked = vi.fn();

    const verdict = outboundRecipientAuthorityVerdict({
      toolCall: { name: "message" },
      args: {
        action: "send",
        channel_type: "telegram",
        channel_id: "chat-a",
      },
    }, {
      forwardedContextActive: true,
      currentRoute: { channelType: "telegram", channelId: "chat-a" },
      onRecipientBlocked,
    });

    expect(verdict).toEqual({
      block: true,
      reason: expect.stringMatching(/forwarded.*exact recipient.*not sent/iu),
    });
    expect(onRecipientBlocked).toHaveBeenCalledOnce();
  });

  it("permits a different exact route", () => {
    const verdict = outboundRecipientAuthorityVerdict({
      toolCall: { name: "message" },
      args: {
        action: "send",
        channel_type: "telegram",
        channel_id: "chat-b",
      },
    }, {
      forwardedContextActive: true,
      currentRoute: { channelType: "telegram", channelId: "chat-a" },
    });

    expect(verdict).toBeUndefined();
  });
});
