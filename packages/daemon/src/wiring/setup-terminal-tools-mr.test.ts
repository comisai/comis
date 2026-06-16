// SPDX-License-Identifier: Apache-2.0
/**
 * Wiring tests for the two daemon-side terminal-driver review fixes that live in
 * `wireTerminalTools` (`setup-terminal-tools.ts`):
 *
 *   - Provider reuse: the wiring must reuse the daemon's once-detected cached
 *     `sandboxProvider` (threaded into `TerminalWiringDeps`) instead of
 *     re-running the blocking `detectSandboxProvider()` (a `spawnSync("bwrap")`
 *     smoke test) on every create. The create tool's `detectProvider` must
 *     resolve to the cached provider, and `detectSandboxProvider` must NOT be
 *     invoked by the wiring.
 *   - Spawn-failure telemetry: the wiring must bind the registry's
 *     `onSpawnFailed` hook to emit a `terminal:spawn_failed` event, so a worker
 *     backend-spawn failure surfaces as telemetry (the registry flips the
 *     session to `lost`; the wiring turns the hook into the bus event).
 *
 * `@comis/skills/tools` is mocked so the deps passed to the create-tool +
 * registry factories are captured and asserted (the real factories spawn a real
 * worker / run a real bwrap probe — out of scope for a wiring unit test).
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Capture the deps each factory receives.
const captured: {
  createToolDeps?: Record<string, unknown>;
  registryDeps?: Record<string, unknown>;
} = {};

const detectSandboxProviderSpy = vi.fn(() => ({ name: "fresh-detect" }));

vi.mock("@comis/skills/tools", () => ({
  createTerminalSessionRegistry: vi.fn((deps: Record<string, unknown>) => {
    captured.registryDeps = deps;
    return {
      create: vi.fn(),
      read: vi.fn(),
      get: vi.fn(),
      list: vi.fn(() => []),
      kill: vi.fn(),
      size: vi.fn(() => 0),
      cleanup: vi.fn(),
    };
  }),
  buildProductionSpawnWorker: vi.fn(() => () => ({})),
  resolveWorkerMainPath: vi.fn(() => "/tmp/terminal-worker-main.js"),
  terminalWorkerDir: (dataDir: string) => `${dataDir}/terminal-worker`,
  resolveTmuxSocketPath: (dir: string) => `${dir}/tmux.sock`,
  createTerminalEgressProxy: vi.fn(() => ({ materialize: vi.fn(async () => ({ socketPath: "/tmp/egress.sock", dispose: vi.fn() })) })),
  detectSandboxProvider: detectSandboxProviderSpy,
  createTerminalSessionCreateTool: vi.fn((deps: Record<string, unknown>) => {
    captured.createToolDeps = deps;
    return { name: "terminal_session_create", execute: vi.fn() };
  }),
  createTerminalSessionReadTool: vi.fn(() => ({ name: "terminal_session_read", execute: vi.fn() })),
  createTerminalSessionListTool: vi.fn(() => ({ name: "terminal_session_list", execute: vi.fn() })),
  createTerminalSessionKillTool: vi.fn(() => ({ name: "terminal_session_kill", execute: vi.fn() })),
  createTerminalSessionSendTextTool: vi.fn(() => ({ name: "terminal_session_send_text", execute: vi.fn() })),
  createTerminalSessionSendKeyTool: vi.fn(() => ({ name: "terminal_session_send_key", execute: vi.fn() })),
  createTerminalSessionWaitTool: vi.fn(() => ({ name: "terminal_session_wait", execute: vi.fn() })),
  createTerminalSessionStatusTool: vi.fn(() => ({ name: "terminal_session_status", execute: vi.fn() })),
  createTerminalSessionResizeTool: vi.fn(() => ({ name: "terminal_session_resize", execute: vi.fn() })),
  // The per-session caps factory the terminal wiring constructs ONCE per agent.
  createSessionCaps: vi.fn(() => ({
    startSession: vi.fn(),
    consumeRequest: vi.fn(() => undefined),
    consumeInteraction: vi.fn(() => undefined),
    checkWallClock: vi.fn(() => undefined),
    forget: vi.fn(),
  })),
}));

vi.mock("@comis/core", () => ({
  systemNowMs: () => 1_700_000_000_000,
}));

// Imported AFTER the mocks are registered.
const { wireTerminalTools } = await import("./setup-terminal-tools.js");

type ToolLike = { name: string; execute: (id: string, params: object) => Promise<unknown> };

function makeBus() {
  const events: Array<{ event: string; payload: Record<string, unknown> }> = [];
  return {
    events,
    emit: (event: string, payload: Record<string, unknown>) => {
      events.push({ event, payload });
      return true;
    },
  };
}

beforeEach(() => {
  captured.createToolDeps = undefined;
  captured.registryDeps = undefined;
  detectSandboxProviderSpy.mockClear();
});

describe("wireTerminalTools — reuse the cached sandboxProvider (no per-create bwrap re-detect)", () => {
  it("binds the create tool's detectProvider to the daemon's cached provider and never calls detectSandboxProvider", () => {
    const cachedProvider = { name: "cached-daemon-provider" } as never;
    const tools: ToolLike[] = [];
    wireTerminalTools(tools as never, new Map(), "agent-a", {
      dataDir: "/tmp/comis-mr03",
      skillsLogger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      eventBus: makeBus() as never,
      sandboxProvider: cachedProvider,
    });

    const detectProvider = captured.createToolDeps?.detectProvider as
      | (() => unknown)
      | undefined;
    expect(detectProvider).toBeTypeOf("function");
    // The resolved provider IS the cached one (same reference) — not a fresh detect.
    expect(detectProvider?.()).toBe(cachedProvider);
    // The blocking spawnSync("bwrap") detect was never run by the wiring (detect-once).
    expect(detectSandboxProviderSpy).not.toHaveBeenCalled();
  });

  it("fail-closed is preserved: an undefined cached provider resolves to undefined (create rejects later)", () => {
    const tools: ToolLike[] = [];
    wireTerminalTools(tools as never, new Map(), "agent-a", {
      dataDir: "/tmp/comis-mr03",
      skillsLogger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      eventBus: makeBus() as never,
      sandboxProvider: undefined,
    });
    const detectProvider = captured.createToolDeps?.detectProvider as
      | (() => unknown)
      | undefined;
    expect(detectProvider?.()).toBeUndefined();
    expect(detectSandboxProviderSpy).not.toHaveBeenCalled();
  });
});

describe("wireTerminalTools — onSpawnFailed emits terminal:spawn_failed", () => {
  it("binds the registry's onSpawnFailed hook to emit a terminal:spawn_failed event with the agent id", () => {
    const bus = makeBus();
    wireTerminalTools([] as never, new Map(), "agent-x", {
      dataDir: "/tmp/comis-hr03",
      skillsLogger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      eventBus: bus as never,
      sandboxProvider: { name: "p" } as never,
    });

    const onSpawnFailed = captured.registryDeps?.onSpawnFailed as
      | ((info: { sessionId: string; error?: string }) => void)
      | undefined;
    expect(onSpawnFailed).toBeTypeOf("function");

    // Simulate the registry reporting a worker backend-spawn failure.
    onSpawnFailed?.({ sessionId: "sess-9", error: "spawn ENOENT" });

    const failed = bus.events.find((e) => e.event === "terminal:spawn_failed");
    expect(failed).toBeDefined();
    expect(failed?.payload.sessionId).toBe("sess-9");
    expect(failed?.payload.agentId).toBe("agent-x");
    expect(failed?.payload.hint).toBeTypeOf("string");
    expect(failed?.payload.errorKind).toBeTypeOf("string");
  });
});
