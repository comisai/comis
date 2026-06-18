// SPDX-License-Identifier: Apache-2.0
/**
 * terminal-worker-launch -- the production worker-launch posture (118-SPIKE-GO.md),
 * extracted from `terminal-session-registry.ts` so that file stays under the 800-line
 * architecture cap (the gap-2 workspace wiring pushed it over).
 *
 * This is the `--permission` posture the daemon spawns the Terminal Worker under +
 * the production `spawnWorker` builder. It is PURE module-level wiring (no closure
 * over the registry's session map) — it depends only on `node:child_process` +
 * `systemEnvSnapshot` + the {@link FakeWorkerChild} structural type, so it lifts out
 * cleanly. The registry imports the builder back as the default `spawnWorker`; the
 * daemon (119-04) wires `buildProductionSpawnWorker(workerJsPath, dataDir)`.
 *
 * INFRA-FREE (like the registry): imports ONLY `@comis/core` (`systemEnvSnapshot`) +
 * node builtins — never `@comis/infra`.
 *
 * @module
 */

import { spawn as childSpawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { systemEnvSnapshot } from "@comis/core";

import type { FakeWorkerChild } from "./terminal-session-registry.js";

/**
 * Resolve the absolute path of the compiled standalone worker entry
 * (`terminal-worker-main.js`) that {@link buildProductionSpawnWorker} forks.
 * Computed from THIS module's own URL (both are siblings in the same
 * `terminal-driver` dist dir) so it is correct regardless of install location —
 * global npm prefix, bundled tarball, or dev dist — NEVER a data-dir placeholder.
 * The daemon's `resolveWorkerJsPath` delegates here (119-04 closure).
 */
export function resolveWorkerMainPath(): string {
  return fileURLToPath(new URL("./terminal-worker-main.js", import.meta.url));
}

/**
 * The 118-proven worker-launch permission posture (the daemon spawns the worker
 * under this via its existing `--allow-child-process`). node-pty `forkpty` was
 * proven to allocate a controlling pty under EXACTLY this posture on the VPS.
 * `--allow-fs-write` scopes are supplied by the production `spawnWorker` (the
 * worker's durable-state dir + /tmp), keyed to the data dir at wiring time.
 */
export const WORKER_PERMISSION_ARGS: readonly string[] = [
  "--permission",
  "--allow-addons",
  "--allow-worker",
  "--allow-fs-read=*",
  "--allow-child-process",
];

/**
 * Build the production `spawnWorker` default: forks `node <permission-args>
 * <workerJsPath>` with a 4-fd stdio (fd3 is the events push channel per spec
 * §2.3), scoping fs-writes to the worker's durable-state dir + /tmp. The daemon
 * (119-04 wiring) constructs this with the resolved `workerJsPath` + `dataDir`.
 */
export function buildProductionSpawnWorker(
  workerJsPath: string,
  dataDir: string,
  tmuxSocketPath?: string,
): () => FakeWorkerChild {
  const args = [
    ...WORKER_PERMISSION_ARGS,
    `--allow-fs-write=${dataDir}/terminal-worker`,
    "--allow-fs-write=/tmp",
    workerJsPath,
  ];
  return () =>
    childSpawn(process.execPath, args, {
      stdio: ["pipe", "pipe", "pipe", "pipe"],
      // Inject the data dir so the worker's durable-state dir matches the
      // `--allow-fs-write` scope above (the worker mkdir's + logs there).
      // RECUR-03 (option A): inject this daemon generation's PER-BOOT tmux socket so the worker
      // creates NEW sessions on a fresh server in the live mount namespace (a restart's stranded
      // prior-generation ns never breaks new bwrap sessions — RECUR-02). Stable across worker
      // respawns within a daemon generation (the daemon re-spawns with the same value); a restart
      // brings a new daemon → a new socket. Absent ⇒ the worker's legacy single-socket default.
      env: {
        ...systemEnvSnapshot(),
        COMIS_TERMINAL_DATA_DIR: dataDir,
        ...(tmuxSocketPath !== undefined ? { COMIS_TERMINAL_TMUX_SOCKET: tmuxSocketPath } : {}),
      },
    }) as unknown as FakeWorkerChild;
}
