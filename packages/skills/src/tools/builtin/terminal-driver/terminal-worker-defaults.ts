// SPDX-License-Identifier: Apache-2.0
/**
 * terminal-worker-defaults -- the worker's production-default ports + the small
 * scrollback/stuck/bracketed-paste constants, extracted from
 * `terminal-worker-entry.ts` so that file keeps headroom under the
 * 800-line architecture cap once the `reattach` dispatch path lands.
 *
 * BEHAVIOR-NEUTRAL: pure code movement. The factory defaults (`defaultLoadPty`,
 * `defaultSpawnPipe`, `defaultFsPort`) and the constants
 * (`SCROLLBACK_DEFAULT`/`STUCK_DEFAULT_MS`/`BRACKETED_PASTE_*`) are byte-for-byte the
 * blocks that were inline in the entry; only the LOCATION changed. The entry
 * re-exports `defaultLoadPty` (the daemon wires it as `loadPty` when forking a real
 * worker) so the public surface is unchanged.
 *
 * INFRA-FREE (like every worker-side sibling): value-imports ONLY node builtins, and
 * type-imports the worker's structural contracts from the neutral leaf
 * `terminal-worker-types.ts`; never `@comis/infra` / `@comis/observability` (the
 * worker MUST NOT cross into those layers).
 *
 * @module
 */

import { spawn as childSpawn } from "node:child_process";
import { createRequire } from "node:module";
import {
  writeFileSync as fsWriteFileSync,
  renameSync as fsRenameSync,
  openSync as fsOpenSync,
  fsyncSync as fsFsyncSync,
  closeSync as fsCloseSync,
} from "node:fs";

import type { PipeChildLike, PtyModuleLike, WorkerFsPort } from "./terminal-worker-types.js";

/**
 * The per-session emulator scrollback depth (retained rows above the viewport).
 * Bounds per-session emulator memory to `(rows + 1000) × cols` cells.
 */
export const SCROLLBACK_DEFAULT = 1000;

/**
 * The default operator stuck threshold the classifier compares to a session's
 * no-progress window when `deps.stuckMs` is omitted. The daemon threads the config
 * `worker.stuckMs`; this is the safety-net default.
 */
export const STUCK_DEFAULT_MS = 30_000;

/** DECSET 2004 bracketed-paste START — wraps a `bracketedPaste:true` text so a paste-aware program treats the bytes as DATA. */
export const BRACKETED_PASTE_START = "\x1b[200~";
/** DECSET 2004 bracketed-paste END. */
export const BRACKETED_PASTE_END = "\x1b[201~";

/**
 * The production node-pty loader: a guarded `createRequire` load inside a try —
 * NEVER a top-level static import (that crashes module load when the native addon
 * has no prebuild). A throw is caught by the worker → the pipe backend, `degraded`.
 * ESM (`"type":"module"`), so `createRequire(import.meta.url)` is the lazy load path;
 * the literal module name appears only here, never a top-level binding.
 */
export function defaultLoadPty(): PtyModuleLike {
  const localRequire = createRequire(import.meta.url);
  return localRequire("node-pty") as PtyModuleLike;
}

/** The production pipe-backend spawner: `child_process.spawn` with stdio pipes (mirrors exec-background.ts). `cwd` is set ONLY on the unsandboxed direct-spawn path (bwrap owns the jailed path's cwd). */
export function defaultSpawnPipe(
  bin: string,
  argv: string[],
  opts: { env: NodeJS.ProcessEnv; cwd?: string },
): PipeChildLike {
  return childSpawn(bin, argv, {
    env: opts.env,
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    stdio: ["pipe", "pipe", "pipe"],
  }) as unknown as PipeChildLike;
}

/** The production durable-fs port over `node:fs` sync ops. */
export const defaultFsPort: WorkerFsPort = {
  writeFileSync: (path, data) => fsWriteFileSync(path, data),
  renameSync: (from, to) => fsRenameSync(from, to),
  openSync: (path, flags) => fsOpenSync(path, flags),
  fsyncSync: (fd) => fsFsyncSync(fd),
  closeSync: (fd) => fsCloseSync(fd),
};
