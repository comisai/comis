// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the daemon-side TerminalSessionRegistry (spec §2.1, OPS-01).
 *
 * Fully-injected → runs green on macOS without spawning a real worker. The
 * registry is a FACTORY (`createTerminalSessionRegistry(deps)`) closing over a
 * local `Map<sessionId,SessionHandle>` + a local worker handle (no module-global
 * state); `deps.spawnWorker` substitutes a fake child (an EventEmitter-shaped
 * stub) so crash isolation, lazy re-spawn, the create/read round-trip, and the
 * kill→drop-from-list invariant are all macOS-testable. Proves:
 *   - OPS-01: a child `error` → sessions flip to `lost`, the handle clears, the
 *     registry stays usable; a child `close(1)` → `exited` with exitCode 1.
 *   - lazy re-spawn: after the handle clears, the next `create` re-spawns.
 *   - H-1: `registry.read(id)` round-trips a read frame to the worker and
 *     returns `{screen,cursor,cols,rows,alt,alive}` (the 119-04 round-trip shape).
 *   - M-1: `create` forwards buildDirectSpawn's `{bin,argv}` to the worker
 *     VERBATIM (no re-canonicalization in the registry).
 *   - kill drops the session from `list()`.
 *   - two registries are isolated (no module-global session map).
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";

import {
  createTerminalSessionRegistry,
  type TerminalSessionRegistryDeps,
  type FakeWorkerChild,
} from "./terminal-session-registry.js";
import {
  encodeFrame,
  createFrameDecoder,
  type TerminalRequestFrame,
  type TerminalReplyFrame,
} from "./terminal-ipc.js";

/** A no-op structural logger. */
function makeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/**
 * Build a fake worker child: an EventEmitter with the stdio[0..1] + kill/pid
 * surface the registry drives. `requestFrames` records every frame the registry
 * writes to stdin (fd0). An optional `autoReply` lets the fake answer a request
 * frame on stdout (fd1) — used for the read round-trip.
 */
function makeFakeWorker(
  autoReply?: (frame: TerminalRequestFrame) => TerminalReplyFrame | undefined,
): {
  child: FakeWorkerChild;
  requestFrames: TerminalRequestFrame[];
  emitError: () => void;
  emitClose: (code: number) => void;
} {
  const emitter = new EventEmitter();
  const requestFrames: TerminalRequestFrame[] = [];
  const decoder = createFrameDecoder();

  // stdout is the worker→daemon reply channel; the registry attaches a "data"
  // listener. We expose a push via the EventEmitter on a dedicated stream.
  const stdout = new EventEmitter();

  const stdin = {
    write: (chunk: Buffer) => {
      for (const frame of decoder.push(chunk)) {
        const req = frame as TerminalRequestFrame;
        requestFrames.push(req);
        const reply = autoReply?.(req);
        if (reply) {
          // Echo a correlated reply back on stdout asynchronously.
          queueMicrotask(() => stdout.emit("data", encodeFrame(reply)));
        }
      }
      return true;
    },
  };

  const child: FakeWorkerChild = {
    pid: 9090,
    stdin: stdin as unknown as FakeWorkerChild["stdin"],
    stdout: stdout as unknown as FakeWorkerChild["stdout"],
    on: (event: string, cb: (arg?: unknown) => void) => {
      emitter.on(event, cb);
      return child;
    },
    kill: vi.fn(),
  };

  return {
    child,
    requestFrames,
    emitError: () => emitter.emit("error", new Error("worker crashed")),
    emitClose: (code: number) => emitter.emit("close", code),
  };
}

function baseDeps(
  spawnWorker: TerminalSessionRegistryDeps["spawnWorker"],
  over: Partial<TerminalSessionRegistryDeps> = {},
): TerminalSessionRegistryDeps {
  return {
    spawnWorker,
    logger: makeLogger(),
    nowMs: () => 1_700_000_000_000,
    ...over,
  };
}

describe("createTerminalSessionRegistry — OPS-01 crash isolation", () => {
  it("flips a session to 'lost' on child error, clears the handle, and stays usable", async () => {
    const fake = makeFakeWorker();
    const registry = createTerminalSessionRegistry(baseDeps(() => fake.child));

    const { sessionId } = await registry.create({
      allowId: "bash",
      bin: "/bin/bash",
      argv: [],
      cols: 80,
      rows: 24,
    });

    fake.emitError();

    expect(registry.get(sessionId)?.status).toBe("lost");
    // The registry object does NOT throw and stays usable.
    expect(() => registry.size()).not.toThrow();
    expect(registry.size()).toBe(1);
  });

  it("flips a session to 'exited' with exitCode on child close(1)", async () => {
    const fake = makeFakeWorker();
    const registry = createTerminalSessionRegistry(baseDeps(() => fake.child));

    const { sessionId } = await registry.create({
      allowId: "bash",
      bin: "/bin/bash",
      argv: [],
      cols: 80,
      rows: 24,
    });

    fake.emitClose(1);

    expect(registry.get(sessionId)?.status).toBe("exited");
    expect(registry.get(sessionId)?.exitCode).toBe(1);
  });
});

describe("createTerminalSessionRegistry — lazy re-spawn", () => {
  it("spawns the worker once for the first create (single live worker per registry)", async () => {
    const spawnWorker = vi.fn(() => makeFakeWorker().child);
    const registry = createTerminalSessionRegistry(baseDeps(spawnWorker));

    await registry.create({ allowId: "bash", bin: "/bin/bash", argv: [], cols: 80, rows: 24 });
    await registry.create({ allowId: "bash", bin: "/bin/bash", argv: [], cols: 80, rows: 24 });

    // Two creates against a live worker → spawned ONCE (the worker is reused).
    expect(spawnWorker).toHaveBeenCalledTimes(1);
  });

  it("calls spawnWorker a 2nd time after the worker handle clears", async () => {
    let current: ReturnType<typeof makeFakeWorker> | undefined;
    const spawnWorker = vi.fn(() => {
      current = makeFakeWorker();
      return current.child;
    });
    const registry = createTerminalSessionRegistry(baseDeps(spawnWorker));

    await registry.create({ allowId: "bash", bin: "/bin/bash", argv: [], cols: 80, rows: 24 });
    expect(spawnWorker).toHaveBeenCalledTimes(1);

    // Crash the live worker → handle clears.
    current?.emitClose(1);

    // Next create must re-spawn the worker (daemon stayed up across the crash).
    await registry.create({ allowId: "bash", bin: "/bin/bash", argv: [], cols: 80, rows: 24 });
    expect(spawnWorker).toHaveBeenCalledTimes(2);
  });
});

describe("createTerminalSessionRegistry — kill drops from list", () => {
  it("removes a killed session from list() while the other remains", async () => {
    const fake = makeFakeWorker();
    const registry = createTerminalSessionRegistry(baseDeps(() => fake.child));

    const a = await registry.create({
      allowId: "bash",
      bin: "/bin/bash",
      argv: [],
      cols: 80,
      rows: 24,
    });
    const b = await registry.create({
      allowId: "bash",
      bin: "/bin/bash",
      argv: [],
      cols: 80,
      rows: 24,
    });

    await registry.kill(a.sessionId);

    const ids = registry.list().map((s) => s.sessionId);
    expect(ids).not.toContain(a.sessionId);
    expect(ids).toContain(b.sessionId);
  });
});

describe("createTerminalSessionRegistry — H-1 read round-trip", () => {
  it("round-trips a read frame to the worker and resolves the {screen,...} shape", async () => {
    const fake = makeFakeWorker((req) => {
      if (req.method !== "read") return undefined;
      return {
        sessionId: req.sessionId,
        requestId: req.requestId,
        ok: true,
        result: {
          screen: "hi",
          cursor: { x: 0, y: 0 },
          cols: 80,
          rows: 24,
          alt: false,
          alive: true,
        },
      };
    });
    const registry = createTerminalSessionRegistry(baseDeps(() => fake.child));

    const { sessionId } = await registry.create({
      allowId: "bash",
      bin: "/bin/bash",
      argv: [],
      cols: 80,
      rows: 24,
    });

    const view = await registry.read(sessionId);
    expect(view).toEqual({
      screen: "hi",
      cursor: { x: 0, y: 0 },
      cols: 80,
      rows: 24,
      alt: false,
      alive: true,
    });
  });
});

describe("createTerminalSessionRegistry — M-1 create forwards bin/argv verbatim", () => {
  it("sends a create frame whose params carry the daemon's {bin,argv} unmodified", async () => {
    const fake = makeFakeWorker();
    const registry = createTerminalSessionRegistry(baseDeps(() => fake.child));

    await registry.create({
      allowId: "bash",
      bin: "/canonical/bash",
      argv: ["--prefix", "x"],
      cols: 100,
      rows: 40,
    });

    const createFrame = fake.requestFrames.find((f) => f.method === "create");
    expect(createFrame).toBeDefined();
    expect(createFrame?.params["bin"]).toBe("/canonical/bash");
    expect(createFrame?.params["argv"]).toEqual(["--prefix", "x"]);
  });
});

describe("createTerminalSessionRegistry — no module-global state", () => {
  it("two registries have isolated session maps", async () => {
    const r1 = createTerminalSessionRegistry(baseDeps(() => makeFakeWorker().child));
    const r2 = createTerminalSessionRegistry(baseDeps(() => makeFakeWorker().child));

    await r1.create({ allowId: "bash", bin: "/bin/bash", argv: [], cols: 80, rows: 24 });

    expect(r1.size()).toBe(1);
    expect(r2.size()).toBe(0);
  });
});
