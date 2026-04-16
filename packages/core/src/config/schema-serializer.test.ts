import { describe, it, expect } from "vitest";
import { getConfigSchema, getConfigSections } from "./schema-serializer.js";

describe("getConfigSchema", () => {
  it("returns full schema with type property", () => {
    const schema = getConfigSchema();
    expect(schema).toBeDefined();
    expect(typeof schema).toBe("object");
    // JSON Schema always has a type or definitions at the top level
    expect(schema).toHaveProperty("type");
  });

  it("caches the full schema (same reference on second call)", () => {
    const first = getConfigSchema();
    const second = getConfigSchema();
    expect(first).toBe(second);
  });

  it("returns section-specific schema for agents", () => {
    const schema = getConfigSchema("agents");
    expect(schema).toBeDefined();
    expect(typeof schema).toBe("object");
    expect(schema).toHaveProperty("type");
  });

  it("returns section-specific schema for gateway", () => {
    const schema = getConfigSchema("gateway");
    expect(schema).toBeDefined();
    expect(typeof schema).toBe("object");
    expect(schema).toHaveProperty("type");
  });

  it("throws for unknown section name", () => {
    expect(() => getConfigSchema("unknown_section")).toThrow("Unknown config section: unknown_section");
  });

  it("throws for empty string section", () => {
    expect(() => getConfigSchema("")).toThrow("Unknown config section: ");
  });

  it("getConfigSchema('agents') returns JSON Schema for per-agent config", () => {
    const schema = getConfigSchema("agents");
    expect(schema).toHaveProperty("type");
    // PerAgentConfigSchema is an object type with agent properties
    expect(schema.type).toBe("object");
    const sections = getConfigSections();
    expect(sections).toContain("agents");
  });
});

describe("getConfigSections", () => {
  it("returns an array of section names", () => {
    const sections = getConfigSections();
    expect(Array.isArray(sections)).toBe(true);
    expect(sections.length).toBeGreaterThan(0);
  });

  it("contains agents, security, and gateway", () => {
    const sections = getConfigSections();
    expect(sections).toContain("agents");
    expect(sections).toContain("security");
    expect(sections).toContain("gateway");
  });

  it("contains all 15 sections", () => {
    const sections = getConfigSections();
    expect(sections).toHaveLength(15);
    expect(sections).toContain("agents");
    expect(sections).toContain("channels");
    expect(sections).toContain("memory");
    expect(sections).toContain("routing");
    expect(sections).toContain("daemon");
    expect(sections).toContain("scheduler");
    expect(sections).toContain("integrations");
    expect(sections).toContain("monitoring");
    // New config sections
    expect(sections).toContain("browser");
    expect(sections).toContain("models");
    expect(sections).toContain("providers");
    expect(sections).toContain("messages");
    expect(sections).toContain("approvals");
  });
});
