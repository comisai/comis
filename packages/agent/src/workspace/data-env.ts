// SPDX-License-Identifier: Apache-2.0
/**
 * Workspace-internal data env resolver.
 *
 * Returns environment variables for python/matplotlib subprocesses that
 * derive ALL paths from `workspaceDir`. Avoids slow pip installs in the
 * chart hot path and matplotlib Fontconfig errors from a non-writable
 * default cache dir.
 *
 * This file contains no host-env reads. Subprocesses inheriting the
 * daemon's full environment can pick up host paths (e.g.
 * `/root/.cache/matplotlib`) that fail under read-only systemd hardening
 * (`ProtectSystem=strict`) and leak host PATH into the agent's tool
 * execution.
 *
 * matplotlib + python deps install into the agent workspace's `venv/`.
 * The Dockerfile pre-warms the default workspace's venv at image build
 * time so first-chart latency drops; subsequent chart calls reuse the
 * venv. Full Docker image size goes up (acceptable trade-off).
 *
 * Mirrors workspace-resolver.ts's safePath + workspaceDir precedent
 * (no path.join, no host-env reads).
 *
 * @module
 */

import { safePath } from "@comis/core";

/**
 * Resolve workspace-internal env vars for python/matplotlib subprocesses.
 *
 * The returned record is intended to be MERGED over an existing subprocess
 * env at the call site (e.g. exec-tool's `{ ...baseEnv, ...resolveDataEnv(...) }`),
 * so the workspace-internal values win on collision and the host PATH /
 * cache dirs are not surfaced inside the subprocess.
 *
 * @param opts.workspaceDir - Absolute path to the agent workspace.
 * @returns env-var record suitable for `child_process.spawn(..., { env })`.
 */
export function resolveDataEnv(opts: { workspaceDir: string }): Record<string, string> {
  const venvBin = safePath(opts.workspaceDir, "venv", "bin");
  const cacheDir = safePath(opts.workspaceDir, ".cache");
  const mplDir = safePath(cacheDir, "matplotlib");

  return {
    // Python venv binaries on PATH (no host-PATH pollution).
    PATH: venvBin,
    // matplotlib config + cache dir (writable, workspace-internal).
    MPLCONFIGDIR: mplDir,
    // XDG cache spec -- fontconfig + other libs honor this.
    XDG_CACHE_HOME: cacheDir,
    // Force matplotlib to use a non-interactive backend (avoids
    // Tkinter / X11 dependencies that would bloat the container image
    // and otherwise crash on headless containers).
    MPLBACKEND: "Agg",
    // Disable pip's distrust of the (workspace-internal) venv path.
    PIP_DISABLE_PIP_VERSION_CHECK: "1",
  };
}
