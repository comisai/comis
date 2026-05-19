// SPDX-License-Identifier: Apache-2.0
/**
 * Resolve the absolute filesystem path of the daemon-wide config
 * audit log (Plan 45-05 task 3).
 *
 * The log lives at `~/.comis/logs/config-audit.jsonl` by default;
 * the `COMIS_CONFIG_AUDIT_LOG` env var overrides the full path.
 *
 * The helper accepts a `homedir()` callback and a `getEnv(key)`
 * callback so tests and the daemon composition root can inject their
 * own clock-equivalent fakes without going through `os.homedir()`
 * + `systemGetEnv` directly. Production callers should pass
 * `os.homedir` and `systemGetEnv` (the sanctioned-root helper) per
 * AGENTS.md §2.2.
 *
 * @module
 */

import * as path from "node:path";

import { systemGetEnv } from "@comis/core";
import * as os from "node:os";

/** Env var name for the audit-log path override. */
export const CONFIG_AUDIT_LOG_ENV = "COMIS_CONFIG_AUDIT_LOG";

/** Default subpath under `~/.comis/`. */
const DEFAULT_RELATIVE_PATH = ["logs", "config-audit.jsonl"];

/**
 * Deps for `resolveConfigAuditLogPath`. Tests inject fakes; production
 * uses the module-level defaults (`os.homedir` + `systemGetEnv`).
 */
export interface ResolveLogPathDeps {
  homedir: () => string;
  getEnv: (key: string) => string | undefined;
}

const DEFAULT_DEPS: ResolveLogPathDeps = {
  homedir: () => os.homedir(),
  getEnv: (key) => systemGetEnv(key),
};

/**
 * Resolve the absolute filesystem path of the config-audit log.
 *
 * Precedence:
 *   1. `COMIS_CONFIG_AUDIT_LOG` env var when set to a non-empty value.
 *   2. `<homedir>/.comis/logs/config-audit.jsonl`.
 *
 * @param deps - optional injected `homedir` / `getEnv` fakes.
 * @returns absolute path to the config-audit log file.
 */
export function resolveConfigAuditLogPath(
  deps: ResolveLogPathDeps = DEFAULT_DEPS,
): string {
  const override = deps.getEnv(CONFIG_AUDIT_LOG_ENV);
  if (typeof override === "string" && override.length > 0) {
    return override;
  }
  return path.join(deps.homedir(), ".comis", ...DEFAULT_RELATIVE_PATH);
}
