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
 * Phase 35 Plan 35-02 (WEB-CONTRACTS-04). Wave A primitive — Wave B retargets
 * CLI consumers from @comis/infra → @comis/core for the cli → infra cut.
 *
 * @module
 */
import type { ComisLogger, LogMethod } from "./log-fields.js";

function emit(
  level: string,
  bindings: Record<string, unknown>,
  args: readonly unknown[],
): void {
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
    time: Date.now(),
    ...bindings,
    ...obj,
    msg,
  });
  process.stderr.write(line + "\n");
}

function method(level: string, bindings: Record<string, unknown>): LogMethod {
  return (...args: unknown[]) => emit(level, bindings, args);
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
    trace: method("trace", bindings),
    debug: method("debug", bindings),
    info: method("info", bindings),
    warn: method("warn", bindings),
    error: method("error", bindings),
    fatal: method("fatal", bindings),
    audit: method("audit", bindings),
    child(extraBindings: Record<string, unknown>): ComisLogger {
      return createConsoleLogger(level, { ...bindings, ...extraBindings });
    },
  };
  return logger;
}
