// SPDX-License-Identifier: Apache-2.0
import pino from "pino";
import type { TransportMultiOptions, TransportSingleOptions } from "pino";
import type { ComisLogger as CoreComisLogger } from "@comis/core";

/**
 * Default paths to redact from all log output.
 *
 * Uses Pino's fast-redact under the hood (compiled once, amortized O(1)).
 * Covers common credential field names at any nesting depth up to 4 levels.
 */
const DEFAULT_REDACT_PATHS: string[] = [
  // Top-level
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
  // Expanded credential patterns
  "key",
  "passphrase",
  "connectionString",
  "accessKey",
  // HTTP cookies and webhook signing secrets
  "cookie",
  "webhookSecret",
  // Nested one level (e.g., headers.authorization)
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
  // Expanded credential patterns
  "*.key",
  "*.passphrase",
  "*.connectionString",
  "*.accessKey",
  // HTTP cookies and webhook signing secrets
  "*.cookie",
  "*.webhookSecret",
  // Nested two levels (e.g., config.telegram.botToken)
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
  // Expanded credential patterns
  "*.*.key",
  "*.*.passphrase",
  "*.*.connectionString",
  "*.*.accessKey",
  // HTTP cookies and webhook signing secrets
  "*.*.cookie",
  "*.*.webhookSecret",
  // Nested three levels (e.g., response.config.channels.botToken)
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
  "*.*.*.key",
  "*.*.*.passphrase",
  "*.*.*.connectionString",
  "*.*.*.accessKey",
  // HTTP cookies and webhook signing secrets
  "*.*.*.cookie",
  "*.*.*.webhookSecret",
];

/**
 * Options for creating an Comis logger.
 */
export interface LoggerOptions {
  /** Logger name, included in every log line. */
  name: string;
  /** Minimum log level. Defaults to "info". */
  level?: string;
  /** Enable pretty printing for development. Defaults to false. */
  isDev?: boolean;
  /** Additional paths to redact beyond the defaults. */
  redactPaths?: string[];
  /** Optional mixin function that injects fields into every log line. */
  mixin?: () => Record<string, unknown>;
  /** Multi-target transport config. Takes precedence over isDev pino-pretty. */
  transport?: TransportMultiOptions | TransportSingleOptions;
  /**
   * Disable Pino redaction entirely. ONLY for residency tests where the
   * test must observe that secret values truly do not appear in logs;
   * production must NEVER set this. An architecture test in
   * `test/architecture/source-rules.test.ts` enforces this contract by
   * source-grep on `packages/*\/src/**\/*.ts`.
   *
   * Consumer: only `test/integration/secret-rpc-residency.test.ts` sets
   * this to `true` via the test daemon harness.
   */
  disableRedaction?: boolean;
}

/**
 * Custom audit log level value.
 * Sits between info (30) and warn (40) -- important operational events
 * that should always be logged but are not warnings.
 */
const AUDIT_LEVEL_VALUE = 35;

/**
 * Comis logger type.
 *
 * Aliases the Pino-free structural contract in @comis/core. The Pino-backed
 * runtime impl returned by `createLogger()`
 * (`pino.Logger<"audit"> & { audit: pino.LogFn }`) remains assignable to
 * this contract; the proof lives at
 * `packages/infra/src/logging/__tests__/logger-contract.type-check.ts` via
 * `expectTypeOf<PinoComisLogger>().toExtend<CoreComisLogger>()`. The matcher
 * call uses `.toExtend(...)` — `toMatchTypeOf` was deprecated in
 * expect-type@1.2.0; expect-type@1.3.0 ships with Vitest 4.1.5.
 */
export type ComisLogger = CoreComisLogger;

/**
 * Create an Comis logger with credential redaction and audit level.
 *
 * Features:
 * - Credential redaction via Pino's fast-redact (apiKey, token, password, etc.)
 * - Custom "audit" level (35) between info and warn
 * - ISO timestamps
 * - Child logger support (inherits redaction config)
 * - Dev-mode pretty printing via pino-pretty
 *
 * @param options - Logger configuration
 * @returns A configured Pino logger with audit level
 */
export function createLogger(options: LoggerOptions): ComisLogger {
  const { name, level = "info", isDev = false, redactPaths = [], mixin, transport } = options;

  const allRedactPaths = [...DEFAULT_REDACT_PATHS, ...redactPaths];

  // Pino v10 forbids formatters.level with transport.targets (worker thread
  // transports receive raw numeric levels, formatters don't apply).
  const isMultiTransport = transport && "targets" in transport;

  const pinoOptions: pino.LoggerOptions<"audit"> = {
    name,
    level,
    customLevels: {
      audit: AUDIT_LEVEL_VALUE,
    },
    // When the residency-test harness sets `options.disableRedaction`
    // (see LoggerOptions JSDoc above), emit `redact: undefined` so Pino
    // emits raw payloads and the test can observe that secrets truly do
    // not appear. Production must NEVER enable this flag; an architecture
    // invariant in `test/architecture/source-rules.test.ts` source-greps
    // the literal assignment form and fails the build on any
    // production-source match.
    redact: options.disableRedaction
      ? undefined
      : { paths: allRedactPaths, censor: "[REDACTED]" },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(isMultiTransport
      ? {}
      : {
          formatters: {
            level(label: string, number: number) {
              return { level: label, levelValue: number };
            },
          },
        }),
  };

  if (mixin) {
    pinoOptions.mixin = mixin;
  }

  if (transport) {
    pinoOptions.transport = transport;
  } else if (isDev) {
    pinoOptions.transport = {
      target: "pino-pretty",
      options: {
        colorize: true,
      },
    };
  }

  // Cast via unknown: Pino's `Logger<"audit">.child()` return type does
  // not statically project the `audit` method (Pino's TS types are
  // permissive about custom-level methods on child loggers), so direct
  // assignment to the structural CoreComisLogger contract trips
  // ts2352. The runtime behavior is correct (the `audit` method IS
  // present on every child logger because `customLevels: { audit: 35 }`
  // is inherited), and the assignability proof in
  // `__tests__/logger-contract.test.ts` guards the contract — but the
  // cast here must route through `unknown` to satisfy tsc.
  return pino<"audit">(pinoOptions) as unknown as ComisLogger;
}
