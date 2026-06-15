// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the SEC-03 (Phase 192) raw-error log-redaction helper.
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
import { redactErr } from "./video-log-redaction.js";

describe("redactErr (SEC-03 raw-error scrub)", () => {
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
});
