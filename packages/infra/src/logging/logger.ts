// SPDX-License-Identifier: Apache-2.0
import { createRequire } from "node:module";
import pino from "pino";
import type { TransportMultiOptions, TransportSingleOptions } from "pino";
import type { ComisLogger as CoreComisLogger } from "@comis/core";
import { CREDENTIAL_KEYS, redactSecretsInText } from "@comis/observability";

// `maskToken` is loaded via createRequire on the EDGE-KEEPING SUBPATH
// (not the package barrel) to defeat the cyclic-package cycle detection
// that Node 22's require()-of-ESM emits when the package graph itself
// has a cycle (@comis/observability already depends on @comis/infra for
// appendRegularFile + O_NOFOLLOW helpers).
//
// The subpath `@comis/observability/dist/redact/edge-keeping.js` is a
// pure-function leaf module with no static imports of @comis/infra,
// so Node sees no cycle when loading it specifically (even though the
// package graph as a whole is cyclic). The subpath is declared in
// `packages/observability/package.json` `exports`.
//
// createRequire defers resolution to module-load time, at which point
// both dist trees exist (sequential build: infra first, then
// observability against infra's dist).
const _edgeKeeping = createRequire(import.meta.url)(
  "@comis/observability/dist/redact/edge-keeping.js",
) as { maskToken: (input: string) => string };
const maskToken = _edgeKeeping.maskToken;

/**
 * Maximum nesting depth at which we apply redaction.
 *
 * Matches the CLAUDE.md "Logging" section guidance: "Pino auto-redacts
 * credentials … up to 3 levels deep". Generates paths at depths 0..3
 * inclusive (4 lanes total per credential key).
 */
const REDACT_MAX_DEPTH = 3;

/**
 * Build the Pino redact.paths array by generating one path per
 * (depth, key) tuple. Runs once at module init.
 *
 * Coupling: keys come from `@comis/observability`'s `CREDENTIAL_KEYS`
 * (single source of truth shared with the diagnostic-payload sanitizer
 * via `isCredentialFieldName`). Any future credential key added to
 * that Set auto-redacts at every nesting depth — there is nothing to
 * keep in sync here.
 *
 * NOTE: Pino's `redact.paths` matcher is CASE-SENSITIVE. `CREDENTIAL_KEYS`
 * therefore intentionally contains BOTH snake_case AND camelCase forms
 * for every multi-word entry (see sanitize-diagnostic-payload.ts header
 * comment on the Set's three-lane structure). The `isCredentialFieldName`
 * predicate inside the sanitizer uses lowercase-compare and is
 * unaffected by the duplication.
 */
function generateRedactPaths(
  keys: ReadonlySet<string>,
  maxDepth: number,
): string[] {
  const out: string[] = [];
  for (let depth = 0; depth <= maxDepth; depth++) {
    const prefix = "*.".repeat(depth);
    for (const key of keys) {
      out.push(`${prefix}${key}`);
    }
  }
  return out;
}

/**
 * Default paths to redact from all log output.
 *
 * Uses Pino's fast-redact under the hood (compiled once, amortized O(1)).
 * Covers every key in `@comis/observability`'s `CREDENTIAL_KEYS` set at
 * every nesting depth up to {@link REDACT_MAX_DEPTH} levels.
 *
 * Exported (test affordance) so the end-to-end Pino redaction tests in
 * `logger.test.ts` can exercise the production path list directly — keeps
 * the test honest about what is actually wired into the factory.
 */
export const DEFAULT_REDACT_PATHS: string[] = generateRedactPaths(
  CREDENTIAL_KEYS,
  REDACT_MAX_DEPTH,
);

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
  /**
   * Disable the Pino regex-redact transport.
   *
   * The transport runs the free-form regex pass (`redactSecretsInText`)
   * over every JSON log line; structured-field redaction (Pino's
   * fast-redact `redact:` config) is unchanged. Set this to `false` to
   * keep the structured censor active but skip the transport — useful
   * for tests that compare raw JSON output without the regex pass.
   *
   * Defaults to `true` (transport enabled). When `disableRedaction` is
   * `true`, this flag has no effect — the transport is also skipped to
   * preserve the residency-test invariant.
   */
  regexRedactInTransport?: boolean;
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
    //
    // The censor is a callback that applies maskToken (edge-keeping
    // mask: "sk-123...cdef") for string values, preserving correlation-
    // token utility while never re-leaking the body. Non-string values
    // fall back to the literal "[REDACTED]" — that is the ONE sanctioned
    // use of the literal in production source, narrowed to this exact
    // call site via an eslint-disable annotation (see eslint.config.js
    // and test/architecture/source-rules.test.ts).
    redact: options.disableRedaction
      ? undefined
      : {
          paths: allRedactPaths,
          censor: (value: unknown): string => {
            if (typeof value === "string") return maskToken(value);
            // eslint-disable-next-line no-restricted-syntax -- non-string Pino censor fallback (sanctioned literal)
            return "[REDACTED]";
          },
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

  // Serializer for err objects: redact credential bodies from err.message and err.stack.
  // Pino's structured-field fast-redact (above) only covers named key paths; err.message
  // and err.stack are unstructured text that bypass it entirely. This serializer applies
  // the same free-form regex pass (`redactSecretsInText`) to both fields before Pino
  // serializes the err object to JSON — covering all `logger.xxx({ err }, "…")` call sites.
  //
  // Gated on !options.disableRedaction to preserve the residency-test invariant (the
  // harness enables that flag so raw values appear in logs for test assertion).
  if (!options.disableRedaction) {
    pinoOptions.serializers = {
      err: (err: unknown) => {
        if (err instanceof Error) {
          return {
            message: redactSecretsInText(err.message),
            stack: err.stack ? redactSecretsInText(err.stack) : undefined,
            name: err.name,
          };
        }
        return err as Record<string, unknown>;
      },
    };
  }

  // Transport selection:
  //   1. Explicit `transport` option wins (caller knows what they want).
  //   2. Dev mode → pino-pretty for terminal output.
  //   3. Production default → redact transport target via the
  //      @comis/infra resolution shim. The transport runs
  //      `redactSecretsInText` over every JSON log line (free-form
  //      regex pass) as a second-line defense for credential bodies
  //      that survived the structured-field censor above.
  //
  // The redact transport is skipped when (a) the caller disables
  // redaction entirely (residency test harness) or (b) the caller
  // explicitly opts out via `regexRedactInTransport: false`.
  if (transport) {
    pinoOptions.transport = transport;
  } else if (isDev) {
    pinoOptions.transport = {
      target: "pino-pretty",
      options: {
        colorize: true,
      },
    };
  } else if (!options.disableRedaction && options.regexRedactInTransport !== false) {
    pinoOptions.transport = {
      target: "@comis/infra/dist/logging/redact-transport.js",
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
