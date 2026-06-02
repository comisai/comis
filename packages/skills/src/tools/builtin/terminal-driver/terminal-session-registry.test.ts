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

/**
 * Build a fake worker whose stdout can be driven to emit RAW (non-frame) bytes,
 * so the registry's stdout handler is fed a malformed / hostile chunk. Used by
 * HR-02. `emitRaw` pushes arbitrary bytes onto the reply channel; `emitOversizedPrefix`
 * pushes a uint32 length prefix above the framer cap (the HR-01 DoS prefix).
 */
function makeRawDrivableWorker(): {
  child: FakeWorkerChild;
  emitRaw: (bytes: Buffer) => void;
  emitOversizedPrefix: () => void;
} {
  const emitter = new EventEmitter();
  const stdout = new EventEmitter();
  const child: FakeWorkerChild = {
    pid: 7070,
    stdin: { write: () => true } as unknown as FakeWorkerChild["stdin"],
    stdout: stdout as unknown as FakeWorkerChild["stdout"],
    on: (event: string, cb: (arg?: unknown) => void) => {
      emitter.on(event, cb);
      return child;
    },
    kill: vi.fn(),
  };
  const oversized = Buffer.alloc(4);
  oversized.writeUInt32BE(0xffffffff, 0); // ~4 GiB declared body → above the framer cap
  return {
    child,
    emitRaw: (bytes: Buffer) => stdout.emit("data", bytes),
    emitOversizedPrefix: () => stdout.emit("data", oversized),
  };
}

describe("createTerminalSessionRegistry — HR-02 malformed-frame on stdout does NOT crash (OPS-01)", () => {
  it("a non-JSON reply byte on stdout is caught (no uncaughtException), logs WARN errorKind:'protocol', and drops the worker", async () => {
    const fake = makeRawDrivableWorker();
    const logger = makeLogger();
    const registry = createTerminalSessionRegistry(baseDeps(() => fake.child, { logger }));

    const { sessionId } = await registry.create({
      allowId: "bash",
      bin: "/bin/bash",
      argv: [],
      cols: 80,
      rows: 24,
    });

    // A length-prefixed frame whose body is NOT valid JSON ("{" then garbage):
    // JSON.parse throws INSIDE the stdout 'data' listener. Pre-patch this is an
    // uncaughtException that takes the daemon down (the precise opposite of OPS-01).
    const garbageBody = Buffer.from("{not-json", "utf8");
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(garbageBody.length, 0);

    // The handler must NOT throw out of the listener.
    expect(() => fake.emitRaw(Buffer.concat([prefix, garbageBody]))).not.toThrow();

    // The corrupt worker is dropped: the running session flips to 'lost'.
    expect(registry.get(sessionId)?.status).toBe("lost");
    // A WARN with a closed-union errorKind ('validation' — the frame failed
    // structural decode) was logged for the corrupt frame.
    const warn = logger.warn.mock.calls.find(
      ([obj]) => (obj as { errorKind?: string }).errorKind === "validation",
    );
    expect(warn).toBeDefined();
  });

  it("an oversized HR-01 length prefix on stdout is caught (FrameTooLargeError), not rethrown — daemon survives", async () => {
    const fake = makeRawDrivableWorker();
    const logger = makeLogger();
    const registry = createTerminalSessionRegistry(baseDeps(() => fake.child, { logger }));

    const { sessionId } = await registry.create({
      allowId: "bash",
      bin: "/bin/bash",
      argv: [],
      cols: 80,
      rows: 24,
    });

    // The framer throws FrameTooLargeError on this prefix; the handler must swallow it.
    expect(() => fake.emitOversizedPrefix()).not.toThrow();
    expect(registry.get(sessionId)?.status).toBe("lost");
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe("createTerminalSessionRegistry — HR-03 worker create failure is surfaced (OPS-07)", () => {
  it("an ok:false create reply flips the session to 'lost' (list/read agree alive:false) and fires onSpawnFailed", async () => {
    // The worker's handleCreate throws (bad bin ENOENT, forkpty failure, …) → the
    // worker replies { ok:false } to the create frame. Pre-patch the registry does
    // NOT register a create waiter, so correlate() drops the reply and the handle
    // stays 'running' forever (alive:true) despite a dead child.
    const fake = makeFakeWorker((req) => {
      if (req.method !== "create") return undefined;
      return {
        sessionId: req.sessionId,
        requestId: req.requestId,
        ok: false,
        error: "spawn ENOENT: /usr/bin/somecli",
      };
    });
    const spawnFailures: Array<{ sessionId: string; error?: string }> = [];
    const registry = createTerminalSessionRegistry(
      baseDeps(() => fake.child, {
        onSpawnFailed: (info) => spawnFailures.push(info),
      }),
    );

    const { sessionId } = await registry.create({
      allowId: "somecli",
      bin: "/usr/bin/somecli",
      argv: [],
      cols: 80,
      rows: 24,
    });

    // Let the queued microtask reply land.
    await new Promise((r) => setImmediate(r));

    // The handle reflects the failure — NOT a perpetual alive:true.
    expect(registry.get(sessionId)?.status).toBe("lost");
    // list() and read() agree the session is not alive.
    expect(registry.list().find((s) => s.sessionId === sessionId)?.alive).toBe(false);
    const view = await registry.read(sessionId);
    expect(view.alive).toBe(false);
    // OPS-07: the spawn-failure hook fired with the session id + the worker error.
    expect(spawnFailures).toHaveLength(1);
    expect(spawnFailures[0].sessionId).toBe(sessionId);
    expect(spawnFailures[0].error).toMatch(/ENOENT/);
  });

  it("an ok:true create reply leaves the session 'running' and does NOT fire onSpawnFailed", async () => {
    const fake = makeFakeWorker((req) => {
      if (req.method !== "create") return undefined;
      return {
        sessionId: req.sessionId,
        requestId: req.requestId,
        ok: true,
        result: { sessionId: req.sessionId, backend: "pty", cols: 80, rows: 24 },
      };
    });
    const spawnFailures: unknown[] = [];
    const registry = createTerminalSessionRegistry(
      baseDeps(() => fake.child, { onSpawnFailed: (info) => spawnFailures.push(info) }),
    );

    const { sessionId } = await registry.create({
      allowId: "bash",
      bin: "/bin/bash",
      argv: [],
      cols: 80,
      rows: 24,
    });
    await new Promise((r) => setImmediate(r));

    expect(registry.get(sessionId)?.status).toBe("running");
    expect(spawnFailures).toHaveLength(0);
  });
});

describe("createTerminalSessionRegistry — MR-01 request() reply timeout (wedged worker)", () => {
  it("read() against a worker that never replies settles to alive:false on the injected timeout (no hang, no leaked resolver)", async () => {
    // A worker that ACCEPTS the read frame but NEVER replies (wedged, not crashed:
    // no close/error to trigger clearWorker). Pre-patch read() awaits forever.
    const fake = makeFakeWorker(); // no autoReply → no reply is ever emitted

    // A controllable fake timer: capture the scheduled callback so the test fires it.
    let firedCb: (() => void) | undefined;
    let scheduledMs: number | undefined;
    const setTimer = vi.fn((cb: () => void, ms: number) => {
      firedCb = cb;
      scheduledMs = ms;
      return { id: 1 } as unknown;
    });
    const clearTimer = vi.fn();

    const registry = createTerminalSessionRegistry(
      baseDeps(() => fake.child, {
        requestTimeoutMs: 1234,
        setTimer: setTimer as never,
        clearTimer: clearTimer as never,
      }),
    );

    const { sessionId } = await registry.create({
      allowId: "bash",
      bin: "/bin/bash",
      argv: [],
      cols: 80,
      rows: 24,
    });

    const readPromise = registry.read(sessionId);
    // The read registered a timeout with the configured duration.
    expect(setTimer).toHaveBeenCalled();
    expect(scheduledMs).toBe(1234);

    // Fire the timeout (simulate expiry) → read settles to the not-alive minimal view.
    firedCb?.();
    const view = await readPromise;
    expect(view.alive).toBe(false);
    expect(view.screen).toBe("");
  });

  it("a normal reply cancels the pending timeout (clearTimer is called, no spurious timeout fire)", async () => {
    const fake = makeFakeWorker((req) =>
      req.method === "read"
        ? {
            sessionId: req.sessionId,
            requestId: req.requestId,
            ok: true,
            result: { screen: "ok", cursor: { x: 0, y: 0 }, cols: 80, rows: 24, alt: false, alive: true },
          }
        : undefined,
    );
    const clearTimer = vi.fn();
    const registry = createTerminalSessionRegistry(
      baseDeps(() => fake.child, {
        setTimer: ((cb: () => void) => ({ cb })) as never,
        clearTimer: clearTimer as never,
      }),
    );

    const { sessionId } = await registry.create({
      allowId: "bash",
      bin: "/bin/bash",
      argv: [],
      cols: 80,
      rows: 24,
    });
    const view = await registry.read(sessionId);
    expect(view.screen).toBe("ok");
    // The reply arrived → the timeout was cancelled (clearTimer called for the read key).
    expect(clearTimer).toHaveBeenCalled();
  });
});

describe("createTerminalSessionRegistry — LR-02 clearWorker preserves waiter identity", () => {
  it("resolves a flushed read waiter with the REAL (sessionId,requestId) — observable via the flush-debug log carrying the real session id, not a blank", async () => {
    // A worker that accepts the read frame but never replies; then the worker
    // crashes (close), so clearWorker() flushes the parked read waiter. The
    // synthetic termination reply must carry the waiter's real (sessionId,
    // requestId) — NOT blanked empty strings — so identity-keyed callers (a
    // future interaction tool) cannot mis-handle the termination reply. The
    // §2.7-observable signal is a per-waiter flush DEBUG carrying the real id.
    const fake = makeFakeWorker();
    const logger = makeLogger();
    const registry = createTerminalSessionRegistry(baseDeps(() => fake.child, { logger }));

    const { sessionId } = await registry.create({
      allowId: "bash",
      bin: "/bin/bash",
      argv: [],
      cols: 80,
      rows: 24,
    });

    const readPromise = registry.read(sessionId); // parks a (sessionId,requestId) waiter
    fake.emitClose(1); // clearWorker flushes the parked waiter

    const view = await readPromise;
    expect(view.alive).toBe(false);

    // The flush logged the waiter's REAL session id (not "") — proving the
    // synthetic termination reply preserved identity rather than blanking it.
    const flushLog = logger.debug.mock.calls.find(
      ([obj]) =>
        (obj as { hint?: string }).hint === "flushing pending waiter; worker terminated" &&
        (obj as { sessionId?: string }).sessionId === sessionId,
    );
    expect(flushLog).toBeDefined();
    const obj = flushLog?.[0] as { sessionId?: string; requestId?: string };
    expect(obj.sessionId).toBe(sessionId);
    expect(obj.sessionId).not.toBe("");
    expect(obj.requestId).not.toBe("");
  });
});
