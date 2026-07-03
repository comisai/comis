// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for redactValue() — the pure, bounded redaction primitive.
 *
 * This is the redaction keystone:
 *   - No secrets ever (9 Pino keys + secret shapes → `<redacted>`).
 *   - No absolute paths ($HOME → ~, system-absolute → last 2 segments);
 *     IP / hostname / MAC masked.
 *   - PII (email / phone / CC / SSN) masked.
 *
 * The replacement token is the lowercase-angle `<redacted>` — deliberately
 * NOT `[REDACTED]` like the log sanitizer, so output always shows WHICH
 * layer redacted a value.
 */

import { describe, it, expect } from "vitest";
import {
  redactValue,
  REDACT_LIMITS,
  type RedactionReason,
  type RedactedValue,
} from "./redact-value.js";
import { applyTemplate } from "../activity/template-engine.js";
import type { LabelSpec } from "../activity/label-spec.js";
import {
  CREDENTIAL_LOG_PATTERNS,
  SECRET_SHAPE_PATTERNS,
} from "./redact-value.js";

const REDACTED = "<redacted>";

/** The 9 secret keys mirrored from the CLAUDE.md "Pino auto-redacts" list. */
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

describe("redactValue — the distinct lowercase-angle replacement token", () => {
  it("emits the lowercase-angle <redacted> token, NOT [REDACTED]", () => {
    const out = redactValue({ apiKey: "hunter2" });
    const value = out.value as Record<string, unknown>;
    expect(value.apiKey).toBe("<redacted>");
    expect(value.apiKey).not.toBe("[REDACTED]");
    expect(JSON.stringify(out.value)).not.toContain("[REDACTED]");
  });
});

describe("redactValue — key-based redaction (one assertion per Pino key)", () => {
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

describe("redactValue — shape-based redaction (secret caught under a benign key)", () => {
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

// ---------------------------------------------------------------------------
// Three secret shapes the log sanitizer covers that the activity shape pass
// must mirror — URL-embedded password, Bearer token, and aws_secret_access_key.
// Without them, a credential under a BENIGN allowlisted key survives verbatim
// into the user-visible label (asserted end-to-end through applyTemplate
// below): the password / token / 40-char secret substring would still be
// present in redactValue(...).value.
// ---------------------------------------------------------------------------

describe("redactValue — secret-shape gap (URL password / Bearer / AWS secret) under a benign key", () => {
  it("redacts the password in a URL-embedded credential (://user:password@host)", () => {
    const out = redactValue({ url: "https://user:hunter2secret@db.internal.example.com/path" });
    const value = out.value as Record<string, unknown>;
    // The password substring must be gone — URL_PASSWORD has capture groups, so
    // verify .replace() masked the whole credential span (not just $0 leaving
    // the captured password behind).
    expect(value.url).not.toContain("hunter2secret");
    expect(value.url).toContain(REDACTED);
    expect(reasons(out)).toContain("secret_shape");
  });

  it("redacts a Bearer token in an Authorization-style value", () => {
    const out = redactValue({ cmd: "Authorization: Bearer abcdef0123456789abcdef" });
    const value = out.value as Record<string, unknown>;
    expect(value.cmd).not.toContain("abcdef0123456789abcdef");
    expect(value.cmd).toContain(REDACTED);
    expect(reasons(out)).toContain("secret_shape");
  });

  it("redacts an aws_secret_access_key=<40 chars> value", () => {
    const out = redactValue({
      note: "aws_secret_access_key=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd",
    });
    const value = out.value as Record<string, unknown>;
    expect(value.note).not.toContain("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd");
    expect(value.note).toContain(REDACTED);
    expect(reasons(out)).toContain("secret_shape");
  });

  it("strips ALL three credential substrings from a combined benign-keyed value", () => {
    const out = redactValue({
      detail:
        "fetch https://admin:s3cr3tPassw0rd@host then Bearer abcdef0123456789abcdef and aws_secret_access_key=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd",
    });
    const value = out.value as Record<string, unknown>;
    const rendered = String(value.detail);
    expect(rendered).not.toContain("s3cr3tPassw0rd");
    expect(rendered).not.toContain("abcdef0123456789abcdef");
    expect(rendered).not.toContain("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd");
  });
});

describe("applyTemplate — no credential survives the rendered label/detail under an allowlisted key", () => {
  it("masks a URL password in an allowlisted {url} label", () => {
    const spec: LabelSpec = {
      semanticPhase: "tool",
      label: "fetch {url}",
      detailKeys: ["url"],
    };
    const result = applyTemplate(spec, {
      url: "https://admin:s3cr3tPassw0rd@host.example.com/v1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.defaultLabel).not.toContain("s3cr3tPassw0rd");
    expect(result.value.defaultLabel).toContain("<redacted>");
    expect(result.value.redactionsApplied.some((r) => r.reason === "secret_shape")).toBe(true);
  });

  it("masks a Bearer token in an allowlisted {cmd} detail", () => {
    const spec: LabelSpec = {
      semanticPhase: "tool",
      label: "run command",
      detail: "run {cmd}",
      detailKeys: ["cmd"],
    };
    const result = applyTemplate(spec, {
      cmd: 'curl -H "Authorization: Bearer abcdef0123456789abcdefghij" https://x',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.defaultDetail).not.toContain("abcdef0123456789abcdefghij");
    expect(result.value.defaultDetail).toContain("<redacted>");
  });
});

// ---------------------------------------------------------------------------
// Regression guard: the activity SECRET_SHAPE_PATTERNS must stay a superset of
// the log sanitizer's CREDENTIAL_LOG_PATTERNS. Any future credential shape added
// to the log sanitizer but not the activity redactor is a silent security
// regression (this drift was exactly the secret-shape gap above). Containment is
// asserted by pattern `.source`, with an explicit allowlist for intentional
// exclusions (expected empty).
// ---------------------------------------------------------------------------

describe("activity SECRET_SHAPE_PATTERNS contains every log-sanitizer credential shape", () => {
  /**
   * Intentional exclusions, each with a reason. MUST stay empty —
   * a non-empty entry is a deliberate, reviewed decision to NOT mirror a log
   * sanitizer shape into the activity redactor.
   */
  const ALLOWED_EXCLUSIONS: ReadonlyArray<{ source: string; reason: string }> = [];

  it("covers every CREDENTIAL_LOG_PATTERNS source (no silent drift)", () => {
    const shapeSources = new Set(SECRET_SHAPE_PATTERNS.map((p) => p.source));
    const excluded = new Set(ALLOWED_EXCLUSIONS.map((e) => e.source));
    const missing = CREDENTIAL_LOG_PATTERNS.filter(
      (p) => !shapeSources.has(p.source) && !excluded.has(p.source),
    ).map((p) => p.source);
    expect(missing).toEqual([]);
  });

  it("keeps the intentional-exclusion allowlist empty", () => {
    expect(ALLOWED_EXCLUSIONS).toHaveLength(0);
  });
});

describe("redactValue — absolute path COMPACTION (not stripping)", () => {
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

// ---------------------------------------------------------------------------
// URL hosts must NOT be stripped by the absolute-path matcher.
//
// Without the scheme guard, a URL like `https://finance.yahoo.com/quote/IBM/`
// renders as `"fetching https:/quote/IBM/"` — `compactPaths`'s ABS_PATH_RE
// greedily matches the `//finance.yahoo.com/quote/IBM/` span inside the URL as
// a 4-segment absolute path and compacts it to its last 2 segments, eating one
// of the scheme's two slashes. URLs are public, user-facing info
// (tavily.com/search renders verbatim); path compaction is for
// filesystem paths only.
//
// The `(?<!:)` negative-lookbehind on the leading `/` is what keeps URL scheme
// separators (`://`) intact. The two assertions below (scheme starts with
// `https://` and no `absolute_path` reason recorded) pin that contract.
// Asserting only the scheme survival keeps the test decoupled from whether
// HOSTNAME_RE later masks `finance.yahoo.com` — that's a separate, unrelated
// network-identifier mask that runs AFTER compactPaths; the failure signature
// here is the lost scheme slash.
// ---------------------------------------------------------------------------

describe("redactValue — URL host not stripped by absolute-path matcher", () => {
  it("preserves the https:// scheme separator on a public URL (no compactPaths false positive)", () => {
    const out = redactValue({ url: "https://finance.yahoo.com/quote/IBM/" });
    const value = out.value as Record<string, unknown>;
    // The scheme's two slashes MUST survive. Pre-patch returns "https:/quote/IBM/"
    // (one slash, host eaten by ABS_PATH_RE compaction).
    expect(String(value.url).startsWith("https://")).toBe(true);
    // And no absolute_path reason is recorded for a URL input — that reason
    // is for filesystem-path compaction only, not URL hosts.
    expect(out.redactionsApplied.find((r) => r.reason === "absolute_path")).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // URL host is NOT masked by HOSTNAME_RE.
  //
  // Preserving the scheme slashes alone is not enough: without its own guard,
  // HOSTNAME_RE (redact-value.ts) still matches finance.yahoo.com (≥3 labels
  // ending in alpha TLD) and the URL renders as "https://<redacted>/quote/MSFT/".
  // URL hosts are public, user-facing info — they must not be masked.
  // Standalone hostnames (e.g. internal "db-primary.internal.example.com") DO
  // stay masked (defense against infra leakage); only URL-context hosts are
  // exempt. A `(?<!\/\/)` lookbehind on HOSTNAME_RE skips hosts preceded by `//`.
  // -------------------------------------------------------------------------
  it("preserves the URL host (does NOT mask it via HOSTNAME_RE)", () => {
    const out = redactValue({ url: "https://finance.yahoo.com/quote/MSFT/" });
    const value = out.value as Record<string, unknown>;
    // The URL host must be intact, not "<redacted>".
    expect(value.url).toBe("https://finance.yahoo.com/quote/MSFT/");
    // No network_identifier reason recorded for a URL input.
    expect(out.redactionsApplied.find((r) => r.reason === "network_identifier")).toBeUndefined();
  });

  it("still masks standalone (non-URL) hostnames — defense-in-depth regression guard", () => {
    // Internal infra hostname not inside a URL → STILL gets masked.
    const out = redactValue({ host: "connect to db-primary.internal.example.com please" });
    const value = out.value as Record<string, unknown>;
    expect(String(value.host)).not.toContain("db-primary.internal.example.com");
    expect(String(value.host)).toContain("<redacted>");
    expect(out.redactionsApplied.find((r) => r.reason === "network_identifier")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// URL PATHS are protected from the PII matchers.
//
// Exempting URL HOSTS from HOSTNAME_RE via the `(?<!\/\/)` lookbehind is not
// enough on its own: URL PATHS would still flow through every PII matcher
// unguarded — a press-release URL like
// `https://www.prnewswire.com/news-releases/...-302781634.html` would render
// with the 9-digit ID falsely masked by PHONE_RE. Public URL
// hosts AND paths are user-facing context, not infrastructure leakage. A
// single URL-aware extract-and-restore pre-pass wraps the network + PII
// matcher passes so numeric IDs in URL paths are not false-positive-masked.
//
// The first two tests (9-digit ID, CC-shaped path) pin that pre-pass —
// without it, PHONE_RE / CREDIT_CARD_RE match the URL path span and the
// URL renders with `<redacted>` instead of verbatim. The remaining three are
// regression guards for the span-precision and defense-in-depth invariants.
// ---------------------------------------------------------------------------

describe("redactValue — URL paths protected from PII matchers (PHONE/CC/SSN/EMAIL)", () => {
  it("preserves a 9-digit press-release ID in a URL path (no PHONE_RE false positive)", () => {
    const url =
      "https://www.prnewswire.com/news-releases/ituran-presents-first-quarter-2026-results-302781634.html";
    const out = redactValue({ url });
    const value = out.value as Record<string, unknown>;
    // The URL must render verbatim — `302781634` is a press-release ID in the
    // path, NOT a phone number. Without the URL guard, PHONE_RE matches the
    // digit run and replaces it with `<redacted>`.
    expect(value.url).toBe(url);
    expect(out.redactionsApplied.find((r) => r.reason === "pii_phone")).toBeUndefined();
  });

  it("preserves a CC-shaped digit run in a URL path (no CREDIT_CARD_RE false positive)", () => {
    const url = "https://example.com/account/4111-1111-1111-1111";
    const out = redactValue({ url });
    const value = out.value as Record<string, unknown>;
    // The URL must render verbatim — `4111-1111-1111-1111` is a path segment,
    // NOT a credit card. Without the URL guard, CREDIT_CARD_RE matches the
    // 4-4-4-4 group and replaces it with `<redacted>`.
    expect(value.url).toBe(url);
    expect(out.redactionsApplied.find((r) => r.reason === "pii_credit_card")).toBeUndefined();
  });

  it("still masks a standalone phone number outside any URL (regression guard)", () => {
    // Span-precise: the URL exemption only protects URL spans, not the whole
    // string. A standalone phone number is STILL masked.
    const out = redactValue({ note: "call me at 555-123-4567 about my account" });
    const value = out.value as Record<string, unknown>;
    expect(String(value.note)).toContain("<redacted>");
    expect(String(value.note)).not.toContain("555-123-4567");
    expect(reasons(out)).toContain("pii_phone");
  });

  it("span-precision: URL intact AND standalone phone masked in the same string", () => {
    // The URL guard must stash ONLY the URL span — the phone outside the URL
    // is still masked. A buggy helper that protected the whole string would
    // leak the phone; this guard catches that future regression.
    const out = redactValue({
      note: "see https://example.com/abc — but also call 555-999-8888",
    });
    const value = out.value as Record<string, unknown>;
    const rendered = String(value.note);
    expect(rendered).toContain("https://example.com/abc");
    expect(rendered).not.toContain("555-999-8888");
    expect(rendered).toContain("<redacted>");
    expect(reasons(out)).toContain("pii_phone");
  });

  it("defense-in-depth: URL_PASSWORD still masks embedded credentials (secret-shape runs BEFORE URL guard)", () => {
    // Secret-shape invariant: the URL guard MUST NOT bypass secret-shape masking.
    // Secret-shape pass runs FIRST, so `://user:password@host` is masked before
    // the URL is ever stashed by the new wrapper. Asserts with a vanilla
    // `example.com` host (not the internal `db.internal.example.com` from the
    // secret-shape gap block above) to prove the new helper doesn't accidentally
    // stash the URL BEFORE the secret-shape pass strips the credential.
    const out = redactValue({ url: "https://user:hunter2secret@example.com/path" });
    const value = out.value as Record<string, unknown>;
    expect(String(value.url)).not.toContain("hunter2secret");
    expect(reasons(out)).toContain("secret_shape");
  });
});

describe("redactValue — network identifiers", () => {
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

describe("redactValue — PII masks", () => {
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
  it("exposes the documented default limits", () => {
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
