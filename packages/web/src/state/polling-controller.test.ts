// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for PollingController.
 *
 * Covers the polling lifecycle (hostConnected/hostDisconnected), badge-count
 * aggregation from agent.list/channel.list/session.list RPC results, and the
 * non-fatal error-swallow branch. Uses vi.spyOn on globalThis.setInterval
 * (not vi.useFakeTimers) so each interval tick can be invoked manually.
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ReactiveControllerHost } from "lit";
import type { RpcClient } from "../api/rpc-client.js";
import { PollingController } from "./polling-controller.js";

// -- Helpers --

function makeHost(): {
  host: ReactiveControllerHost;
  controllers: unknown[];
  requestUpdate: ReturnType<typeof vi.fn>;
} {
  const controllers: unknown[] = [];
  const requestUpdate = vi.fn();
  const host: ReactiveControllerHost = {
    addController(c: unknown): void {
      controllers.push(c);
    },
    removeController: vi.fn(),
    requestUpdate,
    updateComplete: Promise.resolve(true),
  };
  return { host, controllers, requestUpdate };
}

function makeRpc(responses: {
  agentList?: unknown;
  channelList?: unknown;
  sessionList?: unknown;
  throwOn?: string;
}): RpcClient {
  return {
    async call<T>(method: string): Promise<T> {
      if (responses.throwOn === method) {
        throw new Error("rpc failure");
      }
      if (method === "agent.list") return (responses.agentList ?? { agents: [] }) as T;
      if (method === "channel.list") return (responses.channelList ?? { channels: [] }) as T;
      if (method === "session.list")
        return (responses.sessionList ?? { sessions: [], total: 0 }) as T;
      throw new Error(`unexpected method: ${method}`);
    },
  } as unknown as RpcClient;
}

describe("PollingController", () => {
  let setIntervalSpy: ReturnType<typeof vi.spyOn>;
  let clearIntervalSpy: ReturnType<typeof vi.spyOn>;
  let scheduledCallbacks: Array<() => void>;

  beforeEach(() => {
    scheduledCallbacks = [];
    // Capture the callback so we can invoke it manually — no fake timers.
    setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockImplementation(((
      cb: () => void,
    ): unknown => {
      scheduledCallbacks.push(cb);
      return Symbol("timer-handle") as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval);
    clearIntervalSpy = vi.spyOn(globalThis, "clearInterval").mockImplementation(() => {});
  });

  afterEach(() => {
    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });

  it("registers itself with the host element via addController on construction", () => {
    const { host, controllers } = makeHost();
    const ctrl = new PollingController(host, makeRpc({}), () => {});
    expect(controllers).toContain(ctrl);
  });

  it("schedules a setInterval callback on hostConnected with the configured interval ms", () => {
    const { host } = makeHost();
    const ctrl = new PollingController(host, makeRpc({}), () => {}, 5_000);
    ctrl.hostConnected();
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy.mock.calls[0]![1]).toBe(5_000);
  });

  it("does not duplicate polling when hostConnected is called twice", async () => {
    const { host } = makeHost();
    const onData = vi.fn();
    const ctrl = new PollingController(host, makeRpc({}), onData);

    ctrl.hostConnected();
    ctrl.hostConnected();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(onData).toHaveBeenCalledTimes(1);
  });

  it("performs an immediate poll on hostConnected before the first interval fires", async () => {
    const { host } = makeHost();
    const onData = vi.fn();
    const ctrl = new PollingController(
      host,
      makeRpc({
        agentList: { agents: ["a1", "a2"] },
        channelList: { channels: [{}, {}, {}] },
        sessionList: { sessions: [], total: 5 },
      }),
      onData,
    );
    ctrl.hostConnected();
    await new Promise((r) => setTimeout(r, 0));
    expect(onData).toHaveBeenCalledTimes(1);
    expect(onData).toHaveBeenCalledWith(
      expect.objectContaining({ agents: 2, channels: 3, sessions: 5 }),
    );
  });

  it("emits the raw agentIds array so command-palette search can resolve agent names", async () => {
    const { host } = makeHost();
    const onData = vi.fn();
    new PollingController(
      host,
      makeRpc({
        agentList: { agents: ["alpha", "beta"] },
        channelList: { channels: [] },
        sessionList: { sessions: [], total: 0 },
      }),
      onData,
    ).hostConnected();
    await new Promise((r) => setTimeout(r, 0));
    expect(onData.mock.calls[0]![0].agentIds).toEqual(["alpha", "beta"]);
  });

  it("truncates session entries to the first 20 to bound command-palette payload size", async () => {
    const sessions = Array.from({ length: 50 }, (_, i) => ({
      sessionKey: `s${i}`,
      agentId: "a",
    }));
    const { host } = makeHost();
    const onData = vi.fn();
    new PollingController(
      host,
      makeRpc({
        agentList: { agents: [] },
        channelList: { channels: [] },
        sessionList: { sessions, total: sessions.length },
      }),
      onData,
    ).hostConnected();
    await new Promise((r) => setTimeout(r, 0));
    expect(onData.mock.calls[0]![0].sessionEntries).toHaveLength(20);
    expect(onData.mock.calls[0]![0].sessionEntries[0].sessionKey).toBe("s0");
  });

  it("defaults sessionEntries to empty array when session.list omits the sessions field", async () => {
    const { host } = makeHost();
    const onData = vi.fn();
    new PollingController(
      host,
      makeRpc({
        sessionList: { total: 0 },
      }),
      onData,
    ).hostConnected();
    await new Promise((r) => setTimeout(r, 0));
    expect(onData.mock.calls[0]![0].sessionEntries).toEqual([]);
  });

  it("requests host re-render via requestUpdate after a successful poll cycle", async () => {
    const { host, requestUpdate } = makeHost();
    new PollingController(host, makeRpc({}), () => {}).hostConnected();
    await new Promise((r) => setTimeout(r, 0));
    expect(requestUpdate).toHaveBeenCalled();
  });

  it("swallows RPC failures silently so badge counts retain stale data (non-fatal branch)", async () => {
    const { host, requestUpdate } = makeHost();
    const onData = vi.fn();
    new PollingController(
      host,
      makeRpc({ throwOn: "agent.list" }),
      onData,
    ).hostConnected();
    await new Promise((r) => setTimeout(r, 0));
    expect(onData).not.toHaveBeenCalled();
    expect(requestUpdate).not.toHaveBeenCalled();
  });

  it("clears the scheduled interval on hostDisconnected to prevent leak after unmount", () => {
    const { host } = makeHost();
    const ctrl = new PollingController(host, makeRpc({}), () => {});
    ctrl.hostConnected();
    ctrl.hostDisconnected();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
  });

  it("ignores hostDisconnected when no timer was scheduled to avoid clearing null handle", () => {
    const { host } = makeHost();
    const ctrl = new PollingController(host, makeRpc({}), () => {});
    ctrl.hostDisconnected();
    expect(clearIntervalSpy).not.toHaveBeenCalled();
  });

  it("invokes the captured interval callback to re-poll on subsequent ticks", async () => {
    const { host } = makeHost();
    const onData = vi.fn();
    new PollingController(host, makeRpc({}), onData).hostConnected();
    await new Promise((r) => setTimeout(r, 0));
    expect(onData).toHaveBeenCalledTimes(1);
    // Manually invoke the captured interval callback to simulate the next tick.
    scheduledCallbacks[0]?.();
    await new Promise((r) => setTimeout(r, 0));
    expect(onData).toHaveBeenCalledTimes(2);
  });

  it("uses the default 30_000ms interval when no explicit interval is supplied", () => {
    const { host } = makeHost();
    const ctrl = new PollingController(host, makeRpc({}), () => {});
    ctrl.hostConnected();
    expect(setIntervalSpy.mock.calls[0]![1]).toBe(30_000);
  });
});
