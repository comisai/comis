// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { parseSlashCommand } from "./command-parser.js";

describe("parseSlashCommand", () => {
  // -----------------------------------------------------------------------
  // Non-command cases
  // -----------------------------------------------------------------------

  it("returns found=false for plain text (no slash)", () => {
    const result = parseSlashCommand("Hello, how are you?");
    expect(result.found).toBe(false);
    expect(result.cleanedText).toBe("Hello, how are you?");
    expect(result.isDirective).toBe(false);
    expect(result.isStandalone).toBe(false);
  });

  it("returns found=false for empty string", () => {
    const result = parseSlashCommand("");
    expect(result.found).toBe(false);
    expect(result.cleanedText).toBe("");
  });

  it("returns found=false for just /", () => {
    const result = parseSlashCommand("/");
    expect(result.found).toBe(false);
  });

  it("returns found=false for unknown command", () => {
    const result = parseSlashCommand("/unknown");
    expect(result.found).toBe(false);
    expect(result.cleanedText).toBe("/unknown");
  });

  it("returns found=false for slash in middle of text", () => {
    const result = parseSlashCommand("I want to use the /model endpoint");
    expect(result.found).toBe(false);
    expect(result.cleanedText).toBe("I want to use the /model endpoint");
  });

  // -----------------------------------------------------------------------
  // Standalone commands
  // -----------------------------------------------------------------------

  it("parses /status as standalone command", () => {
    const result = parseSlashCommand("/status");
    expect(result.found).toBe(true);
    expect(result.command).toBe("status");
    expect(result.isStandalone).toBe(true);
    expect(result.isDirective).toBe(false);
    expect(result.args).toEqual([]);
    expect(result.cleanedText).toBe("");
  });

  it("parses /context as standalone command", () => {
    const result = parseSlashCommand("/context");
    expect(result.found).toBe(true);
    expect(result.command).toBe("context");
    expect(result.isStandalone).toBe(true);
  });

  it("parses /new as standalone command", () => {
    const result = parseSlashCommand("/new");
    expect(result.found).toBe(true);
    expect(result.command).toBe("new");
    expect(result.isStandalone).toBe(true);
    expect(result.args).toEqual([]);
  });

  it("parses /new with model arg", () => {
    const result = parseSlashCommand("/new openai/gpt-4o");
    expect(result.found).toBe(true);
    expect(result.command).toBe("new");
    expect(result.args).toEqual(["openai/gpt-4o"]);
    expect(result.isStandalone).toBe(true);
  });

  it("parses /reset as standalone command", () => {
    const result = parseSlashCommand("/reset");
    expect(result.found).toBe(true);
    expect(result.command).toBe("reset");
    expect(result.isStandalone).toBe(true);
  });

  it("parses /compact as standalone command", () => {
    const result = parseSlashCommand("/compact");
    expect(result.found).toBe(true);
    expect(result.command).toBe("compact");
    expect(result.isStandalone).toBe(true);
  });

  it("parses /usage as standalone command", () => {
    const result = parseSlashCommand("/usage");
    expect(result.found).toBe(true);
    expect(result.command).toBe("usage");
    expect(result.isStandalone).toBe(true);
    expect(result.isDirective).toBe(false);
    expect(result.cleanedText).toBe("");
  });

  // -----------------------------------------------------------------------
  // /model sub-commands
  // -----------------------------------------------------------------------

  it("parses /model list with args", () => {
    const result = parseSlashCommand("/model list");
    expect(result.found).toBe(true);
    expect(result.command).toBe("model");
    expect(result.args).toEqual(["list"]);
    expect(result.isStandalone).toBe(true);
  });

  it("parses /model with provider/modelId arg", () => {
    const result = parseSlashCommand("/model openai/gpt-4o");
    expect(result.found).toBe(true);
    expect(result.command).toBe("model");
    expect(result.args).toEqual(["openai/gpt-4o"]);
  });

  it("parses /model with no args as standalone", () => {
    const result = parseSlashCommand("/model");
    expect(result.found).toBe(true);
    expect(result.command).toBe("model");
    expect(result.args).toEqual([]);
    expect(result.isStandalone).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Directive: /think
  // -----------------------------------------------------------------------

  it("parses /think standalone as directive", () => {
    const result = parseSlashCommand("/think");
    expect(result.found).toBe(true);
    expect(result.command).toBe("think");
    expect(result.isDirective).toBe(true);
    expect(result.isStandalone).toBe(true);
    expect(result.args).toEqual([]);
  });

  it("parses /think high as standalone with level arg", () => {
    const result = parseSlashCommand("/think high");
    expect(result.found).toBe(true);
    expect(result.command).toBe("think");
    expect(result.args).toEqual(["high"]);
    expect(result.isStandalone).toBe(true);
    expect(result.isDirective).toBe(true);
  });

  it("parses /think low as standalone with level arg", () => {
    const result = parseSlashCommand("/think low");
    expect(result.found).toBe(true);
    expect(result.command).toBe("think");
    expect(result.args).toEqual(["low"]);
    expect(result.isStandalone).toBe(true);
  });

  it("parses /think medium as standalone with level arg", () => {
    const result = parseSlashCommand("/think medium");
    expect(result.found).toBe(true);
    expect(result.command).toBe("think");
    expect(result.args).toEqual(["medium"]);
    expect(result.isStandalone).toBe(true);
  });

  it("parses /think with body text as directive", () => {
    const result = parseSlashCommand("/think What is the meaning of life?");
    expect(result.found).toBe(true);
    expect(result.command).toBe("think");
    expect(result.isDirective).toBe(true);
    expect(result.isStandalone).toBe(false);
    expect(result.cleanedText).toBe("What is the meaning of life?");
    expect(result.args).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // Directive: /verbose
  // -----------------------------------------------------------------------

  it("parses /verbose standalone as directive", () => {
    const result = parseSlashCommand("/verbose");
    expect(result.found).toBe(true);
    expect(result.command).toBe("verbose");
    expect(result.isDirective).toBe(true);
    expect(result.isStandalone).toBe(true);
  });

  it("parses /verbose on as standalone with toggle arg", () => {
    const result = parseSlashCommand("/verbose on");
    expect(result.found).toBe(true);
    expect(result.command).toBe("verbose");
    expect(result.args).toEqual(["on"]);
    expect(result.isStandalone).toBe(true);
  });

  it("parses /verbose off as standalone with toggle arg", () => {
    const result = parseSlashCommand("/verbose off");
    expect(result.found).toBe(true);
    expect(result.command).toBe("verbose");
    expect(result.args).toEqual(["off"]);
    expect(result.isStandalone).toBe(true);
  });

  it("parses /verbose with body text as directive", () => {
    const result = parseSlashCommand("/verbose Tell me more");
    expect(result.found).toBe(true);
    expect(result.command).toBe("verbose");
    expect(result.isDirective).toBe(true);
    expect(result.isStandalone).toBe(false);
    expect(result.cleanedText).toBe("Tell me more");
  });

  // -----------------------------------------------------------------------
  // Directive: /reasoning
  // -----------------------------------------------------------------------

  it("parses /reasoning standalone as directive", () => {
    const result = parseSlashCommand("/reasoning");
    expect(result.found).toBe(true);
    expect(result.command).toBe("reasoning");
    expect(result.isDirective).toBe(true);
    expect(result.isStandalone).toBe(true);
  });

  it("parses /reasoning on as standalone with toggle arg", () => {
    const result = parseSlashCommand("/reasoning on");
    expect(result.found).toBe(true);
    expect(result.command).toBe("reasoning");
    expect(result.args).toEqual(["on"]);
    expect(result.isStandalone).toBe(true);
  });

  it("parses /reasoning with body text as directive", () => {
    const result = parseSlashCommand("/reasoning Explain step by step");
    expect(result.found).toBe(true);
    expect(result.command).toBe("reasoning");
    expect(result.isDirective).toBe(true);
    expect(result.isStandalone).toBe(false);
    expect(result.cleanedText).toBe("Explain step by step");
  });

  // -----------------------------------------------------------------------
  // /config sub-commands
  // -----------------------------------------------------------------------

  it("parses /config show agent as standalone with args", () => {
    const result = parseSlashCommand("/config show agent");
    expect(result.found).toBe(true);
    expect(result.command).toBe("config");
    expect(result.args).toEqual(["show", "agent"]);
    expect(result.isStandalone).toBe(true);
  });

  it("parses /config set agent.budget.maxTokens 50000 with args", () => {
    const result = parseSlashCommand("/config set agent.budget.maxTokens 50000");
    expect(result.found).toBe(true);
    expect(result.command).toBe("config");
    expect(result.args).toEqual(["set", "agent.budget.maxTokens", "50000"]);
    expect(result.isStandalone).toBe(true);
  });

  it("parses /config history as standalone", () => {
    const result = parseSlashCommand("/config history");
    expect(result.found).toBe(true);
    expect(result.command).toBe("config");
    expect(result.args).toEqual(["history"]);
    expect(result.isStandalone).toBe(true);
  });

  it("parses /config with no args as standalone (defaults to show)", () => {
    const result = parseSlashCommand("/config");
    expect(result.found).toBe(true);
    expect(result.command).toBe("config");
    expect(result.args).toEqual([]);
    expect(result.isStandalone).toBe(true);
  });

  // -----------------------------------------------------------------------
  // /stop command
  // -----------------------------------------------------------------------

  it("parses /stop as standalone command", () => {
    const result = parseSlashCommand("/stop");
    expect(result.found).toBe(true);
    expect(result.command).toBe("stop");
    expect(result.isStandalone).toBe(true);
    expect(result.isDirective).toBe(false);
    expect(result.args).toEqual([]);
    expect(result.cleanedText).toBe("");
  });

  it("parses /stop with trailing text as standalone with args", () => {
    const result = parseSlashCommand("/stop some text");
    expect(result.found).toBe(true);
    expect(result.command).toBe("stop");
    expect(result.isStandalone).toBe(true);
    expect(result.args).toEqual(["some", "text"]);
  });

  it("does not recognize 'stop' without slash prefix", () => {
    const result = parseSlashCommand("stop");
    expect(result.found).toBe(false);
    expect(result.cleanedText).toBe("stop");
  });

  // -----------------------------------------------------------------------
  // /export command
  // -----------------------------------------------------------------------

  it("parses /export as standalone command with no args", () => {
    const result = parseSlashCommand("/export");
    expect(result.found).toBe(true);
    expect(result.command).toBe("export");
    expect(result.isStandalone).toBe(true);
    expect(result.isDirective).toBe(false);
    expect(result.args).toEqual([]);
    expect(result.cleanedText).toBe("");
  });

  it("parses /export /tmp/session.html with output path arg", () => {
    const result = parseSlashCommand("/export /tmp/session.html");
    expect(result.found).toBe(true);
    expect(result.command).toBe("export");
    expect(result.args).toEqual(["/tmp/session.html"]);
    expect(result.isStandalone).toBe(true);
  });

  it("does not recognize export mid-text", () => {
    const result = parseSlashCommand("I want to export data");
    expect(result.found).toBe(false);
    expect(result.cleanedText).toBe("I want to export data");
  });

  // -----------------------------------------------------------------------
  // /fork command
  // -----------------------------------------------------------------------

  it("parses /fork as standalone command", () => {
    const result = parseSlashCommand("/fork");
    expect(result.found).toBe(true);
    expect(result.command).toBe("fork");
    expect(result.isStandalone).toBe(true);
    expect(result.isDirective).toBe(false);
    expect(result.args).toEqual([]);
    expect(result.cleanedText).toBe("");
  });

  it("does not recognize fork mid-text", () => {
    const result = parseSlashCommand("I want to /fork this");
    expect(result.found).toBe(false);
    expect(result.cleanedText).toBe("I want to /fork this");
  });

  it("does not recognize 'fork' without slash prefix", () => {
    const result = parseSlashCommand("fork");
    expect(result.found).toBe(false);
    expect(result.cleanedText).toBe("fork");
  });

  // -----------------------------------------------------------------------
  // /branch command
  // -----------------------------------------------------------------------

  it("parses /branch as standalone command with no args (list mode)", () => {
    const result = parseSlashCommand("/branch");
    expect(result.found).toBe(true);
    expect(result.command).toBe("branch");
    expect(result.isStandalone).toBe(true);
    expect(result.isDirective).toBe(false);
    expect(result.args).toEqual([]);
    expect(result.cleanedText).toBe("");
  });

  it("parses /branch with entry ID arg", () => {
    const result = parseSlashCommand("/branch entry-123");
    expect(result.found).toBe(true);
    expect(result.command).toBe("branch");
    expect(result.isStandalone).toBe(true);
    expect(result.args).toEqual(["entry-123"]);
  });

  it("does not recognize branch mid-text", () => {
    const result = parseSlashCommand("Go to the /branch now");
    expect(result.found).toBe(false);
    expect(result.cleanedText).toBe("Go to the /branch now");
  });

  it("does not recognize 'branch' without slash prefix", () => {
    const result = parseSlashCommand("branch");
    expect(result.found).toBe(false);
    expect(result.cleanedText).toBe("branch");
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  it("trims leading/trailing whitespace before parsing", () => {
    const result = parseSlashCommand("  /status  ");
    expect(result.found).toBe(true);
    expect(result.command).toBe("status");
    expect(result.isStandalone).toBe(true);
  });

  it("handles multiline body text with /think directive", () => {
    const result = parseSlashCommand("/think Line one\nLine two\nLine three");
    expect(result.found).toBe(true);
    expect(result.command).toBe("think");
    expect(result.isDirective).toBe(true);
    expect(result.isStandalone).toBe(false);
    expect(result.cleanedText).toBe("Line one\nLine two\nLine three");
  });

  // -----------------------------------------------------------------------
  // /budget directive parsing
  // -----------------------------------------------------------------------

  it("parses /budget 500k with amount in args[0]", () => {
    const result = parseSlashCommand("/budget 500k");
    expect(result.found).toBe(true);
    expect(result.command).toBe("budget");
    expect(result.args).toEqual(["500k"]);
    expect(result.cleanedText).toBe("");
    expect(result.isDirective).toBe(true);
    expect(result.isStandalone).toBe(true);
  });

  it("parses /budget 500k with trailing body text", () => {
    const result = parseSlashCommand("/budget 500k hello world");
    expect(result.found).toBe(true);
    expect(result.command).toBe("budget");
    expect(result.args).toEqual(["500k"]);
    expect(result.cleanedText).toBe("hello world");
    expect(result.isDirective).toBe(true);
    expect(result.isStandalone).toBe(false);
  });

  it("parses /budget alone as standalone with no args", () => {
    const result = parseSlashCommand("/budget");
    expect(result.found).toBe(true);
    expect(result.command).toBe("budget");
    expect(result.args).toEqual([]);
    expect(result.cleanedText).toBe("");
    expect(result.isDirective).toBe(true);
    expect(result.isStandalone).toBe(true);
  });

  it("parses /budget 2m with amount in args[0]", () => {
    const result = parseSlashCommand("/budget 2m");
    expect(result.found).toBe(true);
    expect(result.command).toBe("budget");
    expect(result.args).toEqual(["2m"]);
    expect(result.cleanedText).toBe("");
    expect(result.isDirective).toBe(true);
    expect(result.isStandalone).toBe(true);
  });
});
