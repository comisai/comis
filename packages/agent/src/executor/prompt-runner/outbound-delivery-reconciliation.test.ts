// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { suppressRedundantFinalAfterOutboundDelivery } from "./outbound-delivery-reconciliation.js";
import type { RunPromptParams } from "./prompt-runner-types.js";

const deliveryTarget = {
  channelType: "telegram",
  channelId: "chat-final",
};

function makeParams(overrides: {
  response?: string;
  hasOutboundDelivery?: (target: typeof deliveryTarget) => boolean;
} = {}): {
  params: RunPromptParams;
  hasOutboundDelivery: ReturnType<typeof vi.fn>;
  loggerInfo: ReturnType<typeof vi.fn>;
} {
  const hasOutboundDelivery = vi.fn(
    overrides.hasOutboundDelivery ?? (() => true),
  );
  const loggerInfo = vi.fn();
  const params = {
    result: { response: overrides.response ?? "Delivery complete" },
    executionOverrides: {
      suppressFinalResponseAfterOutboundDelivery: deliveryTarget,
    },
    bridge: { hasOutboundDelivery },
    deps: { logger: { info: loggerInfo } },
  } as unknown as RunPromptParams;

  return { params, hasOutboundDelivery, loggerInfo };
}

describe("suppressRedundantFinalAfterOutboundDelivery", () => {
  it("suppresses a redundant final after exact-route delivery", () => {
    const { params, hasOutboundDelivery, loggerInfo } = makeParams();

    suppressRedundantFinalAfterOutboundDelivery(params);

    expect(hasOutboundDelivery).toHaveBeenCalledWith(deliveryTarget);
    expect(params.result.response).toBe("NO_REPLY");
    expect(params.result.finalResponseSuppressedBy).toBe("outbound_delivery");
    expect(loggerInfo).toHaveBeenCalledWith(
      {
        step: "outbound-delivery-reconciliation",
        channelType: "telegram",
        exactRouteMatched: true,
      },
      "Redundant final response suppressed after successful outbound delivery",
    );
  });

  it("preserves a final when the exact route was not delivered", () => {
    const { params, loggerInfo } = makeParams({
      hasOutboundDelivery: () => false,
    });

    suppressRedundantFinalAfterOutboundDelivery(params);

    expect(params.result.response).toBe("Delivery complete");
    expect(params.result.finalResponseSuppressedBy).toBeUndefined();
    expect(loggerInfo).not.toHaveBeenCalled();
  });

  it("leaves an existing silent response untouched", () => {
    const { params, hasOutboundDelivery, loggerInfo } = makeParams({
      response: "NO_REPLY",
    });

    suppressRedundantFinalAfterOutboundDelivery(params);

    expect(params.result.response).toBe("NO_REPLY");
    expect(params.result.finalResponseSuppressedBy).toBeUndefined();
    expect(hasOutboundDelivery).not.toHaveBeenCalled();
    expect(loggerInfo).not.toHaveBeenCalled();
  });
});
