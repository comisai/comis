// SPDX-License-Identifier: Apache-2.0
import { beforeAll, describe, expect, it } from "vitest";
import { getToolMetadata } from "@comis/core";
import { registerInvocationSideEffectMetadata } from "./register-invocation-side-effect-metadata.js";

describe("registerInvocationSideEffectMetadata", () => {
  beforeAll(() => registerInvocationSideEffectMetadata());

  it("uses exact emitted names for descriptor-name mismatches", () => {
    expect(getToolMetadata("notify_user")?.invocationSideEffects).toEqual({
      kind: "always",
      capabilities: ["outbound_delivery"],
    });
    expect(getToolMetadata("notify")?.invocationSideEffects).toBeUndefined();
    expect(getToolMetadata("image_analyze")?.invocationSideEffects).toEqual({
      kind: "always",
      capabilities: [],
    });
    expect(getToolMetadata("tts_synthesize")?.invocationSideEffects).toEqual({
      kind: "always",
      capabilities: ["outbound_delivery"],
    });
  });
});
