// SPDX-License-Identifier: Apache-2.0
/**
 * prlimit(1) availability probe + WARN-once state for the rlimits wrap.
 * Extracted from mcp-client-discover.ts to keep that leaf under the
 * 500-line per-subdirectory cap.
 *
 * Whether `prlimit(1)` is on PATH. Probed LAZILY on first
 * `wrapStdioCommand` invocation rather than at module-load time. The
 * previous module-init probe (a) blocked module-load by up to the 1s
 * spawnSync timeout on slow disks, and (b) was permanently false if
 * the daemon started before `/usr/bin` was mounted (rare but happens
 * on early-boot systemd units). The lazy approach defers the cost to
 * the first MCP connect (negligible — connect is multi-second already)
 * and lets a `prlimit` install that completes between daemon start and
 * the first connect take effect.
 *
 * The probe is still cached on first call — subsequent connects see no
 * spawnSync overhead. To force a re-probe (e.g., after an operator
 * installs util-linux post-hoc), call `refreshPrlimitAvailable()`.
 *
 * @module
 */

import { spawnSync } from "node:child_process";

let prlimitAvailableCache: boolean | null = null;

function probePrlimitAvailable(): boolean {
  try {
    const result = spawnSync("prlimit", ["--version"], { encoding: "utf-8", timeout: 1000 });
    return result.status === 0;
  } catch {
    return false;
  }
}

/** Lazily probe + cache prlimit availability. Internal accessor. */
export function getPrlimitAvailableCached(): boolean {
  if (prlimitAvailableCache === null) {
    prlimitAvailableCache = probePrlimitAvailable();
  }
  return prlimitAvailableCache;
}

/** Guard ensuring the prlimit-unavailable WARN fires AT MOST ONCE per daemon process. */
let prlimitWarnEmitted = false;

/** Read the WARN-emitted flag. Internal accessor used by wrapStdioCommand. */
export function getPrlimitWarnEmitted(): boolean {
  return prlimitWarnEmitted;
}

/** Mark the WARN as emitted. Internal accessor used by wrapStdioCommand. */
export function setPrlimitWarnEmitted(): void {
  prlimitWarnEmitted = true;
}

/**
 * Test seam: returns the lazily-cached prlimit availability result.
 * Triggers the probe on first call if not yet cached. Exported so the
 * co-located test file (mcp-client-discover.test.ts) can gate branches
 * on the runtime probe outcome.
 *
 * @internal — test-only test seam; not re-exported from the package
 * barrel, but documented as `@internal` so a future contributor does
 * not promote it to public-API status.
 */
export function getPrlimitAvailable(): boolean {
  return getPrlimitAvailableCached();
}

/**
 * Force a re-probe of `prlimit(1)` availability. Use after the
 * operator installs util-linux post-hoc; the next `wrapStdioCommand`
 * call will pick up the new state.
 */
export function refreshPrlimitAvailable(): boolean {
  prlimitAvailableCache = probePrlimitAvailable();
  // Reset the WARN-once flag so a subsequent connect on a host where
  // prlimit JUST disappeared can re-emit the WARN.
  prlimitWarnEmitted = false;
  return prlimitAvailableCache;
}

/** @internal test-only — resets the module-level WARN-once flag for deterministic tests. */
export function __resetPrlimitWarnForTests(): void {
  prlimitWarnEmitted = false;
}

/** @internal test-only — resets the lazy probe cache for deterministic tests. */
export function __resetPrlimitProbeForTests(): void {
  prlimitAvailableCache = null;
  prlimitWarnEmitted = false;
}
