import pino from "pino";
import type { TransportMultiOptions, TransportSingleOptions } from "pino";

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
}

/**
 * Custom audit log level value.
 * Sits between info (30) and warn (40) -- important operational events
 * that should always be logged but are not warnings.
 */
const AUDIT_LEVEL_VALUE = 35;

/**
 * Comis logger type: standard Pino logger with an additional `audit` method.
 */
export type ComisLogger = pino.Logger<"audit"> & { audit: pino.LogFn };

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
    redact: {
      paths: allRedactPaths,
      censor: "[REDACTED]",
    },
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

  return pino<"audit">(pinoOptions) as ComisLogger;
}
