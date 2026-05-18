// SPDX-License-Identifier: Apache-2.0
/**
 * `redactSecrets` structured-walker tests + `sanitizeForPersistence`
 * canonical pipeline.
 *
 * Design §5.3 + §5.5 behavior:
 *   - Object field whose key matches a credential-name suffix → value
 *     replaced by `maskToken(value)` (or `"***"` for non-string values
 *     since masking only applies to strings).
 *   - String fields piped through `redactSecretsInText`.
 *   - Arrays walked element-by-element.
 *   - Cyclic objects produce the `"[Circular]"` sentinel string at the
 *     back-edge.
 *   - Diagnostic strings like `Unrecognized key: "llm"` pass through
 *     unchanged (case-sensitive ENV regex; research §10).
 *
 * `sanitizeForPersistence = redactSecrets ∘ sanitizeDiagnosticPayload
 *   ∘ limitPayloadValue` — the canonical composition for "safe to write
 *   to disk" diagnostic artifacts (design §5.3.3).
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { redactSecrets, sanitizeForPersistence } from "./redact-secrets.js";

describe("redactSecrets — credential-keyed field masking", () => {
  it("masks the value of a top-level credential-keyed field", () => {
    const out = redactSecrets({ token: "sk-1234567890abcdef" }) as Record<string, unknown>;
    expect(out.token).not.toBe("sk-1234567890abcdef");
    expect(typeof out.token).toBe("string");
  });

  it("masks a credential-keyed field nested 3 levels deep", () => {
    const out = redactSecrets({
      outer: { inner: { token: "sk-1234567890abcdef" } },
    }) as { outer: { inner: { token: string } } };
    expect(out.outer.inner.token).not.toBe("sk-1234567890abcdef");
  });

  it("preserves a non-credential field name even when its value LOOKS secretive", () => {
    const out = redactSecrets({ username: "alice", count: 42 }) as Record<string, unknown>;
    expect(out.username).toBe("alice");
    expect(out.count).toBe(42);
  });

  it("walks arrays of objects and masks each element's credential fields", () => {
    const out = redactSecrets([
      { name: "a", token: "sk-1111111111111111" },
      { name: "b", token: "sk-2222222222222222" },
    ]) as Array<{ name: string; token: string }>;
    expect(out).toHaveLength(2);
    expect(out[0]!.token).not.toBe("sk-1111111111111111");
    expect(out[1]!.token).not.toBe("sk-2222222222222222");
    expect(out[0]!.name).toBe("a");
    expect(out[1]!.name).toBe("b");
  });

  it("respects the case-insensitive credential-name set (apiKey, API_KEY, apikey)", () => {
    const out = redactSecrets({
      apiKey: "sk-1234567890abcdef0",
      API_KEY: "sk-aaaa1111bbbb2222",
      apikey: "sk-cccc3333dddd4444",
    }) as Record<string, string>;
    expect(out.apiKey).not.toBe("sk-1234567890abcdef0");
    expect(out.API_KEY).not.toBe("sk-aaaa1111bbbb2222");
    expect(out.apikey).not.toBe("sk-cccc3333dddd4444");
  });
});

describe("redactSecrets — in-string credential redaction", () => {
  it("redacts a credential embedded in a free-text non-credential field", () => {
    const out = redactSecrets({
      logMessage: "Authorization: Bearer sk-1234567890abcdef rejected",
    }) as { logMessage: string };
    expect(out.logMessage.includes("sk-1234567890abcdef")).toBe(false);
    expect(out.logMessage.includes("rejected")).toBe(true);
  });

  it("leaves a diagnostic message 'Unrecognized key: \"llm\"' unchanged", () => {
    // Research §10 closing note: the case-sensitive ENV regex must not
    // match lowercase keys like "llm" in diagnostic strings.
    const out = redactSecrets({
      message: 'Unrecognized key: "llm" in config',
    }) as { message: string };
    expect(out.message).toBe('Unrecognized key: "llm" in config');
  });

  it("leaves primitive values unchanged", () => {
    expect(redactSecrets(42)).toBe(42);
    expect(redactSecrets(null)).toBe(null);
    expect(redactSecrets(true)).toBe(true);
  });

  it("redacts a credential embedded inside a string primitive", () => {
    const out = redactSecrets("token=ghp_abcdefghij12345678901234");
    expect(out).not.toContain("ghp_abcdefghij12345678901234");
  });
});

describe("redactSecrets — cycle guard", () => {
  it("returns the '[Circular]' sentinel at the back-edge of a cyclic object", () => {
    interface Cyclic {
      self?: Cyclic;
      label: string;
    }
    const a: Cyclic = { label: "root" };
    a.self = a; // create a real back-edge

    const out = redactSecrets(a) as { label: string; self: unknown };
    expect(out.label).toBe("root");
    expect(out.self).toBe("[Circular]");
  });

  it("handles cyclic arrays without infinite recursion", () => {
    const arr: unknown[] = ["a"];
    arr.push(arr); // self-reference
    const out = redactSecrets(arr) as unknown[];
    expect(out[0]).toBe("a");
    expect(out[1]).toBe("[Circular]");
  });
});

describe("sanitizeForPersistence — canonical pipeline", () => {
  it("composes limit + sanitize + redact in the documented order", () => {
    // Pipeline: limitPayloadValue -> sanitizeDiagnosticPayload -> redactSecrets.
    //
    // Inputs that flow through all three stages:
    //   - credential-keyed field (caught by sanitizeDiagnosticPayload drop +
    //     redactSecrets mask — sanitize drops first, redact has no value to mask)
    //   - free-text with a credential body (caught by redactSecrets)
    //   - benign field (passes through)
    const out = sanitizeForPersistence({
      apiKey: "sk-1234567890abcdef0",
      msg: "Authorization: Bearer sk-aaaaaaaaaaaaaaaaaaaa",
      benign: "alice",
    }) as Record<string, unknown>;

    // sanitizeDiagnosticPayload drops `apiKey` entirely (it's a credential
    // field-name in the sanitizer's CREDENTIAL_KEYS set).
    expect(Object.prototype.hasOwnProperty.call(out, "apiKey")).toBe(false);

    // redact-text catches the Bearer token inside the message.
    expect(typeof out.msg).toBe("string");
    expect((out.msg as string).includes("sk-aaaaaaaaaaaaaaaaaaaa")).toBe(false);

    // benign field survives.
    expect(out.benign).toBe("alice");
  });

  it("preserves the input shape for purely-benign values", () => {
    const out = sanitizeForPersistence({ user: "alice", count: 42 });
    expect(out).toEqual({ user: "alice", count: 42 });
  });
});
