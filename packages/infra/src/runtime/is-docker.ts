// SPDX-License-Identifier: Apache-2.0
/**
 * Detect whether we are running inside a Docker container.
 *
 * Probes `/.dockerenv`, the standard marker file Docker creates at PID 1's
 * filesystem root. Used by callers that need to surface restart-policy
 * guidance: inside a container the daemon is owned by PID 1 (dumb-init in
 * the official image), so signalling it exits the container — Docker's
 * restart policy is what brings it back. Without `--restart unless-stopped`
 * (or compose `restart: unless-stopped`) the container stays exited.
 *
 * Defensive: any probe error returns false. We never throw out of a runtime
 * detection helper.
 *
 * @module
 */
import { existsSync } from "node:fs";

export function isDocker(): boolean {
  try {
    return existsSync("/.dockerenv");
  } catch {
    return false;
  }
}
