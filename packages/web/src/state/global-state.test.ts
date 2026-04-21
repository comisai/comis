// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { createGlobalState, type GlobalState } from "./global-state.js";

describe("createGlobalState", () => {
  it("returns object with subscribe, getSnapshot, update, and default field values", () => {
    const state = createGlobalState();

    expect(typeof state.subscribe).toBe("function");
    expect(typeof state.getSnapshot).toBe("function");
    expect(typeof state.update).toBe("function");
    expect(state.connectionStatus).toBeDefined();
    expect(state.pendingApprovals).toBeDefined();
    expect(state.errorCount).toBeDefined();
  });

  it("default snapshot has correct initial values", () => {
    const state = createGlobalState();
    const snapshot = state.getSnapshot();

    expect(snapshot.connectionStatus).toBe("disconnected");
    expect(snapshot.pendingApprovals).toBe(0);
    expect(snapshot.errorCount).toBe(0);
    expect(snapshot.systemHealth).toBeNull();
    expect(snapshot.activeAgents).toEqual([]);
    expect(snapshot.activeChannels).toEqual([]);
  });

  it("update merges partial state into snapshot", () => {
    const state = createGlobalState();

    state.update({ connectionStatus: "connected" });

    expect(state.connectionStatus).toBe("connected");
    expect(state.getSnapshot().connectionStatus).toBe("connected");
  });

  it("update notifies all subscribers", () => {
    const state = createGlobalState();
    const handler1 = vi.fn();
    const handler2 = vi.fn();

    state.subscribe(handler1);
    state.subscribe(handler2);

    state.update({ pendingApprovals: 3 });

    expect(handler1).toHaveBeenCalledTimes(1);
    expect(handler2).toHaveBeenCalledTimes(1);
  });

  it("subscribe returns unsubscribe function", () => {
    const state = createGlobalState();
    const handler = vi.fn();

    const unsubscribe = state.subscribe(handler);
    expect(typeof unsubscribe).toBe("function");

    unsubscribe();
    state.update({ errorCount: 5 });

    expect(handler).not.toHaveBeenCalled();
  });

  it("unsubscribe prevents further notifications", () => {
    const state = createGlobalState();
    const handler = vi.fn();

    const unsubscribe = state.subscribe(handler);

    state.update({ connectionStatus: "connected" });
    expect(handler).toHaveBeenCalledTimes(1);

    unsubscribe();

    state.update({ connectionStatus: "disconnected" });
    expect(handler).toHaveBeenCalledTimes(1); // Still 1, not 2
  });

  it("multiple subscribers all receive notifications", () => {
    const state = createGlobalState();
    const handlers = [vi.fn(), vi.fn(), vi.fn()];

    for (const h of handlers) {
      state.subscribe(h);
    }

    state.update({ pendingApprovals: 1 });

    for (const h of handlers) {
      expect(h).toHaveBeenCalledOnce();
    }
  });

  it("getSnapshot returns frozen object (immutable)", () => {
    const state = createGlobalState();
    const snapshot = state.getSnapshot();

    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it("sequential updates accumulate correctly", () => {
    const state = createGlobalState();

    state.update({ connectionStatus: "connected" });
    state.update({ pendingApprovals: 5 });
    state.update({ errorCount: 2 });

    const snapshot = state.getSnapshot();
    expect(snapshot.connectionStatus).toBe("connected");
    expect(snapshot.pendingApprovals).toBe(5);
    expect(snapshot.errorCount).toBe(2);
  });

  it("partial update preserves unmodified fields", () => {
    const state = createGlobalState();

    const agents = [
      { id: "a1", provider: "openai", model: "gpt-4", status: "active" },
    ];

    state.update({
      connectionStatus: "connected",
      activeAgents: agents,
      pendingApprovals: 3,
    });

    // Update only one field
    state.update({ errorCount: 1 });

    const snapshot = state.getSnapshot();
    expect(snapshot.connectionStatus).toBe("connected");
    expect(snapshot.activeAgents).toEqual(agents);
    expect(snapshot.pendingApprovals).toBe(3);
    expect(snapshot.errorCount).toBe(1);
  });

  it("update with systemHealth object works correctly", () => {
    const state = createGlobalState();

    const health = {
      uptime: 3600,
      memoryUsage: 0.45,
      eventLoopDelay: 1.2,
      nodeVersion: "20.10.0",
    };

    state.update({ systemHealth: health });

    expect(state.systemHealth).toEqual(health);
    expect(state.getSnapshot().systemHealth).toEqual(health);
  });

  it("update with activeChannels array works correctly", () => {
    const state = createGlobalState();

    const channels = [
      { type: "discord", name: "main", enabled: true, status: "healthy" as const },
      { type: "telegram", name: "bot", enabled: false, status: "disconnected" as const },
    ];

    state.update({ activeChannels: channels });

    expect(state.activeChannels).toEqual(channels);
  });

  it("getSnapshot returns a new object each call", () => {
    const state = createGlobalState();

    const snap1 = state.getSnapshot();
    const snap2 = state.getSnapshot();

    expect(snap1).toEqual(snap2);
    expect(snap1).not.toBe(snap2); // Different object references
  });

  it("direct property getters reflect updates", () => {
    const state: GlobalState = createGlobalState();

    expect(state.connectionStatus).toBe("disconnected");

    state.update({ connectionStatus: "connected" });
    expect(state.connectionStatus).toBe("connected");

    state.update({ pendingApprovals: 7 });
    expect(state.pendingApprovals).toBe(7);
  });
});
