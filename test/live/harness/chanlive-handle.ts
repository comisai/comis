// SPDX-License-Identifier: Apache-2.0
/**
 * `chanlive-handle.ts` — the CLI-01 lifecycle primitives the `chan`/`tg` CLI
 * (Phase 205, Plan 05) and the standalone-rig launcher (Plan 04) both use:
 *
 *   1. the per-channel HANDLE FILE at `~/.comis-chanlive/<channel>.json`,
 *      written `0600`, recording the three endpoints (emulator control,
 *      rig-control, gateway) + the admin-scoped gateway token + the fixed test
 *      chat id + the rig's throwaway data dir / memory.db path;
 *   2. the RESOLUTION ORDER `--endpoint` › `COMIS_CHANLIVE_ENDPOINT` env ›
 *      handle file (`undefined` when none — the honest dead-handle, NEVER a
 *      silent spawn);
 *   3. a bounded GET /health PROBE — the discover-or-spawn signal the launcher
 *      and `tg status` / `tg up` consume (reuse a healthy rig; report a dead
 *      handle honestly otherwise).
 *
 * The handle records the THREE endpoints (design §10A.3 "three endpoints, one
 * handle"). It carries the gateway token, so `writeHandle` chmods it `0600`
 * (T-205-07 / §13-Q7 / V12 — the token must not leak off-box). `readHandle`
 * returns `undefined` on absence (honest, never a throw).
 *
 * TEST-HARNESS — lives under the test tree, never the packages source tree;
 * ZERO production code change. `test/` is outside every packages source-tree
 * ESLint / architecture rule, so `node:fs` / `node:os` / `node:path` `join` /
 * `process.env` / `fetch` are all fine here.
 *
 * Run the unit tests under the LIVE vitest config (the bare root config
 * excludes `test/live`, collecting 0 files → false green):
 *   pnpm vitest run -c test/live/vitest.config.ts \
 *     test/live/harness/chanlive-handle.test.ts
 *
 * @module
 */

import {
  writeFileSync,
  readFileSync,
  mkdirSync,
  existsSync,
  chmodSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The per-channel handle — the THREE endpoints + the SECRET gateway token + the
 * fixed test chat id + the rig's throwaway data dir / memory.db path. This is
 * the contract the launcher (Plan 04) WRITES and the CLI (Plan 05) READS.
 */
export interface ChanliveHandle {
  /** The channel key, e.g. "telegram". */
  readonly channel: string;
  /** `http://127.0.0.1:<P>` — the emulator `/control/*` base. */
  readonly controlEndpoint: string;
  /** `http://127.0.0.1:<R>` — the rig-control (restart / reset-deep) base (Plan 04). */
  readonly rigControlEndpoint: string;
  /** `http://127.0.0.1:<G>` — the daemon `/rpc` + `/health`. */
  readonly gatewayUrl: string;
  /** The ≥32-char literal scoping rpc/ws/admin — SECRET, persisted only under `0600`. */
  readonly gatewayToken: string;
  /** The fixed test chat (424242). */
  readonly chatId: number;
  /** The rig's throwaway `COMIS_DATA_DIR` (for `tg db` / mirror / traj). */
  readonly dataDir: string;
  /** `<dataDir>/<memory.dbPath>` — the isolated `memory.db` the oracles read. */
  readonly memoryDbPath: string;
}

/** The default handle directory — `~/.comis-chanlive` (a NEW operator-visible artifact, first written by Phase 205). */
function defaultBaseDir(): string {
  return join(homedir(), ".comis-chanlive");
}

/**
 * The absolute path of the handle file for a channel:
 * `<baseDir>/<channel>.json` (default base `~/.comis-chanlive`). The `baseDir`
 * override keeps the unit tests off the operator's real handle dir.
 */
export function handlePath(channel: string, baseDir: string = defaultBaseDir()): string {
  return join(baseDir, `${channel}.json`);
}

/**
 * Write the handle to `<baseDir>/<channel>.json`: create the dir if missing,
 * serialize the JSON, then chmod the file `0600`. The gateway token in the
 * handle is admin-scoped — `0600` keeps it owner-only so it cannot leak off-box
 * (T-205-07 / §13-Q7 / V12).
 */
export function writeHandle(handle: ChanliveHandle, baseDir: string = defaultBaseDir()): void {
  mkdirSync(baseDir, { recursive: true });
  const path = handlePath(handle.channel, baseDir);
  writeFileSync(path, JSON.stringify(handle), "utf-8");
  chmodSync(path, 0o600);
}

/**
 * Read the handle for a channel back from `<baseDir>/<channel>.json`. Returns
 * `undefined` when no handle file exists (honest absence — the CLI maps this to
 * a dead-handle error suggesting `tg up`, never a throw, never a silent spawn).
 */
export function readHandle(
  channel: string,
  baseDir: string = defaultBaseDir(),
): ChanliveHandle | undefined {
  const path = handlePath(channel, baseDir);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf-8")) as ChanliveHandle;
}

/**
 * Resolve the rig-control endpoint for a channel by the EXACT precedence
 * (design §5.1):
 *   1. `--endpoint <url>` flag (passed in by the CLI);
 *   2. `COMIS_CHANLIVE_ENDPOINT` env (read-only, no secret);
 *   3. the handle file's `rigControlEndpoint`.
 *
 * Returns `undefined` when none resolves — the honest dead-handle the CLI turns
 * into an error suggesting `tg up`, NEVER a silent spawn (T-205-08). `--endpoint`
 * / env beat the recorded handle, the only way to target a second / operator rig.
 */
export function resolveEndpoint(
  channel: string,
  opts: { flagEndpoint?: string; baseDir?: string } = {},
): string | undefined {
  if (opts.flagEndpoint) return opts.flagEndpoint; // 1. --endpoint flag
  const env = process.env["COMIS_CHANLIVE_ENDPOINT"]; // 2. env (read-only, no secret)
  if (env) return env;
  return readHandle(channel, opts.baseDir)?.rigControlEndpoint; // 3. handle file
}

/** The default health-probe budget (ms) — short so a dead handle fails fast, never hangs the CLI. */
const DEFAULT_PROBE_TIMEOUT_MS = 2000;

/**
 * Probe rig health: a bounded GET `<gatewayUrl>/health` (the daemon's existing
 * health route). Resolves `true` on a 200-range response, `false` on any throw /
 * non-200 / timeout (honest — a dead endpoint returns `false`, never a crash).
 * This is the discover-or-spawn signal the launcher (Plan 04) and `tg status` /
 * `tg up` (Plan 05) consume to reuse a healthy rig instead of spawning a second.
 */
export async function probeHealth(
  gatewayUrl: string,
  timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  try {
    const res = await fetch(`${gatewayUrl}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    // Connection refused / timeout / DNS — an honest dead handle, never a throw.
    return false;
  }
}
