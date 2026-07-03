// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createLogger, DEFAULT_REDACT_PATHS } from "./logger.js";
import { isValidLogLevel } from "@comis/core";

/**
 * Capture logger output by creating a pino destination writable stream.
 * Returns parsed JSON objects from each log line.
 */
function captureOutput(): { stream: Writable; lines: () => Record<string, unknown>[] } {
  const chunks: string[] = [];

  const stream = new Writable({
    write(chunk: Buffer, _encoding: string, callback: () => void) {
      chunks.push(chunk.toString());
      callback();
    },
  });

  return {
    stream,
    lines() {
      return chunks
        .join("")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    },
  };
}

/**
 * Create a test logger that writes to an in-memory capture stream.
 * Uses pino's destination option by importing pino directly.
 */
async function createTestLogger(
  options: { name: string; level?: string; redactPaths?: string[] } = { name: "test" },
) {
  const { default: pino } = await import("pino");
  const capture = captureOutput();

  const pinoOpts: Record<string, unknown> = {
    name: options.name,
    level: options.level ?? "trace",
    customLevels: { audit: 35 },
    redact: {
      paths: [
        "apiKey",
        "token",
        "password",
        "secret",
        "authorization",
        "accessToken",
        "refreshToken",
        "botToken",
        "privateKey",
        "credential",
        "credentials",
        "*.apiKey",
        "*.token",
        "*.password",
        "*.secret",
        "*.authorization",
        "*.accessToken",
        "*.refreshToken",
        "*.botToken",
        "*.privateKey",
        "*.credential",
        "*.credentials",
        "*.*.apiKey",
        "*.*.token",
        "*.*.password",
        "*.*.secret",
        "*.*.authorization",
        "*.*.accessToken",
        "*.*.refreshToken",
        "*.*.botToken",
        "*.*.privateKey",
        "*.*.credential",
        "*.*.credentials",
        "*.*.*.apiKey",
        "*.*.*.token",
        "*.*.*.password",
        "*.*.*.secret",
        "*.*.*.authorization",
        "*.*.*.accessToken",
        "*.*.*.refreshToken",
        "*.*.*.botToken",
        "*.*.*.privateKey",
        "*.*.*.credential",
        "*.*.*.credentials",
        // Expanded credential patterns
        "key",
        "passphrase",
        "connectionString",
        "accessKey",
        // HTTP cookies and webhook signing secrets
        "cookie",
        "webhookSecret",
        "*.key",
        "*.passphrase",
        "*.connectionString",
        "*.accessKey",
        "*.cookie",
        "*.webhookSecret",
        "*.*.key",
        "*.*.passphrase",
        "*.*.connectionString",
        "*.*.accessKey",
        "*.*.cookie",
        "*.*.webhookSecret",
        "*.*.*.key",
        "*.*.*.passphrase",
        "*.*.*.connectionString",
        "*.*.*.accessKey",
        "*.*.*.cookie",
        "*.*.*.webhookSecret",
        ...(options.redactPaths ?? []),
      ],
      censor: "[REDACTED]",
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level(label: string, number: number) {
        return { level: label, levelValue: number };
      },
    },
  };

  const logger = pino(pinoOpts, capture.stream);

  return { logger, capture };
}

describe("createLogger", () => {
  describe("credential redaction", () => {
    it("redacts top-level apiKey", async () => {
      const { logger, capture } = await createTestLogger();
      logger.info({ apiKey: "sk-test-12345" }, "test message");

      const lines = capture.lines();
      expect(lines).toHaveLength(1);
      expect(lines[0]!.apiKey).toBe("[REDACTED]");
    });

    it("redacts nested authorization header", async () => {
      const { logger, capture } = await createTestLogger();
      logger.info({ headers: { authorization: "Bearer xxx-secret-token" } }, "request");

      const lines = capture.lines();
      expect(lines).toHaveLength(1);
      const headers = lines[0]!.headers as Record<string, unknown>;
      expect(headers.authorization).toBe("[REDACTED]");
    });

    it("redacts deeply nested botToken", async () => {
      const { logger, capture } = await createTestLogger();
      logger.info({ config: { telegram: { botToken: "123:ABC" } } }, "config loaded");

      const lines = capture.lines();
      expect(lines).toHaveLength(1);
      const config = lines[0]!.config as Record<string, Record<string, unknown>>;
      expect(config.telegram.botToken).toBe("[REDACTED]");
    });

    it("redacts 4-level nested botToken", async () => {
      const { logger, capture } = await createTestLogger();
      logger.info(
        { response: { config: { channels: { botToken: "secret-4level-token" } } } },
        "deep config",
      );

      const lines = capture.lines();
      expect(lines).toHaveLength(1);
      const response = lines[0]!.response as Record<
        string,
        Record<string, Record<string, unknown>>
      >;
      expect(response.config.channels.botToken).toBe("[REDACTED]");
    });

    it("redacts 4-level nested apiKey", async () => {
      const { logger, capture } = await createTestLogger();
      logger.info(
        { outer: { middle: { inner: { apiKey: "sk-deeply-nested" } } } },
        "deep api key",
      );

      const lines = capture.lines();
      expect(lines).toHaveLength(1);
      const outer = lines[0]!.outer as Record<string, Record<string, Record<string, unknown>>>;
      expect(outer.middle.inner.apiKey).toBe("[REDACTED]");
    });

    it("does NOT redact non-credential fields", async () => {
      const { logger, capture } = await createTestLogger();
      logger.info({ username: "alice", action: "login", count: 42 }, "user action");

      const lines = capture.lines();
      expect(lines).toHaveLength(1);
      expect(lines[0]!.username).toBe("alice");
      expect(lines[0]!.action).toBe("login");
      expect(lines[0]!.count).toBe(42);
    });

    it("redacts top-level key field", async () => {
      const { logger, capture } = await createTestLogger();
      logger.info({ key: "my-secret-key-value" }, "key redaction test");

      const lines = capture.lines();
      expect(lines).toHaveLength(1);
      expect(lines[0]!.key).toBe("[REDACTED]");
    });

    it("redacts top-level passphrase field", async () => {
      const { logger, capture } = await createTestLogger();
      logger.info({ passphrase: "ssh-passphrase-secret" }, "passphrase test");

      const lines = capture.lines();
      expect(lines).toHaveLength(1);
      expect(lines[0]!.passphrase).toBe("[REDACTED]");
    });

    it("redacts top-level connectionString field", async () => {
      const { logger, capture } = await createTestLogger();
      logger.info({ connectionString: "postgres://user:pass@host:5432/db" }, "connstr test");

      const lines = capture.lines();
      expect(lines).toHaveLength(1);
      expect(lines[0]!.connectionString).toBe("[REDACTED]");
    });

    it("redacts top-level accessKey field", async () => {
      const { logger, capture } = await createTestLogger();
      logger.info({ accessKey: "AKIAIOSFODNN7EXAMPLE" }, "accessKey test");

      const lines = capture.lines();
      expect(lines).toHaveLength(1);
      expect(lines[0]!.accessKey).toBe("[REDACTED]");
    });

    it("redacts nested connectionString at 2 levels", async () => {
      const { logger, capture } = await createTestLogger();
      logger.info({ db: { connectionString: "mysql://root:pass@localhost/app" } }, "nested connstr");

      const lines = capture.lines();
      expect(lines).toHaveLength(1);
      const db = lines[0]!.db as Record<string, unknown>;
      expect(db.connectionString).toBe("[REDACTED]");
    });

    it("redacts password field", async () => {
      const { logger, capture } = await createTestLogger();
      logger.info({ password: "hunter2" }, "login attempt");

      const lines = capture.lines();
      expect(lines).toHaveLength(1);
      expect(lines[0]!.password).toBe("[REDACTED]");
    });

    it("redacts top-level cookie field", async () => {
      const { logger, capture } = await createTestLogger();
      logger.info({ cookie: "session=abc123; token=xyz" }, "cookie redaction test");

      const lines = capture.lines();
      expect(lines).toHaveLength(1);
      expect(lines[0]!.cookie).toBe("[REDACTED]");
    });

    it("redacts top-level webhookSecret field", async () => {
      const { logger, capture } = await createTestLogger();
      logger.info({ webhookSecret: "whsec_xyz_signing_secret" }, "webhookSecret redaction test");

      const lines = capture.lines();
      expect(lines).toHaveLength(1);
      expect(lines[0]!.webhookSecret).toBe("[REDACTED]");
    });

    it("redacts nested cookie at 2 levels", async () => {
      const { logger, capture } = await createTestLogger();
      logger.info({ headers: { cookie: "session=abc123" } }, "nested cookie");

      const lines = capture.lines();
      expect(lines).toHaveLength(1);
      const headers = lines[0]!.headers as Record<string, unknown>;
      expect(headers.cookie).toBe("[REDACTED]");
    });

    it("redacts nested webhookSecret at 3 levels", async () => {
      const { logger, capture } = await createTestLogger();
      logger.info({ config: { telegram: { webhookSecret: "tg_wh_secret" } } }, "deep webhookSecret");

      const lines = capture.lines();
      expect(lines).toHaveLength(1);
      const config = lines[0]!.config as Record<string, Record<string, unknown>>;
      expect(config.telegram.webhookSecret).toBe("[REDACTED]");
    });
  });

  describe("audit level", () => {
    it("audit level exists and is callable", async () => {
      const { logger, capture } = await createTestLogger();
      logger.audit({ action: "user.create" }, "user created");

      const lines = capture.lines();
      expect(lines).toHaveLength(1);
      expect(lines[0]!.level).toBe("audit");
      expect(lines[0]!.levelValue).toBe(35);
      expect(lines[0]!.msg).toBe("user created");
    });

    it("audit is between info (30) and warn (40)", async () => {
      const { logger, capture } = await createTestLogger();
      logger.audit("audit event");

      const lines = capture.lines();
      expect(lines).toHaveLength(1);
      const levelValue = lines[0]!.levelValue as number;
      expect(levelValue).toBeGreaterThan(30);
      expect(levelValue).toBeLessThan(40);
    });

    // The `.audit()` level (35) must be callable through the PRODUCTION
    // `createLogger` factory (the typed ComisLogger surface), not just the
    // hand-rolled test pino above. The audit subscriber calls
    // `logger.audit(scrubbedRecord, "…")`; this proves the production wrapper
    // routes it to level 35 end-to-end (captured via a file transport, the
    // proven in-file poll pattern, since createLogger owns its pino instance).
    it("createLogger().audit(...) emits a record at level 35 (production factory path)", async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), "comis-audit-level-"));
      const auditFile = join(tmpDir, "audit.log");
      try {
        const logger = createLogger({
          name: "audit-level-prod",
          // Explicit file transport so we can read the bytes the production
          // factory actually wrote (skips the worker-thread redact transport).
          transport: {
            targets: [{ target: "pino/file", options: { destination: auditFile } }],
          },
        });

        // The typed ComisLogger surface exposes `.audit(obj, msg)`.
        logger.audit({ kind: "secret_access" }, "audit");

        // Poll until the worker thread flushes the line to disk.
        const deadline = Date.now() + 8000;
        let content = "";
        while (Date.now() < deadline) {
          try {
            content = await readFile(auditFile, "utf8");
            if (content.trim().length > 0) break;
          } catch {
            // file not yet created by the transport worker — keep polling
          }
          await new Promise((r) => setTimeout(r, 100));
        }

        const lines = content
          .split("\n")
          .filter((l) => l.trim().length > 0)
          .map((l) => JSON.parse(l) as Record<string, unknown>);
        expect(lines).toHaveLength(1);
        // Pino's file transport emits the numeric level; audit === 35.
        expect(lines[0]!.level).toBe(35);
        expect(lines[0]!.msg).toBe("audit");
        expect(lines[0]!.kind).toBe("secret_access");
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("child logger", () => {
    it("child logger inherits redaction", async () => {
      const { logger, capture } = await createTestLogger();
      const child = logger.child({ component: "auth" });
      child.info({ apiKey: "sk-child-key", user: "bob" }, "child log");

      const lines = capture.lines();
      expect(lines).toHaveLength(1);
      expect(lines[0]!.apiKey).toBe("[REDACTED]");
      expect(lines[0]!.component).toBe("auth");
      expect(lines[0]!.user).toBe("bob");
    });
  });

  describe("timestamp format", () => {
    it("uses ISO timestamp format", async () => {
      const { logger, capture } = await createTestLogger();
      logger.info("timestamp test");

      const lines = capture.lines();
      expect(lines).toHaveLength(1);
      const time = lines[0]!.time as string;
      // ISO 8601 format: YYYY-MM-DDTHH:MM:SS.sssZ
      expect(time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });
  });

  describe("level formatting", () => {
    it("outputs level as label and numeric value", async () => {
      const { logger, capture } = await createTestLogger();
      logger.info("level format test");

      const lines = capture.lines();
      expect(lines).toHaveLength(1);
      expect(lines[0]!.level).toBe("info");
      expect(lines[0]!.levelValue).toBe(30);
    });
  });

  describe("factory function", () => {
    it("createLogger returns a logger with expected name", () => {
      const logger = createLogger({ name: "test-factory" });
      // Pino exposes bindings containing the name
      const bindings = logger.bindings();
      expect(bindings.name).toBe("test-factory");
    });

    it("createLogger supports custom redact paths", () => {
      // Should not throw when creating with extra paths
      const logger = createLogger({
        name: "custom-redact",
        redactPaths: ["customSecret", "*.customSecret"],
      });
      expect(logger).toBeDefined();
      expect(typeof logger.info).toBe("function");
      expect(typeof logger.audit).toBe("function");
    });
  });

  describe("dev mode", () => {
    it("creates logger with isDev=true without error", () => {
      // Dev mode uses pino-pretty transport -- just verify it doesn't throw
      const logger = createLogger({ name: "dev-test", isDev: true });
      expect(logger).toBeDefined();
      expect(typeof logger.info).toBe("function");
    });
  });

  describe("isValidLogLevel", () => {
    it("returns true for valid log levels", () => {
      for (const level of ["fatal", "error", "warn", "info", "audit", "debug", "trace", "silent"]) {
        expect(isValidLogLevel(level)).toBe(true);
      }
    });

    it('returns false for "verbose" (invalid level)', () => {
      expect(isValidLogLevel("verbose")).toBe(false);
    });

    it("returns false for empty string", () => {
      expect(isValidLogLevel("")).toBe(false);
    });

    it("returns false for arbitrary strings", () => {
      expect(isValidLogLevel("notALevel")).toBe(false);
      expect(isValidLogLevel("WARNING")).toBe(false);
      expect(isValidLogLevel("INFO")).toBe(false); // case-sensitive
    });
  });

  describe("multi-target transport compatibility", () => {
    it("createLogger with transport.targets does not throw", () => {
      const logger = createLogger({
        name: "multi-transport-test",
        transport: {
          targets: [
            {
              target: "pino/file",
              options: { destination: 1 },
            },
          ],
        },
      });
      expect(logger).toBeDefined();
      expect(typeof logger.info).toBe("function");
      expect(typeof logger.audit).toBe("function");
    });

    it("createLogger with single transport preserves level formatter", () => {
      const logger = createLogger({
        name: "single-transport-test",
        isDev: true,
      });
      expect(logger).toBeDefined();
      expect(typeof logger.info).toBe("function");
    });
  });

  describe("mixin function plumbing", () => {
    it("mixin function injects fields into every log line", async () => {
      const { default: pino } = await import("pino");
      const capture = captureOutput();

      const logger = pino(
        {
          name: "mixin-test",
          level: "trace",
          mixin: () => ({ traceId: "abc-123", module: "gateway" }),
          formatters: {
            level(label: string, number: number) {
              return { level: label, levelValue: number };
            },
          },
        },
        capture.stream,
      );

      logger.info({ durationMs: 42 }, "test with mixin");

      const lines = capture.lines();
      expect(lines).toHaveLength(1);
      expect(lines[0]!.traceId).toBe("abc-123");
      expect(lines[0]!.module).toBe("gateway");
      expect(lines[0]!.durationMs).toBe(42);
    });
  });

  // The helpers above rebuild Pino by hand and bypass createLogger(), leaving
  // the factory's optional-mixin wiring and the err-serializer's non-Error
  // fallback unexercised. These drive createLogger() DIRECTLY.
  // `regexRedactInTransport: false` skips the worker-thread transport (sync
  // stdout, no async teardown) while keeping the structured censor + serializers
  // installed.
  describe("createLogger factory wiring (mixin + err-serializer)", () => {
    it("threads a provided mixin through the factory", () => {
      const mixin = vi.fn(() => ({ traceId: "trace-xyz" }));
      const logger = createLogger({ name: "mixin-factory", regexRedactInTransport: false, mixin });
      // Pino runs the mixin in-process when building each enabled log line.
      logger.info({ durationMs: 7 }, "with factory mixin");
      expect(mixin).toHaveBeenCalled();
    });

    it("err-serializer passes a non-Error err through without throwing", () => {
      // Default redaction stays on, so the err serializer is installed. A
      // non-Error err value must hit the `return err as Record<…>` fallback
      // (not the Error message/stack redaction branch) and never throw.
      const logger = createLogger({ name: "err-nonerror", regexRedactInTransport: false });
      expect(() => logger.error({ err: "plain-string-not-an-error" }, "boom")).not.toThrow();
      expect(() => logger.error({ err: { code: "EACCES" } }, "boom-obj")).not.toThrow();
    });
  });

  describe("createLogger level option", () => {
    it("respects level option", () => {
      const logger = createLogger({ name: "level-test", level: "debug" });
      expect(logger.level).toBe("debug");
    });

    it("defaults to info level when not specified", () => {
      const logger = createLogger({ name: "default-level-test" });
      expect(logger.level).toBe("info");
    });
  });

  describe("createLogger redaction output", () => {
    it("redacts apiKey field in output", async () => {
      const { default: pino } = await import("pino");
      const capture = captureOutput();

      const logger = pino(
        {
          name: "redact-factory-test",
          level: "trace",
          redact: {
            paths: ["apiKey", "*.apiKey"],
            censor: "[REDACTED]",
          },
        },
        capture.stream,
      );

      logger.info({ apiKey: "sk-secret-value-12345", user: "alice" }, "redaction test");

      const lines = capture.lines();
      expect(lines).toHaveLength(1);
      expect(lines[0]!.apiKey).toBe("[REDACTED]");
      expect(lines[0]!.user).toBe("alice");
    });
  });

  // -----------------------------------------------------------------
  // Edge-keeping censor + transport-shim wiring.
  // -----------------------------------------------------------------

  describe("createLogger censor + transport (factory shape)", () => {
    it("createLogger with disableRedaction:true produces a logger that does not crash", () => {
      // The residency-test harness flips this flag; production source
      // is FORBIDDEN from setting it (architecture invariant). This
      // test only proves the flag does not crash the factory.
      const logger = createLogger({
        name: "residency-test-shape",
        disableRedaction: true,
      });
      expect(logger).toBeDefined();
      expect(typeof logger.info).toBe("function");
    });

    it("createLogger with regexRedactInTransport:false produces a logger that does not crash", () => {
      const logger = createLogger({
        name: "skip-transport-shape",
        regexRedactInTransport: false,
      });
      expect(logger).toBeDefined();
      expect(typeof logger.info).toBe("function");
    });

    it("createLogger with an explicit transport overrides the default redact transport", () => {
      const logger = createLogger({
        name: "custom-transport-shape",
        transport: {
          targets: [
            {
              target: "pino/file",
              options: { destination: 1 },
            },
          ],
        },
      });
      expect(logger).toBeDefined();
      expect(typeof logger.info).toBe("function");
    });
  });

  describe("edge-keeping censor — applies maskToken to string secrets", () => {
    // The factory-built logger wires a Pino transport at
    // `@comis/infra/dist/logging/redact-transport.js`, which Pino runs
    // in a worker thread. The worker is heavyweight and asynchronous;
    // these tests instead instantiate Pino directly with the same
    // censor function to verify the value-mapping shape — that is the
    // load-bearing contract. Worker-thread plumbing is covered by the
    // integration smoke in test/integration/secret-rpc-residency.
    async function makeMaskingLogger() {
      const { default: pino } = await import("pino");
      // Load maskToken via the EDGE-KEEPING SUBPATH (not the package
      // barrel) — Node 22 rejects require()-of-ESM when the resolved
      // module is part of a package-level cycle. The edge-keeping
      // module is a pure-function leaf and has no static imports of
      // @comis/infra, so subpath-direct loading sidesteps the cycle.
      // Mirrors the production resolution in `logger.ts`.
      const edgeKeeping = await import(
        "@comis/observability/dist/redact/edge-keeping.js"
      );
      const { maskToken } = edgeKeeping;
      const capture = captureOutput();
      const logger = pino(
        {
          name: "mask-token-test",
          level: "trace",
          redact: {
            paths: ["apiKey", "token", "password", "*.apiKey"],
            censor: (value: unknown): string =>
              // eslint-disable-next-line no-restricted-syntax -- test mirror of production censor's non-string fallback
              typeof value === "string" ? maskToken(value) : "[REDACTED]",
          },
          formatters: {
            level(label: string, number: number) {
              return { level: label, levelValue: number };
            },
          },
        },
        capture.stream,
      );
      return { logger, capture };
    }

    it("masks an 18+ char token with the edge-keeping shape (not the literal '[REDACTED]')", async () => {
      const { logger, capture } = await makeMaskingLogger();
      logger.info({ apiKey: "sk-1234567890abcdef" }, "long-token");

      const lines = capture.lines();
      expect(lines).toHaveLength(1);
      const censored = lines[0]!.apiKey as string;
      // The plaintext is gone.
      expect(censored).not.toBe("sk-1234567890abcdef");
      // The censor produced an edge-mask, not the literal "[REDACTED]".
      expect(censored).not.toBe("[REDACTED]");
      // The "sk-" prefix survives the head window (keepStart=6).
      expect(censored.startsWith("sk-")).toBe(true);
      // The U+2026 ellipsis appears in the middle.
      expect(censored.includes("…")).toBe(true);
    });

    it("collapses sub-18-char tokens to the '***' short-token sentinel", async () => {
      const { logger, capture } = await makeMaskingLogger();
      logger.info({ apiKey: "short" }, "short-token");

      const lines = capture.lines();
      expect(lines).toHaveLength(1);
      expect(lines[0]!.apiKey).toBe("***");
    });

    it("non-string credential values fall back to the literal '[REDACTED]' sentinel", async () => {
      const { logger, capture } = await makeMaskingLogger();
      // A boolean under a credential-keyed field — censor's non-string
      // branch fires.
      logger.info({ apiKey: true, password: 42 }, "non-string");

      const lines = capture.lines();
      expect(lines).toHaveLength(1);
      expect(lines[0]!.apiKey).toBe("[REDACTED]");
      expect(lines[0]!.password).toBe("[REDACTED]");
    });
  });

  // ---------------------------------------------------------------------
  // CREDENTIAL_KEYS-driven redaction
  //
  // These tests exercise the PRODUCTION `DEFAULT_REDACT_PATHS` exported
  // from `./logger.js` (NOT the hand-coded list in `createTestLogger`).
  // The pre-fix `DEFAULT_REDACT_PATHS` is a 64-entry hand-table missing
  // every snake_case OAuth key + bare `auth` + `client_secret`; post-fix
  // it is generated from `@comis/observability`'s `CREDENTIAL_KEYS` Set,
  // which widens to include BOTH snake_case AND camelCase forms (Pino
  // redact.paths is case-sensitive). The regression suite below proves
  // the camelCase coverage is preserved across the swap.
  // ---------------------------------------------------------------------
  describe("CREDENTIAL_KEYS-driven redaction", () => {
    // Build a Pino logger using the PRODUCTION `DEFAULT_REDACT_PATHS`
    // imported from `./logger.js`. Writes to an in-memory stream so
    // the test stays in-process (no worker-thread transport).
    async function makeProductionPathsLogger() {
      const { default: pino } = await import("pino");
      const capture = captureOutput();
      const logger = pino(
        {
          name: "redact-paths-test",
          level: "trace",
          redact: {
            paths: DEFAULT_REDACT_PATHS,
            censor: "[REDACTED]",
          },
          formatters: {
            level(label: string, number: number) {
              return { level: label, levelValue: number };
            },
          },
        },
        capture.stream,
      );
      return { logger, capture };
    }

    // Build a payload with `field: value` at the requested nesting depth.
    // depth 0: { [field]: value }
    // depth 1: { wrap: { [field]: value } }
    // depth 2: { wrap: { wrap: { [field]: value } } }
    // depth 3: { wrap: { wrap: { wrap: { [field]: value } } } }
    function buildNested(
      field: string,
      value: string,
      depth: number,
    ): Record<string, unknown> {
      let result: Record<string, unknown> = { [field]: value };
      for (let i = 0; i < depth; i++) {
        result = { wrap: result };
      }
      return result;
    }

    // Emit one log line carrying `field` at the requested nesting depth,
    // parse the captured JSON, and return the value at that depth (which
    // Pino either passes through unchanged or replaces with its
    // redaction marker).
    async function redactAtDepth(
      field: string,
      value: string,
      depth: 0 | 1 | 2 | 3,
    ): Promise<unknown> {
      const { logger, capture } = await makeProductionPathsLogger();
      logger.info(buildNested(field, value, depth), "test-msg");
      const lines = capture.lines();
      expect(lines).toHaveLength(1);
      let node: Record<string, unknown> | undefined = lines[0];
      for (let i = 0; i < depth; i++) {
        node = node?.["wrap"] as Record<string, unknown> | undefined;
      }
      return node?.[field];
    }

    const SNAKE_CASE_KEYS = [
      "access_token",
      "refresh_token",
      "api_key",
      "bot_token",
      "webhook_secret",
      "private_key",
      "auth",
      "client_secret",
    ] as const;

    const CAMEL_CASE_KEYS = [
      "apiKey",
      "botToken",
      "accessToken",
      "refreshToken",
      "privateKey",
      "webhookSecret",
      "clientSecret",
      "accessKey",
      "connectionString",
    ] as const;

    const WIDENING_KEYS = ["credentials", "passphrase", "key"] as const;

    const ALLOWLIST_KEYS = [
      "keyName",
      "cacheKey",
      "sessionKey",
      "eventKey",
    ] as const;

    for (const key of SNAKE_CASE_KEYS) {
      for (const depth of [0, 1, 2, 3] as const) {
        it(`redacts snake_case ${key} at depth ${depth}`, async () => {
          const result = await redactAtDepth(
            key,
            "SHOULD-BE-REDACTED",
            depth,
          );
          // Pino's structured-field censor replaces the value; the
          // exact masked form may be the literal "[REDACTED]" (in
          // this test) or an edge-keeping mask (in the production
          // factory). The invariant is that the plaintext is gone.
          expect(result).not.toBe("SHOULD-BE-REDACTED");
        });
      }
    }

    for (const key of CAMEL_CASE_KEYS) {
      for (const depth of [0, 1, 2, 3] as const) {
        it(`(regression) redacts camelCase ${key} at depth ${depth}`, async () => {
          const result = await redactAtDepth(
            key,
            "SHOULD-BE-REDACTED",
            depth,
          );
          expect(result).not.toBe("SHOULD-BE-REDACTED");
        });
      }
    }

    for (const key of WIDENING_KEYS) {
      it(`redacts widening key ${key} at depth 0`, async () => {
        const result = await redactAtDepth(key, "SHOULD-BE-REDACTED", 0);
        expect(result).not.toBe("SHOULD-BE-REDACTED");
      });
    }

    for (const key of ALLOWLIST_KEYS) {
      it(`(allowlist) does NOT redact ${key} at depth 0`, async () => {
        // Allowlist key value passes through unchanged. These names
        // are absent from CREDENTIAL_KEYS, so Pino has no path entry
        // for them and the value is emitted verbatim.
        const result = await redactAtDepth(key, "SAFE-VALUE", 0);
        expect(result).toBe("SAFE-VALUE");
      });
    }
  });
});

// ---------------------------------------------------------------------------
// log redaction — multi-target transport and err serializer
//
// These tests write to a temp file via createLogger with a multi-target
// transport mirroring the daemon's createFileTransport structure, then
// assert that credential bodies are masked before hitting the file.
// ---------------------------------------------------------------------------
describe("log redaction — multi-target transport and err serializer", () => {
  let tmpDir: string;
  let logFile: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "comis-redact-test-"));
    logFile = join(tmpDir, "test.log");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("multi-target file transport masks Bearer hf_<44+> in errorText, msg, and argsPreview fields; env-ref passes through", { timeout: 12000 }, async () => {
    const HF_TOKEN = "hf_" + "A".repeat(44);
    const ENV_REF = "${HF_TOKEN}"; // must NOT be masked

    const logger = createLogger({
      name: "redact-test",
      // Mirror the daemon's createFileTransport structure:
      // Each target is expressed as a pipeline (stage → destination), matching
      // the correct pino API for chaining a Transform upstream of a Writable.
      transport: {
        targets: [
          {
            // File target with upstream redact stage
            pipeline: [
              { target: "@comis/infra/dist/logging/pipeline-redact-stage.js" },
              { target: "pino/file", options: { destination: logFile } },
            ],
          },
          // Stdout target for visual verification (no assertion on stdout content)
          { target: "pino/file", options: { destination: 1 } },
        ],
      },
    });

    logger.error({ errorText: `auth failed: Bearer ${HF_TOKEN}` }, "redact errorText test");
    logger.info({ msg: `token is ${HF_TOKEN}` }, "redact msg test");
    // argsPreview is a must-mask field (exec/tool arg previews).
    logger.info({ argsPreview: `run --auth Bearer ${HF_TOKEN}` }, "redact argsPreview test");
    logger.info({ msg: `ref is ${ENV_REF}` }, "env-ref pass-through test");

    // Allow transport worker thread(s) to flush.
    // Pipeline transports spawn a chain of worker threads; they need more time
    // than a simple single-target transport to flush to disk. A bare
    // `content.length > 0` check RACES: the error line is logged first, so on a
    // loaded runner the loop breaks the instant that one line lands while the
    // later `info` lines (including the env-ref line, logged LAST) are still in
    // the pipeline worker's buffer — and the `toContain(ENV_REF)` assertion then
    // fails against a partial file. Poll until BOTH lines whose *presence* we
    // assert (argsPreview, logged 3rd; env-ref, logged 4th/last) have flushed,
    // so all four records are on disk before we assert. The deadline backstops.
    const deadline = Date.now() + 8000;
    let content = "";
    while (Date.now() < deadline) {
      try {
        content = await readFile(logFile, "utf8");
        if (content.includes(ENV_REF) && content.includes("argsPreview")) break;
      } catch {
        // File not yet created by the pipeline worker — keep polling
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(content).not.toContain(HF_TOKEN); // raw token must be masked (covers errorText, msg, AND argsPreview)
    expect(content).toContain(ENV_REF); // env-ref must pass through
    expect(content).toContain("argsPreview"); // the argsPreview line was written through the stage (field key survives; value masked above)
  });

  it("serializers.err scrubs hf_ token from err.message and err.stack", { timeout: 8000 }, async () => {
    const HF_TOKEN = "hf_" + "B".repeat(44);
    const err = new Error(`auth failed token=${HF_TOKEN}`);

    const logger = createLogger({
      name: "err-serializer-test",
      transport: {
        targets: [{ target: "pino/file", options: { destination: logFile } }],
      },
    });

    logger.error({ err }, "err serializer test");

    // Poll until a COMPLETE record has flushed (worker thread may take time to
    // start). A bare `content.length > 0` check can break mid-write, so the
    // absence assertion could pass against a truncated line that hasn't reached
    // the token yet — a false pass that would hide a redaction regression. Wait
    // for the trailing newline that terminates a full JSON record.
    const deadline = Date.now() + 5000;
    let content = "";
    while (Date.now() < deadline) {
      try {
        content = await readFile(logFile, "utf8");
        if (content.includes("\n")) break;
      } catch {
        // File not yet created — keep polling
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(content).not.toContain(HF_TOKEN);
  });
});

// ── regression: pipeline-redact-stage must preserve line delimiters ──

describe("pipeline-redact-stage preserves newline-delimited JSON lines", () => {
  let tmpDir: string;
  let logFile: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "comis-redact-line-test-"));
    logFile = join(tmpDir, "redact-line.log");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("three log records produce three newline-terminated individually JSON-parseable lines", { timeout: 15000 }, async () => {
    // Each yielded string gets "\n" appended so records are written as
    // newline-delimited JSON rather than concatenated into one blob.

    const logger = createLogger({
      name: "redact-line-test",
      transport: {
        pipeline: [
          { target: "@comis/infra/dist/logging/pipeline-redact-stage.js" },
          { target: "pino/file", options: { destination: logFile } },
        ],
      },
    });

    logger.info({ step: "one" }, "redact-line one");
    logger.info({ step: "two" }, "redact-line two");
    logger.info({ step: "three" }, "redact-line three");

    // Poll until all 3 records are flushed (worker threads need time to start and flush).
    const deadline = Date.now() + 10000;
    let content = "";
    while (Date.now() < deadline) {
      try {
        content = await readFile(logFile, "utf8");
        // Wait until at least 3 "redact-line" substrings appear so we know all records landed
        if ((content.match(/redact-line/g) ?? []).length >= 3) break;
      } catch {
        // File not yet created — keep polling
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    // Split on \n to get lines (ignoring trailing empty string after final \n)
    const rawLines = content.split("\n").filter((l) => l.trim().length > 0);

    // ASSERT 1: exactly 3 lines
    expect(rawLines.length, "expected 3 newline-delimited lines, got a concatenated blob").toBe(3);

    // ASSERT 2: each line is individually JSON-parseable
    for (const line of rawLines) {
      expect(() => JSON.parse(line), `line is not valid JSON: ${line.substring(0, 80)}`).not.toThrow();
    }

    // ASSERT 3: each parsed record has the expected msg field
    const parsed = rawLines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(parsed.map((r) => r["msg"])).toEqual(
      expect.arrayContaining(["redact-line one", "redact-line two", "redact-line three"]),
    );
  });
});
