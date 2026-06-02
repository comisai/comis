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
 * A minimal stub PTY backend: exposes the node-pty `spawn` → `{onData,...}`
 * surface the worker wires. The test drives stdout by calling `emit(chunk)`.
 */
function makeFakeBackend(): {
  spawn: ReturnType<typeof vi.fn>;
  emit: (chunk: string) => void;
  lastSpawn: () => { bin: string; argv: string[] } | undefined;
} {
  let onData: ((d: string) => void) | undefined;
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
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
    };
    return handle;
  });
  return {
    spawn,
    emit: (chunk: string) => onData?.(chunk),
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

    let read = await worker.handle({
      sessionId: "s1",
      requestId: "rq-read-1",
      traceId: TRACE_ID,
      method: "read",
      params: { sessionId: "s1" },
    });
    expect((read.result as { screen: string; alive: boolean }).screen).toBe("pipe-out\n");
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

describe("createTerminalWorker — H-1 read frame handler", () => {
  it("returns {screen,cursor,cols,rows,alt,alive} from the per-session stdout ring", async () => {
    const fake = makeFakeBackend();
    const ptyLib = { spawn: fake.spawn };
    const worker = createTerminalWorker(baseDeps({ loadPty: () => ptyLib }));

    await worker.handle(
      createFrame({ sessionId: "s1", bin: "/bin/bash", argv: [], cols: 100, rows: 40 }),
    );
    // The backend emits stdout into the per-session ring.
    fake.emit("hello\n");

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
    expect(view.screen).toBe("hello\n"); // the accumulated ring content
    expect(view.cursor).toEqual({ x: 0, y: 0 });
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
