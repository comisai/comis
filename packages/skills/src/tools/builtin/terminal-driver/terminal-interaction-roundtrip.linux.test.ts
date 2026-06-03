// SPDX-License-Identifier: Apache-2.0
/**
 * TR-03/04/05 (Linux/VPS) — the LIVE-PTY interaction round-trip: the four
 * implemented interaction tools (send_text / send_key / resize / wait) driven
 * through the REAL TerminalSessionRegistry (120-03) + the REAL Terminal Worker
 * with the REAL node-pty `forkpty` backend (`loadPty = defaultLoadPty`) + real
 * injected timers, against a real interactive program (`/bin/cat`).
 *
 * This is the macOS-unprovable half (the macOS author box's node-pty cannot
 * `posix_spawnp` in-harness — the 119-03/119-04 precedent): a real submit ->
 * settle -> observe loop AND a real control-key exit. `describe.skipIf(
 * process.platform !== "linux")` so it COMPILES + SKIPS on macOS and runs live on
 * `comisvps` (where forkpty works). The orchestrator flips it green on the VPS
 * post-execute. Mirrors the `bwrap-egress-integration.test.ts` Linux-gate idiom +
 * the 119-04 macOS sibling's bridge shape, but end-to-end through the TOOLS (not
 * the worker directly).
 *
 * `cat` is a minimal line-buffered interactive program: it echoes each submitted
 * line and exits on EOF (C-d). It needs no REPL setup and is universally present.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { realpathSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import {
  createTerminalSessionCreateTool,
  createTerminalSessionReadTool,
  createTerminalSessionSendTextTool,
  createTerminalSessionSendKeyTool,
  createTerminalSessionResizeTool,
  createTerminalSessionWaitTool,
  type TerminalToolDeps,
} from "./terminal-tools.js";
import {
  createTerminalSessionRegistry,
  type FakeWorkerChild,
  type WaitResult,
} from "./terminal-session-registry.js";
import { createTerminalWorker, defaultLoadPty } from "./terminal-worker-entry.js";
import { encodeFrame, createFrameDecoder, type TerminalRequestFrame } from "./terminal-ipc.js";
import type { AllowEntryLike, TerminalScope } from "./allowlist-matcher.js";

function isLinux(): boolean {
  return process.platform === "linux";
}

const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * 122-06: the registry threads the daemon-resolved bwrapPath onto the create frame
 * (the SEC-16 seam); the worker ALWAYS jails (no unjailed path), so create
 * fail-closes without it. Resolved once like `BwrapProvider.available()`.
 */
function resolveBwrapPath(): string {
  return execFileSync("which", ["bwrap"], { encoding: "utf8" }).trim();
}

/** The operator scope on the allow entry (SEC-02/03) — `cat` runs fine in a workspace jail. */
const WORKSPACE_SCOPE: TerminalScope = {
  filesystem: "workspace",
  network: "none",
  credentialHome: "exclude",
  uid: "dedicated",
};

/** Resolve `/bin/cat` (or its realpath) on the host. */
function catPath(): string {
  for (const candidate of ["/bin/cat", "/usr/bin/cat"]) {
    try {
      return realpathSync(candidate);
    } catch {
      /* next */
    }
  }
  throw new Error("no cat binary");
}

/**
 * A real throwaway workspace dir — always --bind RW into the jail (the session cwd).
 * 122-06: the worker spawns `cat` INSIDE the bwrap workspace jail with `--chdir <cwd>`
 * + `--uid 65534` (nobody). The create TOOL threads only `scope` (not workspace/cwd —
 * that daemon plumbing lands later), so `planSpawnFromCreateFrame` would otherwise
 * default the jail workspace+cwd to the daemon HOME — a dir nobody cannot use as the
 * working directory, so the jailed `cat` fails to spawn (session → lost, wait never
 * completes). The PASSING siblings (terminal-worker-entry / terminal-render-live /
 * terminal-scope-matrix .linux) all hand the worker a real mkdtemp workspace; this
 * bridge mirrors them by injecting one onto the create frame (the daemon→worker seam),
 * leaving the tool→registry path — and the SEC-15-wrapped tool-layer read — untouched.
 */
function makeWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "interaction-roundtrip-ws-"));
}

/**
 * The in-process bridge wiring the REAL node-pty loader (`defaultLoadPty`) + REAL
 * timers so the worker drives a live PTY via forkpty on the VPS. The OS pipe is
 * still bridged in-process here; the FULL separate-process posture is exercised by
 * the daemon wiring + the VPS smoke at a higher tier.
 *
 * The bridge ALSO injects the session's real `workspace`/`cwd` onto the `create`
 * frame (122-06): the create tool threads `scope` but not workspace/cwd, so the
 * worker would otherwise jail `cat` with `--chdir <HOME>` under uid 65534 and the
 * spawn fails. This is the daemon→worker pipe seam — exactly where the daemon will
 * supply the workspace in production — so the tool→registry path stays unchanged and
 * the tool-layer read is still SEC-15-wrapped.
 */
function makeBridgedPtyWorkerChild(workspace: string): FakeWorkerChild {
  const worker = createTerminalWorker({ loadPty: defaultLoadPty, logger: noopLogger });
  const decoder = createFrameDecoder();
  let onStdout: ((chunk: Buffer) => void) | undefined;
  const child: FakeWorkerChild = {
    pid: 5253,
    stdin: {
      write(chunk: Buffer): boolean {
        for (const frame of decoder.push(chunk)) {
          const req = frame as TerminalRequestFrame;
          // Inject the jail workspace/cwd onto the create frame (the daemon→worker
          // seam) so the worker's buildSpawnPlan binds a real RW workspace + chdirs
          // into it — mirroring the passing worker-direct .linux siblings. Other
          // methods pass through untouched.
          if (req.method === "create") {
            req.params = { ...req.params, workspace, cwd: workspace };
          }
          void worker.handle(req).then((reply) => onStdout?.(encodeFrame(reply)));
        }
        return true;
      },
    },
    stdout: {
      on(_event: "data", cb: (chunk: Buffer) => void): void {
        onStdout = cb;
      },
    },
    on(): FakeWorkerChild {
      return child;
    },
    kill(): void {},
  };
  return child;
}

function toolDeps(registry: ReturnType<typeof createTerminalSessionRegistry>, entry: AllowEntryLike): TerminalToolDeps {
  return {
    registry,
    allowEntries: [entry],
    detectProvider: () => ({}) as never,
    logger: noopLogger,
    eventBus: { emit: () => true },
    nowMs: () => Date.now(),
    agentId: "agent-interaction-linux",
  };
}

// ===========================================================================
// THE VPS LIVE-PTY INTERACTION ASSERTION (120-05, TR-03/04/05) — through the
// TOOLS. Drives a REAL `cat` via a REAL forkpty worker (real injected timers) and
// proves the full submit -> settle -> observe loop AND that a real control key
// (C-d / EOF) exits a live program — end-to-end through the agent-facing tools.
// On macOS this entire describe block is skipped.
// ===========================================================================
describe.skipIf(!isLinux())("TR-03/04/05 (Linux) — live-PTY interaction round-trip through the tools", () => {
  it("send_text(submit) echoes, wait forText observes it, then send_key C-d exits (submit->settle->observe + control key)", async () => {
    const cat = catPath();
    // A real RW workspace the worker --binds + --chdirs into (the session cwd) — the
    // jailed `cat` cannot run with the default HOME cwd under uid 65534. The bridge
    // injects it onto the create frame (the daemon→worker seam).
    const workspace = makeWorkspace();
    const registry = createTerminalSessionRegistry({
      spawnWorker: () => makeBridgedPtyWorkerChild(workspace),
      logger: noopLogger,
      nowMs: () => Date.now(),
      // 122-06: threaded onto the create frame so the worker jails `cat`.
      bwrapPath: resolveBwrapPath(),
    });
    const entry: AllowEntryLike = { id: "cat", match: { path: cat }, scope: WORKSPACE_SCOPE };

    const createTool = createTerminalSessionCreateTool(toolDeps(registry, entry));
    const readTool = createTerminalSessionReadTool(toolDeps(registry, entry));
    const sendTextTool = createTerminalSessionSendTextTool(toolDeps(registry, entry));
    const sendKeyTool = createTerminalSessionSendKeyTool(toolDeps(registry, entry));
    const resizeTool = createTerminalSessionResizeTool(toolDeps(registry, entry));
    const waitTool = createTerminalSessionWaitTool(toolDeps(registry, entry));

    // create a real-PTY `cat` session.
    const created = await createTool.execute("create-call", { allowId: "cat", command: cat, cols: 80, rows: 24 });
    const { sessionId } = created.details as { sessionId: string };
    expect(sessionId.length).toBeGreaterThan(0);

    // submit "hello": text -> settle -> \r. `cat` echoes the line.
    await sendTextTool.execute("send-call", { sessionId, text: "hello", submit: true, bracketedPaste: false });

    // wait forText: the echoed "hello" appears (bounded; resolves on text).
    const waited = (await waitTool.execute("wait-text", { sessionId, forText: "hello", timeoutMs: 3000 }))
      .details as WaitResult;
    expect(waited.isComplete).toBe(true);

    // read: the live program echoed the submitted line.
    const screen = (await readTool.execute("read-call", { sessionId })).details as { screen: string; alive: boolean };
    expect(screen.screen).toContain("hello");
    expect(screen.alive).toBe(true);

    // resize the live PTY and confirm the geometry is coherent.
    const resized = (await resizeTool.execute("resize-call", { sessionId, cols: 100, rows: 30 })).details as {
      ok: boolean;
    };
    expect(resized.ok).toBe(true);

    // send_key C-d (EOF) -> `cat` exits. wait forExit observes the real exit.
    await sendKeyTool.execute("eof-call", { sessionId, keys: ["C-d"] });
    const exited = (await waitTool.execute("wait-exit", { sessionId, forExit: true, timeoutMs: 3000 }))
      .details as WaitResult;
    expect(exited.isComplete).toBe(true);
    expect(exited.reason).toBe("exit");

    // a final read confirms the live program is no longer alive.
    const finalView = (await readTool.execute("read-final", { sessionId })).details as { alive: boolean };
    expect(finalView.alive).toBe(false);

    await registry.cleanup();
  });
});
