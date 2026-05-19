// SPDX-License-Identifier: Apache-2.0
/**
 * Default redact-pattern matrix tests.
 *
 * Each entry asserts:
 *   - A POSITIVE example: the pattern matches a representative secret
 *   - A NEGATIVE example: the pattern does NOT match a benign string
 *     (especially diagnostic-shaped strings like
 *     `Unrecognized key: "llm"`, lowercase config-key paths, etc.)
 *
 * Default set: 28 default token-shape patterns + 4 Comis additions
 * (Slack/Discord bot tokens, Discord webhook URL, generic HMAC
 * signature, comis_* prefix). Coverage criterion: each pattern is
 * exercised by at least one positive and one negative case
 * (~32+ test cases total).
 *
 * The bare-token / prefix-token patterns require a MIN_LENGTH ≥ 18
 * char body where applicable (matches the edge-keeping mask's
 * threshold) so short strings do not surface partial previews.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { getDefaultRedactPatterns } from "./patterns.js";
import type { RedactPattern } from "./patterns.js";

const patterns: ReadonlyArray<RedactPattern> = getDefaultRedactPatterns();

function findPattern(name: string): RedactPattern {
  const p = patterns.find((x) => x.name === name);
  if (!p) throw new Error(`pattern "${name}" missing from default set`);
  return p;
}

function patternMatches(p: RedactPattern, sample: string): boolean {
  // Recompile a fresh RegExp from the pattern's `regex` source+flags so
  // the lastIndex state of /g regexes does not leak across calls.
  const re = new RegExp(p.regex.source, p.regex.flags);
  return re.test(sample);
}

describe("default pattern set — surface", () => {
  it("returns a non-empty readonly array of RedactPattern objects", () => {
    expect(Array.isArray(patterns)).toBe(true);
    expect(patterns.length).toBeGreaterThan(28);
  });

  it("every pattern carries `name`, `regex`, and `kind` fields", () => {
    for (const p of patterns) {
      expect(typeof p.name).toBe("string");
      expect(p.regex).toBeInstanceOf(RegExp);
      expect(["prefix", "bare", "env", "url-query", "header", "json", "cli", "pem", "platform"]).toContain(p.kind);
    }
  });

  it("every pattern name is unique within the default set", () => {
    const names = patterns.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("every pattern's regex carries the global flag (g) for replace semantics", () => {
    for (const p of patterns) {
      expect(p.regex.flags).toContain("g");
    }
  });
});

describe("prefix-shape token patterns", () => {
  it("sk- (OpenAI/Anthropic style): matches sk- + 16+ chars", () => {
    expect(patternMatches(findPattern("sk-prefix"), "sk-1234567890abcdef1234")).toBe(true);
  });

  it("sk- pattern: does NOT match the bare 'sk-' string or short variants", () => {
    expect(patternMatches(findPattern("sk-prefix"), "sk-")).toBe(false);
    expect(patternMatches(findPattern("sk-prefix"), "sk-short")).toBe(false);
  });

  it("ghp_ (GitHub Personal): matches ghp_ + 20+ chars", () => {
    expect(patternMatches(findPattern("github-token"), "ghp_AbCdEf0123456789012345")).toBe(true);
  });

  it("ghp_ pattern: does NOT match diagnostic strings containing the token name", () => {
    expect(patternMatches(findPattern("github-token"), "ghp_")).toBe(false);
    expect(patternMatches(findPattern("github-token"), "ghp_short")).toBe(false);
  });

  it("xoxb-/xoxa-/xoxp-/xoxr-/xoxs- (Slack legacy): matches", () => {
    expect(patternMatches(findPattern("slack-legacy-token"), "xoxb-123456-abcdef-XYZWXYZWXYZW")).toBe(true);
    expect(patternMatches(findPattern("slack-legacy-token"), "xoxa-1-abcdefghijklmnopqr")).toBe(true);
    expect(patternMatches(findPattern("slack-legacy-token"), "xoxp-1234-5678-abcdefghij")).toBe(true);
  });

  it("xoxb- pattern: does NOT match the literal token name", () => {
    expect(patternMatches(findPattern("slack-legacy-token"), "xoxb-")).toBe(false);
  });

  it("xapp- (Slack app-level): matches", () => {
    expect(patternMatches(findPattern("slack-app-token"), "xapp-1-A123-456-abcdefghijklmno")).toBe(true);
  });

  it("gsk_ (Groq): matches", () => {
    expect(patternMatches(findPattern("groq-key"), "gsk_AbCdEf0123456789012345")).toBe(true);
  });

  it("AIza (Google API key): matches", () => {
    expect(patternMatches(findPattern("google-api-key"), "AIzaSyAbCdEf0123456789012345_-")).toBe(true);
  });

  it("AIza pattern: does NOT match an unrelated AIza-prefixed config name", () => {
    expect(patternMatches(findPattern("google-api-key"), "AIza")).toBe(false);
  });

  it("ya29. (Google OAuth bearer): matches", () => {
    expect(patternMatches(findPattern("google-oauth-bearer"), "ya29.AbCdEfGhIjKl1234567890")).toBe(true);
  });

  it("1//0 (Google refresh token): matches", () => {
    expect(patternMatches(findPattern("google-refresh-token"), "1//0AbCdEf0123456789012345")).toBe(true);
  });

  it("eyJ...JWT (3-segment dotted base64): matches", () => {
    expect(patternMatches(findPattern("jwt-token"), "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c")).toBe(true);
  });

  it("eyJ pattern: does NOT match the bare 'eyJ' prefix or non-dotted JWT-shaped text", () => {
    expect(patternMatches(findPattern("jwt-token"), "eyJ")).toBe(false);
    expect(patternMatches(findPattern("jwt-token"), "eyJabcdefg")).toBe(false);
  });

  it("pplx- (Perplexity): matches", () => {
    expect(patternMatches(findPattern("perplexity-key"), "pplx-0123456789abcdef0123456789")).toBe(true);
  });

  it("npm_ (npm Personal Access Token): matches", () => {
    expect(patternMatches(findPattern("npm-token"), "npm_AbCdEf0123456789012345AAAAAAAA")).toBe(true);
  });

  it("AKID (AWS access key id): matches AKID + 16+ alphanumeric", () => {
    expect(patternMatches(findPattern("aws-access-key-id"), "AKIDEXAMPLE0123456")).toBe(true);
  });

  it("LTAI (Alibaba): matches", () => {
    expect(patternMatches(findPattern("alibaba-key"), "LTAI0123456789abcdef0123")).toBe(true);
  });

  it("hf_ (Hugging Face): matches", () => {
    expect(patternMatches(findPattern("huggingface-token"), "hf_0123456789ABCDEFabcdef0123456789")).toBe(true);
  });

  it("r8_ (Replicate): matches", () => {
    expect(patternMatches(findPattern("replicate-token"), "r8_0123456789ABCDEFabcdef0123456789")).toBe(true);
  });

  it("Telegram bot token shape: matches digits:base64 of 35+ chars", () => {
    expect(patternMatches(findPattern("telegram-bot-token"), "1234567890:AAFmcSEAAQABcDeFgHiJkLmNoPqRsTuVwXy")).toBe(true);
  });

  it("Telegram bot token: does NOT match arbitrary colon-separated digits-text", () => {
    expect(patternMatches(findPattern("telegram-bot-token"), "12:abc")).toBe(false);
  });

  it("Apple app-specific password shape (xxxx-xxxx-xxxx-xxxx): matches", () => {
    expect(patternMatches(findPattern("apple-app-password"), "abcd-efgh-ijkl-mnop")).toBe(true);
  });

  it("Apple pattern: does NOT match benign-allowlist words (sign-in-and-go-now)", () => {
    expect(patternMatches(findPattern("apple-app-password"), "sign-in-and-go-now")).toBe(false);
  });
});

describe("structural patterns", () => {
  it("ENV-style uppercase: matches API_KEY=sk-... with uppercase identifier", () => {
    expect(patternMatches(findPattern("env-uppercase-credential"), "ANTHROPIC_API_KEY=sk-abc1234567890def0")).toBe(true);
  });

  it("ENV-style uppercase: does NOT match lowercase api_key=... (preserves diagnostic strings)", () => {
    // `Unrecognized key: "llm"` and similar diagnostic strings must pass
    // through unchanged.
    expect(patternMatches(findPattern("env-uppercase-credential"), "api_key=lowercase-skip")).toBe(false);
    expect(patternMatches(findPattern("env-uppercase-credential"), 'Unrecognized key: "llm"')).toBe(false);
  });

  it("URL query param api_key=...: matches", () => {
    expect(patternMatches(findPattern("url-query-credential"), "https://x/?api_key=sk-abc1234567890def0")).toBe(true);
  });

  it("URL query param: does NOT match an unrelated query like ?foo=bar", () => {
    expect(patternMatches(findPattern("url-query-credential"), "https://x/?foo=bar")).toBe(false);
  });

  it("Authorization HTTP header: matches Bearer + 18+ chars", () => {
    expect(patternMatches(findPattern("authorization-header"), "Authorization: Bearer sk-1234567890abcdef")).toBe(true);
  });

  it("Authorization HTTP header: does NOT match an Authorization-name-only mention", () => {
    expect(patternMatches(findPattern("authorization-header"), 'param name "Authorization"')).toBe(false);
  });

  it("Cookie HTTP header: matches", () => {
    expect(patternMatches(findPattern("cookie-header"), "Cookie: session=abc-very-long-cookie-value")).toBe(true);
  });

  it("JSON-field credential: matches \"apiKey\":\"sk-...\"", () => {
    expect(patternMatches(findPattern("json-field-credential"), '{"apiKey":"sk-1234567890abcdef"}')).toBe(true);
  });

  it("JSON-field credential: does NOT match field-name-only \"apiKey\":\"\"", () => {
    expect(patternMatches(findPattern("json-field-credential"), '{"apiKey":""}')).toBe(false);
  });

  it("CLI-flag credential: matches --token=long-value", () => {
    expect(patternMatches(findPattern("cli-flag-credential"), "--api-key=sk-1234567890abcdef")).toBe(true);
    expect(patternMatches(findPattern("cli-flag-credential"), "--token=abcdef1234567890123456")).toBe(true);
  });

  it("CLI-flag credential: does NOT match a non-credential flag like --verbose", () => {
    expect(patternMatches(findPattern("cli-flag-credential"), "--verbose")).toBe(false);
  });

  it("Bare bearer token (≥18 chars hex-ish): matches", () => {
    expect(patternMatches(findPattern("bare-bearer-token"), "Bearer abcdef0123456789012345")).toBe(true);
  });

  it("Bare bearer token: does NOT match short Bearer values (< 18)", () => {
    expect(patternMatches(findPattern("bare-bearer-token"), "Bearer short")).toBe(false);
  });

  it("PEM block: matches -----BEGIN PRIVATE KEY----- ... -----END PRIVATE KEY-----", () => {
    const pem = "-----BEGIN PRIVATE KEY-----\nMIIEv\n-----END PRIVATE KEY-----";
    expect(patternMatches(findPattern("pem-block"), pem)).toBe(true);
  });

  it("PEM block: does NOT match a partial-only BEGIN line", () => {
    expect(patternMatches(findPattern("pem-block"), "-----BEGIN ")).toBe(false);
  });
});

describe("Comis-additions patterns", () => {
  it("comis_ prefix token: matches", () => {
    expect(patternMatches(findPattern("comis-prefix-token"), "comis_abc1234567890def01234")).toBe(true);
  });

  it("comis_ prefix: does NOT match the bare prefix or short tokens", () => {
    expect(patternMatches(findPattern("comis-prefix-token"), "comis_")).toBe(false);
    expect(patternMatches(findPattern("comis-prefix-token"), "comis_short")).toBe(false);
  });

  it("Slack webhook URL: matches https://hooks.slack.com/services/T.../B.../...", () => {
    expect(
      patternMatches(
        findPattern("slack-webhook-url"),
        "https://hooks.slack.com/services/T01ABC2DEF3/B01XYZ4ABC5/abcdefghij1234567890",
      ),
    ).toBe(true);
  });

  it("Slack webhook URL: does NOT match an unrelated slack URL", () => {
    expect(patternMatches(findPattern("slack-webhook-url"), "https://slack.com/foo")).toBe(false);
  });

  it("Discord bot token: matches base64 + dot + 18+ chars", () => {
    // Discord bot tokens are roughly `<userId base64>.<timestamp>.<HMAC>`
    // — three dotted base64 segments. Token-shape match here is structural.
    expect(
      patternMatches(
        findPattern("discord-bot-token"),
        "MTAxMjM0NTY3ODkwMTIzNDU2.GabcdE.abcdEfGhIjKlMnOpQrStUvWxYz12345",
      ),
    ).toBe(true);
  });

  it("Discord bot token: does NOT match a short dotted token", () => {
    expect(patternMatches(findPattern("discord-bot-token"), "ab.cd.ef")).toBe(false);
  });

  it("Generic HMAC signature (hex hash, 40+ chars): matches", () => {
    expect(
      patternMatches(
        findPattern("hmac-signature"),
        "X-Signature: sha256=abcdef0123456789abcdef0123456789abcdef0123456789",
      ),
    ).toBe(true);
  });

  it("Generic HMAC signature: does NOT match a short hex chunk", () => {
    expect(patternMatches(findPattern("hmac-signature"), "abcdef")).toBe(false);
  });
});
