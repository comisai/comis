// SPDX-License-Identifier: Apache-2.0
//
// createMultiActionDispatchTool opt-in factory flag for details augmentation.
//
// MultiActionDispatchConfig has an opt-in `augmentDetails` map that augments
// the `details` object on a per-action basis. message-tool's `attach` action
// uses this hook to add `visibleDelivery`. The test asserts the wrapped tool's
// result includes the augmented details.
import { describe, it, expect, vi } from "vitest";
import {
  createMultiActionDispatchTool,
  type MultiActionDispatchConfig,
} from "./messaging-factory.js";
import type { RpcCall } from "./tools/cron-tool.js";
import { Type } from "typebox";

describe("createMultiActionDispatchTool opt-in factory flag for details augmentation", () => {
  it("augmentDetails hook adds visibleDelivery to attach action result", async () => {
    const mockRpcCall: RpcCall = vi.fn(async () => ({ messageId: "M", channelId: "C" }));
    const schema = Type.Object({
      action: Type.Literal("attach"),
      channel_type: Type.String(),
      channel_id: Type.String(),
      caption: Type.Optional(Type.String()),
    });
    // Cast through unknown — exercises the `augmentDetails` field of the
    // factory contract.
    const config = {
      name: "msg",
      label: "Msg",
      description: "test",
      parameters: schema,
      validActions: ["attach"] as const,
      actionHandler: async (_action: string, _p: Record<string, unknown>, rpc: RpcCall) =>
        rpc("message.attach", _p),
      // The new opt-in: per-action augmentation hook.
      augmentDetails: {
        attach: (params: Record<string, unknown>) => ({
          visibleDelivery: {
            kind: "attachment" as const,
            channelType: params.channel_type as string,
            channelId: params.channel_id as string,
            caption: (params.caption as string | undefined) ?? "",
            deliveredAt: 1234,
          },
        }),
      },
    } as unknown as MultiActionDispatchConfig<typeof schema>;

    const tool = createMultiActionDispatchTool(config, mockRpcCall);
    const result = await tool.execute("call-1", {
      action: "attach",
      channel_type: "telegram",
      channel_id: "C",
      caption: "hi",
    } as never);

    // details is augmented with the visibleDelivery record.
    const details = result.details as
      | { visibleDelivery?: { kind: string; channelType: string; channelId: string; caption: string; deliveredAt: number } }
      | undefined;
    expect(details).toBeDefined();
    expect(details?.visibleDelivery).toBeDefined();
    expect(details?.visibleDelivery?.channelType).toBe("telegram");
    expect(details?.visibleDelivery?.caption).toBe("hi");
  });
});
