// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the four implemented terminal-driver tools (create/read/kill/
 * list) — the allowlist gate (SEC-01), fail-closed-on-no-provider (SEC-16), the
 * buildDirectSpawn canonicalization end-to-end (M-1 / SEC-14), and the OPS-07
 * transition + failure observability.
 *
 * Pure-JS / macOS-green: a fake registry + a fake provider + a capturing logger
 * + a capturing event bus are injected, so no real worker/PTY/sandbox is touched
 * here. The live create→read→kill on a real PTY is the round-trip suite; the
 * bare-metal fail-closed (bwrap removed) is VPS-gated.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { realpathSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createTerminalSessionCreateTool,
  createTerminalSessionReadTool,
  createTerminalSessionListTool,
  createTerminalSessionKillTool,
  createTerminalSessionSendTextTool,
  createTerminalSessionSendKeyTool,
  createTerminalSessionResizeTool,
  createTerminalSessionWaitTool,
  type TerminalToolDeps,
} from "./terminal-tools.js";
import {
  DEFAULT_SCROLLBACK,
  type TerminalSessionRegistry,
  type CreateRequest,
  type CreateResult,
  type TerminalView,
  type SendResult,
  type WaitResult,
  type SessionHandle,
  type SessionListing,
} from "./terminal-session-registry.js";
import type { ReadOptions } from "./terminal-render.js";
import type { AllowEntryLike, TerminalScope } from "./allowlist-matcher.js";

/** The least-privilege default scope (mirrors the config schema defaults). */
const DEFAULT_SCOPE: TerminalScope = {
  filesystem: "workspace",
  network: "none",
  credentialHome: "exclude",
  uid: "dedicated",
};

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

interface CapturedLog {
  level: "debug" | "info" | "warn" | "error";
  obj: Record<string, unknown>;
  msg: string;
}

function makeCapturingLogger(): {
  logs: CapturedLog[];
  debug: (o: Record<string, unknown>, m: string) => void;
  info: (o: Record<string, unknown>, m: string) => void;
  warn: (o: Record<string, unknown>, m: string) => void;
  error: (o: Record<string, unknown>, m: string) => void;
} {
  const logs: CapturedLog[] = [];
  return {
    logs,
    debug: (obj, msg) => logs.push({ level: "debug", obj, msg }),
    info: (obj, msg) => logs.push({ level: "info", obj, msg }),
    warn: (obj, msg) => logs.push({ level: "warn", obj, msg }),
    error: (obj, msg) => logs.push({ level: "error", obj, msg }),
  };
}

interface CapturedEvent {
  event: string;
  payload: Record<string, unknown>;
}

function makeCapturingBus(): {
  events: CapturedEvent[];
  emit: (event: string, payload: Record<string, unknown>) => void;
} {
  const events: CapturedEvent[] = [];
  return {
    events,
    emit: (event, payload) => {
      events.push({ event, payload });
    },
  };
}

interface SendTextCall {
  sessionId: string;
  args: { text: string; submit?: boolean; bracketedPaste?: boolean };
}
interface SendKeyCall {
  sessionId: string;
  args: { keys: string[] };
}
interface ResizeCall {
  sessionId: string;
  args: { cols: number; rows: number };
}
interface WaitCall {
  sessionId: string;
  args: { forIdleMs?: number; forText?: string; forExit?: boolean; timeoutMs?: number };
}

interface FakeRegistry extends TerminalSessionRegistry {
  createCalls: CreateRequest[];
  readCalls: string[];
  /** The `opts` arg each `read` was called with (121-04 — the render-param forwarding). */
  readOptsCalls: Array<ReadOptions | undefined>;
  killCalls: string[];
  sendTextCalls: SendTextCall[];
  sendKeyCalls: SendKeyCall[];
  resizeCalls: ResizeCall[];
  waitCalls: WaitCall[];
}

function makeFakeRegistry(overrides?: {
  createImpl?: (req: CreateRequest) => Promise<CreateResult>;
  readImpl?: (id: string, opts?: ReadOptions) => Promise<TerminalView>;
  sendTextImpl?: (id: string, args: SendTextCall["args"]) => Promise<SendResult>;
  sendKeyImpl?: (id: string, args: SendKeyCall["args"]) => Promise<SendResult>;
  resizeImpl?: (id: string, args: ResizeCall["args"]) => Promise<{ ok: boolean }>;
  waitImpl?: (id: string, args: WaitCall["args"]) => Promise<WaitResult>;
  handles?: Map<string, SessionHandle>;
  listing?: SessionListing[];
}): FakeRegistry {
  const createCalls: CreateRequest[] = [];
  const readCalls: string[] = [];
  const readOptsCalls: Array<ReadOptions | undefined> = [];
  const killCalls: string[] = [];
  const sendTextCalls: SendTextCall[] = [];
  const sendKeyCalls: SendKeyCall[] = [];
  const resizeCalls: ResizeCall[] = [];
  const waitCalls: WaitCall[] = [];
  const handles = overrides?.handles ?? new Map<string, SessionHandle>();
  let listing = overrides?.listing ?? [];

  return {
    createCalls,
    readCalls,
    readOptsCalls,
    killCalls,
    sendTextCalls,
    sendKeyCalls,
    resizeCalls,
    waitCalls,
    async create(req: CreateRequest): Promise<CreateResult> {
      createCalls.push(req);
      if (overrides?.createImpl) return overrides.createImpl(req);
      return { sessionId: "sess-1", allowId: req.allowId, cols: req.cols, rows: req.rows };
    },
    async read(id: string, opts?: ReadOptions): Promise<TerminalView> {
      readCalls.push(id);
      readOptsCalls.push(opts);
      if (overrides?.readImpl) return overrides.readImpl(id, opts);
      return { screen: "hello", cursor: { x: 0, y: 0 }, cols: 120, rows: 40, alt: false, alive: true };
    },
    async sendText(id: string, args: SendTextCall["args"]): Promise<SendResult> {
      sendTextCalls.push({ sessionId: id, args });
      if (overrides?.sendTextImpl) return overrides.sendTextImpl(id, args);
      return { screen: "after-text", cursor: { x: 1, y: 2 } };
    },
    async sendKey(id: string, args: SendKeyCall["args"]): Promise<SendResult> {
      sendKeyCalls.push({ sessionId: id, args });
      if (overrides?.sendKeyImpl) return overrides.sendKeyImpl(id, args);
      return { screen: "after-key", cursor: { x: 3, y: 4 } };
    },
    async resize(id: string, args: ResizeCall["args"]): Promise<{ ok: boolean }> {
      resizeCalls.push({ sessionId: id, args });
      if (overrides?.resizeImpl) return overrides.resizeImpl(id, args);
      return { ok: true };
    },
    async wait(id: string, args: WaitCall["args"]): Promise<WaitResult> {
      waitCalls.push({ sessionId: id, args });
      if (overrides?.waitImpl) return overrides.waitImpl(id, args);
      return { matched: true, isComplete: true, reason: "idle", screen: "settled", cursor: { x: 0, y: 0 } };
    },
    get(id: string): SessionHandle | undefined {
      return handles.get(id);
    },
    list(): SessionListing[] {
      return listing;
    },
    async kill(id: string): Promise<void> {
      killCalls.push(id);
      listing = listing.filter((s) => s.sessionId !== id);
    },
    size(): number {
      return handles.size;
    },
    async cleanup(): Promise<void> {
      /* no-op */
    },
  };
}

/** Resolve the realpath of a known shell binary available on the test host. */
function realBashPath(): string {
  for (const candidate of ["/bin/bash", "/usr/bin/bash", "/bin/sh"]) {
    try {
      return realpathSync(candidate);
    } catch {
      /* try next */
    }
  }
  throw new Error("no shell binary found on test host");
}

function bashAllowEntry(scope: TerminalScope = DEFAULT_SCOPE): AllowEntryLike {
  return { id: "bash", match: { path: realBashPath() }, scope };
}

function baseDeps(
  registry: FakeRegistry,
  overrides?: Partial<TerminalToolDeps>,
): TerminalToolDeps {
  const logger = makeCapturingLogger();
  const eventBus = makeCapturingBus();
  return {
    registry,
    allowEntries: [bashAllowEntry()],
    // A present provider by default (a non-undefined sentinel passes the gate).
    detectProvider: () => ({}) as never,
    logger,
    eventBus,
    nowMs: () => 1000,
    agentId: "agent-1",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("terminal-tools — create gate + canonicalization + observability", () => {
  it("rejects a non-allowlisted command with permission_denied and never spawns (SEC-01)", async () => {
    const registry = makeFakeRegistry();
    const tool = createTerminalSessionCreateTool(baseDeps(registry));

    await expect(
      tool.execute("call-1", { allowId: "bash", command: "/usr/bin/evil" }),
    ).rejects.toThrow(/\[permission_denied\]/);
    // The gate fired BEFORE any spawn — the registry was never asked to create.
    expect(registry.createCalls).toHaveLength(0);
  });

  it("fails closed when no sandbox provider is available (SEC-16)", async () => {
    const registry = makeFakeRegistry();
    const deps = baseDeps(registry, { detectProvider: () => undefined });
    const tool = createTerminalSessionCreateTool(deps);

    await expect(
      tool.execute("call-1", { allowId: "bash", command: realBashPath() }),
    ).rejects.toThrow(/\[permission_denied\][\s\S]*sandbox provider/i);
    // Fail-closed: no unsandboxed spawn.
    expect(registry.createCalls).toHaveLength(0);
  });

  it("spawns via the registry when a provider is present and the command is allowlisted", async () => {
    const registry = makeFakeRegistry();
    const tool = createTerminalSessionCreateTool(baseDeps(registry));

    const result = await tool.execute("call-1", { allowId: "bash", command: realBashPath() });
    expect(registry.createCalls).toHaveLength(1);
    expect((result.details as CreateResult).sessionId).toBe("sess-1");
  });

  it("logs INFO+durationMs+toolName and emits terminal:session_state on a successful create (OPS-07)", async () => {
    const registry = makeFakeRegistry();
    const logger = makeCapturingLogger();
    const eventBus = makeCapturingBus();
    const deps = baseDeps(registry, { logger, eventBus });
    const tool = createTerminalSessionCreateTool(deps);

    await tool.execute("call-1", { allowId: "bash", command: realBashPath() });

    const info = logger.logs.find((l) => l.level === "info");
    expect(info).toBeDefined();
    expect(info?.obj.durationMs).toBeTypeOf("number");
    expect(info?.obj.toolName).toBe("terminal_session_create");

    const transition = eventBus.events.find((e) => e.event === "terminal:session_state");
    expect(transition).toBeDefined();
    expect(transition?.payload.sessionId).toBe("sess-1");
    expect(transition?.payload.agentId).toBe("agent-1");
  });

  it("logs WARN with hint+errorKind and emits terminal:spawn_failed on a spawn failure (OPS-07)", async () => {
    const registry = makeFakeRegistry({
      createImpl: async () => {
        throw new Error("worker spawn boom");
      },
    });
    const logger = makeCapturingLogger();
    const eventBus = makeCapturingBus();
    const deps = baseDeps(registry, { logger, eventBus });
    const tool = createTerminalSessionCreateTool(deps);

    await expect(
      tool.execute("call-1", { allowId: "bash", command: realBashPath() }),
    ).rejects.toThrow(/worker spawn boom/);

    const failLog = logger.logs.find((l) => l.level === "warn" || l.level === "error");
    expect(failLog).toBeDefined();
    expect(failLog?.obj.hint).toBeTypeOf("string");
    expect(failLog?.obj.errorKind).toBeTypeOf("string");

    const failed = eventBus.events.find((e) => e.event === "terminal:spawn_failed");
    expect(failed).toBeDefined();
    expect(failed?.payload.hint).toBeTypeOf("string");
    expect(failed?.payload.errorKind).toBeTypeOf("string");
  });

  it("canonicalizes via buildDirectSpawn — passes realpath bin + argsPrefix-prefixed argv to registry.create (M-1, SEC-14)", async () => {
    // Build a symlink to bash; buildDirectSpawn must resolve it to bash's realpath.
    const dir = mkdtempSync(join(tmpdir(), "term-m1-"));
    const link = join(dir, "bash-link");
    const realBash = realBashPath();
    symlinkSync(realBash, link);

    const registry = makeFakeRegistry();
    const entry: AllowEntryLike = {
      id: "bash",
      // The pin is the realpath of bash; the symlink resolves to the same target → matches.
      match: { path: realBash, argsPrefix: ["--prefix-arg"] },
      scope: DEFAULT_SCOPE,
    };
    const deps = baseDeps(registry, { allowEntries: [entry] });
    const tool = createTerminalSessionCreateTool(deps);

    await tool.execute("call-1", { allowId: "bash", command: link, args: ["extra"] });

    expect(registry.createCalls).toHaveLength(1);
    const req = registry.createCalls[0];
    // bin is the canonical realpath of bash, NOT the symlink surface path.
    expect(req.bin).toBe(realBash);
    expect(req.bin).not.toBe(link);
    // argv = operator argsPrefix first, then the agent's args (argsPrefix preserved end-to-end).
    expect(req.argv).toEqual(["--prefix-arg", "extra"]);
  });
});

describe("terminal-tools — SEC-02/03 scope is sourced from the entry, never the agent params", () => {
  it("forwards matched.entry.scope into registry.create VERBATIM", async () => {
    // SEC-02: the declared scope must reach the worker. The tool reads it from the
    // matched allow entry (operator config) and threads it into registry.create.
    const scope: TerminalScope = {
      filesystem: "listed-paths",
      paths: ["/srv/data"],
      network: "listed-hosts",
      hosts: ["api.example.com"],
      credentialHome: "include",
      uid: "dedicated",
    };
    const registry = makeFakeRegistry();
    const deps = baseDeps(registry, { allowEntries: [bashAllowEntry(scope)] });
    const tool = createTerminalSessionCreateTool(deps);

    await tool.execute("call-1", { allowId: "bash", command: realBashPath() });

    expect(registry.createCalls).toHaveLength(1);
    expect(registry.createCalls[0].scope).toEqual(scope);
  });

  it("SEC-03 lock: CreateParams exposes NO scope field — the agent has no param to set/widen scope", () => {
    // The create tool's TypeBox schema is closed; `scope` is not a property, so a
    // model cannot supply one. Scope flows ONLY from the operator allow entry.
    const tool = createTerminalSessionCreateTool(baseDeps(makeFakeRegistry()));
    const props = (tool.parameters as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(props)).not.toContain("scope");
  });

  it("SEC-03 lock: a scope supplied in the agent params is IGNORED — the entry's scope wins", async () => {
    // Even if a (schema-rejected) `scope` rides the raw params, the tool must read
    // scope EXCLUSIVELY from matched.entry — never from params.
    const entryScope: TerminalScope = {
      filesystem: "workspace",
      network: "none",
      credentialHome: "exclude",
      uid: "dedicated",
    };
    const registry = makeFakeRegistry();
    const deps = baseDeps(registry, { allowEntries: [bashAllowEntry(entryScope)] });
    const tool = createTerminalSessionCreateTool(deps);

    await tool.execute("call-1", {
      allowId: "bash",
      command: realBashPath(),
      // A malicious widening attempt smuggled into the raw params:
      scope: { filesystem: "full", network: "full", credentialHome: "include", uid: "daemon" },
    });

    expect(registry.createCalls).toHaveLength(1);
    // The entry's least-privilege scope is forwarded — NOT the agent's widened one.
    expect(registry.createCalls[0].scope).toEqual(entryScope);
  });
});

describe("terminal-tools — read / list / kill delegation", () => {
  it("read returns the {screen,cursor,cols,rows,alt,alive} shape from the registry", async () => {
    const registry = makeFakeRegistry({
      readImpl: async () => ({
        screen: "grid-text",
        cursor: { x: 3, y: 5 },
        cols: 80,
        rows: 24,
        alt: true,
        alive: true,
      }),
    });
    const tool = createTerminalSessionReadTool(baseDeps(registry));

    const result = await tool.execute("call-1", { sessionId: "sess-1" });
    const view = result.details as TerminalView;
    expect(view.screen).toBe("grid-text");
    expect(view.cursor).toEqual({ x: 3, y: 5 });
    expect(view.cols).toBe(80);
    expect(view.rows).toBe(24);
    expect(view.alt).toBe(true);
    expect(view.alive).toBe(true);
    expect(registry.readCalls).toEqual(["sess-1"]);
  });

  it("kill returns { ok } and invokes registry.kill; the killed id drops from list afterward", async () => {
    const registry = makeFakeRegistry({
      listing: [
        { sessionId: "sess-1", allowId: "bash", command: "/bin/bash", alive: true, lastActivity: 1 },
        { sessionId: "sess-2", allowId: "bash", command: "/bin/bash", alive: true, lastActivity: 1 },
      ],
    });
    const killTool = createTerminalSessionKillTool(baseDeps(registry));
    const listTool = createTerminalSessionListTool(baseDeps(registry));

    const killed = await killTool.execute("call-1", { sessionId: "sess-1" });
    expect((killed.details as { ok: boolean }).ok).toBe(true);
    expect(registry.killCalls).toEqual(["sess-1"]);

    const listed = await listTool.execute("call-2", {});
    const rows = listed.details as SessionListing[];
    expect(rows.map((r) => r.sessionId)).not.toContain("sess-1");
    expect(rows.map((r) => r.sessionId)).toContain("sess-2");
  });

  it("list delegates to registry.list and returns the rows", async () => {
    const registry = makeFakeRegistry({
      listing: [{ sessionId: "sess-9", allowId: "bash", command: "/bin/bash", alive: true, lastActivity: 7 }],
    });
    const tool = createTerminalSessionListTool(baseDeps(registry));

    const result = await tool.execute("call-1", {});
    const rows = result.details as SessionListing[];
    expect(rows).toHaveLength(1);
    expect(rows[0].sessionId).toBe("sess-9");
  });
});

// ===========================================================================
// 121-04 Task 2 — the read tool forwards {format,scrollback,includeAltBuffer}
// (closing the 119-04 schema-only gap) + surfaces the diff; the create tool
// passes a non-agent-dialable scrollback into the CreateRequest.
// ===========================================================================

describe("terminal-tools — read forwards format/scrollback/includeAltBuffer (TR-02/14)", () => {
  it("passes the explicit {format,scrollback,includeAltBuffer} params to registry.read", async () => {
    const registry = makeFakeRegistry();
    const tool = createTerminalSessionReadTool(baseDeps(registry));

    await tool.execute("call-1", {
      sessionId: "sess-1",
      format: "ansi",
      scrollback: 25,
      includeAltBuffer: false,
    });

    expect(registry.readCalls).toEqual(["sess-1"]);
    // The 119-04 schema params now reach registry.read (the gap this plan closes).
    expect(registry.readOptsCalls).toHaveLength(1);
    expect(registry.readOptsCalls[0]).toEqual({ format: "ansi", scrollback: 25, includeAltBuffer: false });
  });

  it("applies the spec §5 defaults (format=text, scrollback=0, includeAltBuffer=true) when params are absent", async () => {
    const registry = makeFakeRegistry();
    const tool = createTerminalSessionReadTool(baseDeps(registry));

    await tool.execute("call-1", { sessionId: "sess-1" });

    expect(registry.readOptsCalls[0]).toEqual({ format: "text", scrollback: 0, includeAltBuffer: true });
  });

  it("surfaces the registry's diff on the jsonResult payload (TR-14 screen-diff reaches the agent)", async () => {
    const registry = makeFakeRegistry({
      readImpl: async () => ({
        screen: "grid",
        cursor: { x: 0, y: 0 },
        cols: 80,
        rows: 24,
        alt: false,
        alive: true,
        diff: { changed: true, firstChangedRow: 2, lastChangedRow: 5 },
      }),
    });
    const tool = createTerminalSessionReadTool(baseDeps(registry));

    const result = await tool.execute("call-1", { sessionId: "sess-1" });
    const view = result.details as TerminalView;
    expect(view.diff).toEqual({ changed: true, firstChangedRow: 2, lastChangedRow: 5 });
  });
});

describe("terminal-tools — create passes a non-agent-dialable scrollback (TR-14)", () => {
  it("builds a CreateRequest carrying scrollback=DEFAULT_SCROLLBACK (sourced from a const, not an agent param)", async () => {
    const registry = makeFakeRegistry();
    const tool = createTerminalSessionCreateTool(baseDeps(registry));

    await tool.execute("call-1", { allowId: "bash", command: realBashPath() });

    expect(registry.createCalls).toHaveLength(1);
    // The agent cannot dial the emulator's retained depth; the create tool sources
    // it from DEFAULT_SCROLLBACK (operator config later — never an agent knob).
    expect(registry.createCalls[0].scrollback).toBe(DEFAULT_SCROLLBACK);
  });
});

// ---------------------------------------------------------------------------
// The four interaction tools (send_text / send_key / resize / wait) — TR-03/04/05.
// Each is a THIN delegation to the registry method (the read/kill precedent):
// it reads its params, calls the one registry method, logs durationMs (§2.7), and
// returns the registry's returned shape VERBATIM. No re-gating (the session was
// gated at create); no detectProvider touch.
// ---------------------------------------------------------------------------

describe("terminal-tools — send_text delegation", () => {
  it("calls registry.sendText once with {text,submit,bracketedPaste} and returns its {screen,cursor} verbatim", async () => {
    const registry = makeFakeRegistry({
      sendTextImpl: async () => ({ screen: "echoed HELLO", cursor: { x: 7, y: 1 } }),
    });
    const tool = createTerminalSessionSendTextTool(baseDeps(registry));

    const res = await tool.execute("call-1", {
      sessionId: "s1",
      text: "hi",
      submit: true,
      bracketedPaste: false,
    });

    expect(registry.sendTextCalls).toHaveLength(1);
    expect(registry.sendTextCalls[0]).toEqual({
      sessionId: "s1",
      args: { text: "hi", submit: true, bracketedPaste: false },
    });
    // The tool body equals the registry's returned {screen,cursor}.
    expect(res.details).toEqual({ screen: "echoed HELLO", cursor: { x: 7, y: 1 } });
  });

  it("forwards a missing text as the empty-string default (the schema validates upstream; no tool-layer throw)", async () => {
    const registry = makeFakeRegistry();
    const tool = createTerminalSessionSendTextTool(baseDeps(registry));

    await tool.execute("call-1", { sessionId: "s1" });
    expect(registry.sendTextCalls).toHaveLength(1);
    expect(registry.sendTextCalls[0].args.text).toBe("");
  });

  it("logs an INFO with durationMs (§2.7)", async () => {
    const registry = makeFakeRegistry();
    const logger = makeCapturingLogger();
    let t = 1000;
    const tool = createTerminalSessionSendTextTool(baseDeps(registry, { logger, nowMs: () => (t += 5) }));

    await tool.execute("call-1", { sessionId: "s1", text: "x" });
    const info = logger.logs.find((l) => l.level === "info");
    expect(info).toBeDefined();
    expect(info?.obj.durationMs).toBeTypeOf("number");
    expect(info?.obj.toolName).toBe("terminal_session_send_text");
  });
});

describe("terminal-tools — send_key delegation", () => {
  it("calls registry.sendKey with {keys} and returns its {screen,cursor}", async () => {
    const registry = makeFakeRegistry({
      sendKeyImpl: async () => ({ screen: "after C-c", cursor: { x: 0, y: 9 } }),
    });
    const tool = createTerminalSessionSendKeyTool(baseDeps(registry));

    const res = await tool.execute("call-1", { sessionId: "s1", keys: ["C-c"] });

    expect(registry.sendKeyCalls).toHaveLength(1);
    expect(registry.sendKeyCalls[0]).toEqual({ sessionId: "s1", args: { keys: ["C-c"] } });
    expect(res.details).toEqual({ screen: "after C-c", cursor: { x: 0, y: 9 } });
  });

  it("forwards an EMPTY keys array as-is (the worker no-ops; not a tool-layer error)", async () => {
    const registry = makeFakeRegistry();
    const tool = createTerminalSessionSendKeyTool(baseDeps(registry));

    await tool.execute("call-1", { sessionId: "s1", keys: [] });
    expect(registry.sendKeyCalls).toHaveLength(1);
    expect(registry.sendKeyCalls[0].args.keys).toEqual([]);
  });

  it("logs an INFO with durationMs (§2.7)", async () => {
    const registry = makeFakeRegistry();
    const logger = makeCapturingLogger();
    let t = 2000;
    const tool = createTerminalSessionSendKeyTool(baseDeps(registry, { logger, nowMs: () => (t += 3) }));

    await tool.execute("call-1", { sessionId: "s1", keys: ["Up"] });
    const info = logger.logs.find((l) => l.level === "info");
    expect(info?.obj.durationMs).toBeTypeOf("number");
    expect(info?.obj.toolName).toBe("terminal_session_send_key");
  });
});

describe("terminal-tools — resize delegation", () => {
  it("calls registry.resize with {cols,rows} and returns { ok:true }", async () => {
    const registry = makeFakeRegistry();
    const tool = createTerminalSessionResizeTool(baseDeps(registry));

    const res = await tool.execute("call-1", { sessionId: "s1", cols: 100, rows: 30 });

    expect(registry.resizeCalls).toHaveLength(1);
    expect(registry.resizeCalls[0]).toEqual({ sessionId: "s1", args: { cols: 100, rows: 30 } });
    expect(res.details).toEqual({ ok: true });
  });

  it("forwards { ok:false } from the registry unchanged (absent/wedged session)", async () => {
    const registry = makeFakeRegistry({ resizeImpl: async () => ({ ok: false }) });
    const tool = createTerminalSessionResizeTool(baseDeps(registry));

    const res = await tool.execute("call-1", { sessionId: "missing", cols: 80, rows: 24 });
    expect(res.details).toEqual({ ok: false });
  });

  it("logs an INFO with durationMs (§2.7)", async () => {
    const registry = makeFakeRegistry();
    const logger = makeCapturingLogger();
    let t = 3000;
    const tool = createTerminalSessionResizeTool(baseDeps(registry, { logger, nowMs: () => (t += 4) }));

    await tool.execute("call-1", { sessionId: "s1", cols: 90, rows: 20 });
    const info = logger.logs.find((l) => l.level === "info");
    expect(info?.obj.durationMs).toBeTypeOf("number");
    expect(info?.obj.toolName).toBe("terminal_session_resize");
  });
});

describe("terminal-tools — wait delegation", () => {
  it("calls registry.wait with the (forIdleMs/forText/forExit/timeoutMs) settle params and returns the snapshot", async () => {
    const registry = makeFakeRegistry({
      waitImpl: async () => ({
        matched: true,
        isComplete: true,
        reason: "idle",
        screen: "quiet",
        cursor: { x: 2, y: 2 },
      }),
    });
    const tool = createTerminalSessionWaitTool(baseDeps(registry));

    const res = await tool.execute("call-1", { sessionId: "s1", forIdleMs: 120, timeoutMs: 5000 });

    expect(registry.waitCalls).toHaveLength(1);
    expect(registry.waitCalls[0]).toEqual({
      sessionId: "s1",
      args: { forIdleMs: 120, forText: undefined, forExit: undefined, timeoutMs: 5000 },
    });
    expect(res.details).toEqual({
      matched: true,
      isComplete: true,
      reason: "idle",
      screen: "quiet",
      cursor: { x: 2, y: 2 },
    });
  });

  it("forwards a timeout result UNCHANGED — isComplete:false survives (the tool never coerces it to true)", async () => {
    const registry = makeFakeRegistry({
      waitImpl: async () => ({
        matched: false,
        isComplete: false,
        reason: "timeout",
        screen: "still-busy",
        cursor: { x: 0, y: 0 },
      }),
    });
    const tool = createTerminalSessionWaitTool(baseDeps(registry));

    const res = await tool.execute("call-1", {
      sessionId: "s1",
      forText: "never-appears",
      timeoutMs: 200,
    });
    const body = res.details as WaitResult;
    expect(body.isComplete).toBe(false);
    expect(body.reason).toBe("timeout");
    expect(body.matched).toBe(false);
  });

  it("logs a DEBUG with durationMs (wait is readOnly) (§2.7)", async () => {
    const registry = makeFakeRegistry();
    const logger = makeCapturingLogger();
    let t = 4000;
    const tool = createTerminalSessionWaitTool(baseDeps(registry, { logger, nowMs: () => (t += 6) }));

    await tool.execute("call-1", { sessionId: "s1", forIdleMs: 100 });
    const dbg = logger.logs.find((l) => l.level === "debug" && l.obj.toolName === "terminal_session_wait");
    expect(dbg).toBeDefined();
    expect(dbg?.obj.durationMs).toBeTypeOf("number");
  });
});
