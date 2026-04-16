import { describe, it, expect } from "vitest";
import { NotificationConfigSchema } from "./schema-notification.js";
import { PerAgentConfigSchema } from "./schema-agent.js";

describe("NotificationConfigSchema", () => {
  it("returns defaults when parsing empty object", () => {
    const result = NotificationConfigSchema.parse({});
    expect(result.enabled).toBe(true);
    expect(result.maxPerHour).toBe(30);
    expect(result.dedupeWindowMs).toBe(300_000);
    expect(result.maxChainDepth).toBe(0);
  });

  it("rejects maxPerHour of 0 (must be positive)", () => {
    expect(() => NotificationConfigSchema.parse({ maxPerHour: 0 })).toThrow();
  });

  it("rejects negative maxPerHour", () => {
    expect(() => NotificationConfigSchema.parse({ maxPerHour: -1 })).toThrow();
  });

  it("rejects negative dedupeWindowMs (must be nonnegative)", () => {
    expect(() => NotificationConfigSchema.parse({ dedupeWindowMs: -1 })).toThrow();
  });

  it("accepts primaryChannel with valid channelType and channelId", () => {
    const result = NotificationConfigSchema.parse({
      primaryChannel: { channelType: "telegram", channelId: "123" },
    });
    expect(result.primaryChannel).toEqual({ channelType: "telegram", channelId: "123" });
  });

  it("rejects primaryChannel with empty channelType", () => {
    expect(() =>
      NotificationConfigSchema.parse({ primaryChannel: { channelType: "", channelId: "123" } }),
    ).toThrow();
  });

  it("rejects unknown fields (strictObject)", () => {
    expect(() => NotificationConfigSchema.parse({ unknownField: true })).toThrow();
  });
});

describe("PerAgentConfigSchema notification integration", () => {
  it("notification is undefined when not provided", () => {
    const result = PerAgentConfigSchema.parse({});
    expect(result.notification).toBeUndefined();
  });

  it("parses notification with defaults when empty object provided", () => {
    const result = PerAgentConfigSchema.parse({ notification: {} });
    expect(result.notification?.maxPerHour).toBe(30);
  });
});
