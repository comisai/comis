// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the supervised Terminal Worker entry (spec §2.1/§2.2/§2.3).
 *
 * Pure-JS / fully-injected → runs green on macOS without forking a process.
 * The worker is a FACTORY (`createTerminalWorker(deps)`) so node-pty, the
 * logger, the clock, the env snapshot, and the durable-fs ops are all
 * substitutable. Proves the worker contract:
 *   - an injected `loadPty` that throws selects the PIPE backend and
 *     reports `backend:"degraded"` — never an unhandled spawn crash;
 *   - happy path: an injected `loadPty` returning a stub pty uses the PTY
 *     backend and reports `backend:"pty"`;
 *   - worker half of observability: each request frame's `traceId` is re-established as
 *     the ALS context (`runWithContext`) during handling;
 *   - a `read` frame returns `{screen,cursor,cols,rows,alt,alive}` from the
 *     per-session accumulated stdout ring (the shape the round-trip reads);
 *   - the worker spawns from the frame's `{bin,argv}` verbatim — no
 *     redundant realpath, argsPrefix preserved (buildDirectSpawn is the SOLE
 *     canonicalization site);
 *   - a durable write swallows ONLY the disabled-fsync refusal and still
 *     completes the write+rename.
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";

import { tryGetContext } from "@comis/core";

import {
  createTerminalWorker,
  type TerminalWorkerDeps,
  type FakePtyLike,
} from "./terminal-worker-entry.js";
import { encodeFrame, type TerminalRequestFrame } from "./terminal-ipc.js";

const TRACE_ID = "11111111-2222-4333-8444-555555555555";

/**
 * Flush the per-session @xterm emulator's pending write-parse. `@xterm/headless`
 * parses its write buffer on a MACROTASK (a timer), so a single microtask yield
 * is NOT enough for the grid to reflect just-emitted bytes. `appendRing`
 * fires `emu.write(chunk)` un-awaited (`read` itself awaits the
 * flush); until then a test awaits a real macrotask before reading the grid.
 */
function flushEmulator(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** A no-op structural logger that records the last call per level. */
function makeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

/**
 * A minimal stub PTY backend: exposes the node-pty `spawn` → `{onData,onExit,...}`
 * surface the worker wires. The test drives stdout by calling `emit(chunk)` and
 * the backend exit by calling `emitExit()` (the live node-pty `onExit` analog —
 * mirrors the pipe stub's `close()`).
 */
function makeFakeBackend(): {
  spawn: ReturnType<typeof vi.fn>;
  emit: (chunk: string) => void;
  emitExit: (e?: { exitCode: number; signal?: number }) => void;
  lastSpawn: () => { bin: string; argv: string[] } | undefined;
} {
  let onData: ((d: string) => void) | undefined;
  let onExit: ((e: { exitCode: number; signal?: number }) => void) | undefined;
  let lastBin: string | undefined;
  let lastArgv: string[] | undefined;
  const spawn = vi.fn((bin: string, argv: string[]) => {
    lastBin = bin;
    lastArgv = argv;
    const handle: FakePtyLike = {
      pid: 4242,
      onData: (cb: (d: string) => void) => {
        onData = cb;
      },
      onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => {
        onExit = cb;
      },
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
    };
    return handle;
  });
  return {
    spawn,
    emit: (chunk: string) => onData?.(chunk),
    emitExit: (e: { exitCode: number; signal?: number } = { exitCode: 0 }) => onExit?.(e),
    lastSpawn: () =>
      lastBin === undefined || lastArgv === undefined
        ? undefined
        : { bin: lastBin, argv: lastArgv },
  };
}

/**
 * A minimal stub PIPE backend (the degraded path): `spawnPipe` returns a child
 * with the `stdout.on("data")` + `on("close"/"error")` surface
 * `child_process.spawn` gives. The test drives stdout via `emit(chunk)`.
 */
function makeFakePipeBackend(): {
  spawnPipe: ReturnType<typeof vi.fn>;
  emit: (chunk: string) => void;
  close: () => void;
  lastSpawn: () => { bin: string; argv: string[] } | undefined;
} {
  let onData: ((chunk: Buffer) => void) | undefined;
  let onClose: ((arg?: unknown) => void) | undefined;
  let lastBin: string | undefined;
  let lastArgv: string[] | undefined;
  const spawnPipe = vi.fn((bin: string, argv: string[]) => {
    lastBin = bin;
    lastArgv = argv;
    return {
      pid: 4243,
      stdout: {
        on: (_event: "data", cb: (chunk: Buffer) => void) => {
          onData = cb;
        },
      },
      stdin: { write: vi.fn() },
      on: (event: "close" | "error", cb: (arg?: unknown) => void) => {
        if (event === "close") onClose = cb;
      },
      kill: vi.fn(),
    };
  });
  return {
    spawnPipe,
    emit: (chunk: string) => onData?.(Buffer.from(chunk, "utf8")),
    close: () => onClose?.(0),
    lastSpawn: () =>
      lastBin === undefined || lastArgv === undefined
        ? undefined
        : { bin: lastBin, argv: lastArgv },
  };
}

/**
 * A RECORDING stub PTY backend (interaction tests): every `write()` is
 * captured into `writes: string[]`, every `resize()` into `resizes`, so the
 * send_text/send_key/resize handlers can be asserted at the byte level. The test
 * drives stdout via `emit(chunk)` (into the worker's ring).
 */
function makeRecordingBackend(): {
  spawn: ReturnType<typeof vi.fn>;
  writes: string[];
  resizes: Array<[number, number]>;
  emit: (chunk: string) => void;
  emitExit: (e?: { exitCode: number; signal?: number }) => void;
} {
  const writes: string[] = [];
  const resizes: Array<[number, number]> = [];
  let onData: ((d: string) => void) | undefined;
  let onExit: ((e: { exitCode: number; signal?: number }) => void) | undefined;
  const spawn = vi.fn(() => {
    const handle: FakePtyLike = {
      pid: 5252,
      onData: (cb: (d: string) => void) => {
        onData = cb;
      },
      onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => {
        onExit = cb;
      },
      write: (data: string) => {
        writes.push(data);
      },
      resize: (cols: number, rows: number) => {
        resizes.push([cols, rows]);
      },
      kill: vi.fn(),
    };
    return handle;
  });
  return {
    spawn,
    writes,
    resizes,
    emit: (chunk: string) => onData?.(chunk),
    emitExit: (e: { exitCode: number; signal?: number } = { exitCode: 0 }) => onExit?.(e),
  };
}

/**
 * A RECORDING stub PIPE backend (the degraded path) whose `stdin.write` is
 * captured into `writes` — used to prove resize on a backend with no PTY winsize
 * still records geometry, and that send_* writes route to `stdin`.
 */
function makeRecordingPipeBackend(): {
  spawnPipe: ReturnType<typeof vi.fn>;
  writes: string[];
  emit: (chunk: string) => void;
  close: () => void;
} {
  const writes: string[] = [];
  let onData: ((chunk: Buffer) => void) | undefined;
  let onClose: ((arg?: unknown) => void) | undefined;
  const spawnPipe = vi.fn(() => {
    return {
      pid: 5253,
      stdout: {
        on: (_event: "data", cb: (chunk: Buffer) => void) => {
          onData = cb;
        },
      },
      stdin: {
        write: (data: string) => {
          writes.push(data);
        },
      },
      on: (event: "close" | "error", cb: (arg?: unknown) => void) => {
        if (event === "close") onClose = cb;
      },
      kill: vi.fn(),
    };
  });
  return {
    spawnPipe,
    writes,
    emit: (chunk: string) => onData?.(Buffer.from(chunk, "utf8")),
    close: () => onClose?.(0),
  };
}

/**
 * A deterministic fake scheduler for the injected `setTimer`/`clearTimer` ports —
 * the same shape the settle suite drives. `advance(ms)` fires every timer
 * whose cumulative delay is due, so the in-worker settle is exercised WITHOUT any
 * real wall-clock wait. `liveTimerCount()` proves no leak.
 */
function makeFakeScheduler(): {
  setTimer: (cb: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  advance: (ms: number) => void;
  liveTimerCount: () => number;
} {
  interface Entry {
    cb: () => void;
    fireAt: number;
    cancelled: boolean;
  }
  let nowMs = 0;
  let nextId = 1;
  const entries = new Map<number, Entry>();
  return {
    setTimer: (cb: () => void, ms: number) => {
      const id = nextId++;
      entries.set(id, { cb, fireAt: nowMs + ms, cancelled: false });
      return id;
    },
    clearTimer: (handle: unknown) => {
      const e = entries.get(handle as number);
      if (e !== undefined) e.cancelled = true;
      entries.delete(handle as number);
    },
    advance: (ms: number) => {
      nowMs += ms;
      // Fire all due, non-cancelled timers in scheduled order; a fired timer is
      // removed before its cb runs (a one-shot), so a cb that schedules a new
      // timer is honored on a later advance.
      for (const [id, e] of [...entries.entries()].sort((a, b) => a[1].fireAt - b[1].fireAt)) {
        if (e.cancelled) continue;
        if (e.fireAt <= nowMs) {
          entries.delete(id);
          e.cb();
        }
      }
    },
    liveTimerCount: () => [...entries.values()].filter((e) => !e.cancelled).length,
  };
}

function baseDeps(over: Partial<TerminalWorkerDeps> = {}): TerminalWorkerDeps {
  return {
    loadPty: () => {
      throw new Error("node-pty not loaded in this test by default");
    },
    logger: makeLogger(),
    nowMs: () => 1_700_000_000_000,
    envSnapshot: () => ({ PATH: "/usr/bin" }) as NodeJS.ProcessEnv,
    // The resolved bwrap path the worker wraps the child in. A real path
    // here keeps every behavioural test on the spawn-the-jail path; the
    // fail-closed suite overrides it to `undefined` to prove no-provider rejects.
    // buildScopeArgs / scrubChildEnv / buildEgressRelayLaunch default to the real
    // module exports — tests inject them only to assert the composition.
    bwrapPath: "/usr/bin/bwrap",
    ...over,
  };
}

function createFrame(
  params: Record<string, unknown>,
  over: Partial<TerminalRequestFrame> = {},
): TerminalRequestFrame {
  return {
    sessionId: "s1",
    requestId: "rq-create",
    traceId: TRACE_ID,
    method: "create",
    params,
    ...over,
  };
}

describe("createTerminalWorker — backend selection", () => {
  it("selects the pipe backend and reports degraded when loadPty throws (no crash)", async () => {
    const pipe = makeFakePipeBackend();
    const logger = makeLogger();
    const worker = createTerminalWorker(
      baseDeps({
        loadPty: () => {
          throw new Error("Cannot find module 'node-pty'");
        },
        spawnPipe: pipe.spawnPipe,
        logger,
      }),
    );

    // A create request frame must resolve (NOT throw, NOT reject) with degraded.
    const reply = await worker.handle(
      createFrame({ sessionId: "s1", bin: "/bin/bash", argv: [], cols: 80, rows: 24 }),
    );

    expect(reply.ok).toBe(true);
    expect((reply.result as { backend: string }).backend).toBe("degraded");
    // The pipe backend was used to spawn the child.
    expect(pipe.spawnPipe).toHaveBeenCalledTimes(1);
    // A warn was logged for the unavailable pty (errorKind: dependency).
    expect(logger.warn).toHaveBeenCalled();
  });

  it("accumulates the degraded pipe backend stdout into the read ring, and close flips alive=false", async () => {
    const pipe = makeFakePipeBackend();
    const worker = createTerminalWorker(
      baseDeps({
        loadPty: () => {
          throw new Error("no node-pty");
        },
        spawnPipe: pipe.spawnPipe,
      }),
    );

    await worker.handle(
      createFrame({ sessionId: "s1", bin: "/bin/bash", argv: [], cols: 80, rows: 24 }),
    );
    pipe.emit("pipe-out\n");
    // Read serializes the @xterm grid (not the raw ring), so the
    // rendered viewport CONTAINS the emitted line after the parse flush.
    await flushEmulator();

    let read = await worker.handle({
      sessionId: "s1",
      requestId: "rq-read-1",
      traceId: TRACE_ID,
      method: "read",
      params: { sessionId: "s1" },
    });
    expect((read.result as { screen: string; alive: boolean }).screen).toContain("pipe-out");
    expect((read.result as { alive: boolean }).alive).toBe(true);

    pipe.close();
    read = await worker.handle({
      sessionId: "s1",
      requestId: "rq-read-2",
      traceId: TRACE_ID,
      method: "read",
      params: { sessionId: "s1" },
    });
    expect((read.result as { alive: boolean }).alive).toBe(false);
  });

  it("uses the pty backend and reports backend pty when loadPty returns a stub pty", async () => {
    const fake = makeFakeBackend();
    const ptyLib = { spawn: fake.spawn };
    const worker = createTerminalWorker(
      baseDeps({ loadPty: () => ptyLib }),
    );

    const reply = await worker.handle(
      createFrame({ sessionId: "s1", bin: "/bin/bash", argv: [], cols: 80, rows: 24 }),
    );

    expect(reply.ok).toBe(true);
    expect((reply.result as { backend: string }).backend).toBe("pty");
    expect(fake.spawn).toHaveBeenCalledTimes(1);
  });

  // 124-08 (OPS-05): the THIRD backend selection — a create frame requesting
  // backend:"tmux" with a wired loadTmux selects the tmux named-session backend (the
  // survival path), and the tmux handle satisfies the SAME FakePtyLike seam (onData→ring).
  it("selects the tmux backend and reports backend tmux when backend:tmux is requested + loadTmux is wired", async () => {
    let onData: ((d: string) => void) | undefined;
    let receivedArgs: { sessionId: string; bin: string; argv: readonly string[] } | undefined;
    const tmuxSpawn = vi.fn(
      (spawnArgs: { sessionId: string; bin: string; argv: readonly string[]; cols: number; rows: number }) => {
        // The loader receives the per-session COMPOSED plan command — record it for the
        // post-call assertions (asserting inside the fake would, on mismatch, throw into
        // dispatch and surface as a generic ok:false rather than a legible diff).
        receivedArgs = { sessionId: spawnArgs.sessionId, bin: spawnArgs.bin, argv: spawnArgs.argv };
        const handle: FakePtyLike = {
          pid: 7373,
          onData: (cb: (d: string) => void) => {
            onData = cb;
          },
          onExit: vi.fn(),
          write: vi.fn(),
          resize: vi.fn(),
          kill: vi.fn(),
        };
        return handle;
      },
    );

    const worker = createTerminalWorker(
      baseDeps({
        // A throwing loadPty proves the tmux branch does NOT touch node-pty.
        loadPty: () => {
          throw new Error("loadPty must not be called on the tmux path");
        },
        loadTmux: { spawn: tmuxSpawn },
      }),
    );

    const reply = await worker.handle(
      createFrame({ sessionId: "s1", bin: "/bin/bash", argv: [], cols: 80, rows: 24, backend: "tmux" }),
    );

    expect(reply.ok).toBe(true);
    expect((reply.result as { backend: string }).backend).toBe("tmux");
    expect(tmuxSpawn).toHaveBeenCalledTimes(1);
    // The loader received the per-session sessionId (the survival name derives from it) and
    // the COMPOSED plan command: bwrap is the outer bin (the jail), the driven /bin/bash
    // rides inside plan.argv after the bwrap `--` — i.e. tmux drives the bwrap-jailed child
    // (no unjailed path; the jail is still present, 124-08 nesting note).
    expect(receivedArgs?.sessionId).toBe("s1");
    expect(receivedArgs?.bin).toBe("/usr/bin/bwrap");
    expect(receivedArgs?.argv).toContain("/bin/bash");

    // The tmux handle feeds the ring through the SAME seam — emit a chunk + read it back.
    onData?.("tmux-pane-out\n");
    await flushEmulator();
    const read = await worker.handle({
      sessionId: "s1",
      requestId: "rq-read-tmux",
      traceId: TRACE_ID,
      method: "read",
      params: { sessionId: "s1" },
    });
    expect((read.result as { screen: string }).screen).toContain("tmux-pane-out");
  });

  // 124-08: a backend:"tmux" request with NO loadTmux wired must NOT crash — it falls back
  // to the node-pty path (a worker built without the tmux loader cannot drive tmux).
  it("falls back to pty when backend:tmux is requested but loadTmux is absent (no crash)", async () => {
    const fake = makeFakeBackend();
    const worker = createTerminalWorker(baseDeps({ loadPty: () => ({ spawn: fake.spawn }) }));

    const reply = await worker.handle(
      createFrame({ sessionId: "s1", bin: "/bin/bash", argv: [], cols: 80, rows: 24, backend: "tmux" }),
    );

    expect(reply.ok).toBe(true);
    expect((reply.result as { backend: string }).backend).toBe("pty");
    expect(fake.spawn).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// BL-01 (165-REVIEW): the worker `reattach` frame — the load-bearing fix for the
// recover-on-boot ZOMBIE. The registry rehydrates a recovered durable session
// `running` but the worker (freshly spawned, EMPTY sessions map) only re-attaches a
// tmux pane inside `handleCreate`. So a recovered session's first `read`/`status`
// returned alive:false — a zombie. The fix: a distinct `reattach` method that
// ATTACHES to an EXISTING tmux session by name (hasSession true → register + attach;
// hasSession false → ok:false, NEVER a fresh new-session/create — I10 no-double-drive).
//
// THE GAP THE ORIGINALS MISSED: drive a `read` AGAINST the reattached session and
// assert it returns the LIVE pane (alive:true), with exactly one reattach (no spawn).
// ===========================================================================
describe("createTerminalWorker — reattach frame (BL-01: recover-on-boot is not a zombie)", () => {
  /** A fake tmux loader whose `reattach` returns a live pane handle iff `alive`. */
  function makeReattachLoader(alive: boolean): {
    loadTmux: { spawn: ReturnType<typeof vi.fn>; reattach: ReturnType<typeof vi.fn> };
    emit: (chunk: string) => void;
  } {
    let onData: ((d: string) => void) | undefined;
    const reattach = vi.fn(
      (a: { sessionId: string; cols: number; rows: number }): FakePtyLike | undefined => {
        void a;
        if (!alive) return undefined; // the tmux session did NOT survive — gone.
        return {
          pid: 8181,
          onData: (cb: (d: string) => void) => {
            onData = cb;
          },
          onExit: vi.fn(),
          write: vi.fn(),
          resize: vi.fn(),
          kill: vi.fn(),
        };
      },
    );
    // spawn must NEVER be called on the reattach path (that would be a fresh CLI → double-drive).
    const spawn = vi.fn(() => {
      throw new Error("reattach must NOT call spawn (I10 — no double-drive)");
    });
    return { loadTmux: { spawn, reattach }, emit: (chunk: string) => onData?.(chunk) };
  }

  function reattachFrame(sessionId: string): TerminalRequestFrame {
    return {
      sessionId,
      requestId: `rq-reattach-${sessionId}`,
      traceId: TRACE_ID,
      method: "reattach",
      params: { sessionId, cols: 120, rows: 40 },
    };
  }

  it("re-attaches a LIVE tmux session (ok:true) so a subsequent read returns the LIVE pane (alive:true), with ZERO spawn (I10)", async () => {
    const tmux = makeReattachLoader(true);
    const worker = createTerminalWorker(
      baseDeps({
        loadPty: () => {
          throw new Error("reattach must not touch node-pty");
        },
        loadTmux: tmux.loadTmux,
      }),
    );

    // The recover-on-boot reattach frame (no prior create — the worker's sessions map is empty).
    const reattach = await worker.handle(reattachFrame("old-sess"));
    expect(reattach.ok, "a live tmux session re-attaches ok").toBe(true);
    expect(tmux.loadTmux.reattach).toHaveBeenCalledTimes(1);
    expect(tmux.loadTmux.spawn, "reattach must NOT spawn a fresh CLI (I10)").not.toHaveBeenCalled();

    // THE LOAD-BEARING ASSERTION (the gap the originals skipped): a read against the
    // reattached session returns the LIVE pane — alive:true + the surviving pane bytes —
    // NOT the zombie alive:false the registry-only test never caught.
    tmux.emit("resumed-pane-output\n");
    await flushEmulator();
    const read = await worker.handle({
      sessionId: "old-sess",
      requestId: "rq-read-resumed",
      traceId: TRACE_ID,
      method: "read",
      params: { sessionId: "old-sess" },
    });
    expect((read.result as { alive: boolean }).alive, "a re-attached session is ALIVE, not a zombie").toBe(true);
    expect((read.result as { screen: string }).screen).toContain("resumed-pane-output");
  });

  it("a GONE tmux session replies ok:false and registers NOTHING (a later read is alive:false — honest death, never a zombie)", async () => {
    const tmux = makeReattachLoader(false); // hasSession false → reattach returns undefined
    const worker = createTerminalWorker(
      baseDeps({ loadPty: () => ({ spawn: vi.fn() }), loadTmux: tmux.loadTmux }),
    );

    const reattach = await worker.handle(reattachFrame("gone-sess"));
    expect(reattach.ok, "a genuinely-gone tmux session re-attaches NOT-ok").toBe(false);
    expect(tmux.loadTmux.spawn, "a gone session must NEVER fall back to a fresh spawn").not.toHaveBeenCalled();

    // No session was registered — a read is the honest not-found alive:false (NOT a zombie running).
    const read = await worker.handle({
      sessionId: "gone-sess",
      requestId: "rq-read-gone",
      traceId: TRACE_ID,
      method: "read",
      params: { sessionId: "gone-sess" },
    });
    expect((read.result as { alive: boolean }).alive).toBe(false);
  });

  it("a reattach with NO loadTmux wired replies ok:false (cannot re-attach without the tmux backend)", async () => {
    const worker = createTerminalWorker(baseDeps({ loadPty: () => ({ spawn: vi.fn() }) }));
    const reattach = await worker.handle(reattachFrame("no-tmux"));
    expect(reattach.ok).toBe(false);
  });
});

describe("createTerminalWorker — ALS traceId re-establishment", () => {
  it("dispatches each frame inside runWithContext so the frame traceId is the live ALS context", async () => {
    let seenTraceId: string | undefined;
    const fake = makeFakeBackend();
    const logger = {
      debug: vi.fn(),
      info: vi.fn((_obj: Record<string, unknown>, _msg: string) => {
        // Capture the ALS context that is live DURING handling.
        seenTraceId = tryGetContext()?.traceId;
      }),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const ptyLib = { spawn: fake.spawn };
    const worker = createTerminalWorker(baseDeps({ loadPty: () => ptyLib, logger }));

    await worker.handle(
      createFrame({ sessionId: "s1", bin: "/bin/bash", argv: [], cols: 80, rows: 24 }),
    );

    expect(seenTraceId).toBe(TRACE_ID);
  });
});

describe("createTerminalWorker — inbound context is validated, not trusted", () => {
  it("regenerates a fresh UUID traceId when the wire traceId is NOT a valid UUID (log-correlation poisoning defense)", async () => {
    // An arbitrary attacker-chosen / forged traceId off the wire must NOT be
    // stamped onto worker logs verbatim — runWithContext does not validate against
    // RequestContextSchema (traceId: z.guid()), so the worker must sanitize it.
    let seenTraceId: string | undefined;
    const fake = makeFakeBackend();
    const logger = {
      debug: vi.fn(),
      info: vi.fn(() => {
        seenTraceId = tryGetContext()?.traceId;
      }),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const worker = createTerminalWorker(baseDeps({ loadPty: () => ({ spawn: fake.spawn }), logger }));

    const forged = "../../etc/passwd; DROP TABLE traces; not-a-uuid";
    await worker.handle(
      createFrame(
        { sessionId: "s1", bin: "/bin/bash", argv: [], cols: 80, rows: 24 },
        { traceId: forged },
      ),
    );

    // The forged string is rejected; a freshly-generated UUID is used instead.
    expect(seenTraceId).toBeDefined();
    expect(seenTraceId).not.toBe(forged);
    // The replacement is a valid v-anything UUID (8-4-4-4-12 hex).
    expect(seenTraceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("passes a VALID wire UUID traceId through unchanged (legitimate correlation preserved)", async () => {
    let seenTraceId: string | undefined;
    const fake = makeFakeBackend();
    const logger = {
      debug: vi.fn(),
      info: vi.fn(() => {
        seenTraceId = tryGetContext()?.traceId;
      }),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const worker = createTerminalWorker(baseDeps({ loadPty: () => ({ spawn: fake.spawn }), logger }));

    await worker.handle(
      createFrame({ sessionId: "s1", bin: "/bin/bash", argv: [], cols: 80, rows: 24 }),
    );
    expect(seenTraceId).toBe(TRACE_ID); // a valid UUID is preserved
  });

  it("does NOT unconditionally elevate the worker context to trustLevel:'admin' (no latent EoP foothold)", async () => {
    // The worker makes no authorization decisions (create/read only); an
    // unconditional admin context is a latent trust-elevation foothold for any
    // future worker-side code that reads getContext().trustLevel. It must be the
    // least-privileged level, not admin.
    let seenTrust: string | undefined;
    const fake = makeFakeBackend();
    const logger = {
      debug: vi.fn(),
      info: vi.fn(() => {
        seenTrust = tryGetContext()?.trustLevel;
      }),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const worker = createTerminalWorker(baseDeps({ loadPty: () => ({ spawn: fake.spawn }), logger }));

    await worker.handle(
      createFrame({ sessionId: "s1", bin: "/bin/bash", argv: [], cols: 80, rows: 24 }),
    );
    expect(seenTrust).toBeDefined();
    expect(seenTrust).not.toBe("admin");
    expect(seenTrust).toBe("guest"); // least privilege — the worker gates on nothing
  });
});

describe("createTerminalWorker — read frame handler", () => {
  it("returns {screen,cursor,cols,rows,alt,alive} from the per-session @xterm grid", async () => {
    const fake = makeFakeBackend();
    const ptyLib = { spawn: fake.spawn };
    const worker = createTerminalWorker(baseDeps({ loadPty: () => ptyLib }));

    await worker.handle(
      createFrame({ sessionId: "s1", bin: "/bin/bash", argv: [], cols: 100, rows: 40 }),
    );
    // The backend emits stdout; the per-session emulator renders it into the grid.
    fake.emit("hello\n");
    await flushEmulator(); // @xterm parses on a macrotask

    const readReply = await worker.handle({
      sessionId: "s1",
      requestId: "rq-read",
      traceId: TRACE_ID,
      method: "read",
      params: { sessionId: "s1" },
    });

    expect(readReply.ok).toBe(true);
    const view = readReply.result as {
      screen: string;
      cursor: { x: number; y: number };
      cols: number;
      rows: number;
      alt: boolean;
      alive: boolean;
    };
    // The screen is the rendered grid (CONTAINS the line), the cursor is
    // REAL — after "hello\n" the bare LF moves DOWN a row without a carriage
    // return, so the cursor is {x:5, y:1} (column 5 = after "hello", row 1), NOT
    // the {0,0} placeholder.
    expect(view.screen).toContain("hello");
    expect(view.cursor).toEqual({ x: 5, y: 1 });
    expect(view.cols).toBe(100);
    expect(view.rows).toBe(40);
    expect(view.alt).toBe(false);
    expect(view.alive).toBe(true);
  });
});

describe("createTerminalWorker — spawn the child verbatim AFTER the bwrap `--`", () => {
  it("spawns bwrap as arg0 with the frame's bin + full argv appearing AFTER `--` (no realpath)", async () => {
    // The child is wrapped in bwrap (the worker holds the PTY master,
    // bwrap+child run inside). The frame's {bin,argv} are passed
    // VERBATIM — but now AFTER the bwrap composer's `--` terminator, never
    // re-canonicalized (buildDirectSpawn is the SOLE canonicalization site).
    const fake = makeFakeBackend();
    const ptyLib = { spawn: fake.spawn };
    const worker = createTerminalWorker(
      baseDeps({
        loadPty: () => ptyLib,
        bwrapPath: "/usr/bin/bwrap",
      }),
    );

    await worker.handle(
      createFrame({
        sessionId: "s1",
        bin: "/canonical/bash",
        argv: ["--prefix-arg", "extra"],
        cols: 80,
        rows: 24,
        scope: {
          filesystem: "workspace",
          network: "none",
          credentialPaths: [],
          uid: "dedicated",
        },
        workspace: "/work/agent-1",
        cwd: "/work/agent-1/project",
      }),
    );

    const spawned = fake.lastSpawn();
    // arg0 is bwrap, not the bare child.
    expect(spawned?.bin).toBe("/usr/bin/bwrap");
    // The child bin + its full argv appear AFTER the `--` separator, verbatim.
    const sep = spawned?.argv.indexOf("--") ?? -1;
    expect(sep).toBeGreaterThanOrEqual(0);
    expect(spawned?.argv.slice(sep + 1)).toEqual(["/canonical/bash", "--prefix-arg", "extra"]);
  });
});

describe("createTerminalWorker — the scope materializes into the bwrap argv", () => {
  it("wraps the child in bwrap with the scope-materialized args (workspace bind, unshare-net, uid)", async () => {
    // The worker CONSUMES the scope threaded onto the frame: it calls
    // buildScopeArgs and spawns `bwrap [scope args] -- bin argv`. Assert the
    // composed argv carries the workspace bind, the deny-all netns, the net-new
    // uid, and the child AFTER `--`.
    const fake = makeFakeBackend();
    const ptyLib = { spawn: fake.spawn };
    const worker = createTerminalWorker(
      baseDeps({ loadPty: () => ptyLib, bwrapPath: "/usr/bin/bwrap" }),
    );

    const reply = await worker.handle(
      createFrame({
        sessionId: "s1",
        bin: "/canonical/bash",
        argv: ["extra"],
        cols: 80,
        rows: 24,
        scope: {
          filesystem: "workspace",
          network: "none",
          credentialPaths: [],
          uid: "dedicated",
        },
        workspace: "/work/agent-1",
        cwd: "/work/agent-1/project",
      }),
    );

    expect(reply.ok).toBe(true);
    const spawned = fake.lastSpawn();
    expect(spawned?.bin).toBe("/usr/bin/bwrap");
    const argv = spawned?.argv ?? [];
    // The workspace is always bound RW.
    expect(argv).toContain("--bind");
    expect(argv.join(" ")).toContain("/work/agent-1 /work/agent-1");
    // network:none => a kernel-enforced empty netns, no socket.
    expect(argv).toContain("--unshare-net");
    // uid:dedicated => a net-new uid (the default least-privilege posture).
    expect(argv).toContain("--uid");
    // The child appears AFTER the `--` separator.
    const sep = argv.indexOf("--");
    expect(argv.slice(sep + 1)).toEqual(["/canonical/bash", "extra"]);
  });

  it("includes the always-on ~/.comis carve-out (--tmpfs <dataDir>) before the child", async () => {
    // The carve-out rides through the composer — proves the worker passes the real
    // dataDir (os.homedir()/.comis). The tmpfs shadows ~/.comis for every child.
    const fake = makeFakeBackend();
    const worker = createTerminalWorker(
      baseDeps({ loadPty: () => ({ spawn: fake.spawn }), bwrapPath: "/usr/bin/bwrap" }),
    );

    await worker.handle(
      createFrame({
        sessionId: "s1",
        bin: "/bin/bash",
        argv: [],
        cols: 80,
        rows: 24,
        scope: { filesystem: "full", network: "full", credentialPaths: ["~/.claude"], uid: "daemon" },
        workspace: "/work/agent-1",
        cwd: "/work/agent-1",
      }),
    );

    const argv = fake.lastSpawn()?.argv ?? [];
    // `--tmpfs <home>/.comis` is present even at filesystem:full.
    const tmpfsIdx = argv.indexOf("--tmpfs");
    expect(tmpfsIdx).toBeGreaterThanOrEqual(0);
    const carveOut = argv.find((a) => a.endsWith("/.comis"));
    expect(carveOut).toBeDefined();
  });

  it("scrubs the child env: NODE_OPTIONS / CLAUDECODE / CLAUDE_CODE_* are stripped, PATH survives", async () => {
    // bwrap forwards the spawner env to the child (no --clearenv), so the env handed
    // to pty.spawn IS the child env — it must be scrubbed.
    const fake = makeFakeBackend();
    let recordedEnv: NodeJS.ProcessEnv | undefined;
    const recordingSpawn = vi.fn(
      (bin: string, argv: string[], opts: { cols: number; rows: number; env: NodeJS.ProcessEnv }) => {
        recordedEnv = opts.env;
        return fake.spawn(bin, argv);
      },
    );
    const worker = createTerminalWorker(
      baseDeps({
        loadPty: () => ({ spawn: recordingSpawn }),
        bwrapPath: "/usr/bin/bwrap",
        envSnapshot: () =>
          ({
            PATH: "/usr/bin",
            NODE_OPTIONS: "--require /tmp/evil.js",
            CLAUDECODE: "1",
            CLAUDE_CODE_ENTRYPOINT: "cli",
          }) as NodeJS.ProcessEnv,
      }),
    );

    await worker.handle(
      createFrame({
        sessionId: "s1",
        bin: "/bin/bash",
        argv: [],
        cols: 80,
        rows: 24,
        scope: { filesystem: "workspace", network: "none", credentialPaths: [], uid: "dedicated" },
        workspace: "/work/a",
        cwd: "/work/a",
      }),
    );

    expect(recordedEnv).toBeDefined();
    expect(recordedEnv?.["PATH"]).toBe("/usr/bin"); // rich env survives
    expect(recordedEnv?.["NODE_OPTIONS"]).toBeUndefined(); // interpreter-control stripped
    expect(recordedEnv?.["CLAUDECODE"]).toBeUndefined(); // nested-CLI marker stripped
    expect(recordedEnv?.["CLAUDE_CODE_ENTRYPOINT"]).toBeUndefined(); // CLAUDE_CODE_* stripped
  });

  it("wraps the DEGRADED pipe backend in bwrap too (no unjailed degraded path)", async () => {
    // When loadPty throws, the worker uses the pipe backend — which is ALSO wrapped
    // in bwrap with the scrubbed env (the jail wraps BOTH backends).
    const pipe = makeFakePipeBackend();
    let recordedEnv: NodeJS.ProcessEnv | undefined;
    const recordingPipe = vi.fn(
      (bin: string, argv: string[], opts: { env: NodeJS.ProcessEnv }) => {
        recordedEnv = opts.env;
        return pipe.spawnPipe(bin, argv);
      },
    );
    const worker = createTerminalWorker(
      baseDeps({
        loadPty: () => {
          throw new Error("Cannot find module 'node-pty'");
        },
        spawnPipe: recordingPipe,
        bwrapPath: "/usr/bin/bwrap",
        envSnapshot: () =>
          ({ PATH: "/usr/bin", NODE_OPTIONS: "--require /tmp/evil.js" }) as NodeJS.ProcessEnv,
      }),
    );

    const reply = await worker.handle(
      createFrame({
        sessionId: "s1",
        bin: "/bin/bash",
        argv: ["-l"],
        cols: 80,
        rows: 24,
        scope: { filesystem: "workspace", network: "none", credentialPaths: [], uid: "dedicated" },
        workspace: "/work/a",
        cwd: "/work/a",
      }),
    );

    expect(reply.ok).toBe(true);
    expect((reply.result as { backend: string }).backend).toBe("degraded");
    const spawned = pipe.lastSpawn();
    expect(spawned?.bin).toBe("/usr/bin/bwrap"); // bwrap wraps the pipe child too
    const sep = spawned?.argv.indexOf("--") ?? -1;
    expect(spawned?.argv.slice(sep + 1)).toEqual(["/bin/bash", "-l"]); // child after `--`
    expect(recordedEnv?.["NODE_OPTIONS"]).toBeUndefined(); // env scrubbed on the degraded path
    expect(recordedEnv?.["PATH"]).toBe("/usr/bin");
  });
});

// ===========================================================================
// listed-hosts egress materialization + dispose-on-teardown +
// the worker-path fail-closed. macOS asserts the WIRING (materialize
// called, socket bound via the composer, HTTPS_PROXY set, dispose called) — the
// LIVE relay-as-init bridge is the VPS suite.
// ===========================================================================

/**
 * A fake {@link EgressControlPort} whose `materialize(hosts)` records its calls and
 * returns a fixed socket path + a spy `dispose`. Drives the listed-hosts wiring
 * assertions without standing up a real proxy server (the LIVE bridge is VPS-only).
 */
function makeFakeEgressControl(socketPath = "/tmp/e.sock") {
  const materialize = vi.fn(async (_hosts: string[]) => ({
    socketPath,
    dispose,
  }));
  const dispose = vi.fn(async () => {});
  return { egressControl: { materialize }, materialize, dispose, socketPath };
}

describe("createTerminalWorker — listed-hosts egress materialization", () => {
  it("materializes the relay, binds the socket via the composer, and sets HTTPS_PROXY", async () => {
    const fake = makeFakeBackend();
    const egress = makeFakeEgressControl("/tmp/e.sock");
    let recordedEnv: NodeJS.ProcessEnv | undefined;
    const recordingSpawn = vi.fn(
      (bin: string, argv: string[], opts: { cols: number; rows: number; env: NodeJS.ProcessEnv }) => {
        recordedEnv = opts.env;
        return fake.spawn(bin, argv);
      },
    );
    const worker = createTerminalWorker(
      baseDeps({
        loadPty: () => ({ spawn: recordingSpawn }),
        bwrapPath: "/usr/bin/bwrap",
        egressControl: egress.egressControl,
      }),
    );

    await worker.handle(
      createFrame({
        sessionId: "s1",
        bin: "/bin/curl",
        argv: ["https://api.example.com"],
        cols: 80,
        rows: 24,
        scope: {
          filesystem: "workspace",
          network: "listed-hosts",
          hosts: ["api.example.com"],
          credentialPaths: [],
          uid: "dedicated",
        },
        workspace: "/work/a",
        cwd: "/work/a",
      }),
    );

    // materialize was called with exactly the scope's hosts.
    expect(egress.materialize).toHaveBeenCalledTimes(1);
    expect(egress.materialize).toHaveBeenCalledWith(["api.example.com"]);
    // The returned socket is bound via the composer's relaySocketPath.
    const argv = fake.lastSpawn()?.argv ?? [];
    expect(argv.join(" ")).toContain("--bind /tmp/e.sock /tmp/e.sock");
    // The child env carries HTTPS_PROXY pointing at the in-jail relay loopback.
    expect(recordedEnv?.["HTTPS_PROXY"]).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("inserts the RUNNABLE relay-init between bwrap's `--` and the child, and lets the init own the uid drop (no bwrap --uid)", async () => {
    // 122-fix: for listed-hosts the relay-init (a real node subprocess) runs as
    // userns-root to bring `lo` up, THEN drops to the net-new uid before exec'ing
    // the child. So (a) the composed argv carries `node <relay-init> --socket …
    // --port … --setgid 65534 --setuid 65534 --` AFTER bwrap's `--` and BEFORE the
    // child, and (b) bwrap itself must NOT pre-drop via `--uid` (that would strip
    // CAP_NET_ADMIN and break the loopback-up).
    const fake = makeFakeBackend();
    const egress = makeFakeEgressControl("/tmp/e.sock");
    const worker = createTerminalWorker(
      baseDeps({
        loadPty: () => ({ spawn: fake.spawn }),
        bwrapPath: "/usr/bin/bwrap",
        egressControl: egress.egressControl,
      }),
    );

    await worker.handle(
      createFrame({
        sessionId: "s1",
        bin: "/bin/curl",
        argv: ["https://api.example.com"],
        cols: 80,
        rows: 24,
        scope: {
          filesystem: "workspace",
          network: "listed-hosts",
          hosts: ["api.example.com"],
          credentialPaths: [],
          uid: "dedicated",
        },
        workspace: "/work/a",
        cwd: "/work/a",
      }),
    );

    const argv = fake.lastSpawn()?.argv ?? [];
    const sep = argv.indexOf("--");
    expect(sep).toBeGreaterThanOrEqual(0);
    const afterSeparator = argv.slice(sep + 1);
    // The relay-init is the FIRST thing after `--` (arg0 = node runtime).
    expect(afterSeparator[0]).toBe(process.execPath);
    expect(afterSeparator[1]).toMatch(/egress-relay-init\.js$/);
    // It carries the bridge coordinates + the uid drop, then its own `--`, then the child.
    expect(afterSeparator).toContain("--socket");
    expect(afterSeparator).toContain("/tmp/e.sock");
    expect(afterSeparator).toContain("--setuid");
    expect(afterSeparator).toContain("65534");
    const innerSep = afterSeparator.indexOf("--");
    expect(innerSep).toBeGreaterThanOrEqual(0);
    expect(afterSeparator.slice(innerSep + 1)).toEqual(["/bin/curl", "https://api.example.com"]);
    // bwrap itself does NOT pre-drop the uid for listed-hosts (the init does).
    expect(argv.slice(0, sep)).not.toContain("--uid");
  });

  it("does NOT materialize for network:none (deny-all)", async () => {
    const fake = makeFakeBackend();
    const egress = makeFakeEgressControl();
    const worker = createTerminalWorker(
      baseDeps({
        loadPty: () => ({ spawn: fake.spawn }),
        bwrapPath: "/usr/bin/bwrap",
        egressControl: egress.egressControl,
      }),
    );
    await worker.handle(
      createFrame({
        sessionId: "s1",
        bin: "/bin/bash",
        argv: [],
        cols: 80,
        rows: 24,
        scope: { filesystem: "workspace", network: "none", credentialPaths: [], uid: "dedicated" },
        workspace: "/work/a",
        cwd: "/work/a",
      }),
    );
    expect(egress.materialize).not.toHaveBeenCalled();
  });

  it("does NOT materialize for network:full (--share-net)", async () => {
    const fake = makeFakeBackend();
    const egress = makeFakeEgressControl();
    const worker = createTerminalWorker(
      baseDeps({
        loadPty: () => ({ spawn: fake.spawn }),
        bwrapPath: "/usr/bin/bwrap",
        egressControl: egress.egressControl,
      }),
    );
    await worker.handle(
      createFrame({
        sessionId: "s1",
        bin: "/bin/bash",
        argv: [],
        cols: 80,
        rows: 24,
        scope: { filesystem: "workspace", network: "full", credentialPaths: [], uid: "dedicated" },
        workspace: "/work/a",
        cwd: "/work/a",
      }),
    );
    expect(egress.materialize).not.toHaveBeenCalled();
  });

  it("disposes the egress materialization ONCE when the listed-hosts session exits (no leak)", async () => {
    const fake = makeFakeBackend();
    const egress = makeFakeEgressControl();
    const worker = createTerminalWorker(
      baseDeps({
        loadPty: () => ({ spawn: fake.spawn }),
        bwrapPath: "/usr/bin/bwrap",
        egressControl: egress.egressControl,
      }),
    );
    await worker.handle(
      createFrame({
        sessionId: "s1",
        bin: "/bin/curl",
        argv: [],
        cols: 80,
        rows: 24,
        scope: {
          filesystem: "workspace",
          network: "listed-hosts",
          hosts: ["api.example.com"],
          credentialPaths: [],
          uid: "dedicated",
        },
        workspace: "/work/a",
        cwd: "/work/a",
      }),
    );
    expect(egress.dispose).not.toHaveBeenCalled();
    // The backend exits — and exit AND a duplicate signal both fire — dispose once.
    fake.emitExit({ exitCode: 0 });
    fake.emitExit({ exitCode: 0 });
    // dispose is async; allow the microtask to settle.
    await Promise.resolve();
    expect(egress.dispose).toHaveBeenCalledTimes(1);
  });
});

describe("createTerminalWorker — worker-path fail-closed", () => {
  it("does NOT spawn (ok:false) when bwrapPath is undefined — never an unjailed child", async () => {
    const fake = makeFakeBackend();
    const pipe = makeFakePipeBackend();
    const worker = createTerminalWorker(
      baseDeps({
        loadPty: () => ({ spawn: fake.spawn }),
        spawnPipe: pipe.spawnPipe,
        bwrapPath: undefined, // no provider materialized a jail
      }),
    );

    const reply = await worker.handle(
      createFrame({
        sessionId: "s1",
        bin: "/bin/bash",
        argv: [],
        cols: 80,
        rows: 24,
        scope: { filesystem: "workspace", network: "none", credentialPaths: [], uid: "dedicated" },
        workspace: "/work/a",
        cwd: "/work/a",
      }),
    );

    // The create reply is a failure — the registry flips the session lost.
    expect(reply.ok).toBe(false);
    // NEITHER backend spawned — no unjailed fallback.
    expect(fake.spawn).not.toHaveBeenCalled();
    expect(pipe.spawnPipe).not.toHaveBeenCalled();
  });

  it("does NOT spawn (ok:false) when listed-hosts has no egress port (fail-closed)", async () => {
    const fake = makeFakeBackend();
    const worker = createTerminalWorker(
      baseDeps({
        loadPty: () => ({ spawn: fake.spawn }),
        bwrapPath: "/usr/bin/bwrap",
        egressControl: undefined, // listed-hosts demands a port; absent ⇒ fail-closed
      }),
    );

    const reply = await worker.handle(
      createFrame({
        sessionId: "s1",
        bin: "/bin/curl",
        argv: [],
        cols: 80,
        rows: 24,
        scope: {
          filesystem: "workspace",
          network: "listed-hosts",
          hosts: ["api.example.com"],
          credentialPaths: [],
          uid: "dedicated",
        },
        workspace: "/work/a",
        cwd: "/work/a",
      }),
    );

    expect(reply.ok).toBe(false);
    expect(fake.spawn).not.toHaveBeenCalled();
  });
});

describe("createTerminalWorker — durable write under disabled fsync", () => {
  it("swallows ONLY the disabled-fsync refusal and still completes write+rename", () => {
    const written = new Map<string, string>();
    const renamed: Array<[string, string]> = [];

    // An fs port that throws an ERR_ACCESS_DENIED-shaped error on fsync.
    const fsPort = {
      writeFileSync: vi.fn((path: string, data: string) => {
        written.set(path, data);
      }),
      renameSync: vi.fn((from: string, to: string) => {
        renamed.push([from, to]);
        // Materialize the rename in our fake store so we can assert content.
        const data = written.get(from);
        if (data !== undefined) written.set(to, data);
      }),
      openSync: vi.fn(() => 7),
      fsyncSync: vi.fn(() => {
        const err = new Error("fsync API is disabled when Permission Model is enabled") as Error & {
          code?: string;
        };
        err.code = "ERR_ACCESS_DENIED";
        throw err;
      }),
      closeSync: vi.fn(),
    };

    const worker = createTerminalWorker(baseDeps({ fs: fsPort }));

    // The durable write must NOT throw despite the fsync refusal.
    expect(() => worker.writeDurable("/data/state.json", "payload")).not.toThrow();
    // The target file content is intact (write+rename completed).
    expect(written.get("/data/state.json")).toBe("payload");
    expect(renamed.length).toBe(1);
  });

  it("re-throws a genuine I/O error from fsync (not the permission refusal)", () => {
    const fsPort = {
      writeFileSync: vi.fn(),
      renameSync: vi.fn(),
      openSync: vi.fn(() => 7),
      fsyncSync: vi.fn(() => {
        const err = new Error("EIO: i/o error") as Error & { code?: string };
        err.code = "EIO";
        throw err;
      }),
      closeSync: vi.fn(),
    };

    const worker = createTerminalWorker(baseDeps({ fs: fsPort }));

    expect(() => worker.writeDurable("/data/state.json", "payload")).toThrow(/EIO/);
  });
});

// ===========================================================================
// The interaction frame handlers.
//
// These compose `encodeKeyChord` (the named-key grammar) and
// `runSettle` (the bounded injected-clock settle). The recording backend captures
// every byte written so the EXACT bytes + the submit ORDERING (text -> settle ->
// \r, never coalesced) are asserted; the fake scheduler drives the in-worker
// settle deterministically.
// ===========================================================================

function sendKeyFrame(keys: string[]): TerminalRequestFrame {
  return {
    sessionId: "s1",
    requestId: "rq-send-key",
    traceId: TRACE_ID,
    method: "send_key",
    params: { sessionId: "s1", keys },
  };
}

describe("createTerminalWorker — send_key (named-key grammar -> exact bytes)", () => {
  it("writes the EXACT control byte for C-c (\\x03) and replies { screen, cursor }", async () => {
    const rec = makeRecordingBackend();
    const worker = createTerminalWorker(
      baseDeps({ loadPty: () => ({ spawn: rec.spawn }) }),
    );

    await worker.handle(
      createFrame({ sessionId: "s1", bin: "/bin/bash", argv: [], cols: 80, rows: 24 }),
    );
    rec.emit("prompt$ "); // seed output so the post-action snapshot is non-empty

    const reply = await worker.handle(sendKeyFrame(["C-c"]));

    expect(reply.ok).toBe(true);
    expect(rec.writes).toEqual(["\x03"]); // exactly one write of Ctrl-C
    const result = reply.result as { screen: string; cursor: { x: number; y: number } };
    // The post-action perception is the PLAIN grid snapshot (not the raw ANSI ring):
    // the prompt is present and the REAL emulator cursor (on its row), not a {0,0} stub.
    expect(result.screen).toContain("prompt$");
    expect(result.cursor.y).toBe(0);
  });

  it("returns the PLAIN grid snapshot, NOT the raw ANSI ring (a driving agent must not be blinded by an offloaded byte-log)", async () => {
    // Regression for the live Rust-build failure: send_key/send_text/wait used to
    // return the raw `state.ring` (the accumulating ANSI byte-log), which for a
    // full-screen TUI exceeds the 100K tool-result offload cap → the result is
    // offloaded → the driving agent loses the CLI's state and flails. The fix:
    // return the emulator's plain grid snapshot (ANSI-free + bounded), like `read`.
    const rec = makeRecordingBackend();
    const worker = createTerminalWorker(baseDeps({ loadPty: () => ({ spawn: rec.spawn }) }));
    await worker.handle(createFrame({ sessionId: "s1", bin: "/bin/bash", argv: [], cols: 80, rows: 24 }));
    rec.emit("\x1b[31m\x1b[1mHELLO-ANSI\x1b[0m"); // heavily SGR-styled output (red, bold)

    const reply = await worker.handle(sendKeyFrame(["Enter"]));
    const screen = (reply.result as { screen: string }).screen;

    expect(screen).toContain("HELLO-ANSI"); // the rendered TEXT is perceived
    expect(screen).not.toContain("\x1b"); // but NO raw ANSI escapes (pre-fix returned state.ring)
    expect(screen.length).toBeLessThan(8192); // bounded — never the unbounded raw byte-log
  });

  it("writes the joined chord bytes for [Up, Enter] -> \\x1b[A\\r", async () => {
    const rec = makeRecordingBackend();
    const worker = createTerminalWorker(
      baseDeps({ loadPty: () => ({ spawn: rec.spawn }) }),
    );
    await worker.handle(
      createFrame({ sessionId: "s1", bin: "/bin/bash", argv: [], cols: 80, rows: 24 }),
    );

    await worker.handle(sendKeyFrame(["Up", "Enter"]));

    // A single write of the joined chord is fine; assert the concatenation.
    expect(rec.writes.join("")).toBe("\x1b[A\r");
  });

  it("writes \\x1b[Z for S-Tab (back-tab)", async () => {
    const rec = makeRecordingBackend();
    const worker = createTerminalWorker(
      baseDeps({ loadPty: () => ({ spawn: rec.spawn }) }),
    );
    await worker.handle(
      createFrame({ sessionId: "s1", bin: "/bin/bash", argv: [], cols: 80, rows: 24 }),
    );

    await worker.handle(sendKeyFrame(["S-Tab"]));

    expect(rec.writes.join("")).toBe("\x1b[Z");
  });

  it("does NOT write to the backend on an unknown key and replies ok:false with the invalid key (keystroke-injection guard)", async () => {
    const rec = makeRecordingBackend();
    const worker = createTerminalWorker(
      baseDeps({ loadPty: () => ({ spawn: rec.spawn }) }),
    );
    await worker.handle(
      createFrame({ sessionId: "s1", bin: "/bin/bash", argv: [], cols: 80, rows: 24 }),
    );

    const reply = await worker.handle(sendKeyFrame(["Frobnicate"]));

    expect(reply.ok).toBe(false);
    expect(reply.error ?? "").toMatch(/Frobnicate|invalid|unknown/i);
    // The encodeKeyChord throw is caught and surfaced — NOTHING written.
    expect(rec.writes.length).toBe(0);
  });

  it("routes send_key writes to the pipe backend stdin on the degraded path", async () => {
    const pipe = makeRecordingPipeBackend();
    const worker = createTerminalWorker(
      baseDeps({
        loadPty: () => {
          throw new Error("no node-pty");
        },
        spawnPipe: pipe.spawnPipe,
      }),
    );
    await worker.handle(
      createFrame({ sessionId: "s1", bin: "/bin/bash", argv: [], cols: 80, rows: 24 }),
    );

    await worker.handle(sendKeyFrame(["C-c"]));

    expect(pipe.writes).toEqual(["\x03"]);
  });

  it("accepts injected setTimer/clearTimer ports on TerminalWorkerDeps", async () => {
    const sched = makeFakeScheduler();
    const rec = makeRecordingBackend();
    // The deps MUST accept setTimer/clearTimer (needed for the settle in Task 2/3);
    // send_key itself needs no timer, but constructing the worker with them must
    // type-check and run.
    const worker = createTerminalWorker(
      baseDeps({
        loadPty: () => ({ spawn: rec.spawn }),
        setTimer: sched.setTimer,
        clearTimer: sched.clearTimer,
      }),
    );
    await worker.handle(
      createFrame({ sessionId: "s1", bin: "/bin/bash", argv: [], cols: 80, rows: 24 }),
    );

    const reply = await worker.handle(sendKeyFrame(["C-c"]));
    expect(reply.ok).toBe(true);
    expect(rec.writes).toEqual(["\x03"]);
  });
});

function sendTextFrame(
  text: string,
  opts: { submit?: boolean; bracketedPaste?: boolean } = {},
): TerminalRequestFrame {
  return {
    sessionId: "s1",
    requestId: "rq-send-text",
    traceId: TRACE_ID,
    method: "send_text",
    params: {
      sessionId: "s1",
      text,
      submit: opts.submit ?? false,
      bracketedPaste: opts.bracketedPaste ?? false,
    },
  };
}

function resizeFrame(cols: number, rows: number): TerminalRequestFrame {
  return {
    sessionId: "s1",
    requestId: "rq-resize",
    traceId: TRACE_ID,
    method: "resize",
    params: { sessionId: "s1", cols, rows },
  };
}

/**
 * The deterministic settle-drive pattern: the in-worker
 * settle resolves only when the fake clock fires its idle timer, but the handler
 * AWAITS that settle — so we cannot `await worker.handle(...)` then advance (the
 * promise never resolves; deadlock). Instead: kick the handle (capturing the
 * promise), `advance` past the idle window on the NEXT microtask tick to fire the
 * idle timer, THEN await. A small `await Promise.resolve()` lets the handler reach
 * its `await settleSession(...)` (registering the timer) before we advance.
 */
async function driveSettle<T>(
  promise: Promise<T>,
  sched: ReturnType<typeof makeFakeScheduler>,
  advanceMs: number,
): Promise<T> {
  // Yield so the async handler runs up to its first `await` (timer registered).
  await Promise.resolve();
  await Promise.resolve();
  sched.advance(advanceMs);
  return promise;
}

describe("createTerminalWorker — send_text (submit ordering + bracketed paste)", () => {
  it("send_text WITHOUT submit writes the text once, settles, never writes \\r", async () => {
    const sched = makeFakeScheduler();
    const rec = makeRecordingBackend();
    const worker = createTerminalWorker(
      baseDeps({ loadPty: () => ({ spawn: rec.spawn }), setTimer: sched.setTimer, clearTimer: sched.clearTimer }),
    );
    await worker.handle(createFrame({ sessionId: "s1", bin: "/bin/bash", argv: [], cols: 80, rows: 24 }));

    const p = worker.handle(sendTextFrame("ls", { submit: false }));
    const reply = await driveSettle(p, sched, 200); // > the 120ms idle window

    expect(reply.ok).toBe(true);
    expect(rec.writes).toEqual(["ls"]); // exactly the text — no \r ever
    expect(rec.writes).not.toContain("\r");
    const result = reply.result as { screen: string; cursor: { x: number; y: number } };
    expect(result.cursor).toEqual({ x: 0, y: 0 });
  });

  it("send_text WITH submit writes text, settles, THEN writes \\r (ordered, NEVER coalesced)", async () => {
    const sched = makeFakeScheduler();
    const rec = makeRecordingBackend();
    const worker = createTerminalWorker(
      baseDeps({ loadPty: () => ({ spawn: rec.spawn }), setTimer: sched.setTimer, clearTimer: sched.clearTimer }),
    );
    await worker.handle(createFrame({ sessionId: "s1", bin: "/bin/bash", argv: [], cols: 80, rows: 24 }));

    const p = worker.handle(sendTextFrame("ls", { submit: true }));
    // Let the handler write the text + register the settle timer, but DO NOT
    // advance yet: at this point only the text has been written, NOT the \r.
    await Promise.resolve();
    await Promise.resolve();
    expect(rec.writes).toEqual(["ls"]); // text first, Enter not yet sent

    // Now fire the idle settle; the \r is written only AFTER the settle resolves.
    sched.advance(200);
    const reply = await p;

    expect(reply.ok).toBe(true);
    expect(rec.writes).toEqual(["ls", "\r"]); // text, settle, THEN Enter — two writes
    // The text and Enter are NEVER coalesced into one write.
    expect(rec.writes).not.toContain("ls\r");
  });

  it("send_text bracketedPaste wraps the text in \\x1b[200~ ... \\x1b[201~", async () => {
    const sched = makeFakeScheduler();
    const rec = makeRecordingBackend();
    const worker = createTerminalWorker(
      baseDeps({ loadPty: () => ({ spawn: rec.spawn }), setTimer: sched.setTimer, clearTimer: sched.clearTimer }),
    );
    await worker.handle(createFrame({ sessionId: "s1", bin: "/bin/bash", argv: [], cols: 80, rows: 24 }));

    const p = worker.handle(sendTextFrame("pasted", { bracketedPaste: true, submit: false }));
    await driveSettle(p, sched, 200);

    expect(rec.writes).toContain("\x1b[200~pasted\x1b[201~");
    expect(rec.writes).not.toContain("\r");
  });

  it("send_text bracketedPaste + submit: wraps, settles, THEN \\r (writes === [wrapped, \\r])", async () => {
    const sched = makeFakeScheduler();
    const rec = makeRecordingBackend();
    const worker = createTerminalWorker(
      baseDeps({ loadPty: () => ({ spawn: rec.spawn }), setTimer: sched.setTimer, clearTimer: sched.clearTimer }),
    );
    await worker.handle(createFrame({ sessionId: "s1", bin: "/bin/bash", argv: [], cols: 80, rows: 24 }));

    const p = worker.handle(sendTextFrame("pasted", { bracketedPaste: true, submit: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(rec.writes).toEqual(["\x1b[200~pasted\x1b[201~"]); // wrapped first, no \r yet
    sched.advance(200);
    await p;

    expect(rec.writes).toEqual(["\x1b[200~pasted\x1b[201~", "\r"]);
  });

  it("send_text on an absent session returns the minimal not-alive snapshot (no throw)", async () => {
    const sched = makeFakeScheduler();
    const worker = createTerminalWorker(
      baseDeps({ loadPty: () => ({ spawn: makeRecordingBackend().spawn }), setTimer: sched.setTimer, clearTimer: sched.clearTimer }),
    );
    // No create — the session does not exist.
    const reply = await worker.handle(sendTextFrame("ls", { submit: true }));
    expect(reply.ok).toBe(true);
    expect((reply.result as { screen: string }).screen).toBe("");
  });
});

describe("createTerminalWorker — resize (pty winsize + ring geometry)", () => {
  it("calls pty.resize(cols,rows), updates state geometry, replies { ok:true }", async () => {
    const rec = makeRecordingBackend();
    const worker = createTerminalWorker(baseDeps({ loadPty: () => ({ spawn: rec.spawn }) }));
    await worker.handle(createFrame({ sessionId: "s1", bin: "/bin/bash", argv: [], cols: 80, rows: 24 }));

    const reply = await worker.handle(resizeFrame(100, 30));

    expect(reply.ok).toBe(true);
    expect((reply.result as { ok: boolean }).ok).toBe(true);
    // The pty backend's winsize was updated.
    expect(rec.resizes).toEqual([[100, 30]]);
    // The ring geometry is recorded and the grid is resized — a
    // subsequent read reflects the new cols/rows.
    const read = await worker.handle({
      sessionId: "s1",
      requestId: "rq-read",
      traceId: TRACE_ID,
      method: "read",
      params: { sessionId: "s1" },
    });
    expect((read.result as { cols: number; rows: number }).cols).toBe(100);
    expect((read.result as { cols: number; rows: number }).rows).toBe(30);
  });

  it("on the degraded pipe backend (no PTY winsize) still records geometry + replies { ok:true }", async () => {
    const pipe = makeRecordingPipeBackend();
    const worker = createTerminalWorker(
      baseDeps({
        loadPty: () => {
          throw new Error("no node-pty");
        },
        spawnPipe: pipe.spawnPipe,
      }),
    );
    await worker.handle(createFrame({ sessionId: "s1", bin: "/bin/bash", argv: [], cols: 80, rows: 24 }));

    const reply = await worker.handle(resizeFrame(120, 40));

    expect(reply.ok).toBe(true);
    expect((reply.result as { ok: boolean }).ok).toBe(true);
    const read = await worker.handle({
      sessionId: "s1",
      requestId: "rq-read",
      traceId: TRACE_ID,
      method: "read",
      params: { sessionId: "s1" },
    });
    expect((read.result as { cols: number; rows: number }).cols).toBe(120);
    expect((read.result as { cols: number; rows: number }).rows).toBe(40);
  });
});

function waitFrame(params: {
  forIdleMs?: number;
  forText?: string;
  forExit?: boolean;
  timeoutMs?: number;
}): TerminalRequestFrame {
  return {
    sessionId: "s1",
    requestId: "rq-wait",
    traceId: TRACE_ID,
    method: "wait",
    params: { sessionId: "s1", ...params },
  };
}

describe("createTerminalWorker — wait (settle -> {matched,isComplete,reason,screen,cursor})", () => {
  it("wait IDLE: a quiet ring resolves { matched:true, isComplete:true, reason:'idle' } with the ring screen", async () => {
    const sched = makeFakeScheduler();
    const rec = makeRecordingBackend();
    const worker = createTerminalWorker(
      baseDeps({ loadPty: () => ({ spawn: rec.spawn }), setTimer: sched.setTimer, clearTimer: sched.clearTimer }),
    );
    await worker.handle(createFrame({ sessionId: "s1", bin: "/bin/bash", argv: [], cols: 80, rows: 24 }));
    rec.emit("boot\n");

    const p = worker.handle(waitFrame({ forIdleMs: 100 }));
    await Promise.resolve();
    await Promise.resolve();
    sched.advance(100); // ring quiet for the idle window
    const reply = await p;

    expect(reply.ok).toBe(true);
    const r = reply.result as {
      matched: boolean;
      isComplete: boolean;
      reason: string;
      screen: string;
      cursor: { x: number; y: number };
    };
    expect(r).toMatchObject({ matched: true, isComplete: true, reason: "idle" });
    expect(r.screen).toContain("boot"); // the post-action plain grid snapshot (not the raw ANSI ring)
    expect(r.cursor).toEqual({ x: expect.any(Number), y: expect.any(Number) });
  });

  it("wait TEXT: a ring append carrying forText resolves reason:'text' WITHOUT waiting the full idle window", async () => {
    const sched = makeFakeScheduler();
    const rec = makeRecordingBackend();
    const worker = createTerminalWorker(
      baseDeps({ loadPty: () => ({ spawn: rec.spawn }), setTimer: sched.setTimer, clearTimer: sched.clearTimer }),
    );
    await worker.handle(createFrame({ sessionId: "s1", bin: "/bin/bash", argv: [], cols: 80, rows: 24 }));

    const p = worker.handle(waitFrame({ forText: "ready>", forIdleMs: 5_000, timeoutMs: 10_000 }));
    await Promise.resolve();
    await Promise.resolve();
    // A backend data event carries the awaited text — resolves immediately (no
    // idle advance, no timeout advance).
    rec.emit("ready>");
    const reply = await p;

    const r = reply.result as { matched: boolean; isComplete: boolean; reason: string; screen: string };
    expect(r).toMatchObject({ matched: true, isComplete: true, reason: "text" });
    expect(r.screen).toContain("ready>");
  });

  it("wait EXIT: a backend close resolves reason:'exit'", async () => {
    const sched = makeFakeScheduler();
    const pipe = makeRecordingPipeBackend();
    const worker = createTerminalWorker(
      baseDeps({
        loadPty: () => {
          throw new Error("no node-pty");
        },
        spawnPipe: pipe.spawnPipe,
        setTimer: sched.setTimer,
        clearTimer: sched.clearTimer,
      }),
    );
    await worker.handle(createFrame({ sessionId: "s1", bin: "/bin/bash", argv: [], cols: 80, rows: 24 }));

    const p = worker.handle(waitFrame({ forExit: true, forIdleMs: 5_000, timeoutMs: 10_000 }));
    await Promise.resolve();
    await Promise.resolve();
    pipe.close(); // backend exits
    const reply = await p;

    const r = reply.result as { matched: boolean; isComplete: boolean; reason: string };
    expect(r).toMatchObject({ matched: true, isComplete: true, reason: "exit" });
  });

  it("wait EXIT on the PTY backend: a node-pty onExit resolves reason:'exit' (not timeout) — the VPS real-PTY gate", async () => {
    // REGRESSION (RED-first): the PTY (node-pty) backend MUST wire `handle.onExit`
    // → markExited the same way the pipe backend wires `close`/`error`. Without it,
    // a real node-pty child that exits never notifies the in-flight settle's onExit
    // subscription, so `wait({forExit:true})` runs to TIMEOUT (reason "timeout")
    // instead of settling "exit". macOS uses the degraded pipe backend in-harness
    // (which DID wire close), masking this; the VPS real-PTY gate
    // (`terminal-worker-entry.linux.test.ts:132`,
    // `terminal-interaction-roundtrip.linux.test.ts:161`) caught it. This injects a
    // fake PTY so the bug reproduces deterministically on macOS.
    const sched = makeFakeScheduler();
    const rec = makeRecordingBackend();
    const worker = createTerminalWorker(
      baseDeps({
        loadPty: () => ({ spawn: rec.spawn }),
        setTimer: sched.setTimer,
        clearTimer: sched.clearTimer,
      }),
    );
    const created = await worker.handle(
      createFrame({ sessionId: "s1", bin: "/bin/cat", argv: [], cols: 80, rows: 24 }),
    );
    expect((created.result as { backend: string }).backend).toBe("pty"); // the PTY backend, not degraded

    const p = worker.handle(waitFrame({ forExit: true, forIdleMs: 5_000, timeoutMs: 10_000 }));
    await Promise.resolve();
    await Promise.resolve();
    // The live node-pty child exits — must fire markExited and resolve the settle
    // "exit" WITHOUT advancing the overall timeout clock.
    rec.emitExit({ exitCode: 0 });
    const reply = await p;

    const r = reply.result as { matched: boolean; isComplete: boolean; reason: string };
    expect(r).toMatchObject({ matched: true, isComplete: true, reason: "exit" });

    // A subsequent read confirms the PTY exit flipped the session not-alive
    // (markExited set state.alive=false), same as the pipe backend's close.
    const read = await worker.handle({
      sessionId: "s1",
      requestId: "rq-read-after-exit",
      traceId: TRACE_ID,
      method: "read",
      params: { sessionId: "s1" },
    });
    expect((read.result as { alive: boolean }).alive).toBe(false);

    // No timer leaked (the settle cleaned up the overall-timeout timer on exit).
    expect(sched.liveTimerCount()).toBe(0);
  });

  it("wait TIMEOUT (load-bearing): a ring that never quiets resolves { matched:false, isComplete:false, reason:'timeout' }", async () => {
    const sched = makeFakeScheduler();
    const rec = makeRecordingBackend();
    const worker = createTerminalWorker(
      baseDeps({ loadPty: () => ({ spawn: rec.spawn }), setTimer: sched.setTimer, clearTimer: sched.clearTimer }),
    );
    await worker.handle(createFrame({ sessionId: "s1", bin: "/bin/bash", argv: [], cols: 80, rows: 24 }));

    // forIdleMs:100 but a data event every 40ms keeps the ring from ever being
    // quiet for 100ms; the overall timeout (capped) fires first.
    const p = worker.handle(waitFrame({ forIdleMs: 100, timeoutMs: 1_000 }));
    await Promise.resolve();
    await Promise.resolve();
    // Drive the ring busy: emit every 40ms up to (and past) the 1000ms cap.
    for (let t = 40; t <= 1_040; t += 40) {
      rec.emit("x");
      sched.advance(40);
      await Promise.resolve();
    }
    const reply = await p;

    const r = reply.result as { matched: boolean; isComplete: boolean; reason: string; screen: string };
    // The reply RESOLVES (the worker never holds the frame open).
    expect(reply.ok).toBe(true);
    expect(r.isComplete).toBe(false); // EXPLICIT: a false isComplete:true would strand the agent
    expect(r).toMatchObject({ matched: false, reason: "timeout" });
    expect(r.screen).toContain("x"); // the current (busy) ring
  });

  it("wait on an ABSENT session resolves the gone shape { matched:false, isComplete:false, reason:'exit' }", async () => {
    const sched = makeFakeScheduler();
    const worker = createTerminalWorker(
      baseDeps({ loadPty: () => ({ spawn: makeRecordingBackend().spawn }), setTimer: sched.setTimer, clearTimer: sched.clearTimer }),
    );
    // No create.
    const reply = await worker.handle(waitFrame({ forIdleMs: 100 }));
    const r = reply.result as { matched: boolean; isComplete: boolean; reason: string };
    expect(r).toMatchObject({ matched: false, isComplete: false, reason: "exit" });
  });
});

// ===========================================================================
// The worker rewired to the per-session @xterm emulator.
//
// `read` now serializes the REAL grid (real cursor, real alt) from the
// per-session emulator instead of the raw stdout ring. These tests drive the
// REAL `createSessionEmulator` (pure-JS @xterm — runs on macOS) for the
// grid/cursor/alt assertions, and a RECORDING emulator stub (via the injectable
// `createEmulator` dep) to prove the wiring (resize called, write fed).
// ===========================================================================

function readFrame(): TerminalRequestFrame {
  return {
    sessionId: "s1",
    requestId: "rq-read-emu",
    traceId: TRACE_ID,
    method: "read",
    params: { sessionId: "s1" },
  };
}

/**
 * A RECORDING emulator stub for the injectable `createEmulator` dep. Captures
 * `write`/`resize`/`dispose` calls so the worker WIRING can be asserted without
 * a real Terminal. `snapshot` returns a canned grid view (the wiring tests do
 * not need real parsing — the real-emulator tests cover that).
 */
function makeRecordingEmulator(): {
  createEmulator: (opts: { cols: number; rows: number; scrollback: number }) => unknown;
  writes: string[];
  resizes: Array<[number, number]>;
  disposes: number;
  lastConstruct: () => { cols: number; rows: number; scrollback: number } | undefined;
  /** Toggle the (canned) hasContentBelowFold() return for the settle-gate test. */
  setBelowFold: (v: boolean) => void;
  /** Override the (canned) snapshot().screen for the diff test. */
  setScreen: (s: string) => void;
} {
  const writes: string[] = [];
  const resizes: Array<[number, number]> = [];
  let disposes = 0;
  let belowFold = false;
  let screen = "CANNED";
  let lastOpts: { cols: number; rows: number; scrollback: number } | undefined;
  return {
    writes,
    resizes,
    get disposes() {
      return disposes;
    },
    lastConstruct: () => lastOpts,
    setBelowFold: (v: boolean) => {
      belowFold = v;
    },
    setScreen: (s: string) => {
      screen = s;
    },
    createEmulator: (opts: { cols: number; rows: number; scrollback: number }) => {
      lastOpts = opts;
      let curCols = opts.cols;
      let curRows = opts.rows;
      return {
        // Mirror the real wrapper's `write(data): Promise<void>` shape so the
        // worker's appendRing wiring is unchanged.
        write: (data: string): Promise<void> => {
          writes.push(data);
          return Promise.resolve();
        },
        snapshot: () => ({
          screen,
          cursor: { x: 7, y: 2 },
          cols: curCols,
          rows: curRows,
          alt: false,
        }),
        resize: (cols: number, rows: number) => {
          resizes.push([cols, rows]);
          curCols = cols;
          curRows = rows;
        },
        hasContentBelowFold: () => belowFold,
        dispose: () => {
          disposes++;
        },
        // `term` is unused by the worker wiring; a stub satisfies the type.
        term: {} as unknown,
      };
    },
  };
}

describe("createTerminalWorker — read serializes the REAL @xterm grid", () => {
  it("read returns the real grid + REAL cursor (not {0,0}) — the ring-snapshot replacement", async () => {
    // Use the REAL createSessionEmulator (default dep) so the grid/cursor/alt are
    // produced by genuine @xterm parsing.
    const rec = makeRecordingBackend();
    const worker = createTerminalWorker(baseDeps({ loadPty: () => ({ spawn: rec.spawn }) }));
    await worker.handle(createFrame({ sessionId: "s1", bin: "/bin/bash", argv: [], cols: 80, rows: 24 }));

    // Clear + home + "abc": the real emulator lands the cursor at column 3.
    rec.emit("\x1b[2J\x1b[Habc");
    // Wait for the @xterm macrotask parse-flush so the read sees the grid.
    await flushEmulator();

    const reply = await worker.handle(readFrame());
    const view = reply.result as {
      screen: string;
      cursor: { x: number; y: number };
      cols: number;
      rows: number;
      alt: boolean;
      alive: boolean;
    };

    expect(view.screen).toContain("abc");
    // RED-provable: the pre-patch ring path returned cursor {0,0}; the emulator
    // returns the REAL cursorX (3 after "abc").
    expect(view.cursor.x).toBe(3);
    expect(view.alt).toBe(false);
    expect(view.alive).toBe(true);
  });

  it("read reports alt:true on an alt-screen byte stream and alt:false on leave", async () => {
    const rec = makeRecordingBackend();
    const worker = createTerminalWorker(baseDeps({ loadPty: () => ({ spawn: rec.spawn }) }));
    await worker.handle(createFrame({ sessionId: "s1", bin: "/bin/vim", argv: [], cols: 80, rows: 24 }));

    rec.emit("\x1b[?1049h"); // enter alt screen
    rec.emit("VIM");
    await flushEmulator();
    let reply = await worker.handle(readFrame());
    let view = reply.result as { screen: string; alt: boolean };
    expect(view.alt).toBe(true);
    expect(view.screen).toContain("VIM");

    rec.emit("\x1b[?1049l"); // leave alt screen
    await flushEmulator();
    reply = await worker.handle(readFrame());
    view = reply.result as { screen: string; alt: boolean };
    expect(view.alt).toBe(false);
  });

  it("resize resizes the emulator grid (the real @xterm reflow) and read reflects it", async () => {
    const rec = makeRecordingBackend();
    const recEmu = makeRecordingEmulator();
    const worker = createTerminalWorker(
      baseDeps({ loadPty: () => ({ spawn: rec.spawn }), createEmulator: recEmu.createEmulator }),
    );
    await worker.handle(createFrame({ sessionId: "s1", bin: "/bin/bash", argv: [], cols: 80, rows: 24 }));

    await worker.handle(resizeFrame(100, 30));

    // The emulator's resize was called with the new geometry (the spy proves the
    // wiring; the real-emulator path reflows for real).
    expect(recEmu.resizes).toEqual([[100, 30]]);
    const reply = await worker.handle(readFrame());
    const view = reply.result as { cols: number; rows: number };
    expect(view.cols).toBe(100);
    expect(view.rows).toBe(30);
  });

  it("constructs the emulator on create and feeds appendRing into it (wiring)", async () => {
    const rec = makeRecordingBackend();
    const recEmu = makeRecordingEmulator();
    const worker = createTerminalWorker(
      baseDeps({ loadPty: () => ({ spawn: rec.spawn }), createEmulator: recEmu.createEmulator }),
    );
    await worker.handle(createFrame({ sessionId: "s1", bin: "/bin/bash", argv: [], cols: 80, rows: 24 }));

    // The emulator was constructed with the create-frame geometry + a default scrollback.
    expect(recEmu.lastConstruct()?.cols).toBe(80);
    expect(recEmu.lastConstruct()?.rows).toBe(24);
    expect(recEmu.lastConstruct()?.scrollback).toBeGreaterThan(0);
  });

  it("constructs the emulator with the scrollback carried on the create frame", async () => {
    // The create frame now carries the per-session scrollback ceiling
    // (the registry sources it from DEFAULT_SCROLLBACK / config). The worker must
    // read it from the frame — NOT hard-code SCROLLBACK_DEFAULT. Pre-patch the
    // construction ignored the frame and always used 1000, so this fails.
    const rec = makeRecordingBackend();
    const recEmu = makeRecordingEmulator();
    const worker = createTerminalWorker(
      baseDeps({ loadPty: () => ({ spawn: rec.spawn }), createEmulator: recEmu.createEmulator }),
    );
    await worker.handle(
      createFrame({ sessionId: "s1", bin: "/bin/bash", argv: [], cols: 80, rows: 24, scrollback: 250 }),
    );
    expect(recEmu.lastConstruct()?.scrollback).toBe(250);

    // Every data chunk is fed into the emulator's write (the grid ingest). The
    // worker chains the writes through state.writeFlush (a serialized in-order queue
    // resolving on the parse callback), so drain it via a read (which awaits the
    // flush) before asserting the in-order feed.
    rec.emit("first");
    rec.emit("second");
    await worker.handle(readFrame()); // read awaits writeFlush -> the chain drains
    expect(recEmu.writes).toEqual(["first", "second"]);
  });

  it("degraded backend (loadPty throws) STILL feeds the emulator + read uses it (no regression)", async () => {
    // The emulator renders whatever bytes arrive on BOTH backends. On the
    // degraded pipe backend the emulator is still constructed + fed; read uses it.
    const pipe = makeFakePipeBackend();
    const worker = createTerminalWorker(
      baseDeps({
        loadPty: () => {
          throw new Error("no node-pty");
        },
        spawnPipe: pipe.spawnPipe,
      }),
    );
    await worker.handle(createFrame({ sessionId: "s1", bin: "/bin/bash", argv: [], cols: 80, rows: 24 }));

    pipe.emit("degraded-line\n");
    await flushEmulator();
    const reply = await worker.handle(readFrame());
    const view = reply.result as { screen: string; alive: boolean };

    // The accumulated output is perceivable (the emulator rendered it); the
    // degraded backend keeps working (not regressed).
    expect(view.screen).toContain("degraded-line");
    expect(view.alive).toBe(true);
  });
});

// ===========================================================================
// The worker read threads format/scrollback into emu.snapshot AND
// awaits the pending write-parse before serializing (the §2.4 stability flush).
// ===========================================================================

function readFrameWith(params: { format?: string; scrollback?: number }): TerminalRequestFrame {
  return {
    sessionId: "s1",
    requestId: "rq-read-fmt",
    traceId: TRACE_ID,
    method: "read",
    params: { sessionId: "s1", ...params },
  };
}

describe("createTerminalWorker — read threads format/scrollback + awaits the write-flush", () => {
  it("read format:'ansi' returns SGR; format:'text' (default) strips it", async () => {
    const rec = makeRecordingBackend();
    const worker = createTerminalWorker(baseDeps({ loadPty: () => ({ spawn: rec.spawn }) }));
    await worker.handle(createFrame({ sessionId: "s1", bin: "/bin/bash", argv: [], cols: 80, rows: 24 }));

    rec.emit("\x1b[31mRED\x1b[0m");
    await flushEmulator();

    const ansi = (await worker.handle(readFrameWith({ format: "ansi" }))).result as { screen: string };
    expect(ansi.screen).toContain("\x1b["); // the worker passed format:'ansi' to emu.snapshot
    expect(ansi.screen).toContain("RED");

    const text = (await worker.handle(readFrameWith({ format: "text" }))).result as { screen: string };
    expect(text.screen).not.toContain("\x1b[");
    expect(text.screen).toContain("RED");

    // An absent/invalid format defaults to text (no SGR).
    const dflt = (await worker.handle(readFrame())).result as { screen: string };
    expect(dflt.screen).not.toContain("\x1b[");
  });

  it("read scrollback:N returns an off-screen line the default read omits", async () => {
    const rec = makeRecordingBackend();
    const worker = createTerminalWorker(baseDeps({ loadPty: () => ({ spawn: rec.spawn }) }));
    // Small-rows session so lines scroll off.
    await worker.handle(createFrame({ sessionId: "s1", bin: "/bin/bash", argv: [], cols: 80, rows: 5 }));

    for (let i = 1; i <= 12; i++) rec.emit(`LINE-${String(i).padStart(2, "0")}\r\n`);
    await flushEmulator();

    const dflt = (await worker.handle(readFrame())).result as { screen: string };
    expect(dflt.screen).not.toContain("LINE-01"); // scrolled off the viewport

    const scrolled = (await worker.handle(readFrameWith({ scrollback: 10 }))).result as { screen: string };
    expect(scrolled.screen).toContain("LINE-01"); // the worker passed scrollback to emu.snapshot
  });

  it("read AWAITS the pending write-parse — an immediate read (no manual flush) reflects the chunk (§2.4)", async () => {
    // The load-bearing stability guarantee: the worker tracks the latest write-
    // flush promise and `read` awaits it before serializing. With the real async
    // @xterm write(data, cb), a NON-awaiting read would observe a stale (blank)
    // grid. Here we emit and IMMEDIATELY read WITHOUT flushEmulator() — the read
    // must still reflect the just-emitted bytes (RED on the pre-patch path).
    const rec = makeRecordingBackend();
    const worker = createTerminalWorker(baseDeps({ loadPty: () => ({ spawn: rec.spawn }) }));
    await worker.handle(createFrame({ sessionId: "s1", bin: "/bin/bash", argv: [], cols: 80, rows: 24 }));

    rec.emit("\x1b[2J\x1b[Himmediate");
    // NO flushEmulator() — read must await the pending parse itself.
    const reply = await worker.handle(readFrame());
    const view = reply.result as { screen: string; cursor: { x: number; y: number } };

    expect(view.screen).toContain("immediate");
    expect(view.cursor.x).toBe(9); // "immediate" is 9 chars — the real cursor after the awaited parse
  });
});

// ===========================================================================
// The per-session lastSnapshot screen-diff on read + the settle
// gated on !hasContentBelowFold() (the "more content below ⇒ NOT settled" rule).
// ===========================================================================

describe("createTerminalWorker — read returns a screen-diff + keeps lastSnapshot", () => {
  it("first read changed:true; a change -> changed:true; no change -> changed:false", async () => {
    const rec = makeRecordingBackend();
    const recEmu = makeRecordingEmulator();
    const worker = createTerminalWorker(
      baseDeps({ loadPty: () => ({ spawn: rec.spawn }), createEmulator: recEmu.createEmulator }),
    );
    await worker.handle(createFrame({ sessionId: "s1", bin: "/bin/bash", argv: [], cols: 80, rows: 24 }));

    // First read: no prior snapshot -> changed:true.
    recEmu.setScreen("line A");
    const first = (await worker.handle(readFrame())).result as { diff: { changed: boolean } };
    expect(first.diff.changed).toBe(true);

    // The grid changes -> the next read diffs changed:true.
    recEmu.setScreen("line B");
    const second = (await worker.handle(readFrame())).result as {
      diff: { changed: boolean; firstChangedRow: number };
    };
    expect(second.diff.changed).toBe(true);

    // No change between reads -> changed:false (lastSnapshot matched).
    const third = (await worker.handle(readFrame())).result as { diff: { changed: boolean } };
    expect(third.diff.changed).toBe(false);
  });
});

describe("createTerminalWorker — settle gated on !hasContentBelowFold (load-bearing)", () => {
  it("a wait over a below-fold frame does NOT resolve idle; it settles once below-fold flips false", async () => {
    const sched = makeFakeScheduler();
    const rec = makeRecordingBackend();
    const recEmu = makeRecordingEmulator();
    recEmu.setBelowFold(true); // content remains below the fold -> NOT settleable
    const worker = createTerminalWorker(
      baseDeps({
        loadPty: () => ({ spawn: rec.spawn }),
        createEmulator: recEmu.createEmulator,
        setTimer: sched.setTimer,
        clearTimer: sched.clearTimer,
      }),
    );
    await worker.handle(createFrame({ sessionId: "s1", bin: "/bin/bash", argv: [], cols: 80, rows: 24 }));

    // A pending-detector: race the wait against a synchronous sentinel so a
    // resolved wait is detectable AFTER draining microtasks (a thorough drain so
    // a RED state — no gate — that resolved idle at the first advance is caught).
    const PENDING = Symbol("pending");
    const waitP = worker.handle(waitFrame({ forIdleMs: 50 }));
    const drain = async (): Promise<void> => {
      for (let i = 0; i < 10; i++) await Promise.resolve();
    };
    const raced = (): Promise<typeof PENDING | { result: { reason: string } }> =>
      Promise.race([waitP, Promise.resolve(PENDING)]) as Promise<
        typeof PENDING | { result: { reason: string } }
      >;

    await drain(); // let the handler reach `await settleSession(...)` (timer armed)

    // Advance past the idle window: the idle timer fires but isSettleable() is
    // false (content below the fold) -> it must RE-ARM, NOT resolve idle.
    sched.advance(50);
    await drain();
    expect(await raced()).toBe(PENDING); // RED: a missing gate resolves idle here

    // Still below the fold after another window -> still pending.
    sched.advance(50);
    await drain();
    expect(await raced()).toBe(PENDING);

    // Content scrolls into view: below-fold flips false; a ring change re-arms the
    // idle debounce, and the next quiet window resolves idle.
    recEmu.setBelowFold(false);
    rec.emit("x"); // ring change re-arms idle
    await drain();
    sched.advance(50);
    const r = (await waitP).result as { reason: string; isComplete: boolean };
    expect(r.reason).toBe("idle");
    expect(r.isComplete).toBe(true);
  });

  it("no regression: below-fold false settles idle as the baseline settle does", async () => {
    const sched = makeFakeScheduler();
    const rec = makeRecordingBackend();
    const recEmu = makeRecordingEmulator();
    recEmu.setBelowFold(false); // nothing below the fold -> the gate is a no-op
    const worker = createTerminalWorker(
      baseDeps({
        loadPty: () => ({ spawn: rec.spawn }),
        createEmulator: recEmu.createEmulator,
        setTimer: sched.setTimer,
        clearTimer: sched.clearTimer,
      }),
    );
    await worker.handle(createFrame({ sessionId: "s1", bin: "/bin/bash", argv: [], cols: 80, rows: 24 }));
    rec.emit("boot\n");

    const p = worker.handle(waitFrame({ forIdleMs: 50 }));
    await Promise.resolve();
    await Promise.resolve();
    sched.advance(50); // a quiet idle window -> resolves idle exactly as before
    const r = (await p).result as { reason: string; isComplete: boolean };
    expect(r.reason).toBe("idle");
    expect(r.isComplete).toBe(true);
  });
});

// ===========================================================================
// Wave 2 (124-05): the worker drives classifyFrame on each SETTLED frame and
// emits an attention TerminalEventFrame on fd3 via the injected writeFd3 — the
// no-poll mechanism's worker half (TR-11). EDGE-triggered: a settled+parked frame
// emits terminal:input_needed; a never-parked working stream emits nothing. The
// injected fd3-writer captures the frames so the wiring is provable on macOS.
// ===========================================================================

import { decodeFrames, type TerminalEventFrame } from "./terminal-ipc.js";

/** A capturing fake fd3-writer + a decoder over everything written. */
function makeFd3Capture(): {
  writeFd3: (b: Buffer) => void;
  frames: () => TerminalEventFrame[];
} {
  const buffers: Buffer[] = [];
  return {
    writeFd3: (b: Buffer) => buffers.push(b),
    frames: () =>
      buffers.length === 0 ? [] : (decodeFrames(Buffer.concat(buffers)) as TerminalEventFrame[]),
  };
}

describe("createTerminalWorker — TR-11 fd3 attention emit on a settled frame (no poll)", () => {
  it("a foreground `wait` settle on a cursor-parked prompt SUPPRESSES the fd3 emit (LIVE-04 #4 — the wait reply is the agent's attention signal)", async () => {
    const sched = makeFakeScheduler();
    const rec = makeRecordingBackend();
    const fd3 = makeFd3Capture();
    const worker = createTerminalWorker(
      baseDeps({
        loadPty: () => ({ spawn: rec.spawn }),
        setTimer: sched.setTimer,
        clearTimer: sched.clearTimer,
        writeFd3: fd3.writeFd3, // 124-05: the injected fd3 push-channel writer
      }),
    );
    await worker.handle(createFrame({ sessionId: "s1", bin: "/bin/bash", argv: [], cols: 80, rows: 24 }));

    // Render a real parked prompt: a boot line + a trailing prompt with NO newline,
    // so the @xterm cursor lands on the prompt line (the last non-blank row) — parked.
    rec.emit("boot output line\n");
    rec.emit("Do you trust this? (y/n) ");

    // A `wait` settle resolves idle on the now-quiet, parked frame. LIVE-04 (#4): this is the
    // agent's FOREGROUND wait — its REPLY (the resolved WaitResult) is the agent's attention signal
    // (it unblocks + drives), so the worker SUPPRESSES the fd3 emit for a wait settle. A fd3 woken
    // turn here would RACE the agent (the launch escalation: at launch claude's welcome screen
    // settles DURING the wait → a spurious "waiting for input" before the agent sends its first
    // keystroke). The emit mechanism itself is proven in terminal-attention-emitter.test.ts; a
    // backgrounded drive is attended by the daemon backstop, not this fd3.
    const p = worker.handle(waitFrame({ forIdleMs: 50 }));
    await Promise.resolve();
    await Promise.resolve();
    await flushEmulator(); // let the @xterm parse land so the snapshot reflects the prompt
    sched.advance(50);
    await p;
    await flushEmulator();

    expect(
      fd3.frames(),
      "a foreground wait settle writes NO fd3 frame (LIVE-04 — the wait reply is the agent's attention signal)",
    ).toHaveLength(0);
  });

  it("a settled working stream that never parks (cursor mid-screen, content below) emits NO input_needed frame", async () => {
    const sched = makeFakeScheduler();
    const rec = makeRecordingBackend();
    const fd3 = makeFd3Capture();
    const worker = createTerminalWorker(
      baseDeps({
        loadPty: () => ({ spawn: rec.spawn }),
        setTimer: sched.setTimer,
        clearTimer: sched.clearTimer,
        writeFd3: fd3.writeFd3,
      }),
    );
    await worker.handle(createFrame({ sessionId: "s1", bin: "/bin/bash", argv: [], cols: 80, rows: 24 }));

    // A generation-style frame: the cursor is moved UP to mid-screen (CUP) with content
    // still rendered BELOW it — the thinking-pause shape the classifier reads as working.
    rec.emit("line one of generated output\n");
    rec.emit("line two\nline three\nline four\n");
    rec.emit("\x1b[2;1H"); // move cursor to row 2 col 1 — above the rendered tail (not parked)

    const p = worker.handle(waitFrame({ forIdleMs: 50 }));
    await Promise.resolve();
    await Promise.resolve();
    await flushEmulator();
    sched.advance(50);
    await p;
    await flushEmulator();

    const inputNeeded = fd3.frames().filter((f) => f.event === "terminal:input_needed");
    expect(inputNeeded).toHaveLength(0);
  });

  it("a worker with NO writeFd3 injected still settles normally (the emit is best-effort, never required)", async () => {
    const sched = makeFakeScheduler();
    const rec = makeRecordingBackend();
    const worker = createTerminalWorker(
      // No writeFd3 — the worker must not crash; the settle still resolves.
      baseDeps({ loadPty: () => ({ spawn: rec.spawn }), setTimer: sched.setTimer, clearTimer: sched.clearTimer }),
    );
    await worker.handle(createFrame({ sessionId: "s1", bin: "/bin/bash", argv: [], cols: 80, rows: 24 }));
    rec.emit("ready> ");

    const p = worker.handle(waitFrame({ forIdleMs: 50 }));
    await Promise.resolve();
    await Promise.resolve();
    await flushEmulator();
    sched.advance(50);
    const reply = await p;
    expect(reply.ok).toBe(true);
    expect((reply.result as { reason: string }).reason).toBe("idle");
  });

  it("a child that exits with NO settle pending still pushes terminal:session_state(exited) on fd3 (the exit wake — TR-11 holds for completion, not just prompts)", async () => {
    const sched = makeFakeScheduler();
    const rec = makeRecordingBackend();
    const fd3 = makeFd3Capture();
    const worker = createTerminalWorker(
      baseDeps({
        loadPty: () => ({ spawn: rec.spawn }),
        setTimer: sched.setTimer,
        clearTimer: sched.clearTimer,
        writeFd3: fd3.writeFd3,
      }),
    );
    await worker.handle(createFrame({ sessionId: "s1", bin: "/bin/bash", argv: ["-c", "true"], cols: 80, rows: 24 }));

    // Output, then the child EXITS while the agent has NOTHING in flight — no wait,
    // no read, no send (the "long command finished while the agent sat idle" shape;
    // ALSO the `claude --help` soak shape: print + exit, never a prompt). Pre-patch
    // the ONLY emit site is the settle path, so this exit pushes NOTHING and an
    // event-driven agent would never be woken — it would have to poll (the exact
    // anti-pattern TR-11 forbids).
    rec.emit("done\n");
    await flushEmulator();
    rec.emitExit({ exitCode: 0 });
    // Drain the fire-and-forget exit observe (awaits the emulator parse internally).
    await flushEmulator();
    await Promise.resolve();
    await Promise.resolve();
    await flushEmulator();

    const exitFrames = fd3.frames().filter((f) => f.event === "terminal:session_state");
    expect(exitFrames).toHaveLength(1); // the exited transition rode fd3 — push, no poll
    expect(exitFrames[0]!.sessionId).toBe("s1");
    expect(exitFrames[0]!.payload).toMatchObject({ state: "exited" });
    // Redaction-safe: no screen/text on the wire.
    expect(exitFrames[0]!.payload).not.toHaveProperty("screen");
  });

  it("an exit that resolves a PENDING settle pushes the exited transition exactly ONCE (the exit observe + the settle observe dedup edge-triggered)", async () => {
    const sched = makeFakeScheduler();
    const rec = makeRecordingBackend();
    const fd3 = makeFd3Capture();
    const worker = createTerminalWorker(
      baseDeps({
        loadPty: () => ({ spawn: rec.spawn }),
        setTimer: sched.setTimer,
        clearTimer: sched.clearTimer,
        writeFd3: fd3.writeFd3,
      }),
    );
    await worker.handle(createFrame({ sessionId: "s1", bin: "/bin/bash", argv: ["-c", "true"], cols: 80, rows: 24 }));
    rec.emit("working...\n");

    // A wait({forExit}) is IN FLIGHT when the child exits: the exit resolves the settle
    // (whose own observe classifies exited) AND fires the exit-path observe — the
    // edge-triggered emitter must collapse them into ONE session_state frame.
    const p = worker.handle(waitFrame({ forExit: true, timeoutMs: 5_000 }));
    await Promise.resolve();
    await flushEmulator();
    rec.emitExit({ exitCode: 0 });
    await p;
    await flushEmulator();
    await Promise.resolve();
    await Promise.resolve();
    await flushEmulator();

    const exitFrames = fd3.frames().filter((f) => f.event === "terminal:session_state");
    expect(exitFrames).toHaveLength(1); // edge-triggered: never a double push for one exit
    expect(exitFrames[0]!.payload).toMatchObject({ state: "exited" });
  });
});

// ===========================================================================
// 124-06 Task 1 — the worker `status` frame: the classifier stays SINGLE-HOMED
// in the worker. A `status` request builds a ClassifierFrame from the current
// emulator snapshot (+ the diff vs the previously-classified frame + the
// per-session progress clock), runs classifyFrame, and replies the spec §5
// perception subset {state, cursorParked, screenDiffEmpty, interactions, exitCode?}.
// RED on pre-patch: there is NO `status` dispatch case → dispatch replies the
// `unknown method: status` ok:false (the default branch), so `reply.ok` is false
// and `result` is undefined.
// ===========================================================================

/** A `status` request frame for the default session id. */
function statusFrame(): TerminalRequestFrame {
  return {
    sessionId: "s1",
    requestId: "rq-status",
    traceId: TRACE_ID,
    method: "status" as TerminalRequestFrame["method"],
    params: { sessionId: "s1" },
  };
}

describe("createTerminalWorker — 124-06 status frame (classifier single-homed in the worker)", () => {
  it("a settled, cursor-parked prompt → status replies state:'awaiting-input', cursorParked:true, screenDiffEmpty:true", async () => {
    const sched = makeFakeScheduler();
    const rec = makeRecordingBackend();
    const worker = createTerminalWorker(
      baseDeps({ loadPty: () => ({ spawn: rec.spawn }), setTimer: sched.setTimer, clearTimer: sched.clearTimer }),
    );
    await worker.handle(createFrame({ sessionId: "s1", bin: "/bin/bash", argv: [], cols: 80, rows: 24 }));

    // The same parked-prompt shape the fd3 attention suite uses: a boot line + a
    // trailing prompt with NO newline, so the @xterm cursor lands on the prompt line.
    rec.emit("boot output line\n");
    rec.emit("Do you trust this? (y/n) ");
    await flushEmulator(); // let the @xterm parse land so the snapshot reflects the prompt

    const reply = await worker.handle(statusFrame());
    expect(reply.ok).toBe(true);
    const view = reply.result as {
      state: string;
      cursorParked: boolean;
      screenDiffEmpty: boolean;
      interactions: number;
      confidence: string;
      reason: string;
    };
    expect(view.state).toBe("awaiting-input");
    expect(view.cursorParked).toBe(true);
    expect(view.screenDiffEmpty).toBe(true);
    // 163-03 (CLASS-02): the classifier confidence + reason ride the worker reply
    // end-to-end (statusReplyFromState -> the `status` frame result). A cursor-parked
    // prompt is the high-confidence structural certainty.
    expect(view.confidence).toBe("high");
    expect(view.reason).toBe("settled_cursor_parked");
    // Redaction-safe: the status reply carries NO raw screen text (structural only).
    expect(reply.result).not.toHaveProperty("screen");
    expect(typeof view.interactions).toBe("number");
  });

  it("an exited session → status reports state:'exited' and the exit code", async () => {
    const sched = makeFakeScheduler();
    const rec = makeRecordingBackend();
    const worker = createTerminalWorker(
      baseDeps({ loadPty: () => ({ spawn: rec.spawn }), setTimer: sched.setTimer, clearTimer: sched.clearTimer }),
    );
    await worker.handle(createFrame({ sessionId: "s1", bin: "/bin/bash", argv: [], cols: 80, rows: 24 }));
    rec.emit("done\n");
    rec.emitExit({ exitCode: 7 }); // the live pty child exits with code 7
    await flushEmulator();

    const reply = await worker.handle(statusFrame());
    expect(reply.ok).toBe(true);
    const view = reply.result as { state: string; exitCode?: number };
    expect(view.state).toBe("exited");
    expect(view.exitCode).toBe(7);
  });

  it("an ABSENT session → status degrades to the safe total default (state:'exited', confidence:'high', reason:'exited') — the 5th plumbing seam (163-03)", async () => {
    // handleStatus has its OWN absent-session degrade (separate from statusReplyFromState):
    // a `status` frame for an unknown session id is gone → `exited`. The widened
    // WorkerStatusPerception must stay total here too — confidence/reason cannot be
    // undefined (the field-plumbing bug class: a missed seam reads undefined downstream).
    const sched = makeFakeScheduler();
    const rec = makeRecordingBackend();
    const worker = createTerminalWorker(
      baseDeps({ loadPty: () => ({ spawn: rec.spawn }), setTimer: sched.setTimer, clearTimer: sched.clearTimer }),
    );
    // No create — the session id "s1" the statusFrame() references does not exist.
    const reply = await worker.handle(statusFrame());
    expect(reply.ok).toBe(true);
    const view = reply.result as { state: string; confidence: string; reason: string };
    expect(view.state).toBe("exited");
    expect(view.confidence).toBe("high");
    expect(view.reason).toBe("exited");
  });

  it("interactions counts the session's send/read/wait/resize interactions", async () => {
    const sched = makeFakeScheduler();
    const rec = makeRecordingBackend();
    const worker = createTerminalWorker(
      baseDeps({ loadPty: () => ({ spawn: rec.spawn }), setTimer: sched.setTimer, clearTimer: sched.clearTimer }),
    );
    await worker.handle(createFrame({ sessionId: "s1", bin: "/bin/bash", argv: [], cols: 80, rows: 24 }));
    rec.emit("ready> ");
    await flushEmulator();

    const before = (await worker.handle(statusFrame())).result as { interactions: number };

    // One send_key interaction (a single keystroke).
    await worker.handle({
      sessionId: "s1",
      requestId: "rq-key",
      traceId: TRACE_ID,
      method: "send_key",
      params: { sessionId: "s1", keys: ["Enter"] },
    });

    const after = (await worker.handle(statusFrame())).result as { interactions: number };
    expect(after.interactions).toBe(before.interactions + 1);
  });
});
