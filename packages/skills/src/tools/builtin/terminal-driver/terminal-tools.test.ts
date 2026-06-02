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
  type TerminalToolDeps,
} from "./terminal-tools.js";
import type {
  TerminalSessionRegistry,
  CreateRequest,
  CreateResult,
  TerminalView,
  SessionHandle,
  SessionListing,
} from "./terminal-session-registry.js";
import type { AllowEntryLike } from "./allowlist-matcher.js";

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

interface FakeRegistry extends TerminalSessionRegistry {
  createCalls: CreateRequest[];
  readCalls: string[];
  killCalls: string[];
}

function makeFakeRegistry(overrides?: {
  createImpl?: (req: CreateRequest) => Promise<CreateResult>;
  readImpl?: (id: string) => Promise<TerminalView>;
  handles?: Map<string, SessionHandle>;
  listing?: SessionListing[];
}): FakeRegistry {
  const createCalls: CreateRequest[] = [];
  const readCalls: string[] = [];
  const killCalls: string[] = [];
  const handles = overrides?.handles ?? new Map<string, SessionHandle>();
  let listing = overrides?.listing ?? [];

  return {
    createCalls,
    readCalls,
    killCalls,
    async create(req: CreateRequest): Promise<CreateResult> {
      createCalls.push(req);
      if (overrides?.createImpl) return overrides.createImpl(req);
      return { sessionId: "sess-1", allowId: req.allowId, cols: req.cols, rows: req.rows };
    },
    async read(id: string): Promise<TerminalView> {
      readCalls.push(id);
      if (overrides?.readImpl) return overrides.readImpl(id);
      return { screen: "hello", cursor: { x: 0, y: 0 }, cols: 120, rows: 40, alt: false, alive: true };
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

function bashAllowEntry(): AllowEntryLike {
  return { id: "bash", match: { path: realBashPath() } };
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
