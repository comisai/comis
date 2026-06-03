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

import { systemEnvSnapshot } from "@comis/core";

import type { FakeWorkerChild } from "./terminal-session-registry.js";

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
      env: systemEnvSnapshot(),
    }) as unknown as FakeWorkerChild;
}
