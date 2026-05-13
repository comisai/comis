// SPDX-License-Identifier: Apache-2.0
/**
 * Detect whether we are running inside a Docker container.
 *
 * Two-probe form (WEB-CONTRACTS-05):
 *  1. `existsSync("/.dockerenv")` — Docker creates this marker file at PID 1's
 *     filesystem root for standard images.
 *  2. `/proc/1/cgroup` regex match — fallback for rootless / minimal images
 *     that lack `/.dockerenv` (also catches containerd + kubepods).
 *
 * Used by callers that need to surface restart-policy guidance: inside a
 * container the daemon is owned by PID 1 (dumb-init in the official image),
 * so signalling it exits the container — Docker's restart policy is what
 * brings it back. Without `--restart unless-stopped` (or compose
 * `restart: unless-stopped`) the container stays exited.
 *
 * Defensive: any probe error returns false. We never throw out of a runtime
 * detection helper.
 *
 * Moved from `@comis/infra` in Phase 33 (SKILLS-SPLIT-09 + RES-ARCH-2);
 * upgraded with the cgroup fallback in Phase 35 (WEB-CONTRACTS-05). The
 * infra-side copy at `packages/infra/src/runtime/is-docker.ts` is retained
 * until Phase 35 Plan 35-05 retargets CLI consumers.
 *
 * @module
 */
import { existsSync, readFileSync } from "node:fs";

export function isDocker(): boolean {
  try {
    if (existsSync("/.dockerenv")) return true;
  } catch {
    /* fall through */
  }
  try {
    const cgroup = readFileSync("/proc/1/cgroup", "utf8");
    if (/\b(docker|containerd|kubepods)\b/.test(cgroup)) return true;
  } catch {
    /* fall through */
  }
  return false;
}
