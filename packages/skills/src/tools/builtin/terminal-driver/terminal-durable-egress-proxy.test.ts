// SPDX-License-Identifier: Apache-2.0
import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  createDurableEgressMaterializer,
  durableProxyLivenessDecision,
} from "./terminal-durable-egress-proxy.js";

class FakeReadable extends EventEmitter {
  destroy = vi.fn();
}

class FakeChild extends EventEmitter {
  readonly stdout = new FakeReadable();
  readonly kill = vi.fn(() => {
    queueMicrotask(() => this.emit("exit", 0, "SIGTERM"));
    return true;
  });
  readonly unref = vi.fn();
}

function silentLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("durable terminal egress proxy lifetime", () => {
  it("survives its launching worker and retires only after the tmux session disappears", () => {
    expect(durableProxyLivenessDecision({
      nowMs: 5_000,
      startedAtMs: 0,
      startupGraceMs: 30_000,
      observedTmuxAlive: false,
      tmuxAlive: false,
    })).toEqual({ action: "retain", observedTmuxAlive: false });
    expect(durableProxyLivenessDecision({
      nowMs: 10_000,
      startedAtMs: 0,
      startupGraceMs: 30_000,
      observedTmuxAlive: false,
      tmuxAlive: true,
    })).toEqual({ action: "retain", observedTmuxAlive: true });
    expect(durableProxyLivenessDecision({
      nowMs: 11_000,
      startedAtMs: 0,
      startupGraceMs: 30_000,
      observedTmuxAlive: true,
      tmuxAlive: false,
    })).toEqual({ action: "retire", reason: "tmux_session_gone" });
    expect(durableProxyLivenessDecision({
      nowMs: 30_000,
      startedAtMs: 0,
      startupGraceMs: 30_000,
      observedTmuxAlive: false,
      tmuxAlive: false,
    })).toEqual({ action: "retire", reason: "tmux_start_timeout" });
  });

  it("launches a detached helper with a scrubbed environment and disposes it explicitly", async () => {
    const child = new FakeChild();
    const spawnProcess = vi.fn(() => child);
    const materialize = createDurableEgressMaterializer({
      logger: silentLogger(),
      nodePath: "/usr/bin/node",
      entryPath: "/opt/comis/terminal-egress-proxy-main.js",
      tmuxPath: "/usr/bin/tmux",
      tmuxSocketForSession: (sessionId) => `/data/t-${sessionId}.sock`,
      tmuxNameForSession: (sessionId) => `comis-${sessionId}`,
      socketDir: "/tmp",
      genId: () => "proxy-a",
      spawnProcess,
    });

    const pending = materialize(
      ["api.example.com"],
      { sessionId: "terminal_a", durability: "durable" },
    );
    queueMicrotask(() => child.stdout.emit("data", Buffer.from("READY\n", "utf8")));
    const result = await pending;

    expect(spawnProcess).toHaveBeenCalledWith(
      "/usr/bin/node",
      expect.arrayContaining([
        "/opt/comis/terminal-egress-proxy-main.js",
        "--socket",
        "/tmp/comis-egress-proxy-a.sock",
        "--tmux-socket",
        "/data/t-terminal_a.sock",
        "--tmux-name",
        "comis-terminal_a",
      ]),
      {
        detached: true,
        env: {},
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    expect(child.unref).toHaveBeenCalledOnce();
    expect(result.socketPath).toBe("/tmp/comis-egress-proxy-a.sock");

    await expect(result.dispose()).resolves.toBeUndefined();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
