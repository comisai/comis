// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { ok, type Result } from "@comis/shared";
import type { ChannelPort, SendMessageOptions } from "./channel.js";

// ---------------------------------------------------------------------------
// Agent Transparency — editMessage rich-options widening
//
// §16.11: ChannelPort.editMessage accepts an optional 4th `options?:
// SendMessageOptions` arg so activity renderers can update inline keyboards /
// components / Block Kit, not just text. The hand-built adapter below passes
// `{ buttons }` to editMessage and must satisfy ChannelPort. On the pre-patch
// 3-arg signature the 4th param is excess and fails tsc — RED proof.
// ---------------------------------------------------------------------------

/** Records the last editMessage options it was given, for the call assertion. */
function makeRichEditAdapter(): ChannelPort & { lastOptions?: SendMessageOptions } {
  const adapter: ChannelPort & { lastOptions?: SendMessageOptions } = {
    channelId: "test-rich",
    channelType: "test",
    async start(): Promise<Result<void, Error>> {
      return ok(undefined);
    },
    async stop(): Promise<Result<void, Error>> {
      return ok(undefined);
    },
    async sendMessage(): Promise<Result<string, Error>> {
      return ok("msg-1");
    },
    // 4th optional param exercised — this is the rich-options surface.
    async editMessage(
      _channelId: string,
      _messageId: string,
      _text: string,
      options?: SendMessageOptions,
    ): Promise<Result<void, Error>> {
      adapter.lastOptions = options;
      return ok(undefined);
    },
    onMessage(): void {
      /* no-op */
    },
    async platformAction(): Promise<Result<unknown, Error>> {
      return ok(undefined);
    },
  };
  return adapter;
}

describe("ChannelPort.editMessage rich options", () => {
  it("accepts an adapter whose editMessage takes SendMessageOptions", () => {
    const adapter = makeRichEditAdapter();
    // Type-level: assigning to ChannelPort proves the widened signature is
    // structurally compatible.
    const port: ChannelPort = adapter;
    expect(port.channelType).toBe("test");
  });

  it("forwards inline buttons through the editMessage options arg", async () => {
    const adapter = makeRichEditAdapter();
    const options: SendMessageOptions = {
      buttons: [[{ text: "Approve", callback_data: "approve:abc" }]],
    };

    const result = await adapter.editMessage!("c1", "m1", "Updated", options);

    expect(result.ok).toBe(true);
    expect(adapter.lastOptions?.buttons?.[0]?.[0]?.text).toBe("Approve");
  });

  it("still allows calling editMessage with only the three required args", async () => {
    const adapter = makeRichEditAdapter();
    const result = await adapter.editMessage!("c1", "m1", "Plain text");
    expect(result.ok).toBe(true);
    expect(adapter.lastOptions).toBeUndefined();
  });
});
