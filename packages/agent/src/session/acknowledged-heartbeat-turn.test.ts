// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { pruneAcknowledgedHeartbeatTurn } from "./acknowledged-heartbeat-turn.js";

function makeSessionManager(): SessionManager {
  return SessionManager.create(join(mkdtempSync(join(tmpdir(), "heartbeat-prune-")), "session.jsonl"));
}

describe("acknowledged heartbeat session maintenance", () => {
  it("removes only the newest complete user and assistant turn", () => {
    const manager = makeSessionManager();
    manager.appendMessage({ role: "user", content: "older request", timestamp: 1 });
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "older response" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "test-model",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: 2,
    });
    manager.appendMessage({ role: "user", content: "heartbeat prompt", timestamp: 3 });
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "HEARTBEAT_OK" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "test-model",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: 4,
    });

    expect(pruneAcknowledgedHeartbeatTurn(manager)).toEqual({ ok: true, value: undefined });
    expect(manager.getBranch().filter((entry) => entry.type === "message").map((entry) => entry.message.role)).toEqual([
      "user",
      "assistant",
    ]);
  });

  it("fails closed when the newest user turn has no assistant response", () => {
    const manager = makeSessionManager();
    manager.appendMessage({ role: "user", content: "incomplete heartbeat", timestamp: 1 });

    expect(pruneAcknowledgedHeartbeatTurn(manager)).toMatchObject({
      ok: false,
      error: { errorKind: "precondition" },
    });
    expect(manager.getBranch().filter((entry) => entry.type === "message")).toHaveLength(1);
  });
});
