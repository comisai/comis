// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the daemon-side TerminalSessionRegistry (spec §2.1, crash isolation).
 *
 * Fully-injected → runs green on macOS without spawning a real worker. The
 * registry is a FACTORY (`createTerminalSessionRegistry(deps)`) closing over a
 * local `Map<sessionId,SessionHandle>` + a local worker handle (no module-global
 * state); `deps.spawnWorker` substitutes a fake child (an EventEmitter-shaped
 * stub) so crash isolation, lazy re-spawn, the create/read round-trip, and the
 * kill→drop-from-list invariant are all macOS-testable. Proves:
 *   - crash isolation: a child `error` → sessions flip to `lost`, the handle clears,
 *     the registry stays usable; a child `close(1)` → `exited` with exitCode 1.
 *   - lazy re-spawn: after the handle clears, the next `create` re-spawns.
 *   - read round-trip: `registry.read(id, OWNER)` round-trips a read frame to the
 *     worker and returns `{screen,cursor,cols,rows,alt,alive}`.
 *   - `create` forwards buildDirectSpawn's `{bin,argv}` to the worker
 *     VERBATIM (no re-canonicalization in the registry).
 *   - kill drops the session from `list()`.
 *   - two registries are isolated (no module-global session map).
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createFakeTimers } from "../../../../../../test/support/fake-timers.js";
import {
  composeStatusView,
  notFoundStatus,
  type WorkerStatusPerception,
} from "./terminal-status-view.js";
import {
  createTerminalSessionRegistry,
  DEFAULT_SCROLLBACK,
  type TerminalSessionRegistryDeps,
  type FakeWorkerChild,
} from "./terminal-session-registry.js";
import type { EvictReason } from "./terminal-reaper.js";
import type { TerminalScope } from "./allowlist-matcher.js";
import type { SessionDescriptorStorePort } from "./terminal-session-reattach.js";
import type { SessionDescriptor } from "./terminal-reattach-match.js";
import {
  encodeFrame,
  createFrameDecoder,
  type TerminalRequestFrame,
  type TerminalReplyFrame,
  type TerminalEventFrame,
} from "./terminal-ipc.js";
import { waitReplyTimeoutMs } from "./terminal-settle.js";

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

/**
 * The single owner threaded through these tests. create/list/read/get/kill/send*
 * are owner-scoped (required arg, NO return-all fallback). These tests are a
 * single-origin world, so they all use one `(agentId, sessionKey)`. The
 * multi-owner invisibility/isolation tests below use their own owners.
 */
const OWNER = { agentId: "a", sessionKey: "s" };

describe("createTerminalSessionRegistry — crash isolation", () => {
  it("flips a session to 'lost' on child error, clears the handle, and stays usable", async () => {
    const fake = makeFakeWorker();
    const registry = createTerminalSessionRegistry(baseDeps(() => fake.child));

    const { sessionId } = await registry.create({
      allowId: "bash",
      bin: "/bin/bash",
      argv: [],
      cols: 80,
      rows: 24,
    }, OWNER);

    fake.emitError();

    expect(registry.get(sessionId, OWNER)?.status).toBe("lost");
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
    }, OWNER);

    fake.emitClose(1);

    expect(registry.get(sessionId, OWNER)?.status).toBe("exited");
    expect(registry.get(sessionId, OWNER)?.exitCode).toBe(1);
  });
});

// ===========================================================================
// MR-02: a worker CRASH must emit a per-session lifecycle signal so the daemon's
// per-session reclaimers (onSessionGone → promotedSessions / driveJournals /
// driveStartedAtMs / loop-guard / FSM-state / wake-file) fire. Pre-patch, the
// crash handlers only mutated the in-memory handle status (markRunningSessionsLost
// / the close flip) and emitted NOTHING — so a promoted session whose worker
// crashes leaked its drive-state for the daemon's lifetime. The fix re-publishes
// a terminal:session_state frame per affected session through the SAME injected
// onTerminalEvent seam the PTY-exit path uses (buildTerminalEventHook → the bus →
// onSessionGone).
// ===========================================================================

describe("createTerminalSessionRegistry — MR-02: worker-crash emits a per-session lifecycle event", () => {
  /** Collect the TerminalEventFrames the registry dispatches to onTerminalEvent. */
  function makeEventSink() {
    const frames: TerminalEventFrame[] = [];
    return { onTerminalEvent: (f: TerminalEventFrame) => frames.push(f), frames };
  }

  it("a child 'error' (worker crash) emits terminal:session_state{state:'lost'} for each running session", async () => {
    const fake = makeFakeWorker();
    const sink = makeEventSink();
    const registry = createTerminalSessionRegistry(baseDeps(() => fake.child, { onTerminalEvent: sink.onTerminalEvent }));

    const a = await registry.create({ allowId: "bash", bin: "/bin/bash", argv: [], cols: 80, rows: 24 }, OWNER);
    const b = await registry.create({ allowId: "bash", bin: "/bin/bash", argv: [], cols: 80, rows: 24 }, OWNER);

    fake.emitError();

    // One lost-lifecycle frame per running session (the daemon re-publishes each onto the bus
    // → onSessionGone reclaims the per-session drive-state — no leak).
    const lost = sink.frames.filter((f) => f.event === "terminal:session_state");
    const lostIds = lost.map((f) => f.sessionId).sort();
    expect(lostIds).toEqual([a.sessionId, b.sessionId].sort());
    for (const f of lost) {
      expect((f.payload as { state?: string }).state, "the crash lifecycle state is 'lost'").toBe("lost");
    }
  });

  it("a child 'close(code)' emits terminal:session_state{state:'exited'} for each running session", async () => {
    const fake = makeFakeWorker();
    const sink = makeEventSink();
    const registry = createTerminalSessionRegistry(baseDeps(() => fake.child, { onTerminalEvent: sink.onTerminalEvent }));

    const a = await registry.create({ allowId: "bash", bin: "/bin/bash", argv: [], cols: 80, rows: 24 }, OWNER);

    fake.emitClose(1);

    const exited = sink.frames.filter((f) => f.event === "terminal:session_state");
    expect(exited.map((f) => f.sessionId)).toEqual([a.sessionId]);
    expect((exited[0]!.payload as { state?: string }).state).toBe("exited");
  });

  it("the per-session lifecycle frame is content-free (sessionId + a state enum only — no screen/payload bytes, I3)", async () => {
    const fake = makeFakeWorker();
    const sink = makeEventSink();
    const registry = createTerminalSessionRegistry(baseDeps(() => fake.child, { onTerminalEvent: sink.onTerminalEvent }));

    await registry.create({ allowId: "bash", bin: "/bin/bash", argv: [], cols: 80, rows: 24 }, OWNER);
    fake.emitError();

    const frame = sink.frames.find((f) => f.event === "terminal:session_state")!;
    expect(frame, "a crash must emit a session_state frame").toBeDefined();
    // Content-free: the payload carries the lifecycle state ONLY (no screen/text/keys field).
    const payloadKeys = Object.keys((frame.payload ?? {}) as Record<string, unknown>);
    expect(payloadKeys).toEqual(["state"]);
  });

  it("a crash with NO still-running sessions emits no lifecycle frame (nothing to reclaim)", async () => {
    const fake = makeFakeWorker();
    const sink = makeEventSink();
    const registry = createTerminalSessionRegistry(baseDeps(() => fake.child, { onTerminalEvent: sink.onTerminalEvent }));
    // Create then KILL the only session — it is no longer `running` when the worker crashes,
    // so the crash has nothing to reclaim and emits no lifecycle frame.
    const { sessionId } = await registry.create({ allowId: "bash", bin: "/bin/bash", argv: [], cols: 80, rows: 24 }, OWNER);
    await registry.kill(sessionId, OWNER);
    fake.emitError();
    expect(sink.frames.filter((f) => f.event === "terminal:session_state")).toHaveLength(0);
  });

  it("a crash without an onTerminalEvent sink still flips the handle + never throws (the seam is optional)", async () => {
    const fake = makeFakeWorker();
    // No onTerminalEvent dep — the emit is best-effort; the crash isolation still works.
    const registry = createTerminalSessionRegistry(baseDeps(() => fake.child));
    const { sessionId } = await registry.create({ allowId: "bash", bin: "/bin/bash", argv: [], cols: 80, rows: 24 }, OWNER);
    expect(() => fake.emitError()).not.toThrow();
    expect(registry.get(sessionId, OWNER)?.status).toBe("lost");
  });
});

describe("createTerminalSessionRegistry — lazy re-spawn", () => {
  it("spawns the worker once for the first create (single live worker per registry)", async () => {
    const spawnWorker = vi.fn(() => makeFakeWorker().child);
    const registry = createTerminalSessionRegistry(baseDeps(spawnWorker));

    await registry.create({ allowId: "bash", bin: "/bin/bash", argv: [], cols: 80, rows: 24 }, OWNER);
    await registry.create({ allowId: "bash", bin: "/bin/bash", argv: [], cols: 80, rows: 24 }, OWNER);

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

    await registry.create({ allowId: "bash", bin: "/bin/bash", argv: [], cols: 80, rows: 24 }, OWNER);
    expect(spawnWorker).toHaveBeenCalledTimes(1);

    // Crash the live worker → handle clears.
    current?.emitClose(1);

    // Next create must re-spawn the worker (daemon stayed up across the crash).
    await registry.create({ allowId: "bash", bin: "/bin/bash", argv: [], cols: 80, rows: 24 }, OWNER);
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
    }, OWNER);
    const b = await registry.create({
      allowId: "bash",
      bin: "/bin/bash",
      argv: [],
      cols: 80,
      rows: 24,
    }, OWNER);

    await registry.kill(a.sessionId, OWNER);

    const ids = registry.list(OWNER).map((s) => s.sessionId);
    expect(ids).not.toContain(a.sessionId);
    expect(ids).toContain(b.sessionId);
  });
});

describe("createTerminalSessionRegistry — read round-trip", () => {
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
    }, OWNER);

    const view = await registry.read(sessionId, OWNER);
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

describe("createTerminalSessionRegistry — create forwards bin/argv verbatim", () => {
  it("sends a create frame whose params carry the daemon's {bin,argv} unmodified", async () => {
    const fake = makeFakeWorker();
    const registry = createTerminalSessionRegistry(baseDeps(() => fake.child));

    await registry.create({
      allowId: "bash",
      bin: "/canonical/bash",
      argv: ["--prefix", "x"],
      cols: 100,
      rows: 40,
    }, OWNER);

    const createFrame = fake.requestFrames.find((f) => f.method === "create");
    expect(createFrame).toBeDefined();
    expect(createFrame?.params["bin"]).toBe("/canonical/bash");
    expect(createFrame?.params["argv"]).toEqual(["--prefix", "x"]);
  });
});

// ===========================================================================
// read(sessionId, opts) forwards {format,scrollback,includeAltBuffer} + returns
// the diff; create carries a scrollback depth.
// ===========================================================================

describe("createTerminalSessionRegistry — read forwards the render opts", () => {
  it("forwards {format,scrollback,includeAltBuffer} into the read frame's params", async () => {
    const fake = makeFakeWorker((req) =>
      req.method === "read"
        ? {
            sessionId: req.sessionId,
            requestId: req.requestId,
            ok: true,
            result: { screen: "x", cursor: { x: 0, y: 0 }, cols: 80, rows: 24, alt: false, alive: true },
          }
        : undefined,
    );
    const registry = createTerminalSessionRegistry(baseDeps(() => fake.child));

    const { sessionId } = await registry.create({
      allowId: "bash",
      bin: "/bin/bash",
      argv: [],
      cols: 80,
      rows: 24,
      scrollback: 1000,
    }, OWNER);

    await registry.read(sessionId, OWNER, { format: "ansi", scrollback: 10, includeAltBuffer: false });

    // The read frame must carry the render opts (the worker's handleRead reads them).
    const readFrame = fake.requestFrames.find((f) => f.method === "read");
    expect(readFrame).toBeDefined();
    expect(readFrame?.params["sessionId"]).toBe(sessionId);
    expect(readFrame?.params["format"]).toBe("ansi");
    expect(readFrame?.params["scrollback"]).toBe(10);
    expect(readFrame?.params["includeAltBuffer"]).toBe(false);
  });

  it("a bare read(sessionId) (no opts) still round-trips and forwards no render opts", async () => {
    const fake = makeFakeWorker((req) =>
      req.method === "read"
        ? {
            sessionId: req.sessionId,
            requestId: req.requestId,
            ok: true,
            result: { screen: "y", cursor: { x: 0, y: 0 }, cols: 80, rows: 24, alt: false, alive: true },
          }
        : undefined,
    );
    const registry = createTerminalSessionRegistry(baseDeps(() => fake.child));

    const { sessionId } = await registry.create({
      allowId: "bash",
      bin: "/bin/bash",
      argv: [],
      cols: 80,
      rows: 24,
      scrollback: 1000,
    }, OWNER);

    const view = await registry.read(sessionId, OWNER);
    expect(view.screen).toBe("y");

    const readFrame = fake.requestFrames.find((f) => f.method === "read");
    expect(readFrame).toBeDefined();
    // opts absent → only the session id rides the frame; no format/scrollback keys.
    expect(readFrame?.params["format"]).toBeUndefined();
    expect(readFrame?.params["scrollback"]).toBeUndefined();
    expect(readFrame?.params["includeAltBuffer"]).toBeUndefined();
  });

  it("returns the worker's diff field on the TerminalView (screen-diff reaches the daemon)", async () => {
    const fake = makeFakeWorker((req) =>
      req.method === "read"
        ? {
            sessionId: req.sessionId,
            requestId: req.requestId,
            ok: true,
            result: {
              screen: "z",
              cursor: { x: 0, y: 0 },
              cols: 80,
              rows: 24,
              alt: false,
              alive: true,
              diff: { changed: true, firstChangedRow: 1, lastChangedRow: 3 },
            },
          }
        : undefined,
    );
    const registry = createTerminalSessionRegistry(baseDeps(() => fake.child));

    const { sessionId } = await registry.create({
      allowId: "bash",
      bin: "/bin/bash",
      argv: [],
      cols: 80,
      rows: 24,
      scrollback: 1000,
    }, OWNER);

    const view = await registry.read(sessionId, OWNER);
    // The worker-produced diff rides the view through to the tool layer.
    expect(view.diff).toEqual({ changed: true, firstChangedRow: 1, lastChangedRow: 3 });
  });
});

describe("createTerminalSessionRegistry — create threads a scrollback depth", () => {
  it("carries an explicit scrollback into the create frame's params", async () => {
    const fake = makeFakeWorker();
    const registry = createTerminalSessionRegistry(baseDeps(() => fake.child));

    await registry.create({
      allowId: "bash",
      bin: "/bin/bash",
      argv: [],
      cols: 80,
      rows: 24,
      scrollback: 5000,
    }, OWNER);

    const createFrame = fake.requestFrames.find((f) => f.method === "create");
    expect(createFrame).toBeDefined();
    // handleCreate constructs Terminal({cols,rows,scrollback}) from this field.
    expect(createFrame?.params["scrollback"]).toBe(5000);
  });

  it("exposes DEFAULT_SCROLLBACK (1000) as the registry-level default scrollback const", async () => {
    // The const is the single source the create tool defaults to. It is the value
    // previously hard-coded worker-side, now sourced from the registry.
    expect(DEFAULT_SCROLLBACK).toBe(1000);
  });
});

// ===========================================================================
// scope + workspace/cwd ride the create frame to the worker (so the jail-side
// composer can call buildScopeArgs(scope, workspace, cwd)).
// ===========================================================================

describe("createTerminalSessionRegistry — scope rides the create frame", () => {
  it("carries the entry's declared scope onto the create frame's params verbatim", async () => {
    const fake = makeFakeWorker();
    const registry = createTerminalSessionRegistry(baseDeps(() => fake.child));
    const scope: TerminalScope = {
      filesystem: "listed-paths",
      paths: ["/srv/data"],
      network: "listed-hosts",
      hosts: ["api.example.com"],
      credentialPaths: ["~/.claude"],
      uid: "dedicated",
    };

    await registry.create({
      allowId: "bash",
      bin: "/bin/bash",
      argv: [],
      cols: 80,
      rows: 24,
      scope,
    }, OWNER);

    const createFrame = fake.requestFrames.find((f) => f.method === "create");
    expect(createFrame).toBeDefined();
    // The worker's handleCreate reads p["scope"] for the jail composer.
    expect(createFrame?.params["scope"]).toEqual(scope);
  });

  it("carries workspace + cwd onto the create frame (the worker needs them to build the jail binds)", async () => {
    const fake = makeFakeWorker();
    const registry = createTerminalSessionRegistry(baseDeps(() => fake.child));

    await registry.create({
      allowId: "bash",
      bin: "/bin/bash",
      argv: [],
      cols: 80,
      rows: 24,
      workspace: "/work/agent-1",
      cwd: "/work/agent-1/project",
    }, OWNER);

    const createFrame = fake.requestFrames.find((f) => f.method === "create");
    expect(createFrame).toBeDefined();
    expect(createFrame?.params["workspace"]).toBe("/work/agent-1");
    expect(createFrame?.params["cwd"]).toBe("/work/agent-1/project");
  });
});

// ===========================================================================
// The registry is the seam that threads the daemon-resolved bwrapPath toward the
// worker. bwrapPath is a STRING, so it rides the create frame (like scope/
// workspace/cwd) for the eventual worker-main to read; the live egressControl
// port is a daemon->worker-main concern (not frame-serialized).
// ===========================================================================

describe("createTerminalSessionRegistry — bwrapPath rides the create frame (jail seam)", () => {
  it("forwards the daemon-resolved bwrapPath onto the create frame's params", async () => {
    const fake = makeFakeWorker();
    const registry = createTerminalSessionRegistry(
      baseDeps(() => fake.child, { bwrapPath: "/usr/bin/bwrap" }),
    );

    await registry.create({
      allowId: "bash",
      bin: "/bin/bash",
      argv: [],
      cols: 80,
      rows: 24,
      scope: { filesystem: "workspace", network: "none", credentialPaths: [], uid: "dedicated" },
      workspace: "/work/agent-1",
      cwd: "/work/agent-1",
    }, OWNER);

    const createFrame = fake.requestFrames.find((f) => f.method === "create");
    expect(createFrame).toBeDefined();
    // The worker's fail-closed branch reads bwrapPath; the registry threads it.
    expect(createFrame?.params["bwrapPath"]).toBe("/usr/bin/bwrap");
  });

  it("omits bwrapPath (undefined) on the frame when no provider resolved one (fail-closed downstream)", async () => {
    const fake = makeFakeWorker();
    // No bwrapPath dep — the worker fail-closes when it reads undefined.
    const registry = createTerminalSessionRegistry(baseDeps(() => fake.child));

    await registry.create({
      allowId: "bash",
      bin: "/bin/bash",
      argv: [],
      cols: 80,
      rows: 24,
      scope: { filesystem: "workspace", network: "none", credentialPaths: [], uid: "dedicated" },
      workspace: "/work/agent-1",
      cwd: "/work/agent-1",
    }, OWNER);

    const createFrame = fake.requestFrames.find((f) => f.method === "create");
    expect(createFrame).toBeDefined();
    expect(createFrame?.params["bwrapPath"]).toBeUndefined();
  });
});

describe("createTerminalSessionRegistry — no module-global state", () => {
  it("two registries have isolated session maps", async () => {
    const r1 = createTerminalSessionRegistry(baseDeps(() => makeFakeWorker().child));
    const r2 = createTerminalSessionRegistry(baseDeps(() => makeFakeWorker().child));

    await r1.create({ allowId: "bash", bin: "/bin/bash", argv: [], cols: 80, rows: 24 }, OWNER);

    expect(r1.size()).toBe(1);
    expect(r2.size()).toBe(0);
  });
});

/**
 * Build a fake worker whose stdout can be driven to emit RAW (non-frame) bytes,
 * so the registry's stdout handler is fed a malformed / hostile chunk.
 * `emitRaw` pushes arbitrary bytes onto the reply channel; `emitOversizedPrefix`
 * pushes a uint32 length prefix above the framer cap (the DoS prefix).
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

describe("createTerminalSessionRegistry — malformed-frame on stdout does NOT crash (crash isolation)", () => {
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
    }, OWNER);

    // A length-prefixed frame whose body is NOT valid JSON ("{" then garbage):
    // JSON.parse throws INSIDE the stdout 'data' listener. Pre-patch this is an
    // uncaughtException that takes the daemon down (the precise opposite of crash isolation).
    const garbageBody = Buffer.from("{not-json", "utf8");
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(garbageBody.length, 0);

    // The handler must NOT throw out of the listener.
    expect(() => fake.emitRaw(Buffer.concat([prefix, garbageBody]))).not.toThrow();

    // The corrupt worker is dropped: the running session flips to 'lost'.
    expect(registry.get(sessionId, OWNER)?.status).toBe("lost");
    // A WARN with a closed-union errorKind ('validation' — the frame failed
    // structural decode) was logged for the corrupt frame.
    const warn = logger.warn.mock.calls.find(
      ([obj]) => (obj as { errorKind?: string }).errorKind === "validation",
    );
    expect(warn).toBeDefined();
  });

  it("an oversized length prefix on stdout is caught (FrameTooLargeError), not rethrown — daemon survives", async () => {
    const fake = makeRawDrivableWorker();
    const logger = makeLogger();
    const registry = createTerminalSessionRegistry(baseDeps(() => fake.child, { logger }));

    const { sessionId } = await registry.create({
      allowId: "bash",
      bin: "/bin/bash",
      argv: [],
      cols: 80,
      rows: 24,
    }, OWNER);

    // The framer throws FrameTooLargeError on this prefix; the handler must swallow it.
    expect(() => fake.emitOversizedPrefix()).not.toThrow();
    expect(registry.get(sessionId, OWNER)?.status).toBe("lost");
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe("createTerminalSessionRegistry — worker create failure is surfaced", () => {
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
    }, OWNER);

    // Let the queued microtask reply land.
    await new Promise((r) => setImmediate(r));

    // The handle reflects the failure — NOT a perpetual alive:true.
    expect(registry.get(sessionId, OWNER)?.status).toBe("lost");
    // list() and read() agree the session is not alive.
    expect(registry.list(OWNER).find((s) => s.sessionId === sessionId)?.alive).toBe(false);
    const view = await registry.read(sessionId, OWNER);
    expect(view.alive).toBe(false);
    // The spawn-failure hook fired with the session id + the worker error.
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
    }, OWNER);
    await new Promise((r) => setImmediate(r));

    expect(registry.get(sessionId, OWNER)?.status).toBe("running");
    expect(spawnFailures).toHaveLength(0);
  });
});

describe("createTerminalSessionRegistry — request() reply timeout (wedged worker)", () => {
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
    }, OWNER);

    const readPromise = registry.read(sessionId, OWNER);
    // The read registered a timeout with the configured duration.
    expect(setTimer).toHaveBeenCalled();
    expect(scheduledMs).toBe(1234);

    // Fire the timeout (simulate expiry) → read settles to the not-alive minimal view.
    firedCb?.();
    const view = await readPromise;
    expect(view.alive).toBe(false);
    expect(view.screen).toBe("");
  });

  it("wait() sizes its reply timeout to the settle budget, NOT the generic short timeout (slow AI-CLI settle is not pre-empted)", async () => {
    // Regression: `wait`'s IPC reply lands only when the in-worker settle resolves
    // (60-90s+ for a driven `claude`). Pre-patch EVERY round-trip used the generic
    // ~10s requestTimeoutMs, so the IPC pre-empted the settle at ~10s and returned a
    // not-complete result while the CLI was still working — stranding the agent.
    const fake = makeFakeWorker(); // never replies → the request reply-timer is what fires
    let firedCb: (() => void) | undefined;
    let scheduledMs: number | undefined;
    const setTimer = vi.fn((cb: () => void, ms: number) => {
      firedCb = cb;
      scheduledMs = ms;
      return { id: 1 } as unknown;
    });
    const registry = createTerminalSessionRegistry(
      baseDeps(() => fake.child, {
        requestTimeoutMs: 1234,
        setTimer: setTimer as never,
        clearTimer: vi.fn() as never,
      }),
    );
    const { sessionId } = await registry.create(
      { allowId: "bash", bin: "/bin/bash", argv: [], cols: 80, rows: 24 },
      OWNER,
    );

    const waitPromise = registry.wait(sessionId, OWNER, { forIdleMs: 30_000, timeoutMs: 120_000 });
    // The wait scheduled its reply timeout at the settle budget + margin — NOT the
    // generic 1234ms requestTimeoutMs that read/write/resize use.
    expect(scheduledMs).toBe(waitReplyTimeoutMs(120_000));
    expect(scheduledMs).not.toBe(1234);

    // Fire the (long) reply timeout → the wait degrades to the honest not-complete shape.
    firedCb?.();
    const result = await waitPromise;
    expect(result.isComplete).toBe(false);
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
    }, OWNER);
    const view = await registry.read(sessionId, OWNER);
    expect(view.screen).toBe("ok");
    // The reply arrived → the timeout was cancelled (clearTimer called for the read key).
    expect(clearTimer).toHaveBeenCalled();
  });
});

describe("createTerminalSessionRegistry — clearWorker preserves waiter identity", () => {
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
    }, OWNER);

    const readPromise = registry.read(sessionId, OWNER); // parks a (sessionId,requestId) waiter
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

// ===========================================================================
// sendText / sendKey forwarding (-> {screen,cursor})
// ===========================================================================

/** An advancing clock: each call returns a strictly larger value (for lastActivity). */
function makeAdvancingClock(start = 1_700_000_000_000): () => number {
  let t = start;
  return () => (t += 1000);
}

describe("createTerminalSessionRegistry — sendText forwarding", () => {
  it("forwards a send_text frame and resolves the {screen,cursor} subset", async () => {
    const fake = makeFakeWorker((req) =>
      req.method === "send_text"
        ? {
            sessionId: req.sessionId,
            requestId: req.requestId,
            ok: true,
            // The worker returns a FULL view; the registry resolves only {screen,cursor}.
            result: { screen: "hello", cursor: { x: 5, y: 0 }, cols: 80, rows: 24, alt: false, alive: true },
          }
        : undefined,
    );
    const registry = createTerminalSessionRegistry(baseDeps(() => fake.child));

    const { sessionId } = await registry.create({
      allowId: "bash",
      bin: "/bin/bash",
      argv: [],
      cols: 80,
      rows: 24,
    }, OWNER);

    const out = await registry.sendText(sessionId, OWNER, { text: "hello", submit: false, bracketedPaste: false });

    // The forwarded frame carries the send_text method + the full param set.
    const frame = fake.requestFrames.find((f) => f.method === "send_text");
    expect(frame).toBeDefined();
    expect(frame?.params["sessionId"]).toBe(sessionId);
    expect(frame?.params["text"]).toBe("hello");
    expect(frame?.params["submit"]).toBe(false);
    expect(frame?.params["bracketedPaste"]).toBe(false);

    // The resolved value is the {screen,cursor} subset, NOT the full view; a send that
    // round-trips an ok worker reply is flagged delivered:true (WR-05).
    expect(out).toEqual({ screen: "hello", cursor: { x: 5, y: 0 }, delivered: true });
  });

  it("advances the session handle's lastActivity on a successful send_text", async () => {
    const fake = makeFakeWorker((req) =>
      req.method === "send_text"
        ? {
            sessionId: req.sessionId,
            requestId: req.requestId,
            ok: true,
            result: { screen: "x", cursor: { x: 1, y: 0 } },
          }
        : undefined,
    );
    const registry = createTerminalSessionRegistry(
      baseDeps(() => fake.child, { nowMs: makeAdvancingClock() }),
    );

    const { sessionId } = await registry.create({
      allowId: "bash",
      bin: "/bin/bash",
      argv: [],
      cols: 80,
      rows: 24,
    }, OWNER);
    const created = registry.get(sessionId, OWNER)?.lastActivity;
    expect(created).toBeDefined();

    await registry.sendText(sessionId, OWNER, { text: "x" });
    const after = registry.get(sessionId, OWNER)?.lastActivity;
    expect(after).toBeGreaterThan(created as number);
  });

  it("degrades a send_text on a reply timeout (ok:false) — no throw, no hang", async () => {
    // A worker that ACCEPTS the frame but never replies; the injected timeout fires.
    const fake = makeFakeWorker(); // no autoReply
    let firedCb: (() => void) | undefined;
    const setTimer = vi.fn((cb: () => void) => {
      firedCb = cb;
      return { id: 1 } as unknown;
    });
    const registry = createTerminalSessionRegistry(
      baseDeps(() => fake.child, {
        requestTimeoutMs: 500,
        setTimer: setTimer as never,
        clearTimer: vi.fn() as never,
      }),
    );

    const { sessionId } = await registry.create({
      allowId: "bash",
      bin: "/bin/bash",
      argv: [],
      cols: 80,
      rows: 24,
    }, OWNER);

    const p = registry.sendText(sessionId, OWNER, { text: "hi" });
    firedCb?.(); // simulate the reply-timeout expiry
    const out = await p;
    expect(out).toEqual({ screen: "", cursor: { x: 0, y: 0 } });
  });

  it("degrades to the {screen:'',cursor:0,0} shape for an absent session (no throw)", async () => {
    const fake = makeFakeWorker();
    const registry = createTerminalSessionRegistry(baseDeps(() => fake.child));
    const out = await registry.sendText("no-such-session", OWNER, { text: "hi" });
    expect(out).toEqual({ screen: "", cursor: { x: 0, y: 0 } });
  });
});

describe("createTerminalSessionRegistry — sendKey forwarding", () => {
  it("forwards a send_key frame with keys[] and resolves {screen,cursor}", async () => {
    const fake = makeFakeWorker((req) =>
      req.method === "send_key"
        ? {
            sessionId: req.sessionId,
            requestId: req.requestId,
            ok: true,
            result: { screen: "^C", cursor: { x: 0, y: 1 } },
          }
        : undefined,
    );
    const registry = createTerminalSessionRegistry(baseDeps(() => fake.child));

    const { sessionId } = await registry.create({
      allowId: "bash",
      bin: "/bin/bash",
      argv: [],
      cols: 80,
      rows: 24,
    }, OWNER);

    const out = await registry.sendKey(sessionId, OWNER, { keys: ["C-c"] });

    const frame = fake.requestFrames.find((f) => f.method === "send_key");
    expect(frame).toBeDefined();
    expect(frame?.params["sessionId"]).toBe(sessionId);
    expect(frame?.params["keys"]).toEqual(["C-c"]);

    // A send that round-trips an ok worker reply is flagged delivered:true (WR-05).
    expect(out).toEqual({ screen: "^C", cursor: { x: 0, y: 1 }, delivered: true });
  });

  it("degrades a send_key on a reply timeout (ok:false) — no throw, no hang", async () => {
    const fake = makeFakeWorker(); // no autoReply
    let firedCb: (() => void) | undefined;
    const setTimer = vi.fn((cb: () => void) => {
      firedCb = cb;
      return { id: 1 } as unknown;
    });
    const registry = createTerminalSessionRegistry(
      baseDeps(() => fake.child, {
        requestTimeoutMs: 500,
        setTimer: setTimer as never,
        clearTimer: vi.fn() as never,
      }),
    );

    const { sessionId } = await registry.create({
      allowId: "bash",
      bin: "/bin/bash",
      argv: [],
      cols: 80,
      rows: 24,
    }, OWNER);

    const p = registry.sendKey(sessionId, OWNER, { keys: ["Up"] });
    firedCb?.();
    const out = await p;
    expect(out).toEqual({ screen: "", cursor: { x: 0, y: 0 } });
  });
});

// ===========================================================================
// resize (-> {ok}) and wait (-> {matched,isComplete,reason,screen,cursor})
// ===========================================================================

describe("createTerminalSessionRegistry — resize forwarding", () => {
  it("forwards a resize frame, returns {ok:true}, and updates the handle geometry", async () => {
    const fake = makeFakeWorker((req) =>
      req.method === "resize"
        ? { sessionId: req.sessionId, requestId: req.requestId, ok: true, result: { ok: true } }
        : undefined,
    );
    const registry = createTerminalSessionRegistry(baseDeps(() => fake.child));

    const { sessionId } = await registry.create({
      allowId: "bash",
      bin: "/bin/bash",
      argv: [],
      cols: 80,
      rows: 24,
    }, OWNER);

    const out = await registry.resize(sessionId, OWNER, { cols: 100, rows: 30 });

    const frame = fake.requestFrames.find((f) => f.method === "resize");
    expect(frame).toBeDefined();
    expect(frame?.params["sessionId"]).toBe(sessionId);
    expect(frame?.params["cols"]).toBe(100);
    expect(frame?.params["rows"]).toBe(30);

    expect(out).toEqual({ ok: true });
    // The snapshot stays coherent — list()/get() reflect the new geometry.
    expect(registry.get(sessionId, OWNER)?.cols).toBe(100);
    expect(registry.get(sessionId, OWNER)?.rows).toBe(30);
  });

  it("returns {ok:false} for an absent session (no throw)", async () => {
    const fake = makeFakeWorker();
    const registry = createTerminalSessionRegistry(baseDeps(() => fake.child));
    const out = await registry.resize("no-such-session", OWNER, { cols: 100, rows: 30 });
    expect(out).toEqual({ ok: false });
  });
});

describe("createTerminalSessionRegistry — wait forwarding", () => {
  it("forwards a wait frame and resolves {matched,isComplete,reason,screen,cursor} verbatim", async () => {
    const fake = makeFakeWorker((req) =>
      req.method === "wait"
        ? {
            sessionId: req.sessionId,
            requestId: req.requestId,
            ok: true,
            result: { matched: true, isComplete: true, reason: "idle", screen: "ready>", cursor: { x: 6, y: 0 } },
          }
        : undefined,
    );
    const registry = createTerminalSessionRegistry(baseDeps(() => fake.child));

    const { sessionId } = await registry.create({
      allowId: "bash",
      bin: "/bin/bash",
      argv: [],
      cols: 80,
      rows: 24,
    }, OWNER);

    const out = await registry.wait(sessionId, OWNER, { forIdleMs: 120, timeoutMs: 5000 });

    const frame = fake.requestFrames.find((f) => f.method === "wait");
    expect(frame).toBeDefined();
    expect(frame?.params["sessionId"]).toBe(sessionId);
    expect(frame?.params["forIdleMs"]).toBe(120);
    expect(frame?.params["timeoutMs"]).toBe(5000);

    expect(out).toEqual({
      matched: true,
      isComplete: true,
      reason: "idle",
      screen: "ready>",
      cursor: { x: 6, y: 0 },
    });
  });

  it("preserves isComplete:false on a worker timeout reply (the load-bearing passthrough)", async () => {
    const fake = makeFakeWorker((req) =>
      req.method === "wait"
        ? {
            sessionId: req.sessionId,
            requestId: req.requestId,
            ok: true,
            result: { matched: false, isComplete: false, reason: "timeout", screen: "still working", cursor: { x: 2, y: 3 } },
          }
        : undefined,
    );
    const registry = createTerminalSessionRegistry(baseDeps(() => fake.child));

    const { sessionId } = await registry.create({
      allowId: "bash",
      bin: "/bin/bash",
      argv: [],
      cols: 80,
      rows: 24,
    }, OWNER);

    const out = await registry.wait(sessionId, OWNER, { forIdleMs: 120 });
    // isComplete:false MUST survive the forward — a flip to true strands the agent.
    expect(out.isComplete).toBe(false);
    expect(out.matched).toBe(false);
    expect(out.reason).toBe("timeout");
    expect(out.screen).toBe("still working");
  });

  it("yields the honest not-complete shape on a worker-timeout (ok:false) — never isComplete:true, never a hang", async () => {
    const fake = makeFakeWorker(); // no autoReply → the request() reply timeout fires
    let firedCb: (() => void) | undefined;
    const setTimer = vi.fn((cb: () => void) => {
      firedCb = cb;
      return { id: 1 } as unknown;
    });
    const registry = createTerminalSessionRegistry(
      baseDeps(() => fake.child, {
        requestTimeoutMs: 500,
        setTimer: setTimer as never,
        clearTimer: vi.fn() as never,
      }),
    );

    const { sessionId } = await registry.create({
      allowId: "bash",
      bin: "/bin/bash",
      argv: [],
      cols: 80,
      rows: 24,
    }, OWNER);

    const p = registry.wait(sessionId, OWNER, { forIdleMs: 120 });
    firedCb?.(); // simulate the reply-timeout expiry → ok:false
    const out = await p;
    expect(out).toMatchObject({
      matched: false,
      isComplete: false,
      reason: "timeout",
      screen: "",
      cursor: { x: 0, y: 0 },
    });
    expect(out.isComplete).toBe(false);
    // T1.1: the degraded shape now carries a worker-wedged hint (not an empty result).
    expect(out.hint).toMatch(/did not reply|wedged|status/i);
  });

  it("defaults a missing/odd isComplete to false (never coerces to true) on a malformed reply", async () => {
    // A reply that OMITS isComplete entirely — the registry must default it to
    // false, never true (a corrupt worker cannot fake completion).
    const fake = makeFakeWorker((req) =>
      req.method === "wait"
        ? {
            sessionId: req.sessionId,
            requestId: req.requestId,
            ok: true,
            result: { matched: true, reason: "idle", screen: "x" } as unknown as Record<string, unknown>,
          }
        : undefined,
    );
    const registry = createTerminalSessionRegistry(baseDeps(() => fake.child));

    const { sessionId } = await registry.create({
      allowId: "bash",
      bin: "/bin/bash",
      argv: [],
      cols: 80,
      rows: 24,
    }, OWNER);

    const out = await registry.wait(sessionId, OWNER, {});
    expect(out.isComplete).toBe(false);
  });
});

// ===========================================================================
// Origin-keying: owner-stamped + owner-scoped create/list/read/get/kill/send*
// (owner-scoped visibility + isolation). The session stays the opaque handle;
// ownership is the gate. A SessionOwner is (agentId, sessionKey); two subagents
// share an agentId but differ on sessionKey (a subagent channelId is
// "sub-agent:<uuid>", session-key.ts:78-79) so they are MUTUALLY INVISIBLE.
//
// RED on the pre-patch single-owner code: list()/read()/get()/kill() ignore the
// owner arg, so two owners' sessions are visible to each other (list length 2,
// cross-owner read alive:true) — the invisibility/no-op assertions fail at
// runtime. The 3-session isolation is proven via a fake worker keying each read
// reply to the frame's sessionId.
// ===========================================================================

/**
 * A fake worker whose `read` reply screen is keyed to the frame's sessionId, so
 * three interleaved reads each resolve ONLY their own bytes (no cross-bleed).
 */
function makeIsolatingWorker() {
  return makeFakeWorker((frame) =>
    frame.method === "read"
      ? {
          sessionId: frame.sessionId,
          requestId: frame.requestId,
          ok: true,
          result: {
            screen: `bytes-for-${frame.sessionId}`,
            cursor: { x: 0, y: 0 },
            cols: 80,
            rows: 24,
            alt: false,
            alive: true,
          },
        }
      : { sessionId: frame.sessionId, requestId: frame.requestId, ok: true },
  );
}

const bashReq = { allowId: "bash", bin: "/bin/bash", argv: [] as string[], cols: 80, rows: 24 };

describe("createTerminalSessionRegistry — per-session isolation (3 interleaved reads)", () => {
  it("each of three sessions reads ONLY its own bytes under interleaved Promise.all (no state bleed)", async () => {
    const fake = makeIsolatingWorker();
    const reg = createTerminalSessionRegistry(baseDeps(() => fake.child));

    const s1 = await reg.create(bashReq, OWNER);
    const s2 = await reg.create(bashReq, OWNER);
    const s3 = await reg.create(bashReq, OWNER);
    // Three distinct opaque handles.
    expect(new Set([s1.sessionId, s2.sessionId, s3.sessionId]).size).toBe(3);

    const [v1, v2, v3] = await Promise.all([
      reg.read(s1.sessionId, OWNER),
      reg.read(s2.sessionId, OWNER),
      reg.read(s3.sessionId, OWNER),
    ]);

    // Each view carries ONLY its own session's bytes — no cross-session bleed.
    expect(v1.screen).toContain(s1.sessionId);
    expect(v2.screen).toContain(s2.sessionId);
    expect(v3.screen).toContain(s3.sessionId);
    expect(v1.screen).not.toContain(s2.sessionId);
    expect(v2.screen).not.toContain(s3.sessionId);
    expect(v3.screen).not.toContain(s1.sessionId);
  });
});

describe("createTerminalSessionRegistry — two subagents are mutually invisible", () => {
  // Two owners: same agentId, distinct sessionKey (two subagent runs — each
  // subagent's channelId is "sub-agent:<uuid>", so formatSessionKey() differs).
  const sub1 = { agentId: "a", sessionKey: "default:user:sub-agent:uuid-1" };
  const sub2 = { agentId: "a", sessionKey: "default:user:sub-agent:uuid-2" };

  it("list() is owner-scoped: each subagent sees ONLY its own session, distinct ids", async () => {
    const fake = makeIsolatingWorker();
    const reg = createTerminalSessionRegistry(baseDeps(() => fake.child));

    await reg.create(bashReq, sub1);
    await reg.create(bashReq, sub2);

    // RED on pre-patch: list ignores the owner → returns BOTH (length 2).
    expect(reg.list(sub1)).toHaveLength(1);
    expect(reg.list(sub2)).toHaveLength(1);
    expect(reg.list(sub1)[0].sessionId).not.toBe(reg.list(sub2)[0].sessionId);
  });

  it("a cross-owner read returns the not-found minimal view (alive:false) — never the other owner's bytes", async () => {
    const fake = makeIsolatingWorker();
    const reg = createTerminalSessionRegistry(baseDeps(() => fake.child));

    await reg.create(bashReq, sub1);
    const s2 = await reg.create(bashReq, sub2);

    // sub1 reads sub2's sessionId → owner mismatch is treated EXACTLY as not-found.
    const crossView = await reg.read(s2.sessionId, sub1);
    expect(crossView.alive).toBe(false);
    expect(crossView.screen).toBe("");
    // The legitimate owner still reads its own bytes.
    const ownView = await reg.read(s2.sessionId, sub2);
    expect(ownView.alive).toBe(true);
    expect(ownView.screen).toContain(s2.sessionId);
  });

  it("a cross-owner get returns undefined; the owner's get returns the handle", async () => {
    const fake = makeIsolatingWorker();
    const reg = createTerminalSessionRegistry(baseDeps(() => fake.child));

    const s2 = await reg.create(bashReq, sub2);

    expect(reg.get(s2.sessionId, sub1)).toBeUndefined();
    expect(reg.get(s2.sessionId, sub2)?.sessionId).toBe(s2.sessionId);
  });
});

// ===========================================================================
// 124-06 Task 1 — registry.status(sessionId, owner) is owner-scoped (TR-13 /
// T-124-15): a cross-owner / killed session returns the not-found minimal view,
// never another owner's real classifier state. The owner's status round-trips a
// `status` frame to the worker and composes the perception with handle.lastActivity.
// RED on pre-patch: `registry.status` does not exist (TypeError) — the interface +
// impl land in GREEN.
// ===========================================================================

/** A fake worker that answers a `status` frame with the spec §5 perception subset. */
function makeStatusWorker() {
  return makeFakeWorker((frame) =>
    frame.method === "status"
      ? {
          sessionId: frame.sessionId,
          requestId: frame.requestId,
          ok: true,
          result: {
            state: "awaiting-input",
            cursorParked: true,
            screenDiffEmpty: true,
            interactions: 3,
          },
        }
      : { sessionId: frame.sessionId, requestId: frame.requestId, ok: true },
  );
}

describe("createTerminalSessionRegistry — 124-06 status is owner-scoped (T-124-15)", () => {
  const sub1 = { agentId: "a", sessionKey: "default:user:sub-agent:uuid-1" };
  const sub2 = { agentId: "a", sessionKey: "default:user:sub-agent:uuid-2" };

  it("the owner's status round-trips the `status` frame and returns the classifier state + lastActivity", async () => {
    const fake = makeStatusWorker();
    const reg = createTerminalSessionRegistry(baseDeps(() => fake.child));

    const s = await reg.create(bashReq, sub1);
    const view = await reg.status(s.sessionId, sub1);

    expect(view.state).toBe("awaiting-input");
    expect(view.cursorParked).toBe(true);
    expect(view.screenDiffEmpty).toBe(true);
    expect(view.interactions).toBe(3);
    expect(typeof view.lastActivity).toBe("number");
    // The worker received a `status` frame (the classifier stays single-homed there).
    expect(fake.requestFrames.some((f) => f.method === "status")).toBe(true);
  });

  it("a cross-owner status returns the not-found minimal view — NEVER the other owner's classifier state (T-124-15)", async () => {
    const fake = makeStatusWorker();
    const reg = createTerminalSessionRegistry(baseDeps(() => fake.child));

    const s2 = await reg.create(bashReq, sub2);

    // sub1 probes sub2's sessionId → owner mismatch is treated EXACTLY as not-found.
    const crossView = await reg.status(s2.sessionId, sub1);
    expect(crossView.state).not.toBe("awaiting-input"); // never the real state
    expect(crossView.cursorParked).toBe(false);
    // No `status` frame was sent for the cross-owner probe (degrades WITHOUT a round-trip).
    expect(fake.requestFrames.some((f) => f.method === "status")).toBe(false);

    // The legitimate owner still sees its real state.
    const ownView = await reg.status(s2.sessionId, sub2);
    expect(ownView.state).toBe("awaiting-input");
  });

  it("a killed/absent session → status returns the not-found minimal view (alive-equivalent exited)", async () => {
    const fake = makeStatusWorker();
    const reg = createTerminalSessionRegistry(baseDeps(() => fake.child));

    const s = await reg.create(bashReq, sub1);
    await reg.kill(s.sessionId, sub1);

    const view = await reg.status(s.sessionId, sub1);
    expect(view.state).not.toBe("awaiting-input");
    expect(view.cursorParked).toBe(false);
  });
});

describe("createTerminalSessionRegistry — TR-13 kill cannot cross owners (T-123-07)", () => {
  const sub1 = { agentId: "a", sessionKey: "default:user:sub-agent:uuid-1" };
  const sub2 = { agentId: "a", sessionKey: "default:user:sub-agent:uuid-2" };

  it("kill(sub2Session, sub1) is a no-op; only kill(sub2Session, sub2) drops it", async () => {
    const fake = makeIsolatingWorker();
    const reg = createTerminalSessionRegistry(baseDeps(() => fake.child));

    const s2 = await reg.create(bashReq, sub2);

    // A foreign owner cannot terminate the session — it survives in sub2's list.
    await reg.kill(s2.sessionId, sub1);
    expect(reg.list(sub2).map((s) => s.sessionId)).toContain(s2.sessionId);

    // The real owner's kill drops it.
    await reg.kill(s2.sessionId, sub2);
    expect(reg.list(sub2)).toHaveLength(0);
  });

  it("send*/resize/wait on a cross-owner sessionId degrade as not-running (defense-in-depth)", async () => {
    const fake = makeIsolatingWorker();
    const reg = createTerminalSessionRegistry(baseDeps(() => fake.child));

    const s2 = await reg.create(bashReq, sub2);

    // A hijacked caller guessing sub2's sessionId under its OWN owner gets the
    // degraded empty snapshot — never drives the other owner's session.
    expect(await reg.sendText(s2.sessionId, sub1, { text: "x" })).toEqual({ screen: "", cursor: { x: 0, y: 0 } });
    expect(await reg.sendKey(s2.sessionId, sub1, { keys: ["C-c"] })).toEqual({ screen: "", cursor: { x: 0, y: 0 } });
    expect(await reg.resize(s2.sessionId, sub1, { cols: 100, rows: 30 })).toEqual({ ok: false });
    expect((await reg.wait(s2.sessionId, sub1, {})).isComplete).toBe(false);
  });
});

describe("createTerminalSessionRegistry — cleanup() is owner-agnostic (tears down the whole per-agent registry)", () => {
  const subA = { agentId: "a", sessionKey: "default:user:sub-agent:uuid-A" };
  const subB = { agentId: "a", sessionKey: "default:user:sub-agent:uuid-B" };

  it("drops EVERY session regardless of owner (the per-agent worker is shared)", async () => {
    const fake = makeIsolatingWorker();
    const reg = createTerminalSessionRegistry(baseDeps(() => fake.child));

    await reg.create(bashReq, subA);
    await reg.create(bashReq, subB);
    expect(reg.size()).toBe(2);

    await reg.cleanup();
    // cleanup evicts both owners' sessions (it is NOT owner-scoped).
    expect(reg.size()).toBe(0);
  });
});

// ===========================================================================
// Compose the reaper into the registry. On maxSessions overflow at create the
// idlest session is evicted (max_sessions); cleanup() stops the sweep (no leaked
// interval); EVERY eviction runs the single audited site — drop +
// cleanupSessionWorkspace + onEvict(reason) + onCapForget (so the cap-state map
// is forgotten on the reap path, not only the tool kill).
//
// RED on the pre-patch registry: the deps have no maxSessions/idleTtlMs/timers/
// onEvict/onCapForget, there is no reaper.checkOverflow() in create, no
// reaper.stop() in cleanup, and no public evict() — so an over-cap create keeps
// all 3 sessions, the fake-timer interval is never armed, and onCapForget never
// fires.
// ===========================================================================

describe("createTerminalSessionRegistry — reaper composition", () => {
  const subA = { agentId: "a", sessionKey: "default:user:sub-agent:uuid-A" };

  /** baseDeps + the reaper wiring: fake timers, an onEvict + onCapForget spy. */
  function reaperDeps(spawnWorker: TerminalSessionRegistryDeps["spawnWorker"], over: Partial<TerminalSessionRegistryDeps> = {}) {
    const timers = createFakeTimers(0);
    const onEvict = vi.fn<(info: { sessionId: string; reason: EvictReason; durationMs: number }) => void>();
    const onCapForget = vi.fn<(sessionId: string) => void>();
    const deps = baseDeps(spawnWorker, {
      maxSessions: 2,
      idleTtlMs: 0,
      wallClockMs: 0,
      sweepIntervalMs: 1000,
      timers,
      onEvict,
      onCapForget,
      ...over,
    });
    return { deps, timers, onEvict, onCapForget };
  }

  it("Test A — overflow on create: a 3rd session over maxSessions 2 evicts the idlest (reason max_sessions), size==2", async () => {
    const fake = makeIsolatingWorker();
    const { deps, onEvict } = reaperDeps(() => fake.child);
    const reg = createTerminalSessionRegistry(deps);

    await reg.create(bashReq, subA);
    await reg.create(bashReq, subA);
    await reg.create(bashReq, subA);

    // The over-cap create evicts the single idlest down to the cap.
    expect(reg.size()).toBe(2);
    expect(onEvict).toHaveBeenCalledTimes(1);
    expect(onEvict.mock.calls[0][0].reason).toBe("max_sessions");
  });

  it("Test B — cleanup() stops the sweep: the fake-timer interval is cancelled (no leaked sweep)", async () => {
    const fake = makeIsolatingWorker();
    const { deps, timers } = reaperDeps(() => fake.child, { maxSessions: 10 });
    const reg = createTerminalSessionRegistry(deps);

    // The sweep interval is armed at construction.
    const armed = timers.unrefRecord().filter((e) => e.kind === "interval");
    expect(armed).toHaveLength(1);
    expect(armed[0].unrefCalled).toBe(true);

    await reg.cleanup();

    // cleanup() must stop the reaper FIRST — the interval is now cancelled.
    expect(timers.unrefRecord().filter((e) => e.kind === "interval")[0].cancelled).toBe(true);
  });

  it("Test C — audited eviction + cap-forget: evict() drops the session AND fires onEvict(reason) + onCapForget(sessionId)", async () => {
    const fake = makeIsolatingWorker();
    const { deps, onEvict, onCapForget } = reaperDeps(() => fake.child, { maxSessions: 10 });
    const reg = createTerminalSessionRegistry(deps);

    const s = await reg.create(bashReq, subA);

    // The public evict() entry point (also reused for max_interactions) —
    // owner-checked, then the single audited eviction site that reuses the kill
    // drop + cleanupSessionWorkspace (proven gone from list) + onEvict + onCapForget.
    await reg.evict(s.sessionId, subA, "max_interactions");

    // The session is gone from the owner's list (the drop + workspace cleanup ran).
    expect(reg.list(subA)).toHaveLength(0);
    // The audited reason fired with the session's wall-clock durationMs.
    expect(onEvict).toHaveBeenCalledTimes(1);
    expect(onEvict.mock.calls[0][0]).toMatchObject({ sessionId: s.sessionId, reason: "max_interactions" });
    expect(typeof onEvict.mock.calls[0][0].durationMs).toBe("number");
    // The cap-state map is forgotten on the reap path (no SessionCaps leak).
    expect(onCapForget).toHaveBeenCalledWith(s.sessionId);
  });

  it("Test C2 — evict() is owner-scoped: a cross-owner evict is a no-op (the session survives, no cap-forget)", async () => {
    const fake = makeIsolatingWorker();
    const other = { agentId: "a", sessionKey: "default:user:sub-agent:uuid-OTHER" };
    const { deps, onEvict, onCapForget } = reaperDeps(() => fake.child, { maxSessions: 10 });
    const reg = createTerminalSessionRegistry(deps);

    const s = await reg.create(bashReq, subA);

    await reg.evict(s.sessionId, other, "max_interactions");

    // A foreign owner cannot evict — the session survives and nothing fired.
    expect(reg.list(subA).map((r) => r.sessionId)).toContain(s.sessionId);
    expect(onEvict).not.toHaveBeenCalled();
    expect(onCapForget).not.toHaveBeenCalled();
  });

  // The teardown paired with `allocateWorkspace`: kill/evict/reap must route the
  // workspace removal through the INJECTABLE `cleanupWorkspace`, not a hard-coded
  // `rm -rf`. This is the seam a data-dir-rooted daemon uses to PERSIST the agent's
  // own workspace — it injects a no-op so a driven milestone's work survives the
  // session end. RED on the pre-patch registry: line 743 called `cleanupSessionWorkspace`
  // directly, so an injected hook was dead and the agent workspace would be deleted.
  it("Test C3 — injectable cleanupWorkspace: kill routes teardown through the injected hook with the session workspace (the persist-the-agent-workspace seam)", async () => {
    const fake = makeIsolatingWorker();
    const cleanupWorkspace = vi.fn<(workspace: string) => void>();
    const agentWorkspace = "/home/u/.comis/workspace/agent-a";
    const { deps } = reaperDeps(() => fake.child, {
      maxSessions: 10,
      allocateWorkspace: () => agentWorkspace,
      cleanupWorkspace,
    });
    const reg = createTerminalSessionRegistry(deps);

    const s = await reg.create(bashReq, subA);
    await reg.kill(s.sessionId, subA);

    // The injected teardown ran with the agent's workspace — a daemon passes a
    // NO-OP here so the persistent workspace is NOT rm -rf'd on session end.
    expect(cleanupWorkspace).toHaveBeenCalledWith(agentWorkspace);
  });
});

// ===========================================================================
// 124-05 (TR-11, spec §2.3): the guarded fd3 events-push READER. The registry
// reads child.stdio[3] with the SAME HR-02 crash-guard as stdout — a decoded
// TerminalEventFrame (no requestId) is dispatched to the daemon-injected
// onTerminalEvent hook; a corrupt fd3 byte WARNs + drops the worker, NEVER
// throws out of the listener (a malformed event frame cannot crash the daemon).
// This is the no-poll consumer: attention arrives via this reader, not a timer.
// ===========================================================================

/**
 * Build a fake worker whose fd3 (`stdio[3]`) can be driven — the events push
 * channel the registry's new reader attaches to. `emitFd3` pushes bytes onto fd3
 * (a length-prefixed event frame, or raw/oversized garbage for the HR-02 tests).
 * stdin/stdout are present so create() round-trips; on/kill complete the surface.
 */
function makeFd3DrivableWorker(): {
  child: FakeWorkerChild;
  emitFd3: (bytes: Buffer) => void;
} {
  const emitter = new EventEmitter();
  const stdout = new EventEmitter();
  const fd3 = new EventEmitter();
  const child = {
    pid: 6161,
    stdin: { write: () => true } as unknown as FakeWorkerChild["stdin"],
    stdout: stdout as unknown as FakeWorkerChild["stdout"],
    // fd0=stdin, fd1=stdout, fd2=stderr, fd3=the events push channel (124-05).
    stdio: [null, stdout, null, fd3],
    on: (event: string, cb: (arg?: unknown) => void) => {
      emitter.on(event, cb);
      return child;
    },
    kill: vi.fn(),
  } as unknown as FakeWorkerChild;
  return { child, emitFd3: (bytes: Buffer) => fd3.emit("data", bytes) };
}

describe("createTerminalSessionRegistry — 124-05 fd3 events-push reader (TR-11, no poll)", () => {
  it("a decoded TerminalEventFrame on fd3 is dispatched to the injected onTerminalEvent hook", async () => {
    const fake = makeFd3DrivableWorker();
    const events: TerminalEventFrame[] = [];
    const registry = createTerminalSessionRegistry(
      baseDeps(() => fake.child, { onTerminalEvent: (f) => events.push(f) }),
    );
    const { sessionId } = await registry.create({
      allowId: "bash",
      bin: "/bin/bash",
      argv: [],
      cols: 80,
      rows: 24,
    }, OWNER);

    // The worker emits a transition event on fd3 (no requestId → routed as an EVENT).
    fake.emitFd3(
      encodeFrame({ sessionId, event: "terminal:input_needed", payload: { state: "awaiting-input", reason: "settled_cursor_parked" } }),
    );

    expect(events).toHaveLength(1);
    expect(events[0].sessionId).toBe(sessionId);
    expect(events[0].event).toBe("terminal:input_needed");
    expect(events[0].payload).toMatchObject({ state: "awaiting-input" });
    // The session is untouched — an event is not a crash signal.
    expect(registry.get(sessionId, OWNER)?.status).toBe("running");
  });

  it("a corrupt (non-JSON) fd3 byte does NOT crash the daemon — WARN errorKind:'validation', drop the worker, never rethrow (HR-02)", async () => {
    const fake = makeFd3DrivableWorker();
    const logger = makeLogger();
    const onTerminalEvent = vi.fn();
    const registry = createTerminalSessionRegistry(
      baseDeps(() => fake.child, { logger, onTerminalEvent }),
    );
    const { sessionId } = await registry.create({
      allowId: "bash",
      bin: "/bin/bash",
      argv: [],
      cols: 80,
      rows: 24,
    }, OWNER);

    // A length-prefixed frame whose body is NOT valid JSON: JSON.parse throws INSIDE
    // the fd3 'data' listener. Pre-patch (no fd3 reader) this is never read; once the
    // reader exists, an UNGUARDED reader would uncaughtException the daemon (the
    // opposite of OPS-01). The guard must swallow it.
    const garbage = Buffer.from("{not-json-event", "utf8");
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(garbage.length, 0);

    expect(() => fake.emitFd3(Buffer.concat([prefix, garbage]))).not.toThrow();

    // The corrupt worker is dropped (running session → lost), a WARN with the closed-
    // union errorKind 'validation' was logged, and the hook was never called with the JUNK
    // frame — but MR-02: the crash path now re-publishes a CLEAN content-free
    // terminal:session_state{lost} lifecycle frame so the daemon reclaims this session's
    // drive-state. So the hook IS called, with exactly that lifecycle frame (never the junk).
    expect(registry.get(sessionId, OWNER)?.status).toBe("lost");
    const warn = logger.warn.mock.calls.find(
      ([obj]) => (obj as { errorKind?: string }).errorKind === "validation",
    );
    expect(warn).toBeDefined();
    // The junk event-shaped frame never reached the hook.
    const forwardedJunk = onTerminalEvent.mock.calls.find(
      ([f]) => (f as TerminalEventFrame).event !== "terminal:session_state",
    );
    expect(forwardedJunk, "the corrupt frame must NOT be forwarded as an event").toBeUndefined();
    // The MR-02 crash-lifecycle frame IS emitted for the (now-lost) running session.
    const lifecycle = onTerminalEvent.mock.calls.find(
      ([f]) => (f as TerminalEventFrame).event === "terminal:session_state",
    );
    expect(lifecycle, "the crash path must re-publish a lost-lifecycle frame (MR-02)").toBeDefined();
    expect((lifecycle![0] as TerminalEventFrame).sessionId).toBe(sessionId);
    expect(((lifecycle![0] as TerminalEventFrame).payload as { state?: string }).state).toBe("lost");
  });

  it("an oversized HR-01 length prefix on fd3 is caught (FrameTooLargeError), not rethrown — daemon survives", async () => {
    const fake = makeFd3DrivableWorker();
    const logger = makeLogger();
    const registry = createTerminalSessionRegistry(baseDeps(() => fake.child, { logger }));
    const { sessionId } = await registry.create({
      allowId: "bash",
      bin: "/bin/bash",
      argv: [],
      cols: 80,
      rows: 24,
    }, OWNER);

    const oversized = Buffer.alloc(4);
    oversized.writeUInt32BE(0xffffffff, 0); // ~4 GiB declared body → above the framer cap

    expect(() => fake.emitFd3(oversized)).not.toThrow();
    expect(registry.get(sessionId, OWNER)?.status).toBe("lost");
    expect(logger.warn).toHaveBeenCalled();
  });

  it("a reply-shaped frame (with requestId) on fd3 is NOT dispatched as an event (routed by the absence of requestId)", async () => {
    const fake = makeFd3DrivableWorker();
    const events: TerminalEventFrame[] = [];
    const registry = createTerminalSessionRegistry(
      baseDeps(() => fake.child, { onTerminalEvent: (f) => events.push(f) }),
    );
    const { sessionId } = await registry.create({
      allowId: "bash",
      bin: "/bin/bash",
      argv: [],
      cols: 80,
      rows: 24,
    }, OWNER);

    // A reply frame (has requestId, no `event`) does not belong on fd3; the reader
    // routes ONLY event-shaped frames to onTerminalEvent — a reply is ignored there.
    fake.emitFd3(encodeFrame({ sessionId, requestId: "rq-1", ok: true, result: {} }));

    expect(events).toHaveLength(0);
    expect(registry.get(sessionId, OWNER)?.status).toBe("running"); // not a corrupt-frame drop
  });

  it("a worker with NO fd3 stream (stdio[3] absent) does not throw on supervision (the reader is optional-chained)", async () => {
    // The plain makeFakeWorker has no stdio[3]; wiring supervision must not throw.
    const fake = makeFakeWorker();
    const registry = createTerminalSessionRegistry(
      baseDeps(() => fake.child, { onTerminalEvent: vi.fn() }),
    );
    await expect(
      registry.create({ allowId: "bash", bin: "/bin/bash", argv: [], cols: 80, rows: 24 }, OWNER),
    ).resolves.toBeDefined();
  });
});

// ===========================================================================
// 163-03 (CLASS-02 status half): the classifier `confidence` + `reason` thread
// through the worker->registry status round-trip — the documented field-plumbing
// bug class (project_mcp_field_plumbing). `classifyFrame` already computes both;
// composeStatusView must fold them through and notFoundStatus must supply a safe
// total default (high/exited) so the widened TerminalStatusView is never partial.
//
// RED on pre-patch: TerminalStatusView/WorkerStatusPerception carry NEITHER field,
// so the perception literal below is a tsc error and the view assertions read
// `undefined`. The source-introspection layer (esbuild strips type annotations, so
// a bare interface widen is not runtime-RED — the events-terminal.test.ts precedent)
// pins the two interfaces declare the fields.
// ===========================================================================

/** The src `terminal-status-view.ts` read for the type-only source-introspection RED. */
const STATUS_VIEW_SRC = readFileSync(
  fileURLToPath(new URL("./terminal-status-view.ts", import.meta.url)),
  "utf8",
);

describe("163-03 — composeStatusView/notFoundStatus thread confidence + reason (CLASS-02)", () => {
  it("composeStatusView passes perception.confidence + perception.reason through verbatim (pure fold)", () => {
    const perception: WorkerStatusPerception = {
      state: "awaiting-input",
      cursorParked: true,
      screenDiffEmpty: true,
      interactions: 4,
      confidence: "high",
      reason: "settled_cursor_parked",
    };
    const view = composeStatusView(perception, { lastActivity: 123 });
    expect(view.confidence).toBe(perception.confidence);
    expect(view.reason).toBe(perception.reason);
    // The pre-existing fold is unchanged for the other fields.
    expect(view.state).toBe("awaiting-input");
    expect(view.lastActivity).toBe(123);
    expect(view.interactions).toBe(4);
  });

  it("notFoundStatus(undefined) supplies a safe total default (state/confidence:high/reason:exited) — no undefined field", () => {
    const view = notFoundStatus(undefined);
    expect(view.state).toBe("exited");
    expect(view.confidence).toBe("high");
    expect(view.reason).toBe("exited");
    // The not-found degrade is the T-124-15 safe shape, never a real classifier verdict.
    expect(view.cursorParked).toBe(false);
    expect(view.screenDiffEmpty).toBe(true);
  });

  it("round-trip: a dialog perception {confidence:'medium', reason:'dialog_detected'} survives the worker->registry hop", () => {
    // The field-plumbing pin: a perception the worker would emit for a dialog frame,
    // folded through composeStatusView, must carry BOTH fields onto the view verbatim
    // (a missed seam reads undefined here — the silent no-op this guards).
    const perception: WorkerStatusPerception = {
      state: "awaiting-input",
      cursorParked: false,
      screenDiffEmpty: true,
      interactions: 1,
      confidence: "medium",
      reason: "dialog_detected",
    };
    const view = composeStatusView(perception, { lastActivity: 9000 });
    expect(view.confidence).toBe("medium");
    expect(view.reason).toBe("dialog_detected");
  });

  it("content-free (I3): reason is a structural machine tag — a single-line string with no newline / TUI bytes", () => {
    // reason is sourced ONLY from Classification.reason (a fixed enum tag), never screen
    // text; assert it carries no newline (the structural-only doc-promise, T-163-07).
    const fromCompose = composeStatusView(
      {
        state: "stuck",
        cursorParked: false,
        screenDiffEmpty: true,
        interactions: 0,
        confidence: "medium",
        reason: "no_progress",
      },
      { lastActivity: 1 },
    );
    expect(typeof fromCompose.reason).toBe("string");
    expect(fromCompose.reason).not.toMatch(/[\r\n]/);
    expect(notFoundStatus(undefined).reason).not.toMatch(/[\r\n]/);
  });

  it("source-introspection: both status shapes DECLARE confidence + reason (esbuild strips types → this is the runtime-RED layer)", () => {
    // The two interfaces must both carry the fields. esbuild erases the annotations
    // at build time, so a bare interface widen is invisible to a runtime assertion —
    // this source check is the proven guard (events-terminal.test.ts precedent).
    expect(STATUS_VIEW_SRC).toMatch(/confidence:\s*"high"\s*\|\s*"medium"/);
    expect(STATUS_VIEW_SRC).toMatch(/reason:\s*string/);
    // notFoundStatus supplies the safe default + composeStatusView folds the perception.
    expect(STATUS_VIEW_SRC).toMatch(/reason:\s*"exited"/);
    expect(STATUS_VIEW_SRC).toMatch(/perception\.confidence/);
    expect(STATUS_VIEW_SRC).toMatch(/perception\.reason/);
  });

  // ---------------------------------------------------------------------------
  // LR-03: composeStatusView is TOTAL against a malformed / version-skewed worker
  // reply. `registry.status` casts the cross-process IPC `reply.result` with
  // `as WorkerStatusPerception` (an UNCHECKED cast of untrusted bytes); if the worker
  // ever omits / mis-types `confidence`/`reason` (a version skew, a corrupt frame),
  // the cast would propagate `undefined`/a non-enum straight onto the status surface
  // the autonomous policy reads. Every OTHER untrusted-boundary reader in this phase is
  // defensively coded (setup-terminal-tools republish narrows p.confidence/p.reason,
  // T-163-11; makeWakeAdapterBus validates shape, WR-03) — composeStatusView must match,
  // coalescing an out-of-enum confidence to "medium" and a non-string reason to a safe
  // tag. RED on pre-patch: the pure pass-through fold copies the bad value verbatim.
  // ---------------------------------------------------------------------------
  it("LR-03: composeStatusView coalesces a MISSING confidence/reason to safe defaults (medium / a string tag)", () => {
    // A version-skewed worker reply that predates CLASS-02: neither field present. The
    // registry casts reply.result `as WorkerStatusPerception`, so this models the
    // post-cast runtime value. The fold must NOT surface undefined.
    const malformed = {
      state: "awaiting-input",
      cursorParked: false,
      screenDiffEmpty: true,
      interactions: 2,
    } as unknown as WorkerStatusPerception;
    const view = composeStatusView(malformed, { lastActivity: 7 });
    expect(view.confidence).toBe("medium");
    expect(typeof view.reason).toBe("string");
    expect(view.reason.length).toBeGreaterThan(0);
    expect(view.reason).not.toMatch(/[\r\n]/);
    // The well-formed fields still fold through unchanged.
    expect(view.state).toBe("awaiting-input");
    expect(view.interactions).toBe(2);
  });

  it("LR-03: composeStatusView coalesces an OUT-OF-ENUM confidence + a non-string reason to safe defaults", () => {
    // A corrupt frame: confidence is a foreign string, reason is a number. The narrow
    // must reject both (only "high"/"medium" pass for confidence; only a string for
    // reason) so the status surface is never a type-breaking value.
    const corrupt = {
      state: "stuck",
      cursorParked: false,
      screenDiffEmpty: true,
      interactions: 0,
      confidence: "extreme",
      reason: 42,
    } as unknown as WorkerStatusPerception;
    const view = composeStatusView(corrupt, { lastActivity: 1 });
    expect(view.confidence).toBe("medium");
    expect(typeof view.reason).toBe("string");
    expect(view.reason).not.toMatch(/[\r\n]/);
  });

  it("LR-03: a WELL-FORMED perception is folded VERBATIM (the narrow only rescues malformed input)", () => {
    // The defensive narrow must not perturb the happy path — a valid {high, ...} or
    // {medium, dialog_detected} perception passes through exactly (regression guard so
    // the coalesce does not silently rewrite good values).
    const ok: WorkerStatusPerception = {
      state: "awaiting-input",
      cursorParked: false,
      screenDiffEmpty: true,
      interactions: 1,
      confidence: "medium",
      reason: "dialog_detected",
    };
    const view = composeStatusView(ok, { lastActivity: 5 });
    expect(view.confidence).toBe("medium");
    expect(view.reason).toBe("dialog_detected");
    const ok2 = composeStatusView(
      { ...ok, confidence: "high", reason: "settled_cursor_parked" },
      { lastActivity: 5 },
    );
    expect(ok2.confidence).toBe("high");
    expect(ok2.reason).toBe("settled_cursor_parked");
  });

  it("LR-03 source-introspection: composeStatusView narrows confidence/reason (esbuild strips the type, so pin the runtime guard)", () => {
    // The coalesce is a runtime narrow (the cast is `as WorkerStatusPerception`, erased
    // at build) — assert the source carries the defensive check so a future edit cannot
    // silently revert to a bare pass-through.
    expect(STATUS_VIEW_SRC).toMatch(/perception\.confidence === "high" \|\| perception\.confidence === "medium"/);
    expect(STATUS_VIEW_SRC).toMatch(/typeof perception\.reason === "string"/);
  });
});

// ===========================================================================
// DUR-01 (165-06): recover-on-boot re-attach + durable-aware markRunningSessionsLost.
//
// The load-bearing gap: on a daemon restart the new registry's `sessions` Map is
// EMPTY, so a healthy 40h drive whose `comis-<old-id>` is STILL alive under tmux is
// wrongly flipped `lost`. The fix: the registry takes an injected descriptorStore +
// isTmuxAlive and, on construction, recovers each persisted descriptor via the pure
// reattachDecision (165-01) → re-attaches a live one as `running` WITHOUT a create
// frame (I10 — never double-drive), maps a genuinely-gone one to the EXISTING
// terminal:session_state(state:"lost") + a content-free unrecoverable reason (NOT a
// non-existent state:"failed") while PRESERVING the journal, and leaves a non-durable
// one to today's lost floor. markRunningSessionsLost becomes durable-aware: a durable
// + tmux-alive session is NOT flipped lost on a worker close (Q4).
//
// All injected → no live tmux. The fake worker's `requestFrames` is the create-frame
// spy (a recovered session must produce ZERO `method:"create"` frames). The genuinely-
// gone + re-attach signals ride injected hooks (onUnrecoverable / onReattached) the
// daemon (165-07) binds to the bus — the registry stays infra-decoupled.
// ===========================================================================

const DURABLE_OWNER = { agentId: "agent-dur", sessionKey: "" };

/** Build a persisted descriptor for a durable session (the recover-on-boot input). */
function durableDescriptor(over: Partial<SessionDescriptor> = {}): SessionDescriptor {
  return {
    sessionId: "old-sess",
    tmuxName: "comis-old-sess",
    allowId: "claude-drive",
    owner: DURABLE_OWNER,
    cols: 120,
    rows: 40,
    durable: true,
    createdAt: 1_600_000_000_000,
    ...over,
  };
}

/** An in-memory descriptor store seeded with the descriptors recover() should return. */
function fakeDescriptorStore(seed: SessionDescriptor[] = []): SessionDescriptorStorePort {
  const map = new Map<string, SessionDescriptor>(seed.map((d) => [d.sessionId, d]));
  return {
    persist: vi.fn((d: SessionDescriptor) => map.set(d.sessionId, d)),
    recover: vi.fn(() => Array.from(map.values())),
    remove: vi.fn((id: string) => map.delete(id)),
  };
}

/**
 * A fake worker that auto-replies to the BL-01 recover-on-boot `reattach` frame with the
 * given `ok`, and to a subsequent `read` with a live pane (so a test can drive a read
 * AGAINST the recovered session and prove it is NOT a zombie). The reattach-vs-read replies
 * are correlated by method.
 */
function makeReattachWorker(reattachOk: boolean): {
  child: FakeWorkerChild;
  requestFrames: TerminalRequestFrame[];
} {
  const fake = makeFakeWorker((frame) => {
    if (frame.method === "reattach") {
      return { sessionId: frame.sessionId, requestId: frame.requestId, ok: reattachOk, result: { backend: "tmux" } };
    }
    if (frame.method === "read") {
      return {
        sessionId: frame.sessionId,
        requestId: frame.requestId,
        ok: true,
        result: { screen: "resumed-pane", cursor: { x: 0, y: 0 }, cols: 120, rows: 40, alt: false, alive: true },
      };
    }
    return undefined;
  });
  return { child: fake.child, requestFrames: fake.requestFrames };
}

describe("createTerminalSessionRegistry — DUR-01 recover-on-boot re-attach", () => {
  it("re-attaches a durable session whose tmux is ALIVE as 'running' with ZERO create frames (I10 — never double-drive)", () => {
    const fake = makeFakeWorker();
    const store = fakeDescriptorStore([durableDescriptor()]);
    const registry = createTerminalSessionRegistry(
      baseDeps(() => fake.child, { durability: { descriptorStore: store, isTmuxAlive: (n) => n === "comis-old-sess" } }),
    );

    // The recovered session is visible + running under its ORIGINAL owner (identity verbatim, I5).
    const handle = registry.get("old-sess", DURABLE_OWNER);
    expect(handle?.status, "a live recovered session is running, not lost").toBe("running");
    expect(handle?.allowId).toBe("claude-drive");
    expect(handle?.cols).toBe(120);
    expect(handle?.rows).toBe(40);

    // I10 — the load-bearing assertion: recover-on-boot issues NO create frame. A fresh
    // create would spawn a SECOND CLI; the worker's has-session-gated backend re-attaches
    // the surviving pane on the next read instead.
    const createFrames = fake.requestFrames.filter((f) => f.method === "create");
    expect(createFrames, "recover-on-boot must NOT issue a create frame (I10)").toHaveLength(0);
  });

  it("BL-01 (the gap the originals missed): recover-on-boot fires ONE reattach frame + a subsequent read returns the LIVE pane (alive:true), ZERO create frames", async () => {
    const fake = makeReattachWorker(true);
    const store = fakeDescriptorStore([durableDescriptor()]);
    const onReattached = vi.fn();
    const onUnrecoverable = vi.fn();
    const registry = createTerminalSessionRegistry(
      baseDeps(() => fake.child, {
        durability: { descriptorStore: store, isTmuxAlive: (n) => n === "comis-old-sess", onReattached, onUnrecoverable },
      }),
    );

    // Let the eager recover-on-boot reattach round-trip settle (the worker confirms ok:true).
    await vi.waitFor(() => expect(onReattached).toHaveBeenCalledTimes(1));

    // EXACTLY ONE reattach frame, ZERO create frames (I10 — re-attach, never re-spawn).
    expect(fake.requestFrames.filter((f) => f.method === "reattach"), "exactly one reattach frame").toHaveLength(1);
    expect(fake.requestFrames.filter((f) => f.method === "create"), "ZERO create frames (I10)").toHaveLength(0);
    expect(onUnrecoverable, "a confirmed re-attach is NOT unrecoverable").not.toHaveBeenCalled();

    // THE LOAD-BEARING ASSERTION: a read against the recovered session returns the LIVE
    // pane (alive:true) — NOT the zombie alive:false the registry-only test never caught.
    const view = await registry.read("old-sess", DURABLE_OWNER);
    expect(view.alive, "a re-attached session is ALIVE, not a zombie").toBe(true);
    expect(view.screen).toContain("resumed-pane");
  });

  it("BL-01: a worker that re-attach-rejects (tmux died between the boot probe and the worker spawn) flips the session lost + fires onUnrecoverable (honest death, never a zombie)", async () => {
    const fake = makeReattachWorker(false); // boot probe said alive, but the worker reattach replies ok:false
    const store = fakeDescriptorStore([durableDescriptor()]);
    const onReattached = vi.fn();
    const onUnrecoverable = vi.fn();
    const registry = createTerminalSessionRegistry(
      baseDeps(() => fake.child, {
        durability: { descriptorStore: store, isTmuxAlive: () => true, onReattached, onUnrecoverable },
      }),
    );

    // The boot probe said alive, so a reattach frame is sent; the worker rejects it.
    await vi.waitFor(() => expect(onUnrecoverable).toHaveBeenCalledTimes(1));
    expect(onReattached, "a rejected re-attach is NOT a successful re-attach").not.toHaveBeenCalled();
    // The handle is flipped lost (honest death) — a read is alive:false, never a zombie running.
    expect(registry.get("old-sess", DURABLE_OWNER)?.status).toBe("lost");
  });

  it("a genuinely-gone durable session emits terminal:session_state(state:'lost') + a content-free unrecoverable reason — NOT a state:'failed', journal PRESERVED", () => {
    const fake = makeFakeWorker();
    const store = fakeDescriptorStore([durableDescriptor()]);
    const onUnrecoverable = vi.fn();
    const registry = createTerminalSessionRegistry(
      baseDeps(() => fake.child, {
        durability: {
          descriptorStore: store,
          isTmuxAlive: () => false, // the tmux session did NOT survive — genuinely gone
          onUnrecoverable,
        },
      }),
    );

    // The genuinely-gone path fires the injected hook the daemon binds to the bus.
    expect(onUnrecoverable).toHaveBeenCalledTimes(1);
    const info = onUnrecoverable.mock.calls[0]![0] as {
      sessionId: string;
      agentId: string;
      reason: string;
      errorKind: string;
    };
    expect(info.sessionId).toBe("old-sess");
    expect(info.agentId).toBe("agent-dur"); // the agentId rides the content-free hook
    expect(info.reason).toBe("tmux_session_gone"); // the content-free unrecoverable reason
    expect(info.errorKind, "§2.7 — a failure branch carries an errorKind").toBeTruthy();
    // The unrecoverable hook carries ONLY ids/enum (content-free, I3) — no screen/text.
    expect(Object.keys(info).sort()).toEqual(["agentId", "errorKind", "reason", "sessionId"]);

    // The JOURNAL is PRESERVED (I10) — recover-on-boot does NOT remove the descriptor's
    // journal; the user-facing `failed` outcome is derived downstream in Phase 166.
    expect(store.remove, "the genuinely-gone path must not delete the durable record/journal").not.toHaveBeenCalled();

    // It is NOT re-attached (not in the live session map).
    expect(registry.get("old-sess", DURABLE_OWNER)).toBeUndefined();
    // Still no create frame on the gone path.
    expect(fake.requestFrames.filter((f) => f.method === "create")).toHaveLength(0);
  });

  it("a worker-CONFIRMED re-attach fires ONE content-free terminal:drive_reattached signal (the obs INFO record)", async () => {
    const fake = makeReattachWorker(true);
    const store = fakeDescriptorStore([durableDescriptor()]);
    const onReattached = vi.fn();
    createTerminalSessionRegistry(
      baseDeps(() => fake.child, {
        durability: { descriptorStore: store, isTmuxAlive: () => true, onReattached },
      }),
    );

    // BL-01: onReattached fires only after the WORKER confirms the re-attach (ok:true),
    // not blindly at recover-time (a tmux that died post-probe must not emit a re-attach).
    await vi.waitFor(() => expect(onReattached).toHaveBeenCalledTimes(1));
    const info = onReattached.mock.calls[0]![0] as { sessionId: string; agentId: string };
    expect(info.sessionId).toBe("old-sess");
    expect(info.agentId).toBe("agent-dur");
    // Content-free (I3): the re-attach signal carries ids only — no screen/text.
    expect(Object.keys(info).sort()).toEqual(["agentId", "sessionId"]);
  });

  it("a NON-durable persisted descriptor is skipped on recover (today's lost floor — not re-attached, no hook)", () => {
    const fake = makeFakeWorker();
    const store = fakeDescriptorStore([durableDescriptor({ sessionId: "nd", durable: false })]);
    const onReattached = vi.fn();
    const onUnrecoverable = vi.fn();
    const registry = createTerminalSessionRegistry(
      baseDeps(() => fake.child, { durability: { descriptorStore: store, isTmuxAlive: () => true, onReattached, onUnrecoverable } }),
    );
    expect(registry.get("nd", DURABLE_OWNER)).toBeUndefined();
    expect(onReattached).not.toHaveBeenCalled();
    expect(onUnrecoverable).not.toHaveBeenCalled();
  });

  it("I1: with NO descriptorStore injected (today's wiring), construction recovers nothing + issues no create frame", () => {
    const fake = makeFakeWorker();
    const registry = createTerminalSessionRegistry(baseDeps(() => fake.child));
    expect(registry.size()).toBe(0);
    expect(fake.requestFrames.filter((f) => f.method === "create")).toHaveLength(0);
  });

  it("persists a descriptor at CREATE-time for a durable session BEFORE the create frame (Pitfall 6 — no orphan window)", async () => {
    const fake = makeFakeWorker();
    const store = fakeDescriptorStore();
    const registry = createTerminalSessionRegistry(
      baseDeps(() => fake.child, { durability: { descriptorStore: store } }),
    );

    await registry.create(
      { allowId: "claude-drive", bin: "/usr/bin/claude", argv: [], cols: 80, rows: 24, durable: true, tmuxName: "comis-x" },
      DURABLE_OWNER,
    );

    // The descriptor was persisted (so a SIGKILL mid-create cannot orphan tmux without a record).
    expect(store.persist).toHaveBeenCalledTimes(1);
    const persisted = store.persist.mock.calls[0]![0] as SessionDescriptor;
    expect(persisted.durable).toBe(true);
    expect(persisted.allowId).toBe("claude-drive");
    expect(persisted.owner).toEqual(DURABLE_OWNER);
    expect(persisted.tmuxName).toBe("comis-x");
  });

  it("I1: create does NOT persist a descriptor for a NON-durable session (today's spawn floor unchanged)", async () => {
    const fake = makeFakeWorker();
    const store = fakeDescriptorStore();
    const registry = createTerminalSessionRegistry(baseDeps(() => fake.child, { durability: { descriptorStore: store } }));
    await registry.create({ allowId: "bash", bin: "/bin/bash", argv: [], cols: 80, rows: 24 }, OWNER);
    expect(store.persist).not.toHaveBeenCalled();
  });
});

describe("createTerminalSessionRegistry — DUR-01 durable-aware markRunningSessionsLost (Q4)", () => {
  it("does NOT flip a durable + tmux-ALIVE session 'lost' on a worker close (it stays recoverable)", async () => {
    const fake = makeFakeWorker();
    const store = fakeDescriptorStore();
    const registry = createTerminalSessionRegistry(
      baseDeps(() => fake.child, { durability: { descriptorStore: store, isTmuxAlive: (n) => n === "comis-x" } }),
    );
    const { sessionId } = await registry.create(
      { allowId: "claude-drive", bin: "/usr/bin/claude", argv: [], cols: 80, rows: 24, durable: true, tmuxName: "comis-x" },
      DURABLE_OWNER,
    );

    fake.emitError(); // the worker crashed — but the detached tmux server lives on.

    // Q4: the durable session is NOT lost (its tmux is alive → still recoverable as running).
    expect(registry.get(sessionId, DURABLE_OWNER)?.status).toBe("running");
  });

  it("DOES flip a durable + tmux-GONE session 'lost' on a worker close (a genuine death)", async () => {
    const fake = makeFakeWorker();
    const store = fakeDescriptorStore();
    const registry = createTerminalSessionRegistry(
      baseDeps(() => fake.child, { durability: { descriptorStore: store, isTmuxAlive: () => false } }),
    );
    const { sessionId } = await registry.create(
      { allowId: "claude-drive", bin: "/usr/bin/claude", argv: [], cols: 80, rows: 24, durable: true, tmuxName: "comis-gone" },
      DURABLE_OWNER,
    );

    fake.emitError();

    expect(registry.get(sessionId, DURABLE_OWNER)?.status).toBe("lost");
  });

  it("a NON-durable spawn session keeps today's 'lost' flip on a worker close (I1 — floor unchanged)", async () => {
    const fake = makeFakeWorker();
    const registry = createTerminalSessionRegistry(
      baseDeps(() => fake.child, { durability: { isTmuxAlive: () => true } }), // even with a live probe, a non-durable session is lost
    );
    const { sessionId } = await registry.create({ allowId: "bash", bin: "/bin/bash", argv: [], cols: 80, rows: 24 }, OWNER);

    fake.emitError();

    expect(registry.get(sessionId, OWNER)?.status).toBe("lost");
  });

  it("I1: with NO isTmuxAlive injected, markRunningSessionsLost flips ALL running → lost (byte-identical to today)", async () => {
    const fake = makeFakeWorker();
    // A durable session but NO isTmuxAlive dep → the durable-aware branch cannot confirm
    // liveness, so it falls through to today's lost flip (the safe default).
    const registry = createTerminalSessionRegistry(baseDeps(() => fake.child));
    const a = await registry.create(
      { allowId: "claude-drive", bin: "/usr/bin/claude", argv: [], cols: 80, rows: 24, durable: true, tmuxName: "comis-x" },
      DURABLE_OWNER,
    );
    const b = await registry.create({ allowId: "bash", bin: "/bin/bash", argv: [], cols: 80, rows: 24 }, OWNER);

    fake.emitError();

    expect(registry.get(a.sessionId, DURABLE_OWNER)?.status).toBe("lost");
    expect(registry.get(b.sessionId, OWNER)?.status).toBe("lost");
  });
});
