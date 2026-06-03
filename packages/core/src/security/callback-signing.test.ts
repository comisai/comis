// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import {
  signCallbackData,
  verifyCallbackData,
  renderCallbackData,
  parseCallbackData,
} from "./callback-signing.js";

// Fixed test secret + shortId so every assertion is deterministic. Neutral
// fixture per AGENTS.md §2.2 — generated once, never a real credential.
const SECRET = randomBytes(32).toString("base64url");
const SHORT_ID = "aZ09bY18cX27"; // 12 base62 chars

describe("signCallbackData", () => {
  it("produces the same HMAC for the same (secret, choice, shortId) inputs", () => {
    const a = signCallbackData(SECRET, "approve", SHORT_ID);
    const b = signCallbackData(SECRET, "approve", SHORT_ID);
    expect(a).toBe(b);
  });

  it("produces a 16-char base64url tag matching the [A-Za-z0-9_-] alphabet", () => {
    const hmac = signCallbackData(SECRET, "approve", SHORT_ID);
    expect(hmac).toMatch(/^[A-Za-z0-9_-]{16}$/);
  });

  it("produces a different HMAC when the choice changes", () => {
    const approve = signCallbackData(SECRET, "approve", SHORT_ID);
    const deny = signCallbackData(SECRET, "deny", SHORT_ID);
    expect(approve).not.toBe(deny);
  });

  it("produces a different HMAC when the shortId changes", () => {
    const a = signCallbackData(SECRET, "approve", SHORT_ID);
    const b = signCallbackData(SECRET, "approve", "ZZ09bY18cX27");
    expect(a).not.toBe(b);
  });

  it("produces a different HMAC when the secret changes", () => {
    const a = signCallbackData(SECRET, "approve", SHORT_ID);
    const b = signCallbackData(randomBytes(32).toString("base64url"), "approve", SHORT_ID);
    expect(a).not.toBe(b);
  });
});

describe("verifyCallbackData", () => {
  it("accepts a genuine signature produced by signCallbackData (roundtrip)", () => {
    const sig = signCallbackData(SECRET, "approve", SHORT_ID);
    expect(verifyCallbackData(SECRET, "approve", SHORT_ID, sig)).toBe(true);
  });

  it("rejects a signature whose single HMAC character was flipped", () => {
    const sig = signCallbackData(SECRET, "approve", SHORT_ID);
    const flipped = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
    expect(verifyCallbackData(SECRET, "approve", SHORT_ID, flipped)).toBe(false);
  });

  it("rejects when the choice differs from what was signed", () => {
    const sig = signCallbackData(SECRET, "approve", SHORT_ID);
    expect(verifyCallbackData(SECRET, "deny", SHORT_ID, sig)).toBe(false);
  });

  it("rejects when the shortId differs from what was signed", () => {
    const sig = signCallbackData(SECRET, "approve", SHORT_ID);
    expect(verifyCallbackData(SECRET, "approve", "ZZ09bY18cX27", sig)).toBe(false);
  });

  // timingSafeEqual THROWS on a length mismatch. The length-guard MUST
  // run first so a wrong-length provided tag returns false WITHOUT throwing.
  it("returns false for a too-short HMAC without throwing (length-guard)", () => {
    expect(() => verifyCallbackData(SECRET, "approve", SHORT_ID, "deadbeef")).not.toThrow();
    expect(verifyCallbackData(SECRET, "approve", SHORT_ID, "deadbeef")).toBe(false);
  });

  it("returns false for a too-long HMAC without throwing (length-guard)", () => {
    const tooLong = "A".repeat(20);
    expect(() => verifyCallbackData(SECRET, "approve", SHORT_ID, tooLong)).not.toThrow();
    expect(verifyCallbackData(SECRET, "approve", SHORT_ID, tooLong)).toBe(false);
  });

  it("returns false for an empty provided HMAC without throwing", () => {
    expect(() => verifyCallbackData(SECRET, "approve", SHORT_ID, "")).not.toThrow();
    expect(verifyCallbackData(SECRET, "approve", SHORT_ID, "")).toBe(false);
  });
});

describe("renderCallbackData", () => {
  it("renders v1.<choice>.<shortId>.<hmac> for a valid approve choice", () => {
    const result = renderCallbackData(SECRET, "approve", SHORT_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatch(/^v1\.approve\.aZ09bY18cX27\.[A-Za-z0-9_-]{16}$/);
  });

  it("embeds the same HMAC that signCallbackData produces", () => {
    const result = renderCallbackData(SECRET, "deny", SHORT_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(`v1.deny.${SHORT_ID}.${signCallbackData(SECRET, "deny", SHORT_ID)}`);
  });

  it("renders the deny and details choices as well", () => {
    for (const choice of ["approve", "deny", "details"] as const) {
      const result = renderCallbackData(SECRET, choice, SHORT_ID);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.startsWith(`v1.${choice}.${SHORT_ID}.`)).toBe(true);
    }
  });

  it("keeps the worst-case payload within the 64-byte Telegram budget", () => {
    const result = renderCallbackData(SECRET, "approve", SHORT_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(new TextEncoder().encode(result.value).length).toBeLessThan(64);
  });

  it("rejects an unknown choice with kind invalid_choice", () => {
    // @ts-expect-error — exercising the runtime guard with an out-of-union value
    const result = renderCallbackData(SECRET, "escalate", SHORT_ID);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("invalid_choice");
  });

  it("rejects a shortId that is not 12 chars with kind invalid_short_id", () => {
    const result = renderCallbackData(SECRET, "approve", "tooShort");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("invalid_short_id");
  });

  it("rejects a shortId with non-base62 characters with kind invalid_short_id", () => {
    const result = renderCallbackData(SECRET, "approve", "aZ09-Y18cX27");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("invalid_short_id");
  });
});

describe("parseCallbackData", () => {
  it("parses a well-formed v1.<choice>.<shortId>.<hmac> string", () => {
    const rendered = renderCallbackData(SECRET, "approve", SHORT_ID);
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    const parsed = parseCallbackData(rendered.value);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.choice).toBe("approve");
    expect(parsed.value.shortId).toBe(SHORT_ID);
    expect(parsed.value.hmac).toMatch(/^[A-Za-z0-9_-]{16}$/);
  });

  it("round-trips render → parse → verify against the signing secret", () => {
    const rendered = renderCallbackData(SECRET, "details", SHORT_ID);
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    const parsed = parseCallbackData(rendered.value);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(
      verifyCallbackData(SECRET, parsed.value.choice, parsed.value.shortId, parsed.value.hmac),
    ).toBe(true);
  });

  it("rejects a wrong version prefix as malformed", () => {
    const result = parseCallbackData(`v2.approve.${SHORT_ID}.AAAAAAAAAAAAAAAA`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("malformed");
  });

  it("rejects an unknown choice token as malformed", () => {
    const result = parseCallbackData(`v1.escalate.${SHORT_ID}.AAAAAAAAAAAAAAAA`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("malformed");
  });

  it("rejects a shortId of the wrong length as malformed", () => {
    const result = parseCallbackData("v1.approve.short.AAAAAAAAAAAAAAAA");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("malformed");
  });

  it("rejects an hmac with non-base64url characters as malformed", () => {
    const result = parseCallbackData(`v1.approve.${SHORT_ID}.AAAAAAAA.AAAAAAA`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("malformed");
  });

  it("rejects an hmac of the wrong length as malformed", () => {
    const result = parseCallbackData(`v1.approve.${SHORT_ID}.AAAA`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("malformed");
  });

  it("rejects a string with too many segments as malformed", () => {
    const result = parseCallbackData(`v1.approve.${SHORT_ID}.AAAAAAAAAAAAAAAA.extra`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("malformed");
  });

  it("rejects an empty string as malformed", () => {
    const result = parseCallbackData("");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("malformed");
  });
});

describe("callback-signing module purity (secret-leak guard)", () => {
  it("imports no logger or console — the secret and hmac never reach a log sink", async () => {
    // The primary guard is that the module is pure (functions take the secret
    // as an argument and never stringify it). Assert the source contains no
    // logger/console reference as a defense-in-depth check.
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const here = fileURLToPath(new URL("./callback-signing.ts", import.meta.url));
    const src = readFileSync(here, "utf8");
    // Strip comments first so prose ("imports no logger") never trips the
    // checks — only real code references to a log sink are forbidden.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/\bconsole\s*\./);
    expect(code).not.toMatch(/getLogger/);
    expect(code).not.toMatch(/\blogger\b/); // no logger identifier in code
    expect(code).not.toMatch(/@comis\/infra/);
  });
});
