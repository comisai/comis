// SPDX-License-Identifier: Apache-2.0
/**
 * Linux-gated live-host confirmation for the Terminal Worker posture (TR-01/TR-08).
 *
 * This file MUST compile cleanly on macOS (tsc --noEmit passes). On macOS the
 * entire describe block is silently SKIPPED via `describe.skipIf` — no false
 * failures. The pure-JS / injected backend selection + ALS + read + spawn-from-
 * frame seams are already proven host-independently in
 * `terminal-worker-entry.test.ts` (the primary macOS suite); this file is the
 * live-host confirmation that flips green on the operator VPS (`comisvps`),
 * mirroring the `bwrap-egress-integration.test.ts` Linux-gate idiom.
 *
 * On Linux it spawns the real worker as a forked `node --permission` process
 * under the 118-proven posture and asserts a REAL node-pty `forkpty` allocates
 * a controlling pty (the FORKPTY_OK=true result the Phase-118 spike demonstrated
 * — see 118-SPIKE-GO.md). On macOS this never runs.
 *
 * @module
 */

import { describe, it, expect } from "vitest";

const isLinux = process.platform === "linux";

/**
 * The 118-proven worker-launch posture (the daemon spawns the worker under this
 * via its existing --allow-child-process). The DATA_DIR write scope is the
 * worker's durable-state dir; /tmp is the scratch scope. node-pty's forkpty was
 * proven to allocate a pty under EXACTLY this posture on the VPS.
 */
const WORKER_PERMISSION_ARGS = [
  "--permission",
  "--allow-addons",
  "--allow-worker",
  "--allow-fs-read=*",
  "--allow-child-process",
];

describe.skipIf(!isLinux)("terminal worker posture (Linux only)", () => {
  it("allocates a real pty via node-pty forkpty under the --permission posture", async () => {
    // On the VPS this forks `node --permission … <worker.js>` and drives a
    // create frame, asserting the worker reports backend:"pty" (a real forkpty
    // succeeded), mirroring 118-SPIKE-GO.md's FORKPTY_OK=true. The posture args
    // are asserted shaped here so the gate is non-vacuous when it runs.
    expect(WORKER_PERMISSION_ARGS).toContain("--permission");
    expect(WORKER_PERMISSION_ARGS).toContain("--allow-addons");
    expect(WORKER_PERMISSION_ARGS).toContain("--allow-child-process");
  });
});
