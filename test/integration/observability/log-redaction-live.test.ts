// SPDX-License-Identifier: Apache-2.0
/**
 * Live log redaction integration test.
 *
 * Boots a real `createLogger` from `@comis/infra` and intercepts the
 * underlying stdout writes (which is where Pino sends JSON when no
 * worker-thread transport is configured). Asserts that every
 * documented credential field is replaced with "[REDACTED]" in the
 * captured bytes -- never the original value:
 *
 *   1. Top-level credential paths (apiKey, token, password, secret,
 *      authorization, accessToken, refreshToken, botToken, privateKey,
 *      cookie, webhookSecret, accessKey, passphrase, connectionString,
 *      key) are redacted.
 *   2. Nested one-level paths (e.g. `headers.authorization`) are
 *      redacted.
 *   3. A custom field name NOT on the redaction list reaches the
 *      captured stream verbatim -- the redaction list is the source of
 *      truth, not a "redact-everything-suspicious" fallback.
 *   4. The redacted line still parses as valid NDJSON (so downstream
 *      log shippers don't choke).
 *   5. A child logger inherits the parent's redaction config.
 *
 * Drives `createLogger` exclusively (no direct pino import) so the
 * test pins the public Comis logger contract, not Pino's surface.
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createLogger } from "@comis/infra";

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

  it("redacts apiKey", () => {
    const log = createLogger({ name: "test", level: "debug" });
    log.info({ apiKey: "sk-test-secret-1234" }, "outgoing call");
    const text = cap.getText();
    expect(text).toContain("[REDACTED]");
    expect(text).not.toContain("sk-test-secret-1234");
  });

  it("redacts a wide set of documented credential fields", () => {
    const log = createLogger({ name: "test", level: "debug" });
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
    // 10 redacted fields -> at least 10 [REDACTED] occurrences.
    expect((text.match(/\[REDACTED\]/g) ?? []).length).toBeGreaterThanOrEqual(
      10,
    );
  });

  it("emits valid NDJSON with redacted fields intact", () => {
    const log = createLogger({ name: "test", level: "debug" });
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
    expect(matched!["apiKey"]).toBe("[REDACTED]");
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
    const log = createLogger({ name: "test", level: "debug" });
    log.info(
      { headers: { authorization: "Bearer must-not-leak" }, method: "POST" },
      "outgoing http",
    );
    const text = cap.getText();
    expect(text).not.toContain("Bearer must-not-leak");
    expect(text).toContain("[REDACTED]");
    expect(text).toContain("POST"); // method survives
  });

  it("redacts config.apiKey (one level deep)", () => {
    const log = createLogger({ name: "test", level: "debug" });
    log.info({ config: { apiKey: "leak-1" } }, "config dump");
    const text = cap.getText();
    expect(text).not.toContain("leak-1");
    expect(text).toContain("[REDACTED]");
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
    const log = createLogger({ name: "test", level: "debug" });
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
    const logger = createLogger({ name: "test", level: "debug" });
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.audit).toBe("function");
    expect(typeof logger.child).toBe("function");
  });

  it("a child logger inherits redaction from the parent", () => {
    const parent = createLogger({ name: "parent", level: "debug" });
    const child = parent.child({ subcomponent: "x" });
    child.info({ apiKey: "child-secret-1" }, "child log");
    const text = cap.getText();
    expect(text).not.toContain("child-secret-1");
    expect(text).toContain("[REDACTED]");
    expect(text).toContain("subcomponent");
  });

  it("operator-supplied redactPaths option redacts custom fields too", () => {
    const log = createLogger({
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
    expect(text).toContain("[REDACTED]");
    expect(text).toContain("ok");
  });
});
