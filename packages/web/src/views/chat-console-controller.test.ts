// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import type { ReactiveControllerHost } from "lit";
import { createMockRpcClient } from "../test-support/mock-rpc-client.js";
import { createChatConsoleController } from "./chat-console-controller.js";

function makeHost(): ReactiveControllerHost & { _updates: number } {
  return {
    _updates: 0,
    addController: vi.fn(),
    removeController: vi.fn(),
    requestUpdate(): void {
      (this as { _updates: number })._updates += 1;
    },
    updateComplete: Promise.resolve(true),
  } as unknown as ReactiveControllerHost & { _updates: number };
}

describe("ChatConsoleController", () => {
  it("listSessions: returns session.list rpc response", async () => {
    const host = makeHost();
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      const method = args[0] as string;
      if (method === "session.list") {
        return {
          sessions: [
            { sessionKey: "s1", agentId: "a1", channelId: "web:1", kind: "dm", updatedAt: 1, messageCount: 0 },
            { sessionKey: "s2", agentId: "a2", channelId: "telegram:1", kind: "dm", updatedAt: 2, messageCount: 5 },
          ],
        };
      }
      return {};
    });
    const controller = createChatConsoleController(host, rpc);
    const sessions = await controller.listSessions();
    expect(sessions.length).toBe(2);
    expect(sessions[0]!.sessionKey).toBe("s1");
  });

  it("listSessions: returns empty array when rpc returns no sessions", async () => {
    const host = makeHost();
    const rpc = createMockRpcClient(async () => ({}));
    const controller = createChatConsoleController(host, rpc);
    const sessions = await controller.listSessions();
    expect(sessions).toEqual([]);
  });

  it("loadSessionHistory: returns session.history messages", async () => {
    const host = makeHost();
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      const method = args[0] as string;
      if (method === "session.history") {
        return { messages: [{ id: "m1", role: "user" as const, content: "hi", timestamp: 1 }] };
      }
      return {};
    });
    const controller = createChatConsoleController(host, rpc);
    const messages = await controller.loadSessionHistory("session-1");
    expect(messages.length).toBe(1);
    expect(messages[0]!.role).toBe("user");
  });

  it("loadLatestPipelineSnapshot: returns first snapshot or null", async () => {
    const host = makeHost();
    let mode: "with" | "empty" = "with";
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      const method = args[0] as string;
      if (method === "obs.context.pipeline") {
        return mode === "with"
          ? { snapshots: [{ tokensLoaded: 100, budgetUtilization: 0.5 }] }
          : { snapshots: [] };
      }
      return {};
    });
    const controller = createChatConsoleController(host, rpc);
    let snap = await controller.loadLatestPipelineSnapshot("default");
    expect(snap?.tokensLoaded).toBe(100);
    mode = "empty";
    snap = await controller.loadLatestPipelineSnapshot("default");
    expect(snap).toBeNull();
  });

  it("transcribeAudio: returns audio.transcribe text", async () => {
    const host = makeHost();
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      const method = args[0] as string;
      if (method === "audio.transcribe") return { text: "hello world" };
      return {};
    });
    const controller = createChatConsoleController(host, rpc);
    const text = await controller.transcribeAudio("base64data", "webm");
    expect(text).toBe("hello world");
  });

  it("resetSession / compactSession / exportSession: invoke matching rpc methods", async () => {
    const host = makeHost();
    const calls: string[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      const method = args[0] as string;
      calls.push(method);
      if (method === "session.export") return { data: "data" };
      return {};
    });
    const controller = createChatConsoleController(host, rpc);
    await controller.resetSession("session-1");
    await controller.compactSession("session-1");
    const exported = await controller.exportSession("session-1");
    expect(calls).toEqual(["session.reset", "session.compact", "session.export"]);
    expect(exported).toBe("data");
  });

  it("status / onStatusChange / onNotification: passthrough to rpcClient", () => {
    const host = makeHost();
    const rpc = createMockRpcClient();
    const controller = createChatConsoleController(host, rpc);
    expect(controller.status).toBe("connected");
    const unsubStatus = controller.onStatusChange(() => undefined);
    const unsubNotif = controller.onNotification(() => undefined);
    expect(typeof unsubStatus).toBe("function");
    expect(typeof unsubNotif).toBe("function");
    expect(rpc.onStatusChange).toHaveBeenCalled();
    expect(rpc.onNotification).toHaveBeenCalled();
  });
});
