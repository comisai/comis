// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the raw-error log-redaction helper.
 *
 * `redactErr` is the de-mask discipline the off-turn video poller applies before
 * a raw provider/channel error rides a log line: its free-text message can echo a
 * key / bearer / the Veo `&key=AIza…` download URL, which the Pino redact set
 * (credential-NAMED keys only) never scrubs. These cases prove the message is run
 * through sanitizeLogString, bounded, and the stack is dropped.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { redactErr, makeRedactErr } from "./video-log-redaction.js";

describe("redactErr (raw-error scrub)", () => {
  it("scrubs a Google API key (AIzaSy…) from the error message", () => {
    const secret = "AIzaSyAbCdEfGhIjKlMnOpQrStUvWxYz0123456";
    const out = redactErr(new Error(`download failed with key ${secret}`));
    expect(out.errMessage).not.toContain(secret);
    expect(out.errMessage).toContain("[REDACTED]");
  });

  it("scrubs the Veo keyed-download-URL key value (?…&key=AIza…)", () => {
    const secret = "AIzaSyAbCdEfGhIjKlMnOpQrStUvWxYz0123456";
    const url = `https://generativelanguage.googleapis.com/v1beta/files/x:download?alt=media&key=${secret}`;
    const out = redactErr(new Error(`fetch ${url}`));
    expect(out.errMessage).not.toContain(secret);
    expect(out.errMessage).not.toMatch(/key=AIza[A-Za-z0-9_-]{4,}/);
  });

  it("scrubs a Bearer token and an sk- key from the message", () => {
    const bearer = "Bearer sk-grok-9f8e7d6c5b4a32100123456789ab";
    const sk = "sk-proj-DEADBEEFcafef00dDEADBEEFcafef00dXY";
    const out = redactErr(new Error(`auth ${bearer} key ${sk}`));
    expect(out.errMessage).not.toContain("sk-grok-9f8e7d6c5b4a32100123456789ab");
    expect(out.errMessage).not.toContain(sk);
  });

  it("preserves the error name and a non-secret message verbatim", () => {
    const out = redactErr(new TypeError("the render exceeded the deadline"));
    expect(out.errName).toBe("TypeError");
    expect(out.errMessage).toBe("the render exceeded the deadline");
  });

  it("bounds a very long message to 1500 chars (no unbounded blob)", () => {
    const out = redactErr(new Error("x".repeat(5000)));
    expect(out.errMessage.length).toBe(1500);
  });

  it("never emits the stack (a stack can also carry a URL/secret)", () => {
    const out = redactErr(new Error("boom"));
    expect(out).toEqual({ errName: "Error", errMessage: "boom" });
    expect("stack" in out).toBe(false);
  });

  // ─── DE-MASK: three real leaks a top-level-only scrub misses ───
  // A top-level-only scrub covers only a secret shape in the TOP-LEVEL .message.
  // The poller feeds `redactErr` the RAW provider error, and the realistic failure
  // mode is an undici `TypeError("fetch failed")` whose network/URL detail lives in
  // `err.cause` — so the cause chain MUST be walked. And a FAL key is shaped
  // `<uuid>:<32hex>`, which NO generic pattern catches.

  it("scrubs a Google API key carried in err.cause.message (cause chain, not top-level)", () => {
    // undici surfaces a low-level failure as TypeError("fetch failed") whose
    // .cause carries the real (keyed-URL-bearing) detail. The old redactErr read
    // only the top message → the cause (and any secret in it) was silently dropped.
    const secret = "AIzaSyAbCdEfGhIjKlMnOpQrStUvWxYz0123456";
    const cause = new Error(`getaddrinfo ENOTFOUND host key=${secret}`);
    const out = redactErr(new Error("fetch failed", { cause }));
    expect(out.errMessage).not.toContain(secret);
    // §2.7: the failure-CLASS detail in the cause must SURVIVE redaction —
    // an operator must still tell a DNS failure from a refused connection.
    expect(out.errMessage).toContain("ENOTFOUND");
    expect(out.errMessage).toContain("fetch failed");
  });

  it("scrubs a FAL key shape (<uuid>:<32hex>) the generic patterns miss", () => {
    // A FAL FAL_KEY is `<uuid>:<32hex>`. The UUID half has hyphens (breaks a hex
    // run) and the hex half is ~32 chars (< the 40-char HEX_SECRET_LONG floor),
    // so it is not sk-/Bearer/AIza/long-hex — every existing pattern misses it.
    const falKey = "b1946ac9-2c7f-4d3e-8a1b-9f8e7d6c5b4a:9f8e7d6c5b4a32109f8e7d6c5b4a3210";
    const out = redactErr(new Error(`FAL submit rejected key=${falKey}`));
    expect(out.errMessage).not.toContain(falKey);
    // also when the FAL key half-strings appear bare (the hex tail alone).
    expect(out.errMessage).not.toContain("9f8e7d6c5b4a32109f8e7d6c5b4a3210");
  });

  it("scrubs the Veo keyed-download-URL (&key=) when it lives inside a cause chain", () => {
    const secret = "AIzaSyAbCdEfGhIjKlMnOpQrStUvWxYz0123456";
    const url = `https://generativelanguage.googleapis.com/v1beta/files/x:download?alt=media&key=${secret}`;
    const inner = new Error(`download leg failed for ${url}`);
    const out = redactErr(new Error("fetch failed", { cause: inner }));
    expect(out.errMessage).not.toContain(secret);
    expect(out.errMessage).not.toMatch(/key=AIza[A-Za-z0-9_-]{4,}/);
  });

  it("bounded cause walk — a deep chain does not loop and still scrubs every level", () => {
    const secret = "sk-proj-DEADBEEFcafef00dDEADBEEFcafef00dXY";
    // Build a 6-deep chain (deeper than MAX_CAUSE_DEPTH) with the secret at the
    // bottom — the walk is bounded, so the deepest level may be unwalked, but no
    // walked level may leak and the call must terminate.
    let e: Error = new Error(`leaf ${secret}`);
    for (let i = 0; i < 5; i++) e = new Error(`wrap-${i}`, { cause: e });
    const out = redactErr(e);
    expect(out.errMessage).toContain("wrap-4");
    // The depth bound means the leaf may not be walked — but if it WAS reached it
    // must be scrubbed. Either way the secret must never appear verbatim.
    expect(out.errMessage).not.toContain(secret);
  });

  it("a non-Error cause (string) terminates the walk without throwing", () => {
    const out = redactErr(new Error("fetch failed", { cause: "some string cause" }));
    expect(out.errName).toBe("Error");
    expect(out.errMessage).toContain("fetch failed");
  });
});

describe("redactErr — exact-match bound-secret scrub (the knownSecrets precedent)", () => {
  it("scrubs a bound FAL secret by EXACT MATCH regardless of shape/context", () => {
    // The robust, shape-independent fix: bind the RESOLVED video secrets actually
    // in use and exact-match-scrub them. This catches ANY shape (incl. future ones)
    // without a regex guessing the format — the OutputGuard knownSecrets idiom.
    const falKey = "b1946ac9-2c7f-4d3e-8a1b-9f8e7d6c5b4a:9f8e7d6c5b4a32109f8e7d6c5b4a3210";
    const redact = makeRedactErr([falKey]);
    const out = redact(new Error(`provider error mentioning ${falKey} verbatim`));
    expect(out.errMessage).not.toContain(falKey);
    expect(out.errMessage).toContain("provider error mentioning");
  });

  it("scrubs a bound secret found in err.cause.message", () => {
    const xaiKey = "xai-9f8e7d6c5b4a32100123456789abXYZ0123456789";
    const redact = makeRedactErr([xaiKey]);
    const out = redact(new Error("fetch failed", { cause: new Error(`auth ${xaiKey}`) }));
    expect(out.errMessage).not.toContain(xaiKey);
  });

  it("absent bound secrets (empty list) falls back to pattern scrub with no crash", () => {
    const redact = makeRedactErr([]);
    const secret = "AIzaSyAbCdEfGhIjKlMnOpQrStUvWxYz0123456";
    const out = redact(new Error(`key ${secret}`));
    expect(out.errMessage).not.toContain(secret);
  });

  it("ignores a too-short / empty bound value so it never redacts ordinary text", () => {
    const redact = makeRedactErr(["", "ab", "  "]);
    const out = redact(new Error("the render exceeded the deadline"));
    expect(out.errMessage).toBe("the render exceeded the deadline");
  });

  it("does NOT leak the bound secret list itself anywhere in the output", () => {
    const falKey = "b1946ac9-2c7f-4d3e-8a1b-9f8e7d6c5b4a:9f8e7d6c5b4a32109f8e7d6c5b4a3210";
    const redact = makeRedactErr([falKey]);
    const out = redact(new Error("a benign message"));
    expect(JSON.stringify(out)).not.toContain(falKey);
  });
});
