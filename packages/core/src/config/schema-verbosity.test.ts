import { describe, it, expect } from "vitest";
import {
  VerbosityLevelSchema,
  VerbosityConfigSchema,
  VerbosityOverrideSchema,
} from "./schema-verbosity.js";

describe("VerbosityLevelSchema", () => {
  it("accepts valid levels", () => {
    for (const level of ["auto", "terse", "concise", "standard", "detailed"]) {
      expect(VerbosityLevelSchema.parse(level)).toBe(level);
    }
  });

  it("rejects invalid level", () => {
    expect(() => VerbosityLevelSchema.parse("invalid")).toThrow();
  });
});

describe("VerbosityConfigSchema", () => {
  it("applies correct defaults", () => {
    const result = VerbosityConfigSchema.parse({});
    expect(result.enabled).toBe(true);
    expect(result.defaultLevel).toBe("auto");
    expect(result.overrides).toEqual({});
  });

  it("parses threadLevel when present", () => {
    const result = VerbosityConfigSchema.parse({ threadLevel: "terse" });
    expect(result.threadLevel).toBe("terse");
  });

  it("threadLevel is undefined when absent", () => {
    const result = VerbosityConfigSchema.parse({});
    expect(result.threadLevel).toBeUndefined();
  });

  it("parses overrides with per-channel configs", () => {
    const result = VerbosityConfigSchema.parse({
      overrides: {
        telegram: { level: "terse" },
        discord: { maxResponseChars: 1500 },
      },
    });
    expect(result.overrides.telegram).toEqual({ level: "terse" });
    expect(result.overrides.discord).toEqual({ maxResponseChars: 1500 });
  });
});

describe("VerbosityOverrideSchema", () => {
  it("accepts partial fields — level only", () => {
    const result = VerbosityOverrideSchema.parse({ level: "concise" });
    expect(result.level).toBe("concise");
  });

  it("accepts partial fields — maxResponseChars only", () => {
    const result = VerbosityOverrideSchema.parse({ maxResponseChars: 2000 });
    expect(result.maxResponseChars).toBe(2000);
  });

  it("rejects extra fields (strictObject)", () => {
    expect(() =>
      VerbosityOverrideSchema.parse({ level: "terse", unknownField: true }),
    ).toThrow();
  });
});

describe("PerAgentConfigSchema integration", () => {
  it("accepts verbosity as optional field", async () => {
    // Dynamic import to avoid circular issues at test time
    const { PerAgentConfigSchema } = await import("./schema-agent.js");
    const base = PerAgentConfigSchema.parse({ name: "test" });
    expect(base.verbosity).toBeUndefined();

    const withVerbosity = PerAgentConfigSchema.parse({
      name: "test",
      verbosity: { defaultLevel: "terse" },
    });
    expect(withVerbosity.verbosity?.defaultLevel).toBe("terse");
  });
});
