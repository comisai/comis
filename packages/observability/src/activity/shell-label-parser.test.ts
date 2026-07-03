// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the shell-label-parser.
 *
 * The parser is deterministic — it turns a
 * `bash`/`exec`/`shell` command string into a concise human label. Pipelines
 * append a `(+N steps)` counter for the extra stages. No `eval`, no LLM.
 *
 * Corpus inputs use neutral placeholders (AGENTS.md §2.2 — no secrets).
 */
import { describe, it, expect } from "vitest";
import { parseShellCommand } from "./shell-label-parser.js";

describe("parseShellCommand (shell command summarizer)", () => {
  it("summarizes `head -n N file` as showing the first N lines", () => {
    expect(parseShellCommand("head -n 20 file.txt")).toBe("show first 20 lines of file.txt");
  });

  it("summarizes `head -N file` short form", () => {
    expect(parseShellCommand("head -20 file.ts")).toBe("show first 20 lines of file.ts");
  });

  it("summarizes `tail -f log` as following a file", () => {
    expect(parseShellCommand("tail -f server.log")).toBe("follow server.log");
  });

  it("summarizes `tail -n N file` as showing the last N lines", () => {
    expect(parseShellCommand("tail -n 50 out.txt")).toBe("show last 50 lines of out.txt");
  });

  it("summarizes `sed -n '1,Np'` as printing a line range", () => {
    expect(parseShellCommand("sed -n '1,30p' x.txt")).toBe("print lines 1-30 of x.txt");
  });

  it("summarizes `grep -r pattern .` as a recursive search", () => {
    expect(parseShellCommand("grep -r foo .")).toBe("search for `foo` in .");
  });

  it("summarizes `grep pattern file`", () => {
    expect(parseShellCommand("grep needle haystack.txt")).toBe("search for `needle` in haystack.txt");
  });

  it("summarizes a multi-stage pipeline and appends a (+N steps) counter", () => {
    // 3 stages → head label + 2 extra steps.
    expect(parseShellCommand("head -20 file.ts | sed -n '1,80p' | wc -l")).toBe(
      "show first 20 lines of file.ts (+2 steps)",
    );
  });

  it("summarizes a two-stage pipeline with (+1 steps)", () => {
    expect(parseShellCommand("cat a.txt | grep b")).toBe("show a.txt (+1 steps)");
  });

  it("falls back to a truncated command echo for an unknown utility", () => {
    expect(parseShellCommand("frobnicate --whatsit foo")).toBe("run `frobnicate`");
  });

  it("truncates very long single-token args so the label stays bounded", () => {
    const long = "a".repeat(500);
    const label = parseShellCommand(`cat ${long}.txt`);
    expect(label.length).toBeLessThanOrEqual(140);
  });

  it("does not use eval or dynamic code execution (returns inert text for shell metachars)", () => {
    // A command-substitution attempt is treated as literal text, never executed.
    const label = parseShellCommand("echo $(rm -rf /)");
    expect(typeof label).toBe("string");
    expect(label).not.toContain("undefined");
  });
});

describe("parseShellCommand — secret redaction in the produced label", () => {
  it("redacts a Bearer token that reaches the label through a grep pattern operand", () => {
    // grep's pattern operand flows straight into the label
    // (`search for \`<pattern>\``), so a secret-bearing pattern would leak.
    const label = parseShellCommand("grep 'Bearer abcdef0123456789abcdef' access.log");
    expect(label).not.toContain("abcdef0123456789abcdef");
    expect(label).toContain("<redacted>");
  });

  it("redacts an sk- API key that reaches the label through a grep pattern", () => {
    const label = parseShellCommand("grep sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA secrets.txt");
    expect(label).not.toContain("sk-ant-api03");
    expect(label).toContain("<redacted>");
  });

  it("redacts a ghp_* GitHub PAT that reaches the label through a grep pattern", () => {
    // `ghp_*` is a secret shape the shell-label cases must cover; the sibling
    // sk-/Bearer cases above did not.
    // The parser already masks it (it runs `redactValue`, whose
    // `SECRET_SHAPE_PATTERNS` includes `GITHUB_TOKEN_FULL` = /\bgh[pousr]_…/),
    // so this is a regression-lock for the named shape.
    // A neutral 36-char PAT body (NOT a real token, AGENTS.md §2.2).
    const pat = "ghp_" + "A".repeat(36);
    const label = parseShellCommand(`grep ${pat} audit.log`);
    expect(label).not.toContain(pat);
    expect(label).toContain("<redacted>");
  });

  it("leaves a benign command label unchanged (no spurious redaction)", () => {
    expect(parseShellCommand("head -n 20 file.txt")).toBe("show first 20 lines of file.txt");
    expect(parseShellCommand("grep foo .")).toBe("search for `foo` in .");
  });
});
