// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { toYaml } from "./to-yaml.js";

describe("toYaml", () => {
  it("serializes simple key-value pairs", () => {
    const result = toYaml({ name: "Comis", provider: "anthropic" });
    expect(result).toContain("name: Comis");
    expect(result).toContain("provider: anthropic");
  });

  it("serializes numbers and booleans", () => {
    const result = toYaml({ maxSteps: 25, temperature: 0.7, enabled: true, debug: false });
    expect(result).toContain("maxSteps: 25");
    expect(result).toContain("temperature: 0.7");
    expect(result).toContain("enabled: true");
    expect(result).toContain("debug: false");
  });

  it("skips undefined, null, and empty string values", () => {
    const result = toYaml({ name: "Bot", empty: "", nothing: undefined, nil: null, zero: 0 });
    expect(result).toContain("name: Bot");
    expect(result).toContain("zero: 0");
    expect(result).not.toContain("empty:");
    expect(result).not.toContain("nothing:");
    expect(result).not.toContain("nil:");
  });

  it("serializes nested objects with indentation", () => {
    const result = toYaml({
      budgets: { perExecution: 100000, perDay: 2000000 },
    });
    expect(result).toContain("budgets:");
    expect(result).toContain("  perExecution: 100000");
    expect(result).toContain("  perDay: 2000000");
  });

  it("serializes arrays with dash syntax", () => {
    const result = toYaml({ tags: ["production", "primary"] });
    expect(result).toContain("tags:");
    expect(result).toContain("  - production");
    expect(result).toContain("  - primary");
  });

  it("serializes array of objects", () => {
    const result = toYaml({
      routes: [
        { pattern: "telegram/*", target: "default" },
        { pattern: "discord/*", target: "helper" },
      ],
    });
    expect(result).toContain("routes:");
    // * is a special YAML character, so values get quoted
    expect(result).toContain('- pattern: "telegram/*"');
    expect(result).toContain("target: default");
    expect(result).toContain('- pattern: "discord/*"');
    expect(result).toContain("target: helper");
  });

  it("skips empty arrays", () => {
    const result = toYaml({ items: [], name: "test" });
    expect(result).not.toContain("items:");
    expect(result).toContain("name: test");
  });

  it("skips empty nested objects", () => {
    const result = toYaml({ nested: { a: undefined, b: null, c: "" }, name: "test" });
    expect(result).not.toContain("nested:");
    expect(result).toContain("name: test");
  });

  it("quotes strings with special YAML characters", () => {
    const result = toYaml({ path: "/usr/local:bin", comment: "# note" });
    expect(result).toContain('path: "/usr/local:bin"');
    expect(result).toContain('comment: "# note"');
  });

  it("handles deeply nested objects", () => {
    const result = toYaml({
      session: {
        resetPolicy: {
          mode: "daily",
          dailyResetHour: 4,
        },
      },
    });
    expect(result).toContain("session:");
    expect(result).toContain("  resetPolicy:");
    expect(result).toContain("    mode: daily");
    expect(result).toContain("    dailyResetHour: 4");
  });
});
