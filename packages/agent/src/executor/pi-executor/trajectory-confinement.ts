// SPDX-License-Identifier: Apache-2.0
/**
 * Resolve the confinement base for trajectory-file writes (the directory every
 * resolved `<sessionFile>.trajectory.jsonl` path must stay inside, asserted at
 * open() to reject ancestor-symlink escapes).
 *
 * Two cases:
 *  - The operator explicitly set `diagnostics.trajectory.dir` (e.g.
 *    `/var/log/comis/traj/`) → they own that path's legitimacy, so confinement
 *    is skipped (returns `undefined`) — we must not reject their own write path.
 *  - Default (no explicit dir) → confine to the operator's RESOLVED data root
 *    (`config.dataDir` / `COMIS_DATA_DIR`, threaded as `dataDir`). This is NOT a
 *    hardcoded `~/.comis`: a custom-`dataDir` install (`dataDir: ~/.comis-foo`)
 *    keeps its session files — and their co-located trajectory files — under
 *    that root, so a `~/.comis` base would reject every write while the pointer
 *    sidecar still advertises the (never-created) file, blinding `obs.explain`.
 *    Only when no dataDir is resolved at all do we fall back to `~/.comis`.
 *
 * Same bug class as the 260611 session-index-writer fix (which also fell back
 * to the real `~/.comis` and silently diverged from custom installs).
 *
 * @module
 */
import * as os from "node:os";
import { safePath } from "@comis/core";

export function resolveTrajectoryConfinedBase(
  trajectoryConfigDir: string | undefined,
  dataDir: string | undefined,
): string | undefined {
  if (trajectoryConfigDir !== undefined) return undefined;
  return dataDir ?? safePath(os.homedir(), ".comis");
}
