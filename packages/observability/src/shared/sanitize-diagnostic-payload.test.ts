// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";

import { sanitizeDiagnosticPayload } from "./sanitize-diagnostic-payload.js";

describe("sanitizeDiagnosticPayload — credential field-name drop", () => {
  it("drops a field literally named 'password'", () => {
    const input = { user: "alice", password: "hunter2" };
    expect(sanitizeDiagnosticPayload(input)).toEqual({ user: "alice" });
  });

  it("drops a field literally named 'apiKey'", () => {
    const input = { provider: "openai", apiKey: "sk-secret" };
    expect(sanitizeDiagnosticPayload(input)).toEqual({ provider: "openai" });
  });

  it("drops 'token', 'secret', 'authorization', 'cookie', 'privateKey' (case-insensitive)", () => {
    const input = {
      keep: "ok",
      Token: "t1",
      SECRET: "s1",
      authorization: "a1",
      Cookie: "c1",
      privateKey: "p1",
    };
    expect(sanitizeDiagnosticPayload(input)).toEqual({ keep: "ok" });
  });

  it("PRESERVES allowlisted non-credential names that contain credential substrings — 'passwordfile' is configuration metadata", () => {
    const input = { passwordFile: "/etc/secrets/db.pw", normal: "ok" };
    expect(sanitizeDiagnosticPayload(input)).toEqual({
      passwordFile: "/etc/secrets/db.pw",
      normal: "ok",
    });
  });

  it("PRESERVES allowlisted 'tokenBudget' — limit configuration is not a credential", () => {
    const input = { tokenBudget: 8192, normal: "ok" };
    expect(sanitizeDiagnosticPayload(input)).toEqual({
      tokenBudget: 8192,
      normal: "ok",
    });
  });

  it("PRESERVES allowlisted 'tokenCount' — usage telemetry is not a credential", () => {
    const input = { tokenCount: 412, normal: "ok" };
    expect(sanitizeDiagnosticPayload(input)).toEqual({
      tokenCount: 412,
      normal: "ok",
    });
  });
});

describe("sanitizeDiagnosticPayload — name/value pair shape", () => {
  it("drops a name/value pair when name matches a credential key (case-insensitive)", () => {
    const input = { name: "api_key", value: "sk-secret" };
    expect(sanitizeDiagnosticPayload(input)).toEqual({
      name: "api_key",
      value: "<redacted>",
    });
  });

  it("preserves a name/value pair when name is a regular config key", () => {
    const input = { name: "timeoutMs", value: 5000 };
    expect(sanitizeDiagnosticPayload(input)).toEqual(input);
  });
});

describe("sanitizeDiagnosticPayload — image base-64 → sha256 + format (Comis improvement)", () => {
  it("replaces a base64-encoded image with sha256+bytes+format, preserving the mimeType in 'format'", () => {
    // 10 bytes of "image" pretend payload
    const raw = Buffer.from("imagebytes", "utf8");
    const b64 = raw.toString("base64");
    const expectedSha = createHash("sha256").update(raw).digest("hex");
    const input = {
      kind: "image",
      mimeType: "image/png",
      data: b64,
    };
    const result = sanitizeDiagnosticPayload(input) as Record<string, unknown>;
    expect(result["kind"]).toBe("image");
    expect(result["data"]).toEqual({
      placeholder: "<redacted>",
      bytes: raw.length,
      sha256: expectedSha,
      format: "image/png",
    });
  });

  it("recognizes 'media_type' as an alias for the image format key", () => {
    const raw = Buffer.from("jpegjpeg", "utf8");
    const b64 = raw.toString("base64");
    const input = { media_type: "image/jpeg", data: b64 };
    const result = sanitizeDiagnosticPayload(input) as Record<string, unknown>;
    expect((result["data"] as Record<string, unknown>)["format"]).toBe(
      "image/jpeg",
    );
  });

  it("recognizes 'mime_type' as an alias for the image format key", () => {
    const raw = Buffer.from("webpwebp", "utf8");
    const b64 = raw.toString("base64");
    const input = { mime_type: "image/webp", data: b64 };
    const result = sanitizeDiagnosticPayload(input) as Record<string, unknown>;
    expect((result["data"] as Record<string, unknown>)["format"]).toBe(
      "image/webp",
    );
  });
});

describe("sanitizeDiagnosticPayload — in-string credential regex (passthrough)", () => {
  it("replaces an Authorization: Bearer <jwt> substring inside a free-text field with <redacted>", () => {
    const input = {
      msg: "Got reply with header Authorization: Bearer eyJabcDEF123.payload.sig OK",
    };
    const result = sanitizeDiagnosticPayload(input) as Record<string, unknown>;
    expect(String(result["msg"]).includes("eyJabcDEF123")).toBe(false);
    expect(String(result["msg"]).includes("<redacted>")).toBe(true);
  });

  it("replaces a bare JWT (3-segment dotted base64) substring inside a free-text field", () => {
    const input = {
      msg: "Token captured: eyJabcDEF.payload12345.signatureXYZ in flight",
    };
    const result = sanitizeDiagnosticPayload(input) as Record<string, unknown>;
    expect(String(result["msg"]).includes("eyJabcDEF.payload12345")).toBe(
      false,
    );
    expect(String(result["msg"]).includes("<redacted>")).toBe(true);
  });

  it("replaces a Set-Cookie value substring inside a free-text field", () => {
    const input = {
      msg: "Response had Cookie: session=abcd1234efgh5678 and continued",
    };
    const result = sanitizeDiagnosticPayload(input) as Record<string, unknown>;
    expect(String(result["msg"]).includes("abcd1234efgh5678")).toBe(false);
    expect(String(result["msg"]).includes("<redacted>")).toBe(true);
  });

  it("does NOT touch a string with no credential pattern", () => {
    const input = { msg: "Hello world, this is a normal log line." };
    expect(sanitizeDiagnosticPayload(input)).toEqual(input);
  });

  it("preserves diagnostic strings that match a case-sensitive ENV regex like 'Unrecognized key: \"llm\"'", () => {
    // The Comis case-sensitive ENV regex is uppercase-only (`[A-Z][A-Z0-9_]+`),
    // so lowercase keys ("llm") and the surrounding diagnostic must pass through
    // unchanged — research §10 closing note.
    const input = { msg: 'Unrecognized key: "llm"' };
    expect(sanitizeDiagnosticPayload(input)).toEqual(input);
  });
});

describe("sanitizeDiagnosticPayload — cycle guard returns [Circular]", () => {
  it("emits the literal '[Circular]' string in place of a back-edge inside an object", () => {
    const node: Record<string, unknown> = { v: 1 };
    node["self"] = node;
    const result = sanitizeDiagnosticPayload(node) as Record<string, unknown>;
    expect(result["v"]).toBe(1);
    expect(result["self"]).toBe("[Circular]");
  });

  it("emits the literal '[Circular]' in place of a back-edge through two objects", () => {
    const a: Record<string, unknown> = { name: "a" };
    const b: Record<string, unknown> = { name: "b" };
    a["next"] = b;
    b["back"] = a;
    const result = sanitizeDiagnosticPayload(a) as Record<string, unknown>;
    expect(result["name"]).toBe("a");
    const stepB = result["next"] as Record<string, unknown>;
    expect(stepB["name"]).toBe("b");
    expect(stepB["back"]).toBe("[Circular]");
  });
});

describe("sanitizeDiagnosticPayload — passthrough for non-credential / non-image inputs", () => {
  it("passes through null, number, boolean, and plain-string primitives unchanged", () => {
    expect(sanitizeDiagnosticPayload(null)).toBeNull();
    expect(sanitizeDiagnosticPayload(42)).toBe(42);
    expect(sanitizeDiagnosticPayload(true)).toBe(true);
    expect(sanitizeDiagnosticPayload("plain")).toBe("plain");
  });

  it("passes through an array of plain objects unchanged when no element matches a credential or image rule", () => {
    expect(
      sanitizeDiagnosticPayload([{ a: 1 }, { b: 2 }]),
    ).toEqual([{ a: 1 }, { b: 2 }]);
  });
});
