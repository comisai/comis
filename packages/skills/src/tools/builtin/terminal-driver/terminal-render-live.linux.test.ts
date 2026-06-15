// SPDX-License-Identifier: Apache-2.0
/**
 * (Linux/VPS) — the LIVE-TUI render gate: drive a REAL alt-screen
 * TUI (`vim`) + a REAL scrolling program (`bash`/`seq`) through the REAL Terminal
 * Worker with the REAL node-pty `forkpty` backend (`loadPty = defaultLoadPty`) +
 * the REAL `createSessionEmulator`, and assert the WHOLE stack — real PTY →
 * emulator → grid — renders correctly on Linux.
 *
 * This proves the rendering substrate against a real PTY, where the
 * macOS unit suite cannot reach: this repo's macOS author box's node-pty cannot
 * `posix_spawnp` in-harness. `describe.skipIf(
 * process.platform !== "linux")` so it COMPILES + SKIPS cleanly on macOS and runs
 * live on `comisvps` (where forkpty works). The orchestrator flips it green on the
 * VPS post-execute, exactly as it ran every other `.linux.test.ts`. Mirrors the
 * `terminal-worker-entry.linux.test.ts` / `terminal-roundtrip.linux.test.ts`
 * Linux-gate idiom (the `bwrap-egress-integration.test.ts` pattern).
 *
 * The three live assertions (alt-screen grid + live scrollback +
 * live below-fold-not-settled):
 *   1. live `vim` renders a stable alt-screen `cols×rows` grid (`alt:true`,
 *      `alive:true`, non-empty grid of the expected dimensions), then `:q!` exits.
 *   2. a live `seq 1 100` scroll: `read({scrollback:N})` surfaces an early
 *      off-screen line the viewport-only `read` omits (live perception beyond the
 *      fold).
 *   3. a live slow producer: a `wait({forIdleMs})` does NOT settle `idle` while
 *      output is still scrolling below the fold (the idle-settle gate over a real stream).
 *
 * NO `@comis/infra` import (the worker-boundary rule). On macOS this entire
 * describe block is skipped.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { realpathSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTerminalWorker, defaultLoadPty } from "./terminal-worker-entry.js";
import type { TerminalRequestFrame, TerminalReplyFrame } from "./terminal-ipc.js";
import type { TerminalScope } from "./allowlist-matcher.js";

const isLinux = process.platform === "linux";

const VPS_TRACE_ID = "44444444-5555-4666-8777-888888888888";

/** A no-op structural logger for the live-PTY worker (the VPS run captures nothing). */
const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * The worker now ALWAYS jails the child (`bwrap [scope args] -- bin argv`;
 * the unjailed path is gone), so the live worker MUST be given the resolved bwrap
 * path or create fails closed. vim/bash/seq all run fine in a
 * `filesystem:workspace` jail (system RO binds supply the interpreter + libs +
 * terminfo; the workspace + /tmp are RW). Resolved once like `BwrapProvider`.
 */
function resolveBwrapPath(): string {
  return execFileSync("which", ["bwrap"], { encoding: "utf8" }).trim();
}

/** A real throwaway workspace dir — always --bind RW into the jail (the session cwd). */
function makeWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "render-live-ws-"));
}

/** The least-privilege live scope the create frame carries so the worker jails the child. */
const LIVE_WORKSPACE_SCOPE: TerminalScope = {
  filesystem: "workspace",
  network: "none",
  credentialPaths: [],
  uid: "dedicated",
};

/** Build a live worker with the resolved bwrapPath (so create jails, not fail-closes). */
function makeLiveWorker(): ReturnType<typeof createTerminalWorker> {
  return createTerminalWorker({
    loadPty: defaultLoadPty,
    logger: silentLogger,
    bwrapPath: resolveBwrapPath(),
  });
}

/** Merge the scope + workspace/cwd jail companions into a create frame's params. */
function withJail(params: Record<string, unknown>, workspace: string): Record<string, unknown> {
  return { ...params, scope: LIVE_WORKSPACE_SCOPE, workspace, cwd: workspace };
}

/** The live `read` reply view (the worker's emulator-backed grid). */
interface LiveView {
  screen: string;
  cursor: { x: number; y: number };
  cols: number;
  rows: number;
  alt: boolean;
  alive: boolean;
}

/** The live `wait` settle reply. */
interface LiveWait {
  matched: boolean;
  isComplete: boolean;
  reason: string;
  screen: string;
}

/** Resolve a binary by realpath, trying each candidate; throws if none exist. */
function resolveBin(candidates: string[]): string {
  for (const candidate of candidates) {
    try {
      return realpathSync(candidate);
    } catch {
      /* next */
    }
  }
  throw new Error(`no binary among: ${candidates.join(", ")}`);
}

/** Build a request frame for the live worker (one session id per test for isolation). */
function frame(
  sessionId: string,
  method: string,
  params: Record<string, unknown>,
  requestId: string,
): TerminalRequestFrame {
  return { sessionId, requestId, traceId: VPS_TRACE_ID, method, params };
}

/** Drive a frame through the worker and return the typed result (asserts `ok`). */
async function drive<T>(
  worker: ReturnType<typeof createTerminalWorker>,
  f: TerminalRequestFrame,
): Promise<T> {
  const reply: TerminalReplyFrame = await worker.handle(f);
  expect(reply.ok).toBe(true);
  return reply.result as T;
}

/** A bounded poll: re-read until `pred(view)` or the attempt budget is spent. */
async function readUntil(
  worker: ReturnType<typeof createTerminalWorker>,
  sessionId: string,
  pred: (v: LiveView) => boolean,
  opts: { format?: string; scrollback?: number; attempts?: number; gapMs?: number } = {},
): Promise<LiveView> {
  const attempts = opts.attempts ?? 60;
  const gapMs = opts.gapMs ?? 50;
  let view: LiveView = { screen: "", cursor: { x: 0, y: 0 }, cols: 0, rows: 0, alt: false, alive: false };
  for (let i = 0; i < attempts; i++) {
    view = await drive<LiveView>(
      worker,
      frame(
        sessionId,
        "read",
        { sessionId, ...(opts.format ? { format: opts.format } : {}), ...(opts.scrollback ? { scrollback: opts.scrollback } : {}) },
        `read-${i}`,
      ),
    );
    if (pred(view)) return view;
    await new Promise((r) => setTimeout(r, gapMs));
  }
  return view;
}

describe.skipIf(!isLinux)("(Linux) — live-TUI render through the real PTY + emulator", () => {
  it("live vim renders a stable alt-screen grid (alt:true, cols×rows-shaped), then :q! exits", async () => {
    const vim = resolveBin(["/usr/bin/vim", "/bin/vim", "/usr/local/bin/vim"]);
    const worker = makeLiveWorker();
    const workspace = makeWorkspace();

    // create a real-PTY `vim -u NONE -N` session (no host vimrc; deterministic),
    // jailed inside the workspace.
    const created = await drive<{ backend: string; cols: number; rows: number }>(
      worker,
      frame(
        "vim",
        "create",
        withJail({ sessionId: "vim", bin: vim, argv: ["-u", "NONE", "-N"], cols: 80, rows: 24 }, workspace),
        "rq-create",
      ),
    );
    expect(created.backend).toBe("pty"); // a real forkpty succeeded

    // Let vim draw, then assert the alt-screen grid is stable + correctly shaped.
    const view = await readUntil(worker, "vim", (v) => v.alt && v.alive && v.screen.length > 0);
    expect(view.alt).toBe(true); // vim owns the alternate screen buffer
    expect(view.alive).toBe(true);
    expect(view.cols).toBe(80);
    expect(view.rows).toBe(24);
    // The grid is non-empty and shaped to the viewport (24 newline-joined rows).
    expect(view.screen.length).toBeGreaterThan(0);
    expect(view.screen.split("\n").length).toBe(24);

    // Drive `:q!\r` to quit, then confirm the session exits cleanly.
    await drive<unknown>(worker, frame("vim", "send_text", { sessionId: "vim", text: ":q!", submit: true }, "rq-quit"));
    const exited = await drive<LiveWait>(
      worker,
      frame("vim", "wait", { sessionId: "vim", forExit: true, timeoutMs: 4_000 }, "rq-wait-exit"),
    );
    expect(exited.reason).toBe("exit");
    expect(exited.isComplete).toBe(true);

    const finalView = await drive<LiveView>(worker, frame("vim", "read", { sessionId: "vim" }, "rq-read-final"));
    expect(finalView.alive).toBe(false);
  });

  it("live scrollback: read({scrollback:N}) surfaces an early off-screen line the viewport omits", async () => {
    const bash = resolveBin(["/bin/bash", "/usr/bin/bash"]);
    const worker = makeLiveWorker();
    const workspace = makeWorkspace();

    // `bash -c 'seq 1 100'` prints 100 lines on a 24-row viewport — ~76 scroll off.
    const created = await drive<{ backend: string }>(
      worker,
      frame(
        "seq",
        "create",
        withJail(
          { sessionId: "seq", bin: bash, argv: ["--norc", "--noprofile", "-c", "seq 1 100"], cols: 80, rows: 24, scrollback: 1000 },
          workspace,
        ),
        "rq-create",
      ),
    );
    expect(created.backend).toBe("pty");

    // Wait until the last line (100) has rendered into the viewport.
    await readUntil(worker, "seq", (v) => v.screen.includes("100"));

    // Viewport-only read: an early line (line 1) has scrolled off the top.
    const viewportOnly = await drive<LiveView>(worker, frame("seq", "read", { sessionId: "seq" }, "rq-read-viewport"));
    // Use a word-boundary check so "1" is the standalone early line, not a substring of "100"/"10".
    const earlyLineVisibleInViewport = /(^|\n)1(\r?\n|$)/.test(viewportOnly.screen);
    expect(earlyLineVisibleInViewport).toBe(false);

    // With scrollback, the early off-screen line IS perceivable (live perception).
    const withScrollback = await drive<LiveView>(
      worker,
      frame("seq", "read", { sessionId: "seq", scrollback: 200 }, "rq-read-scrollback"),
    );
    expect(/(^|\n)1(\r?\n|$)/.test(withScrollback.screen)).toBe(true);
    // And the scrollback view is strictly longer (it includes the off-screen rows).
    expect(withScrollback.screen.length).toBeGreaterThan(viewportOnly.screen.length);

    await drive<unknown>(worker, frame("seq", "send_key", { sessionId: "seq", keys: ["C-d"] }, "rq-eof"));
  });

  it("live below-fold ⇒ NOT settled: a slow producer keeps wait({forIdleMs}) from settling idle", async () => {
    const bash = resolveBin(["/bin/bash", "/usr/bin/bash"]);
    const worker = makeLiveWorker();
    const workspace = makeWorkspace();

    // A slow producer: print a line every 100ms for ~3s (30 lines) on a 5-row
    // viewport — output keeps scrolling below the fold the whole time.
    const created = await drive<{ backend: string }>(
      worker,
      frame(
        "slow",
        "create",
        withJail(
          {
            sessionId: "slow",
            bin: bash,
            argv: ["--norc", "--noprofile", "-c", "for i in $(seq 1 30); do echo line-$i; sleep 0.1; done"],
            cols: 80,
            rows: 5,
            scrollback: 1000,
          },
          workspace,
        ),
        "rq-create",
      ),
    );
    expect(created.backend).toBe("pty");

    // Let a few lines emit so the viewport has scrolled (content is below the fold
    // as it scrolls). Then scroll UP so content sits below the displayed viewport,
    // and assert a SHORT idle wait does NOT settle while output is still flowing.
    await readUntil(worker, "slow", (v) => v.screen.includes("line-3"), { attempts: 40, gapMs: 50 });

    // A short idle wait against a still-producing stream: the settle must NOT mark
    // it complete (a frame with content below the fold + a live stream is not idle).
    const waited = await drive<LiveWait>(
      worker,
      frame("slow", "wait", { sessionId: "slow", forIdleMs: 150, timeoutMs: 800 }, "rq-wait-idle"),
    );
    // While output is still scrolling, the wait times out rather than settling idle.
    expect(waited.reason).not.toBe("idle");
    expect(waited.isComplete).toBe(false);

    // Drain to exit so the session ends cleanly (bounded).
    await drive<LiveWait>(worker, frame("slow", "wait", { sessionId: "slow", forExit: true, timeoutMs: 6_000 }, "rq-wait-exit"));
  });
});
