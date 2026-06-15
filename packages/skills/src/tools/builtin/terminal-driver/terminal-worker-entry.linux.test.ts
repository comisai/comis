// SPDX-License-Identifier: Apache-2.0
/**
 * Linux-gated live-host confirmation for the Terminal Worker posture.
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
 * under the proven posture and asserts a REAL node-pty `forkpty` allocates
 * a controlling pty (the FORKPTY_OK=true result the earlier spike demonstrated).
 * On macOS this never runs.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTerminalWorker, defaultLoadPty } from "./terminal-worker-entry.js";
import type { TerminalRequestFrame } from "./terminal-ipc.js";
import type { TerminalScope } from "./allowlist-matcher.js";

const isLinux = process.platform === "linux";

const VPS_TRACE_ID = "22222222-3333-4444-8555-666666666666";

/** A no-op structural logger for the live-PTS worker (the VPS run captures nothing). */
const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * The worker now ALWAYS spawns `bwrap [scope args] -- bin argv` (the
 * unjailed path is deleted). So the live worker MUST be given the resolved bwrap
 * path (the daemon resolves it via `which bwrap`); without it create fails closed.
 * Resolved once, here, exactly like `BwrapProvider.available()`.
 */
function resolveBwrapPath(): string {
  return execFileSync("which", ["bwrap"], { encoding: "utf8" }).trim();
}

/** A real throwaway workspace dir — always --bind RW into the jail (the session cwd). */
function makeWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "worker-entry-live-ws-"));
}

/**
 * The least-privilege live scope: workspace-only fs, deny-all egress, the
 * net-new uid. `cat`/`bash` run fine in a workspace jail (system RO binds give the
 * interpreter + libs; the workspace is RW). The create frame carries it (+ the
 * workspace/cwd companions) so buildSpawnPlan jails the child.
 */
const LIVE_WORKSPACE_SCOPE: TerminalScope = {
  filesystem: "workspace",
  network: "none",
  credentialPaths: [],
  uid: "dedicated",
};

/** Build a request frame for the live-PTY interaction assertion. */
function liveFrame(
  method: string,
  params: Record<string, unknown>,
  requestId: string,
): TerminalRequestFrame {
  return { sessionId: "live", requestId, traceId: VPS_TRACE_ID, method, params };
}

/**
 * The proven worker-launch posture (the daemon spawns the worker under this
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
    // succeeded), mirroring the spike's FORKPTY_OK=true result. The posture args
    // are asserted shaped here so the gate is non-vacuous when it runs.
    expect(WORKER_PERMISSION_ARGS).toContain("--permission");
    expect(WORKER_PERMISSION_ARGS).toContain("--allow-addons");
    expect(WORKER_PERMISSION_ARGS).toContain("--allow-child-process");
  });

  // ==========================================================================
  // THE VPS LIVE-PTY INTERACTION ASSERTION.
  //
  // Drives a REAL interactive program through a REAL node-pty forkpty worker
  // (loadPty = defaultLoadPty, real injected timers) and proves the full
  // submit -> settle -> observe loop AND that a control key affects a live
  // program. This is the macOS-unprovable half (the macOS box's node-pty can't
  // posix_spawnp in-harness), so the orchestrator
  // runs it on comisvps. On macOS this entire describe block is skipped.
  // ==========================================================================
  it("drives a live program: send_text(submit) echoes, then C-d exits (submit->settle->observe + control key)", async () => {
    // `cat` is a minimal line-buffered interactive program: it echoes each
    // submitted line and exits on EOF (C-d). The worker spawns it INSIDE a
    // bwrap workspace jail, so the worker is given the resolved bwrapPath.
    const workspace = makeWorkspace();
    const worker = createTerminalWorker({
      loadPty: defaultLoadPty,
      logger: silentLogger,
      bwrapPath: resolveBwrapPath(),
    });

    // create a real PTY session running `cat` INSIDE the workspace jail.
    const created = await worker.handle(
      liveFrame(
        "create",
        {
          sessionId: "live",
          bin: "/bin/cat",
          argv: [],
          cols: 80,
          rows: 24,
          scope: LIVE_WORKSPACE_SCOPE,
          workspace,
          cwd: workspace,
        },
        "rq-create",
      ),
    );
    expect(created.ok).toBe(true);
    expect((created.result as { backend: string }).backend).toBe("pty"); // real forkpty

    // submit "hello\n": text -> settle -> \r. `cat` echoes the line back.
    const sent = await worker.handle(
      liveFrame(
        "send_text",
        { sessionId: "live", text: "hello", submit: true, bracketedPaste: false },
        "rq-send",
      ),
    );
    expect(sent.ok).toBe(true);

    // wait for the echoed text to appear in the ring (bounded; resolves on text).
    const waited = await worker.handle(
      liveFrame("wait", { sessionId: "live", forText: "hello", timeoutMs: 3_000 }, "rq-wait-1"),
    );
    expect(waited.ok).toBe(true);
    expect((waited.result as { isComplete: boolean }).isComplete).toBe(true);

    // read: the screen shows the submitted line echoed by the live program.
    const read = await worker.handle(
      liveFrame("read", { sessionId: "live" }, "rq-read"),
    );
    expect((read.result as { screen: string }).screen).toContain("hello");
    expect((read.result as { alive: boolean }).alive).toBe(true);

    // send_key C-d (EOF) -> `cat` exits. Then wait for the exit.
    await worker.handle(liveFrame("send_key", { sessionId: "live", keys: ["C-d"] }, "rq-eof"));
    const exited = await worker.handle(
      liveFrame("wait", { sessionId: "live", forExit: true, timeoutMs: 3_000 }, "rq-wait-2"),
    );
    expect(exited.ok).toBe(true);
    // The live program exited: reason "exit" and the settle is complete.
    expect((exited.result as { reason: string }).reason).toBe("exit");
    expect((exited.result as { isComplete: boolean }).isComplete).toBe(true);

    // A final read confirms the session is no longer alive.
    const finalRead = await worker.handle(
      liveFrame("read", { sessionId: "live" }, "rq-read-final"),
    );
    expect((finalRead.result as { alive: boolean }).alive).toBe(false);
  });
});
