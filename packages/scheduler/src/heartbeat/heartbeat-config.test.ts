// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  HeartbeatTargetSchema,
  PerAgentHeartbeatConfigSchema,
  PerAgentSchedulerConfigSchema,
} from "@comis/core";
import { resolveEffectiveHeartbeatConfig } from "./heartbeat-config.js";

// ---- Schema validation tests ----

describe("PerAgentHeartbeatConfigSchema", () => {
  it("produces empty object when all fields omitted", () => {
    const result = PerAgentHeartbeatConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({});
    }
  });

  it("accepts valid partial override (intervalMs only)", () => {
    const result = PerAgentHeartbeatConfigSchema.safeParse({ intervalMs: 600_000 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.intervalMs).toBe(600_000);
      expect(result.data.enabled).toBeUndefined();
    }
  });

  it("accepts full config with all fields", () => {
    const result = PerAgentHeartbeatConfigSchema.safeParse({
      enabled: true,
      intervalMs: 900_000,
      showOk: true,
      showAlerts: false,
      target: { channelType: "telegram", channelId: "bot1", chatId: "123" },
      prompt: "Custom heartbeat prompt",
      session: "heartbeat-session",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(true);
      expect(result.data.intervalMs).toBe(900_000);
      expect(result.data.target?.channelType).toBe("telegram");
      expect(result.data.prompt).toBe("Custom heartbeat prompt");
      expect(result.data.session).toBe("heartbeat-session");
    }
  });

  it("rejects non-positive intervalMs", () => {
    const result = PerAgentHeartbeatConfigSchema.safeParse({ intervalMs: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects negative intervalMs", () => {
    const result = PerAgentHeartbeatConfigSchema.safeParse({ intervalMs: -1 });
    expect(result.success).toBe(false);
  });

  it("rejects unknown keys (strictObject)", () => {
    const result = PerAgentHeartbeatConfigSchema.safeParse({ unknownKey: true });
    expect(result.success).toBe(false);
  });

  it("accepts all newer fields (allowDm, lightContext, ackMaxChars, responsePrefix, skipHeartbeatOnlyDelivery)", () => {
    const result = PerAgentHeartbeatConfigSchema.safeParse({
      allowDm: true,
      lightContext: true,
      ackMaxChars: 500,
      responsePrefix: "Agent: ",
      skipHeartbeatOnlyDelivery: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.allowDm).toBe(true);
      expect(result.data.lightContext).toBe(true);
      expect(result.data.ackMaxChars).toBe(500);
      expect(result.data.responsePrefix).toBe("Agent: ");
      expect(result.data.skipHeartbeatOnlyDelivery).toBe(true);
    }
  });

  it("rejects unknown model key (strictObject enforcement)", () => {
    const result = PerAgentHeartbeatConfigSchema.safeParse({ model: "x" });
    expect(result.success).toBe(false);
  });

  it("rejects non-positive ackMaxChars", () => {
    const zero = PerAgentHeartbeatConfigSchema.safeParse({ ackMaxChars: 0 });
    expect(zero.success).toBe(false);

    const negative = PerAgentHeartbeatConfigSchema.safeParse({ ackMaxChars: -1 });
    expect(negative.success).toBe(false);
  });
});

describe("HeartbeatTargetSchema", () => {
  it("requires all three fields (channelType, channelId, chatId)", () => {
    expect(HeartbeatTargetSchema.safeParse({}).success).toBe(false);
    expect(HeartbeatTargetSchema.safeParse({ channelType: "telegram" }).success).toBe(false);
    expect(
      HeartbeatTargetSchema.safeParse({ channelType: "telegram", channelId: "bot1" }).success,
    ).toBe(false);
  });

  it("accepts valid target with all three fields", () => {
    const result = HeartbeatTargetSchema.safeParse({
      channelType: "telegram",
      channelId: "bot1",
      chatId: "123",
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty strings", () => {
    expect(
      HeartbeatTargetSchema.safeParse({ channelType: "", channelId: "bot1", chatId: "123" })
        .success,
    ).toBe(false);
    expect(
      HeartbeatTargetSchema.safeParse({ channelType: "telegram", channelId: "", chatId: "123" })
        .success,
    ).toBe(false);
    expect(
      HeartbeatTargetSchema.safeParse({ channelType: "telegram", channelId: "bot1", chatId: "" })
        .success,
    ).toBe(false);
  });
});

describe("PerAgentSchedulerConfigSchema with heartbeat", () => {
  it("accepts heartbeat field in scheduler config", () => {
    const result = PerAgentSchedulerConfigSchema.safeParse({
      heartbeat: { intervalMs: 600_000 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.heartbeat?.intervalMs).toBe(600_000);
    }
  });

  it("heartbeat is optional (defaults to undefined)", () => {
    const result = PerAgentSchedulerConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.heartbeat).toBeUndefined();
    }
  });
});

// ---- Config resolution tests ----

describe("resolveEffectiveHeartbeatConfig", () => {
  const globalDefaults = {
    enabled: true,
    intervalMs: 300_000,
    showOk: false,
    showAlerts: true,
  };

  it("returns global defaults when no per-agent config provided", () => {
    const result = resolveEffectiveHeartbeatConfig(globalDefaults);
    expect(result).toEqual({
      enabled: true,
      intervalMs: 300_000,
      showOk: false,
      showAlerts: true,
      target: undefined,
      prompt: undefined,
      session: undefined,
    });
  });

  it("per-agent intervalMs overrides global intervalMs", () => {
    const result = resolveEffectiveHeartbeatConfig(globalDefaults, { intervalMs: 900_000 });
    expect(result.intervalMs).toBe(900_000);
    expect(result.enabled).toBe(true); // inherited from global
    expect(result.showOk).toBe(false); // inherited from global
  });

  it("per-agent enabled overrides global enabled", () => {
    const result = resolveEffectiveHeartbeatConfig(globalDefaults, { enabled: false });
    expect(result.enabled).toBe(false);
  });

  it("per-agent showOk/showAlerts override global values", () => {
    const result = resolveEffectiveHeartbeatConfig(globalDefaults, {
      showOk: true,
      showAlerts: false,
    });
    expect(result.showOk).toBe(true);
    expect(result.showAlerts).toBe(false);
  });

  it("per-agent-only fields (target, prompt, session) come through", () => {
    const result = resolveEffectiveHeartbeatConfig(globalDefaults, {
      target: { channelType: "telegram", channelId: "bot1", chatId: "123" },
      prompt: "Custom prompt",
      session: "hb-session",
    });
    expect(result.target).toEqual({ channelType: "telegram", channelId: "bot1", chatId: "123" });
    expect(result.prompt).toBe("Custom prompt");
    expect(result.session).toBe("hb-session");
  });

  it("omitted per-agent fields inherit from global (field-level merge, not block replace)", () => {
    const result = resolveEffectiveHeartbeatConfig(globalDefaults, { intervalMs: 600_000 });
    expect(result.enabled).toBe(true); // from global
    expect(result.intervalMs).toBe(600_000); // from per-agent
    expect(result.showOk).toBe(false); // from global
    expect(result.showAlerts).toBe(true); // from global
  });

  it("per-agent enabled: false is respected even when global enabled: true", () => {
    const result = resolveEffectiveHeartbeatConfig(
      { ...globalDefaults, enabled: true },
      { enabled: false },
    );
    expect(result.enabled).toBe(false);
  });

  // ---- Resilience config layering ----

  describe("resilience fields", () => {
    it("inherits alertThreshold from global defaults", () => {
      const result = resolveEffectiveHeartbeatConfig({
        ...globalDefaults,
        alertThreshold: 3,
      });
      expect(result.alertThreshold).toBe(3);
    });

    it("per-agent alertCooldownMs overrides global alertCooldownMs", () => {
      const result = resolveEffectiveHeartbeatConfig(
        { ...globalDefaults, alertCooldownMs: 300_000 },
        { alertCooldownMs: 60_000 },
      );
      expect(result.alertCooldownMs).toBe(60_000);
    });

    it("per-agent staleMs overrides global staleMs", () => {
      const result = resolveEffectiveHeartbeatConfig(
        { ...globalDefaults, staleMs: 120_000 },
        { staleMs: 30_000 },
      );
      expect(result.staleMs).toBe(30_000);
    });
  });
});
