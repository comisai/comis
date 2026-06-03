// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the supervised Terminal Worker entry (spec §2.1/§2.2/§2.3).
 *
 * Pure-JS / fully-injected → runs green on macOS without forking a process.
 * The worker is a FACTORY (`createTerminalWorker(deps)`) so node-pty, the
 * logger, the clock, the env snapshot, and the durable-fs ops are all
 * substitutable. Proves the P0 worker contract:
 *   - TR-08: an injected `loadPty` that throws selects the PIPE backend and
 *     reports `backend:"degraded"` — never an unhandled spawn crash;
 *   - TR-08 happy: an injected `loadPty` returning a stub pty uses the PTY
 *     backend and reports `backend:"pty"`;
 *   - OPS-07 (worker half): each request frame's `traceId` is re-established as
 *     the ALS context (`runWithContext`) during handling;
 *   - H-1: a `read` frame returns `{screen,cursor,cols,rows,alt,alive}` from the
 *     per-session accumulated stdout ring (the shape 119-04's round-trip reads);
 *   - M-1: the worker spawns from the frame's `{bin,argv}` verbatim — no
 *     redundant realpath, argsPrefix preserved (buildDirectSpawn is the SOLE
 *     canonicalization site, in 119-02);
 *   - G-4: a durable write swallows ONLY the disabled-fsync refusal and still
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
 * is NOT enough for the grid to reflect just-emitted bytes. Plan 01's `appendRing`
 * fires `emu.write(chunk)` un-awaited (Plan 02 makes `read` itself await the
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
 * A RECORDING stub PTY backend (Wave-2 interaction tests): every `write()` is
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
 * the same shape Plan 02's settle suite drives. `advance(ms)` fires every timer
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

describe("createTerminalWorker — TR-08 backend selection", () => {
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
    // P2/121: read serializes the @xterm grid (not the raw ring), so the
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
});

describe("createTerminalWorker — OPS-07 ALS traceId re-establishment", () => {
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

describe("createTerminalWorker — LR-01 inbound context is validated, not trusted", () => {
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

describe("createTerminalWorker — H-1 read frame handler", () => {
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
    // P2/121: the screen is the rendered grid (CONTAINS the line), the cursor is
    // REAL — after "hello\n" the bare LF moves DOWN a row without a carriage
    // return, so the cursor is {x:5, y:1} (column 5 = after "hello", row 1), NOT
    // the P1 {0,0} placeholder.
    expect(view.screen).toContain("hello");
    expect(view.cursor).toEqual({ x: 5, y: 1 });
    expect(view.cols).toBe(100);
    expect(view.rows).toBe(40);
    expect(view.alt).toBe(false);
    expect(view.alive).toBe(true);
  });
});

describe("createTerminalWorker — M-1 spawn from frame bin/argv", () => {
  it("spawns the child with EXACTLY the frame's bin + full argv (argsPrefix preserved, no realpath)", async () => {
    const fake = makeFakeBackend();
    const ptyLib = { spawn: fake.spawn };
    const worker = createTerminalWorker(baseDeps({ loadPty: () => ptyLib }));

    await worker.handle(
      createFrame({
        sessionId: "s1",
        bin: "/canonical/bash",
        argv: ["--prefix-arg", "extra"],
        cols: 80,
        rows: 24,
      }),
    );

    const spawned = fake.lastSpawn();
    expect(spawned?.bin).toBe("/canonical/bash");
    expect(spawned?.argv).toEqual(["--prefix-arg", "extra"]);
  });
});

describe("createTerminalWorker — G-4 durable write under disabled fsync", () => {
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
// Wave-2 (120-04): the interaction frame handlers.
//
// These compose Plan-01's `encodeKeyChord` (the named-key grammar) and Plan-02's
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

describe("createTerminalWorker — TR-04 send_key (named-key grammar -> exact bytes)", () => {
  it("writes the EXACT control byte for C-c (\\x03) and replies { screen, cursor }", async () => {
    const rec = makeRecordingBackend();
    const worker = createTerminalWorker(
      baseDeps({ loadPty: () => ({ spawn: rec.spawn }) }),
    );

    await worker.handle(
      createFrame({ sessionId: "s1", bin: "/bin/bash", argv: [], cols: 80, rows: 24 }),
    );
    rec.emit("prompt$ "); // seed the ring so the post-action snapshot is non-empty

    const reply = await worker.handle(sendKeyFrame(["C-c"]));

    expect(reply.ok).toBe(true);
    expect(rec.writes).toEqual(["\x03"]); // exactly one write of Ctrl-C
    const result = reply.result as { screen: string; cursor: { x: number; y: number } };
    expect(result.screen).toBe("prompt$ "); // the post-action ring view
    expect(result.cursor).toEqual({ x: 0, y: 0 });
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
    // T-120-01b: the encodeKeyChord throw is caught and surfaced — NOTHING written.
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
 * The deterministic settle-drive pattern (Plan-02 precedent): the in-worker
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

describe("createTerminalWorker — TR-04 send_text (submit ordering + bracketed paste)", () => {
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
    // TR-04: the text and Enter are NEVER coalesced into one write.
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

describe("createTerminalWorker — TR-03 resize (pty winsize + ring geometry)", () => {
  it("calls pty.resize(cols,rows), updates state geometry, replies { ok:true }", async () => {
    const rec = makeRecordingBackend();
    const worker = createTerminalWorker(baseDeps({ loadPty: () => ({ spawn: rec.spawn }) }));
    await worker.handle(createFrame({ sessionId: "s1", bin: "/bin/bash", argv: [], cols: 80, rows: 24 }));

    const reply = await worker.handle(resizeFrame(100, 30));

    expect(reply.ok).toBe(true);
    expect((reply.result as { ok: boolean }).ok).toBe(true);
    // The pty backend's winsize was updated.
    expect(rec.resizes).toEqual([[100, 30]]);
    // The ring geometry (P1 records it; P2 does the real grid resize) — a
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

describe("createTerminalWorker — TR-05 wait (settle -> {matched,isComplete,reason,screen,cursor})", () => {
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
    expect(r.screen).toBe("boot\n");
    expect(r.cursor).toEqual({ x: 0, y: 0 });
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
// Wave (121-01): the worker rewired to the per-session @xterm emulator.
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
} {
  const writes: string[] = [];
  const resizes: Array<[number, number]> = [];
  let disposes = 0;
  let lastOpts: { cols: number; rows: number; scrollback: number } | undefined;
  return {
    writes,
    resizes,
    get disposes() {
      return disposes;
    },
    lastConstruct: () => lastOpts,
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
          screen: "CANNED",
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
        dispose: () => {
          disposes++;
        },
        // `term` is unused by the worker wiring; a stub satisfies the type.
        term: {} as unknown,
      };
    },
  };
}

describe("createTerminalWorker — 121-01 read serializes the REAL @xterm grid (TR-02)", () => {
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

    // Every data chunk is fed into the emulator's write (the grid ingest). Plan
    // 02 chains the writes through state.writeFlush (a serialized in-order queue
    // resolving on the parse callback), so drain it via a read (which awaits the
    // flush) before asserting the in-order feed.
    rec.emit("first");
    rec.emit("second");
    await worker.handle(readFrame()); // read awaits writeFlush -> the chain drains
    expect(recEmu.writes).toEqual(["first", "second"]);
  });

  it("degraded backend (loadPty throws) STILL feeds the emulator + read uses it (no TR-08 regression)", async () => {
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
    // degraded backend keeps working (TR-08 not regressed).
    expect(view.screen).toContain("degraded-line");
    expect(view.alive).toBe(true);
  });
});

// ===========================================================================
// Plan 121-02: the worker read threads format/scrollback into emu.snapshot AND
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

describe("createTerminalWorker — 121-02 read threads format/scrollback + awaits the write-flush", () => {
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
