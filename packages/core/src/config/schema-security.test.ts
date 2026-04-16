import { describe, it, expect } from "vitest";
import { AgentToAgentConfigSchema, SecurityConfigSchema } from "./schema-security.js";

// ---------------------------------------------------------------------------
// AgentToAgentConfigSchema.subAgentSessionPersistence
// ---------------------------------------------------------------------------

describe("AgentToAgentConfigSchema.subAgentSessionPersistence", () => {
  it("defaults to false when omitted", () => {
    const result = AgentToAgentConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.subAgentSessionPersistence).toBe(false);
    }
  });

  it("accepts explicit true", () => {
    const result = AgentToAgentConfigSchema.safeParse({
      subAgentSessionPersistence: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.subAgentSessionPersistence).toBe(true);
    }
  });

  it("accepts explicit false", () => {
    const result = AgentToAgentConfigSchema.safeParse({
      subAgentSessionPersistence: false,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.subAgentSessionPersistence).toBe(false);
    }
  });

  it("rejects non-boolean value", () => {
    const result = AgentToAgentConfigSchema.safeParse({
      subAgentSessionPersistence: "yes",
    });
    expect(result.success).toBe(false);
  });

  it("is present in SecurityConfigSchema parsed output", () => {
    const result = SecurityConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agentToAgent.subAgentSessionPersistence).toBe(false);
    }
  });

  it("is present in SecurityConfigSchema when set to true", () => {
    const result = SecurityConfigSchema.safeParse({
      agentToAgent: { subAgentSessionPersistence: true },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agentToAgent.subAgentSessionPersistence).toBe(true);
    }
  });
});
