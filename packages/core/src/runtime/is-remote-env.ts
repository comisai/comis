// SPDX-License-Identifier: Apache-2.0
/**
 * VPS / headless environment detection.
 *
 * Pure function: given the env block + optional override, returns true when
 * the current process is on a remote/headless host (no DISPLAY, SSH session,
 * etc.) and should fall back to manual-paste OAuth instead of opening a
 * browser via the `open` package.
 *
 * Plumbing: --remote / --local CLI flags map to `force: "remote" | "local"`
 * so operators can override the heuristic when it guesses wrong (e.g. tmux
 * over SSH where DISPLAY is set by tunneling but they still want manual paste).
 *
 * Relocated from `@comis/agent/src/model/oauth-env.ts` in Phase 35 Plan 35-02
 * per Decision D-01 #3 (CLI cuts its `@comis/agent` import surface; the helper
 * is pure, so co-locating it next to is-docker.ts in core/src/runtime/ has no
 * runtime cost). The agent-side copy stays in place per the no-backward-compat
 * convention — Plan 35-05 deletes it once CLI consumers retarget to
 * `@comis/core`.
 *
 * @module
 */

/** Input shape for isRemoteEnvironment. Pure: no process.env reads internally. */
export interface IsRemoteEnvironmentInput {
  /** The env block to inspect — typically process.env at the call site. */
  env: NodeJS.ProcessEnv;
  /** CLI flag override: "remote" forces true; "local" forces false; absent = heuristic. */
  force?: "remote" | "local";
}

/**
 * Decide whether to skip browser-open and go straight to manual-paste.
 *
 * Heuristic (simplified from OpenClaw's remote-env.ts — no WAYLAND_DISPLAY,
 * no isWSLEnv check; Comis is Linux-only per CLAUDE.md):
 *   - force === "remote" → true
 *   - force === "local"  → false
 *   - SSH_CLIENT or SSH_TTY present → true
 *   - !DISPLAY → true
 *   - else → false
 */
export function isRemoteEnvironment(input: IsRemoteEnvironmentInput): boolean {
  if (input.force === "remote") return true;
  if (input.force === "local") return false;
  const env = input.env;
  if (env.SSH_CLIENT || env.SSH_TTY) return true;
  if (!env.DISPLAY) return true;
  return false;
}
