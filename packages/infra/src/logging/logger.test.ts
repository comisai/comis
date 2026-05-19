// SPDX-License-Identifier: Apache-2.0
import { Writable } from "node:stream";
import { describe, it, expect } from "vitest";
import { createLogger } from "./logger.js";
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
});
