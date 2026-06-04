// SPDX-License-Identifier: Apache-2.0
/**
 * Pino-free console logger.
 *
 * Writes structured JSON lines to stderr. Satisfies the ComisLogger structural
 * contract from core/src/logging/log-fields.ts — drop-in replacement for
 * @comis/infra's Pino-backed createLogger() at CLI call sites.
 *
 * Redaction is NOT applied (the Pino-backed logger's redaction is its
 * runtime feature; the structural contract does not enforce it). CLI use
 * cases avoid logging credentials by construction.
 *
 * @module
 */
import type { ComisLogger, LogMethod } from "./log-fields.js";
import { systemNowMs } from "../runtime/system-time.js";

/**
 * Numeric severity per level — mirrors Pino's ordering (audit = 35, between
 * info and warn, matching @comis/infra's AUDIT_LEVEL_VALUE). `silent` is the
 * suppress-everything sentinel. A message emits only when its severity is at
 * or above the configured level's severity.
 */
const LEVEL_SEVERITY: Record<string, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  audit: 35,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: Number.POSITIVE_INFINITY,
};

/**
 * Resolve a level name to its numeric severity. An unknown CONFIGURED level
 * resolves to 0 (fail-open — never silently drop logs because of a typo'd
 * level); message levels are always one of the fixed method names above.
 */
function severityOf(level: string): number {
  return LEVEL_SEVERITY[level] ?? 0;
}

function emit(
  level: string,
  configuredLevel: string,
  bindings: Record<string, unknown>,
  args: readonly unknown[],
): void {
  // Severity gate: drop messages below the configured level (e.g. debug/info
  // when the logger is set to "warn"). Reads the CURRENT configured level on
  // every call so runtime `.level` changes take effect immediately.
  if (severityOf(level) < severityOf(configuredLevel)) {
    return;
  }
  let obj: Record<string, unknown> = {};
  let msg: string | undefined;
  if (args.length > 0 && typeof args[0] === "object" && args[0] !== null) {
    obj = { ...(args[0] as Record<string, unknown>) };
    if (typeof args[1] === "string") msg = args[1];
  } else if (typeof args[0] === "string") {
    msg = args[0];
  }
  const line = JSON.stringify({
    level,
    time: systemNowMs(),
    ...bindings,
    ...obj,
    msg,
  });
  process.stderr.write(line + "\n");
}

function method(
  level: string,
  getConfiguredLevel: () => string,
  bindings: Record<string, unknown>,
): LogMethod {
  return (...args: unknown[]) => emit(level, getConfiguredLevel(), bindings, args);
}

export function createConsoleLogger(
  initialLevel: string = "info",
  initialBindings: Record<string, unknown> = {},
): ComisLogger {
  let level = initialLevel;
  const bindings = { ...initialBindings };

  const logger: ComisLogger = {
    get level(): string {
      return level;
    },
    set level(l: string) {
      level = l;
    },
    trace: method("trace", () => level, bindings),
    debug: method("debug", () => level, bindings),
    info: method("info", () => level, bindings),
    warn: method("warn", () => level, bindings),
    error: method("error", () => level, bindings),
    fatal: method("fatal", () => level, bindings),
    audit: method("audit", () => level, bindings),
    child(extraBindings: Record<string, unknown>): ComisLogger {
      return createConsoleLogger(level, { ...bindings, ...extraBindings });
    },
  };
  return logger;
}
