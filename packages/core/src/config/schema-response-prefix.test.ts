// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { ResponsePrefixConfigSchema } from "./schema-response-prefix.js";

describe("ResponsePrefixConfigSchema", () => {
  it("produces valid defaults from empty object", () => {
    const result = ResponsePrefixConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.template).toBe("");
      expect(result.data.position).toBe("prepend");
    }
  });

  it("accepts fully specified config", () => {
    const result = ResponsePrefixConfigSchema.safeParse({
      template: "{agent.emoji} {model|short}{?thinking: | think}",
      position: "append",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.template).toBe("{agent.emoji} {model|short}{?thinking: | think}");
      expect(result.data.position).toBe("append");
    }
  });

  it("rejects unknown keys (strictObject)", () => {
    const result = ResponsePrefixConfigSchema.safeParse({
      template: "test",
      unknownField: "should-fail",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid position enum value", () => {
    const result = ResponsePrefixConfigSchema.safeParse({
      position: "inline",
    });
    expect(result.success).toBe(false);
  });
});
