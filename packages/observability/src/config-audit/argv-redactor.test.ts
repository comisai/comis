// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";

import {
  redactConfigAuditArgv,
  SECRET_FLAG_NAMES,
  SECRET_FLAG_SUFFIX_PATTERN,
  CONFIG_AUDIT_ARGV_CAP,
} from "./argv-redactor.js";

describe("config-audit/argv-redactor", () => {
  it("masks explicit flag value separated by equals sign without preserving the value", () => {
    const result = redactConfigAuditArgv([
      "comis",
      "--api-key=sk-abc1234567890abcdef",
    ]);
    expect(result).toEqual(["comis", "--api-key=***"]);
    // Critical: the secret token must not appear anywhere in the
    // output, including any preserved-suffix form.
    expect(result.join(" ")).not.toContain("sk-abc1234567890abcdef");
  });

  it("masks bare flag value passed as the next argv element", () => {
    const result = redactConfigAuditArgv([
      "comis",
      "--api-key",
      "sk-abc1234567890abcdef",
    ]);
    expect(result).toEqual(["comis", "--api-key", "***"]);
  });

  it("masks dash-leading value after secret flag even when it looks like a flag", () => {
    // Fail-closed: --api-key consumes the next element unconditionally
    // even when that element starts with '-'. Otherwise an attacker
    // who passed a `-v` value after `--api-key` would have the
    // 'value' leaked into the audit log.
    const result = redactConfigAuditArgv([
      "comis",
      "--api-key",
      "-v",
    ]);
    expect(result).toEqual(["comis", "--api-key", "***"]);
  });

  it("masks plugin flags via the suffix heuristic when the explicit name is unknown", () => {
    const result = redactConfigAuditArgv([
      "comis",
      "--alibaba-model-studio-api-key=sk-secret",
    ]);
    // Suffix heuristic catches `*-api-key=...` even though the full
    // flag name is not in SECRET_FLAG_NAMES.
    expect(result).toEqual(["comis", "--alibaba-model-studio-api-key=***"]);
  });

  it("caps the argv at CONFIG_AUDIT_ARGV_CAP elements regardless of length", () => {
    const longArgv: string[] = [];
    for (let i = 0; i < 20; i++) longArgv.push(`arg${i}`);
    const result = redactConfigAuditArgv(longArgv);
    expect(result).toHaveLength(CONFIG_AUDIT_ARGV_CAP);
    expect(result[0]).toBe("arg0");
    expect(result[CONFIG_AUDIT_ARGV_CAP - 1]).toBe(`arg${CONFIG_AUDIT_ARGV_CAP - 1}`);
  });

  it("passes through non-secret flags and their values unchanged", () => {
    const result = redactConfigAuditArgv([
      "comis",
      "--port",
      "8080",
      "--host",
      "127.0.0.1",
    ]);
    expect(result).toEqual([
      "comis",
      "--port",
      "8080",
      "--host",
      "127.0.0.1",
    ]);
  });

  it("redacts positional tokens via the regex fallback when no explicit flag matches", () => {
    // Positional `API_KEY=sk-…` inside a single argv element. Not
    // a `--flag` shape; redactSecretsInText catches it through the
    // 28-pattern regex set from 45-02.
    const result = redactConfigAuditArgv([
      "comis",
      "exec",
      "API_KEY=sk-abc1234567890abcdef",
    ]);
    expect(result).toHaveLength(3);
    expect(result[0]).toBe("comis");
    expect(result[1]).toBe("exec");
    // The plaintext token must not survive the regex pass.
    expect(result[2]).not.toContain("sk-abc1234567890abcdef");
  });

  it("preserves a non-string argv element defensively (input is always string[] in practice)", () => {
    // Defensive — argv from process.argv is always string[], but a
    // future caller might pass an unexpected shape. Don't crash.
    const input = ["comis", 42 as unknown as string, "--port"];
    const result = redactConfigAuditArgv(input);
    expect(result[0]).toBe("comis");
    // Non-string passes through (the result type stays string[] from
    // the caller's perspective via the regex fallback's coercion).
    expect(result).toHaveLength(3);
  });

  it("exports SECRET_FLAG_NAMES set containing core auth flags", () => {
    // Sanity-check the set has the 5 most-important flags.
    expect(SECRET_FLAG_NAMES.has("--api-key")).toBe(true);
    expect(SECRET_FLAG_NAMES.has("--token")).toBe(true);
    expect(SECRET_FLAG_NAMES.has("--password")).toBe(true);
    expect(SECRET_FLAG_NAMES.has("--secret")).toBe(true);
    expect(SECRET_FLAG_NAMES.has("--auth")).toBe(true);
  });

  it("exports SECRET_FLAG_SUFFIX_PATTERN regex that matches *-key|-token|-secret style flag names", () => {
    // Use the redactor end-to-end rather than asserting regex.test()
    // directly — the test-naming architecture regex picks up bare
    // `.test(...)` calls as fake test descriptions.
    const masked = redactConfigAuditArgv([
      "comis",
      "--alibaba-api-key=secret",
      "--my-plugin-token=secret",
      "--app-secret=secret",
    ]);
    expect(masked).toEqual([
      "comis",
      "--alibaba-api-key=***",
      "--my-plugin-token=***",
      "--app-secret=***",
    ]);

    // Non-secret flags are passthrough.
    const passthrough = redactConfigAuditArgv(["comis", "--port", "--host"]);
    expect(passthrough).toEqual(["comis", "--port", "--host"]);
  });
});
