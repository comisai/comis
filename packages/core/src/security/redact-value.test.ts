// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for redactValue() — the pure, bounded redaction primitive.
 *
 * This is the SEC-01/02/03 keystone (AGENT-TRANSPARENCY-SPEC §10.1/§10.2):
 *   - SEC-01: no secrets ever (9 Pino keys + secret shapes → `<redacted>`).
 *   - SEC-02: no absolute paths ($HOME → ~, system-absolute → last 2 segments);
 *             IP / hostname / MAC masked.
 *   - SEC-03: PII (email / phone / CC / SSN) masked.
 *
 * The replacement token is the lowercase-angle `<redacted>` (Pitfall 5 —
 * NOT `[REDACTED]` like the log sanitizer).
 */

import { describe, it, expect } from "vitest";
import {
  redactValue,
  REDACT_LIMITS,
  type RedactionReason,
  type RedactedValue,
} from "./redact-value.js";

const REDACTED = "<redacted>";

/** The 9 secret keys mirrored from the CLAUDE.md "Pino auto-redacts" list (SEC-01). */
const SECRET_KEYS = [
  "apiKey",
  "token",
  "password",
  "secret",
  "authorization",
  "botToken",
  "privateKey",
  "cookie",
  "webhookSecret",
] as const;

function reasons(result: RedactedValue): RedactionReason[] {
  return result.redactionsApplied.map((r) => r.reason);
}

describe("redactValue — token literal (Pitfall 5)", () => {
  it("emits the lowercase-angle <redacted> token, NOT [REDACTED]", () => {
    const out = redactValue({ apiKey: "hunter2" });
    const value = out.value as Record<string, unknown>;
    expect(value.apiKey).toBe("<redacted>");
    expect(value.apiKey).not.toBe("[REDACTED]");
    expect(JSON.stringify(out.value)).not.toContain("[REDACTED]");
  });
});

describe("redactValue — SEC-01 key-based redaction (one assertion per Pino key)", () => {
  for (const key of SECRET_KEYS) {
    it(`redacts the value under \`${key}\` to <redacted> with reason secret_key`, () => {
      const out = redactValue({ [key]: "any-secret-material-12345" });
      const value = out.value as Record<string, unknown>;
      expect(value[key]).toBe(REDACTED);
      expect(reasons(out)).toContain("secret_key");
      expect(out.redactionsApplied.some((r) => r.key === key && r.reason === "secret_key")).toBe(
        true,
      );
    });
  }

  it("matches secret keys case-insensitively (APIKEY, ApiKey, Authorization)", () => {
    const out = redactValue({ APIKEY: "x", ApiKey: "y", Authorization: "Bearer z" });
    const value = out.value as Record<string, unknown>;
    expect(value.APIKEY).toBe(REDACTED);
    expect(value.ApiKey).toBe(REDACTED);
    expect(value.Authorization).toBe(REDACTED);
  });

  it("redacts a secret key regardless of its (non-string) value shape", () => {
    const out = redactValue({ token: { nested: "structure", with: ["arrays"] } });
    const value = out.value as Record<string, unknown>;
    expect(value.token).toBe(REDACTED);
    expect(reasons(out)).toContain("secret_key");
  });

  it("leaves a benign key with benign content untouched", () => {
    const out = redactValue({ name: "my-mcp-server" });
    const value = out.value as Record<string, unknown>;
    expect(value.name).toBe("my-mcp-server");
    expect(out.redactionsApplied).toHaveLength(0);
    expect(out.truncated).toBe(false);
  });
});

describe("redactValue — SEC-01 shape-based redaction (secret caught under a benign key)", () => {
  it("redacts an Anthropic key (sk-ant-...) embedded under a benign key", () => {
    const out = redactValue({ note: "use sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA now" });
    const value = out.value as Record<string, unknown>;
    expect(value.note).toContain(REDACTED);
    expect(value.note).not.toContain("sk-ant-api03");
    expect(reasons(out)).toContain("secret_shape");
  });

  it("redacts a GitHub token (ghp_...) under a benign key", () => {
    const out = redactValue({ note: "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" });
    const value = out.value as Record<string, unknown>;
    expect(value.note).toContain(REDACTED);
    expect(value.note).not.toContain("ghp_AAAA");
    expect(reasons(out)).toContain("secret_shape");
  });

  it("redacts a JWT triple (aaa.bbb.ccc shaped) under a benign key", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const out = redactValue({ note: `bearer ${jwt}` });
    const value = out.value as Record<string, unknown>;
    expect(value.note).toContain(REDACTED);
    expect(value.note).not.toContain("eyJhbGci");
    expect(reasons(out)).toContain("secret_shape");
  });

  it("redacts an AWS access key id (AKIA...) under a benign key", () => {
    const out = redactValue({ note: "key AKIAIOSFODNN7EXAMPLE here" });
    const value = out.value as Record<string, unknown>;
    expect(value.note).toContain(REDACTED);
    expect(value.note).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(reasons(out)).toContain("secret_shape");
  });
});

describe("redactValue — SEC-02 absolute path COMPACTION (not stripping)", () => {
  it("compacts a $HOME-rooted path to ~ (preserving the trailing segments)", () => {
    const out = redactValue(
      { path: "/Users/alice/.comis/config.yaml" },
      { homeDir: "/Users/alice" },
    );
    const value = out.value as Record<string, unknown>;
    expect(value.path).toContain("~/.comis/config.yaml");
    expect(value.path).not.toContain("/Users/alice");
    expect(reasons(out)).toContain("absolute_path");
  });

  it("compacts a system-absolute path to its last 2 segments", () => {
    const out = redactValue({ path: "/var/folders/xy/T/tmpfile" });
    const value = out.value as Record<string, unknown>;
    expect(value.path).toContain("T/tmpfile");
    expect(value.path).not.toContain("/var/folders/xy");
    expect(reasons(out)).toContain("absolute_path");
  });

  it("leaves a relative path unchanged", () => {
    const out = redactValue({ path: "./foo/bar.ts" });
    const value = out.value as Record<string, unknown>;
    expect(value.path).toBe("./foo/bar.ts");
    expect(reasons(out)).not.toContain("absolute_path");
  });

  it("compaction wins over stripping — the home root never appears verbatim", () => {
    const out = redactValue(
      { detail: "loaded /home/bob/.comis/agents/x.md" },
      { homeDir: "/home/bob" },
    );
    const value = out.value as Record<string, unknown>;
    expect(value.detail).toContain("~");
    expect(value.detail).not.toContain("/home/bob");
  });
});

describe("redactValue — SEC-02 network identifiers", () => {
  it("masks an IPv4 address", () => {
    const out = redactValue({ host: "connect to 10.0.0.5 please" });
    const value = out.value as Record<string, unknown>;
    expect(value.host).not.toContain("10.0.0.5");
    expect(value.host).toContain(REDACTED);
    expect(reasons(out)).toContain("network_identifier");
  });

  it("masks a hostname-shaped string", () => {
    const out = redactValue({ host: "db-primary.internal.example.com" });
    const value = out.value as Record<string, unknown>;
    expect(value.host).toContain(REDACTED);
    expect(reasons(out)).toContain("network_identifier");
  });

  it("masks a MAC-address-shaped string", () => {
    const out = redactValue({ iface: "01:23:45:67:89:ab" });
    const value = out.value as Record<string, unknown>;
    expect(value.iface).not.toContain("01:23:45:67:89:ab");
    expect(value.iface).toContain(REDACTED);
    expect(reasons(out)).toContain("network_identifier");
  });
});

describe("redactValue — SEC-03 PII masks", () => {
  it("masks an email address", () => {
    const out = redactValue({ contact: "reach a@b.com today" });
    const value = out.value as Record<string, unknown>;
    expect(value.contact).not.toContain("a@b.com");
    expect(value.contact).toContain(REDACTED);
    expect(reasons(out)).toContain("pii_email");
  });

  it("masks a phone number", () => {
    const out = redactValue({ contact: "+1 555 123 4567" });
    const value = out.value as Record<string, unknown>;
    expect(value.contact).not.toContain("555 123 4567");
    expect(value.contact).toContain(REDACTED);
    expect(reasons(out)).toContain("pii_phone");
  });

  it("masks a credit-card-shaped number", () => {
    const out = redactValue({ card: "4111 1111 1111 1111" });
    const value = out.value as Record<string, unknown>;
    expect(value.card).not.toContain("4111 1111 1111 1111");
    expect(value.card).toContain(REDACTED);
    expect(reasons(out)).toContain("pii_credit_card");
  });

  it("masks an SSN-shaped number", () => {
    const out = redactValue({ ssn: "123-45-6789" });
    const value = out.value as Record<string, unknown>;
    expect(value.ssn).not.toContain("123-45-6789");
    expect(value.ssn).toContain(REDACTED);
    expect(reasons(out)).toContain("pii_ssn");
  });
});

describe("redactValue — purity, no-throw, scalar pass-through", () => {
  it.each([
    ["number", 42],
    ["zero", 0],
    ["boolean true", true],
    ["boolean false", false],
    ["null", null],
    ["undefined", undefined],
  ])("returns %s unchanged with empty redactionsApplied and never throws", (_label, input) => {
    const out = redactValue(input);
    expect(out.value).toBe(input);
    expect(out.redactionsApplied).toHaveLength(0);
    expect(out.truncated).toBe(false);
  });

  it("returns a benign top-level string unchanged", () => {
    const out = redactValue("just a normal label");
    expect(out.value).toBe("just a normal label");
    expect(out.redactionsApplied).toHaveLength(0);
  });

  it("never throws on a hostile / unusual input", () => {
    expect(() => redactValue(Symbol("x") as unknown)).not.toThrow();
    expect(() => redactValue(() => 0)).not.toThrow();
    expect(() => redactValue(BigInt(10))).not.toThrow();
  });
});

describe("redactValue — immutability + cycle guard", () => {
  it("does not mutate the input object", () => {
    const input = { apiKey: "secret", path: "/Users/alice/x", nested: { token: "t" } };
    const snapshot = JSON.parse(JSON.stringify(input));
    redactValue(input, { homeDir: "/Users/alice" });
    expect(input).toEqual(snapshot);
  });

  it("does not infinite-loop on a cyclic object", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    expect(() => redactValue(a)).not.toThrow();
    const out = redactValue(a);
    expect(out.value).toBeDefined();
  });

  it("does not mutate a nested array input", () => {
    const input = { items: ["sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA", "ok"] };
    redactValue(input);
    expect(input.items[0]).toBe("sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA");
  });
});

describe("redactValue — REDACT_LIMITS bounds", () => {
  it("exposes the §10.1 limits", () => {
    expect(REDACT_LIMITS.maxDepth).toBe(4);
    expect(REDACT_LIMITS.maxKeysPerLevel).toBe(16);
    expect(REDACT_LIMITS.maxArrayLength).toBe(32);
    expect(REDACT_LIMITS.maxTotalBytes).toBe(4096);
  });

  it("truncates over-long arrays at maxArrayLength and flags truncated", () => {
    const big = Array.from({ length: 100 }, (_v, i) => `item-${i}`);
    const out = redactValue({ list: big });
    const value = out.value as Record<string, unknown>;
    expect((value.list as unknown[]).length).toBeLessThanOrEqual(REDACT_LIMITS.maxArrayLength);
    expect(out.truncated).toBe(true);
    expect(reasons(out)).toContain("array_truncated");
  });

  it("caps object keys at maxKeysPerLevel and flags truncated", () => {
    const wide: Record<string, unknown> = {};
    for (let i = 0; i < 40; i++) wide[`k${i}`] = i;
    const out = redactValue(wide);
    const value = out.value as Record<string, unknown>;
    expect(Object.keys(value).length).toBeLessThanOrEqual(REDACT_LIMITS.maxKeysPerLevel);
    expect(out.truncated).toBe(true);
    expect(reasons(out)).toContain("keys_exceeded");
  });

  it("bounds recursion at maxDepth and flags truncated", () => {
    // Build an object nested deeper than maxDepth.
    let deep: Record<string, unknown> = { leaf: "x" };
    for (let i = 0; i < 10; i++) deep = { child: deep };
    const out = redactValue(deep);
    expect(out.truncated).toBe(true);
    expect(reasons(out)).toContain("depth_exceeded");
    expect(() => JSON.stringify(out.value)).not.toThrow();
  });

  it("flags bytes_exceeded when the total serialized budget is blown", () => {
    const huge = { blob: "x".repeat(8192) };
    const out = redactValue(huge);
    expect(out.truncated).toBe(true);
    expect(reasons(out)).toContain("bytes_exceeded");
  });

  it("short-circuits an oversized single string (ReDoS guard) without throwing", () => {
    const giant = "a".repeat(2_000_000);
    expect(() => redactValue({ blob: giant })).not.toThrow();
  });
});

describe("redactValue — recursive descent applies redaction at depth", () => {
  it("redacts a secret key nested inside an object/array tree", () => {
    const out = redactValue({ config: { servers: [{ apiKey: "leak" }] } });
    const value = out.value as { config: { servers: Array<Record<string, unknown>> } };
    expect(value.config.servers[0].apiKey).toBe(REDACTED);
    expect(reasons(out)).toContain("secret_key");
  });

  it("redacts a secret SHAPE nested inside an array element", () => {
    const out = redactValue({ notes: ["all good", "token ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"] });
    const value = out.value as { notes: string[] };
    expect(value.notes[1]).toContain(REDACTED);
    expect(value.notes[0]).toBe("all good");
  });
});
