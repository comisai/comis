// SPDX-License-Identifier: Apache-2.0
/**
 * Daemon supervisor auto-detection + control for `comis config tooling-fill`.
 *
 * Detection order (TOOLFILL-3 / D-2 — first hit wins):
 *   1. `systemctl is-active comis`     → {kind: "systemd"}
 *   2. `pm2 jlist` containing comis    → {kind: "pm2"}
 *   3. `pgrep -f 'node.*daemon\.js'`   → {kind: "bare-process"}
 *   4. nothing matched                 → {kind: "none"}
 *
 * The operator can override with `--restart-cmd "<full stop+start>"` —
 * the orchestrator (Wave 2) constructs `{kind: "manual", cmd}`. This
 * module never builds a manual entry on its own.
 *
 * MUST use `promisify(execFile)` — the synchronous variants deadlock
 * the in-process daemon harness (Plan 25-04 Rule 1 lesson).
 *
 * All shell-outs route through `bash -c "<cmd>"` so the systemd /
 * pm2 / pkill / operator-supplied commands have a uniform launch path.
 * The argv list passed to `execFileAsync` is fixed (`["bash","-c",cmd]`)
 * — operator-controlled shell expansion only happens inside `<cmd>`,
 * which is operator-trusted (T-26-04: operator IS root for their own
 * daemon, accept). Each command carries a 10s timeout that SIGKILLs on
 * elapse; ETIMEDOUT maps to err({kind:"timeout"}).
 *
 * @module
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ok, err, type Result } from "@comis/shared";

const execFileAsync = promisify(execFile);
const DEFAULT_CMD_TIMEOUT_MS = 10_000;

export type Supervisor =
  | { kind: "systemd" }
  | { kind: "pm2" }
  | { kind: "bare-process" }
  | { kind: "manual"; cmd: string }
  | { kind: "none" };

export type SupervisorErrorKind =
  | "command-failed"
  | "timeout"
  | "unsupported"
  | "detection-failed";

export interface SupervisorError {
  readonly kind: SupervisorErrorKind;
  readonly message: string;
  readonly cause?: string;
}

/**
 * Canonical TOOLFILL-3 manual recipe — emitted on `{kind:"none"}` from
 * `stopDaemon` / `startDaemon`. The orchestrator surfaces this to stderr
 * (the helper itself is pure of console output per the plan's "must_haves
 * truths" — orchestrator owns user-facing strings).
 */
export const MANUAL_RECIPE_HINT =
  "Could not auto-detect daemon supervisor (none of systemctl, pm2, pgrep matched). " +
  'Run manually: systemctl stop comis && <edit config.yaml> && systemctl start comis. ' +
  'Or pass --restart-cmd "<full stop+start command>" to override.';

/**
 * Probe systemd → pm2 → bare-process in order; return the first hit.
 *
 * Each probe uses `execFileAsync` with a 10s timeout. ENOENT (the binary
 * isn't installed) and non-zero exit codes both fall through to the next
 * probe — there is no distinction between "not running under this
 * supervisor" and "supervisor binary missing"; both map to "not me".
 *
 * @param timeoutMs - Per-probe timeout (default 10_000).
 */
export async function detectSupervisor(
  timeoutMs: number = DEFAULT_CMD_TIMEOUT_MS,
): Promise<Supervisor> {
  // 1. systemctl is-active comis — exit 0 + stdout startsWith "active"
  try {
    const { stdout } = await execFileAsync(
      "systemctl",
      ["is-active", "comis"],
      { timeout: timeoutMs },
    );
    if (stdout.trim().startsWith("active")) {
      return { kind: "systemd" };
    }
    // exit 0 but not "active" — fall through (e.g. "activating")
  } catch {
    // not systemd, or systemctl absent — fall through
  }

  // 2. pm2 jlist — JSON array containing {name: "comis"}
  try {
    const { stdout } = await execFileAsync("pm2", ["jlist"], {
      timeout: timeoutMs,
    });
    const list = JSON.parse(stdout) as Array<{ name?: string }>;
    if (Array.isArray(list) && list.some((p) => p.name === "comis")) {
      return { kind: "pm2" };
    }
  } catch {
    // not pm2 — fall through
  }

  // 3. pgrep -f 'node.*daemon\.js' — at least one PID
  try {
    const { stdout } = await execFileAsync(
      "pgrep",
      ["-f", "node.*daemon\\.js"],
      { timeout: timeoutMs },
    );
    if (stdout.trim().length > 0) {
      return { kind: "bare-process" };
    }
  } catch {
    // not running as bare process — fall through
  }

  return { kind: "none" };
}

/**
 * Run a shell command via `bash -c` with the given timeout.
 *
 * On success returns `ok(undefined)`. ETIMEDOUT (or SIGTERM/SIGKILL from
 * the timeout's kill signal) maps to err({kind:"timeout"}); any other
 * non-zero exit maps to err({kind:"command-failed"}). The cmd is echoed
 * back via `cause` so the orchestrator can render it in the failure
 * surface (the helper itself remains pure of console output).
 */
async function runShell(
  cmd: string,
  timeoutMs: number,
): Promise<Result<void, SupervisorError>> {
  try {
    await execFileAsync("bash", ["-c", cmd], { timeout: timeoutMs });
    return ok(undefined);
  } catch (e: unknown) {
    const errno = e as NodeJS.ErrnoException & { signal?: string };
    if (
      errno.code === "ETIMEDOUT" ||
      errno.signal === "SIGTERM" ||
      errno.signal === "SIGKILL"
    ) {
      return err({
        kind: "timeout",
        message: `Command exceeded ${timeoutMs}ms`,
        cause: cmd,
      });
    }
    return err({
      kind: "command-failed",
      message: errno.message ?? "Command failed",
      cause: cmd,
    });
  }
}

/**
 * Stop the daemon under the detected supervisor.
 *
 * - `systemd`        → `systemctl stop comis`
 * - `pm2`            → `pm2 stop comis`
 * - `bare-process`   → `pkill -f 'node.*daemon\.js'`
 * - `manual`         → run `s.cmd` verbatim via `bash -c`
 * - `none`           → err({kind:"detection-failed"}, MANUAL_RECIPE_HINT)
 */
export async function stopDaemon(
  s: Supervisor,
  timeoutMs: number = DEFAULT_CMD_TIMEOUT_MS,
): Promise<Result<void, SupervisorError>> {
  switch (s.kind) {
    case "systemd":
      return runShell("systemctl stop comis", timeoutMs);
    case "pm2":
      return runShell("pm2 stop comis", timeoutMs);
    case "bare-process":
      return runShell("pkill -f 'node.*daemon\\.js'", timeoutMs);
    case "manual":
      // CR-03 fix: --restart-cmd is documented as the operator's full
      // stop+start command. Running it BOTH at stopDaemon and startDaemon
      // would (a) effectively run "stop && start && stop && start" and
      // (b) leave the daemon UP during the file edit, violating the
      // TOOLFILL-9 protected window. Treat manual mode as start-only:
      // stopDaemon is a no-op; the operator's cmd runs once at startDaemon
      // time, after the file edit is complete. The "protected window"
      // guarantee weakens under --restart-cmd because we cannot invert
      // an arbitrary command — but the operator chose this path explicitly,
      // and the daemon does not watch config.yaml for changes (Phase 25
      // design), so a write during a still-running daemon is benign:
      // it just doesn't take effect until the operator's restart command
      // lands.
      return ok(undefined);
    case "none":
      return err({
        kind: "detection-failed",
        message: MANUAL_RECIPE_HINT,
      });
  }
}

/**
 * Start the daemon under the detected supervisor.
 *
 * - `systemd`        → `systemctl start comis`
 * - `pm2`            → `pm2 start comis`
 * - `bare-process`   → err({kind:"unsupported"}) — the operator's
 *                      original launch command is unknown to us
 *                      (foreground? background? --permission flags?);
 *                      they must pass `--restart-cmd` for a reliable
 *                      bare-process restart, or migrate to systemd/pm2.
 * - `manual`         → run `s.cmd` verbatim via `bash -c`
 * - `none`           → err({kind:"detection-failed"}, MANUAL_RECIPE_HINT)
 */
export async function startDaemon(
  s: Supervisor,
  timeoutMs: number = DEFAULT_CMD_TIMEOUT_MS,
): Promise<Result<void, SupervisorError>> {
  switch (s.kind) {
    case "systemd":
      return runShell("systemctl start comis", timeoutMs);
    case "pm2":
      return runShell("pm2 start comis", timeoutMs);
    case "bare-process":
      return err({
        kind: "unsupported",
        message:
          "Bare-process supervisor cannot be auto-started — set --restart-cmd or use systemd/pm2",
      });
    case "manual":
      return runShell(s.cmd, timeoutMs);
    case "none":
      return err({
        kind: "detection-failed",
        message: MANUAL_RECIPE_HINT,
      });
  }
}
