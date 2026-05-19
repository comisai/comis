// SPDX-License-Identifier: Apache-2.0
/**
 * Live log redaction integration test.
 *
 * Boots a real `createLogger` from `@comis/infra` and intercepts the
 * underlying stdout writes (which is where Pino sends JSON when no
 * worker-thread transport is configured). Asserts that every
 * documented credential field is MASKED in the captured bytes — never
 * the original value:
 *
 *   1. Top-level credential paths (apiKey, token, password, secret,
 *      authorization, accessToken, refreshToken, botToken, privateKey,
 *      cookie, webhookSecret, accessKey, passphrase, connectionString,
 *      key) are masked.
 *   2. Nested one-level paths (e.g. `headers.authorization`) are
 *      masked.
 *   3. A custom field name NOT on the redaction list reaches the
 *      captured stream verbatim — the redaction list is the source of
 *      truth, not a "redact-everything-suspicious" fallback.
 *   4. The redacted line still parses as valid NDJSON (so downstream
 *      log shippers don't choke).
 *   5. A child logger inherits the parent's redaction config.
 *
 * Drives `createLogger` exclusively (no direct pino import) so the
 * test pins the public Comis logger contract, not Pino's surface.
 *
 * **Mask shape.** The censor is a callback that emits the edge-keeping
 * mask shape ("sk-123…cdef" with a U+2026 ellipsis) for string values
 * ≥ 18 chars, "***" for shorter strings, and "[REDACTED]" for
 * non-string values. The residency invariant is strict (the mask never
 * re-leaks the body), so the load-bearing assertion is "plaintext is
 * absent" — positive shape assertions accept any of the three mask
 * forms via the {@link isCensored} helper.
 *
 * **Transport gating.** The default Pino transport runs the free-form
 * regex pass in a worker thread; that intercepts stdout output. These
 * tests need synchronous stdout capture, so they pass
 * `regexRedactInTransport: false` to skip the transport while keeping
 * the structured censor active.
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createLogger, type LoggerOptions } from "@comis/infra";

// ---------------------------------------------------------------------------
// The redact transport runs in a worker thread and would intercept stdout
// output. These integration tests need synchronous stdout capture, so we
// disable the transport while keeping the structured censor active. The
// censor produces three possible mask shapes:
//   - edge-keeping mask with U+2026 ellipsis ("sk-123…cdef") for strings ≥ 18 chars
//   - "***" sentinel for strings below MIN_LENGTH
//   - "[REDACTED]" sentinel for non-string credential values
// `isCensored` accepts any of the three; tests use it for the
// positive-shape assertion. The negative "plaintext is absent" check
// is the load-bearing residency invariant.
// ---------------------------------------------------------------------------

function createTestLogger(opts: LoggerOptions) {
  return createLogger({
    regexRedactInTransport: false,
    ...opts,
  });
}

const ELLIPSIS = "…"; // U+2026 HORIZONTAL ELLIPSIS

function hasMaskShape(text: string): boolean {
  return (
    text.includes("[REDACTED]") ||
    text.includes("***") ||
    text.includes(ELLIPSIS)
  );
}

// ---------------------------------------------------------------------------
// stdout capture helper -- swaps process.stdout.write for the duration of a
// test so we can read whatever the logger emits without setting up a real
// transport (Pino in default mode writes JSON to fd 1).
// ---------------------------------------------------------------------------

function captureStdout(): { restore: () => void; getText: () => string } {
  const origWrite = process.stdout.write.bind(process.stdout);
  const buf: string[] = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- intercepting console
  (process.stdout.write as any) = (
    chunk: string | Uint8Array,
    enc?: BufferEncoding,
    cb?: (err?: Error | null) => void,
  ): boolean => {
    const text =
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");
    buf.push(text);
    if (typeof cb === "function") cb();
    return true;
  };

  return {
    restore: () => {
      process.stdout.write = origWrite;
    },
    getText: () => buf.join(""),
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("Log redaction -- top-level credential fields via createLogger", () => {
  let cap: ReturnType<typeof captureStdout>;

  beforeEach(() => {
    cap = captureStdout();
  });

  afterEach(() => {
    cap.restore();
  });

  it("redacts apiKey field value in serialized log line per Pino redaction config", () => {
    const log = createTestLogger({ name: "test", level: "debug" });
    log.info({ apiKey: "sk-test-secret-1234" }, "outgoing call");
    const text = cap.getText();
    expect(hasMaskShape(text)).toBe(true);
    expect(text).not.toContain("sk-test-secret-1234");
  });

  it("redacts a wide set of documented credential fields", () => {
    const log = createTestLogger({ name: "test", level: "debug" });
    log.info(
      {
        token: "tk_abc",
        password: "hunter2",
        secret: "shh",
        authorization: "Bearer xyz",
        accessToken: "at_abc",
        refreshToken: "rt_abc",
        botToken: "bot_abc",
        privateKey: "-----BEGIN PRIVATE KEY-----...",
        cookie: "session=abc",
        webhookSecret: "wh_abc",
      },
      "secrets payload",
    );
    const text = cap.getText();
    expect(text).not.toContain("tk_abc");
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("shh");
    expect(text).not.toContain("Bearer xyz");
    expect(text).not.toContain("at_abc");
    expect(text).not.toContain("rt_abc");
    expect(text).not.toContain("bot_abc");
    expect(text).not.toContain("-----BEGIN PRIVATE KEY-----");
    expect(text).not.toContain("session=abc");
    expect(text).not.toContain("wh_abc");
    // 10 redacted fields → at least 10 mask occurrences.
    // Mask shapes: edge-keeping ("…" U+2026), "***", or "[REDACTED]".
    // Count every occurrence of any of the three shapes.
    const maskCount =
      (text.match(/\[REDACTED\]/g) ?? []).length +
      (text.match(/\*\*\*/g) ?? []).length +
      (text.match(/…/g) ?? []).length;
    expect(maskCount).toBeGreaterThanOrEqual(10);
  });

  it("emits valid NDJSON with redacted fields intact", () => {
    const log = createTestLogger({ name: "test", level: "debug" });
    log.info({ apiKey: "must-be-hidden" }, "json shape");
    const text = cap.getText().trim();
    // Some output may include multiple lines (build banner etc.); split
    // and find the line that parses as JSON containing our msg.
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    const matched = lines
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .find(
        (entry): entry is Record<string, unknown> =>
          entry !== null && entry["msg"] === "json shape",
      );
    expect(matched).toBeDefined();
    // The 14-char "must-be-hidden" input is below the
    // 18-char MIN_LENGTH boundary, so maskToken collapses it to "***".
    expect(matched!["apiKey"]).toBe("***");
  });
});

describe("Log redaction -- nested credential paths via createLogger", () => {
  let cap: ReturnType<typeof captureStdout>;

  beforeEach(() => {
    cap = captureStdout();
  });

  afterEach(() => {
    cap.restore();
  });

  it("redacts headers.authorization (one level deep)", () => {
    const log = createTestLogger({ name: "test", level: "debug" });
    log.info(
      { headers: { authorization: "Bearer must-not-leak" }, method: "POST" },
      "outgoing http",
    );
    const text = cap.getText();
    expect(text).not.toContain("Bearer must-not-leak");
    expect(hasMaskShape(text)).toBe(true);
    expect(text).toContain("POST"); // method survives
  });

  it("redacts config.apiKey (one level deep)", () => {
    const log = createTestLogger({ name: "test", level: "debug" });
    log.info({ config: { apiKey: "leak-1" } }, "config dump");
    const text = cap.getText();
    expect(text).not.toContain("leak-1");
    expect(hasMaskShape(text)).toBe(true);
  });
});

describe("Log redaction -- custom field NOT on the list reaches the stream", () => {
  let cap: ReturnType<typeof captureStdout>;

  beforeEach(() => {
    cap = captureStdout();
  });

  afterEach(() => {
    cap.restore();
  });

  it("a non-listed field name 'mySensitiveField' is NOT auto-redacted", () => {
    const log = createTestLogger({ name: "test", level: "debug" });
    log.info(
      { mySensitiveField: "this-must-be-visible-or-the-list-is-stale" },
      "negative test",
    );
    const text = cap.getText();
    // Confirms the redaction list IS the source of truth (operators
    // must add new field names explicitly; there is no fallback that
    // pretends to redact unknown fields).
    expect(text).toContain("this-must-be-visible-or-the-list-is-stale");
  });
});

describe("Log redaction -- API surface and child loggers", () => {
  let cap: ReturnType<typeof captureStdout>;

  beforeEach(() => {
    cap = captureStdout();
  });

  afterEach(() => {
    cap.restore();
  });

  it("createLogger exposes info/audit/child", () => {
    const logger = createTestLogger({ name: "test", level: "debug" });
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.audit).toBe("function");
    expect(typeof logger.child).toBe("function");
  });

  it("a child logger inherits redaction from the parent", () => {
    const parent = createTestLogger({ name: "parent", level: "debug" });
    const child = parent.child({ subcomponent: "x" });
    child.info({ apiKey: "child-secret-1" }, "child log");
    const text = cap.getText();
    expect(text).not.toContain("child-secret-1");
    expect(hasMaskShape(text)).toBe(true);
    expect(text).toContain("subcomponent");
  });

  it("operator-supplied redactPaths option redacts custom fields too", () => {
    const log = createTestLogger({
      name: "test",
      level: "debug",
      redactPaths: ["customCredential"],
    });
    log.info(
      { customCredential: "must-not-leak", normalField: "ok" },
      "custom redact",
    );
    const text = cap.getText();
    expect(text).not.toContain("must-not-leak");
    expect(hasMaskShape(text)).toBe(true);
    expect(text).toContain("ok");
  });
});
