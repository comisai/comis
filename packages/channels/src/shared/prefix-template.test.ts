import { describe, it, expect } from "vitest";
import { tokenizeTemplate, resolveTokens, applyPrefix, FORMATTERS } from "./prefix-template.js";

describe("tokenizeTemplate", () => {
  it("tokenizes plain variable", () => {
    const tokens = tokenizeTemplate("{model}");
    expect(tokens).toEqual([{ type: "variable", name: "model" }]);
  });

  it("tokenizes dotted variable", () => {
    const tokens = tokenizeTemplate("{agent.emoji}");
    expect(tokens).toEqual([{ type: "variable", name: "agent.emoji" }]);
  });

  it("tokenizes variable with formatter", () => {
    const tokens = tokenizeTemplate("{model|short}");
    expect(tokens).toEqual([
      { type: "variable", name: "model", formatter: "short" },
    ]);
  });

  it("tokenizes conditional block", () => {
    const tokens = tokenizeTemplate("{?thinking: | think}");
    expect(tokens).toEqual([
      { type: "conditional", variable: "thinking", text: " | think" },
    ]);
  });

  it("tokenizes combined template", () => {
    const tokens = tokenizeTemplate("{agent.emoji} {model|short}{?thinking: | think}");
    expect(tokens).toEqual([
      { type: "variable", name: "agent.emoji" },
      { type: "literal", value: " " },
      { type: "variable", name: "model", formatter: "short" },
      { type: "conditional", variable: "thinking", text: " | think" },
    ]);
  });

  it("treats unclosed brace as literal", () => {
    const tokens = tokenizeTemplate("hello {unclosed");
    expect(tokens).toEqual([
      { type: "literal", value: "hello " },
      { type: "literal", value: "{unclosed" },
    ]);
  });

  it("handles empty template", () => {
    expect(tokenizeTemplate("")).toEqual([]);
  });

  it("handles literal-only text", () => {
    const tokens = tokenizeTemplate("just plain text");
    expect(tokens).toEqual([{ type: "literal", value: "just plain text" }]);
  });

  it("handles multiple variables in sequence", () => {
    const tokens = tokenizeTemplate("{a}{b}{c}");
    expect(tokens).toEqual([
      { type: "variable", name: "a" },
      { type: "variable", name: "b" },
      { type: "variable", name: "c" },
    ]);
  });
});

describe("FORMATTERS", () => {
  it("short: splits on dash and takes first 2 segments", () => {
    expect(FORMATTERS.short("claude-sonnet-4-5-20250929")).toBe("claude-sonnet");
  });

  it("short: handles single segment", () => {
    expect(FORMATTERS.short("gpt4")).toBe("gpt4");
  });

  it("upper: uppercases", () => {
    expect(FORMATTERS.upper("telegram")).toBe("TELEGRAM");
  });

  it("lower: lowercases", () => {
    expect(FORMATTERS.lower("TELEGRAM")).toBe("telegram");
  });

  it("emoji: maps known providers", () => {
    expect(FORMATTERS.emoji("anthropic")).toBe("\u{1F9E0}");
    expect(FORMATTERS.emoji("openai")).toBe("\u{1F916}");
  });

  it("emoji: case-insensitive", () => {
    expect(FORMATTERS.emoji("Anthropic")).toBe("\u{1F9E0}");
  });

  it("emoji: returns empty for unknown", () => {
    expect(FORMATTERS.emoji("unknown-provider")).toBe("");
  });

  it("initial: first character uppercased", () => {
    expect(FORMATTERS.initial("telegram")).toBe("T");
  });

  it("initial: empty string returns empty", () => {
    expect(FORMATTERS.initial("")).toBe("");
  });
});

describe("resolveTokens", () => {
  it("resolves basic variable", () => {
    const tokens = tokenizeTemplate("{model}");
    expect(resolveTokens(tokens, { model: "claude-sonnet-4-5-20250929" }, FORMATTERS)).toBe(
      "claude-sonnet-4-5-20250929",
    );
  });

  it("resolves dotted variable", () => {
    const tokens = tokenizeTemplate("{agent.emoji}");
    expect(resolveTokens(tokens, { "agent.emoji": "\u{1F916}" }, FORMATTERS)).toBe("\u{1F916}");
  });

  it("applies pipe formatter", () => {
    const tokens = tokenizeTemplate("{model|short}");
    expect(resolveTokens(tokens, { model: "claude-sonnet-4-5-20250929" }, FORMATTERS)).toBe(
      "claude-sonnet",
    );
  });

  it("applies upper formatter", () => {
    const tokens = tokenizeTemplate("{model|upper}");
    expect(resolveTokens(tokens, { model: "telegram" }, FORMATTERS)).toBe("TELEGRAM");
  });

  it("applies lower formatter", () => {
    const tokens = tokenizeTemplate("{channel|lower}");
    expect(resolveTokens(tokens, { channel: "DISCORD" }, FORMATTERS)).toBe("discord");
  });

  it("applies initial formatter", () => {
    const tokens = tokenizeTemplate("{channel|initial}");
    expect(resolveTokens(tokens, { channel: "discord" }, FORMATTERS)).toBe("D");
  });

  it("renders conditional when variable is truthy", () => {
    const tokens = tokenizeTemplate("{?thinking: | think}");
    expect(resolveTokens(tokens, { thinking: "high" }, FORMATTERS)).toBe(" | think");
  });

  it("omits conditional when variable is empty", () => {
    const tokens = tokenizeTemplate("{?thinking: | think}");
    expect(resolveTokens(tokens, { thinking: "" }, FORMATTERS)).toBe("");
  });

  it("omits conditional when variable is 'off'", () => {
    const tokens = tokenizeTemplate("{?thinking: | think}");
    expect(resolveTokens(tokens, { thinking: "off" }, FORMATTERS)).toBe("");
  });

  it("omits conditional when variable is missing", () => {
    const tokens = tokenizeTemplate("{?thinking: | think}");
    expect(resolveTokens(tokens, {}, FORMATTERS)).toBe("");
  });

  it("unresolved variables produce empty string", () => {
    const tokens = tokenizeTemplate("{unknown}");
    expect(resolveTokens(tokens, {}, FORMATTERS)).toBe("");
  });

  it("combined template resolves correctly", () => {
    const tokens = tokenizeTemplate("{agent.emoji} {model|short}{?thinking: | think}");
    const ctx = {
      "agent.emoji": "\u{1F9E0}",
      model: "claude-sonnet-4-5-20250929",
      thinking: "high",
    };
    expect(resolveTokens(tokens, ctx, FORMATTERS)).toBe("\u{1F9E0} claude-sonnet | think");
  });

  it("combined template with thinking off", () => {
    const tokens = tokenizeTemplate("{agent.emoji} {model|short}{?thinking: | think}");
    const ctx = {
      "agent.emoji": "\u{1F9E0}",
      model: "claude-sonnet-4-5-20250929",
      thinking: "off",
    };
    expect(resolveTokens(tokens, ctx, FORMATTERS)).toBe("\u{1F9E0} claude-sonnet");
  });

  it("injection prevention: agent name containing {model} is literal", () => {
    const tokens = tokenizeTemplate("{agent}");
    const ctx = { agent: "{model}", model: "should-not-appear" };
    expect(resolveTokens(tokens, ctx, FORMATTERS)).toBe("{model}");
  });

  it("injection prevention: agent name containing $& is literal", () => {
    const tokens = tokenizeTemplate("{agent}");
    const ctx = { agent: "test$&value" };
    expect(resolveTokens(tokens, ctx, FORMATTERS)).toBe("test$&value");
  });

  it("handles empty context", () => {
    const tokens = tokenizeTemplate("{a} {b|short} {?c:text}");
    expect(resolveTokens(tokens, {}, FORMATTERS)).toBe("  ");
  });

  it("does not apply formatter to empty value", () => {
    const tokens = tokenizeTemplate("{model|short}");
    expect(resolveTokens(tokens, { model: "" }, FORMATTERS)).toBe("");
  });

  it("ignores unknown formatter", () => {
    const tokens = tokenizeTemplate("{model|nonexistent}");
    expect(resolveTokens(tokens, { model: "value" }, FORMATTERS)).toBe("value");
  });
});

describe("applyPrefix", () => {
  const ctx = {
    "agent.emoji": "\u{1F9E0}",
    model: "claude-sonnet-4-5-20250929",
    thinking: "high",
  };

  it("prepends resolved template", () => {
    const result = applyPrefix("Hello world", { template: "{agent.emoji}", position: "prepend" }, ctx);
    expect(result).toBe("\u{1F9E0}\nHello world");
  });

  it("appends resolved template", () => {
    const result = applyPrefix("Hello world", { template: "{agent.emoji}", position: "append" }, ctx);
    expect(result).toBe("Hello world\n\u{1F9E0}");
  });

  it("returns text unchanged when template is empty", () => {
    const result = applyPrefix("Hello world", { template: "", position: "prepend" }, ctx);
    expect(result).toBe("Hello world");
  });

  it("returns text unchanged when template resolves to empty string", () => {
    const result = applyPrefix("Hello world", { template: "{unknown}", position: "prepend" }, {});
    expect(result).toBe("Hello world");
  });

  it("returns text unchanged when template resolves to whitespace only", () => {
    const result = applyPrefix("Hello world", { template: "{a} {b}", position: "prepend" }, {});
    expect(result).toBe("Hello world");
  });

  it("complex template prepend", () => {
    const result = applyPrefix(
      "This is the response.",
      { template: "{agent.emoji} {model|short}{?thinking: | think}", position: "prepend" },
      ctx,
    );
    expect(result).toBe("\u{1F9E0} claude-sonnet | think\nThis is the response.");
  });
});
