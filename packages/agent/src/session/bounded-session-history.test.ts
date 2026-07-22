// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { retainLastCompleteUserTurns } from "./bounded-session-history.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempSessionPath(): string {
  const root = mkdtempSync(join(tmpdir(), "bounded-session-history-"));
  tempDirs.push(root);
  return join(root, "workspace", "sessions", "tenant-a", "scheduler", "job-a.jsonl");
}

function user(sm: SessionManager, text: string): string {
  return sm.appendMessage({ role: "user", content: text, timestamp: 1 } as never);
}

function assistant(sm: SessionManager, text: string): string {
  return sm.appendMessage({
    role: "assistant",
    content: [{ type: "text", text }],
    api: "messages",
    provider: "example",
    model: "test-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 2,
  } as never);
}

function roles(sm: SessionManager): string[] {
  return sm.getBranch()
    .filter((entry) => entry.type === "message")
    .map((entry) => entry.type === "message" ? entry.message.role : "");
}

function visibleTexts(sm: SessionManager): string[] {
  return sm.buildSessionContext().messages.map((message) => {
    if (typeof message.content === "string") return message.content;
    return message.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("");
  });
}

describe("bounded active SDK session history", () => {
  it("retains only the last complete user-led turns including their tool messages", () => {
    const sm = SessionManager.inMemory("/tmp/test-workspace");
    user(sm, "user-1");
    assistant(sm, "assistant-1");
    user(sm, "user-2");
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "call-2", name: "read", arguments: {} }],
      api: "messages",
      provider: "example",
      model: "test-model",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse",
      timestamp: 2,
    } as never);
    sm.appendMessage({
      role: "toolResult",
      toolCallId: "call-2",
      toolName: "read",
      content: [{ type: "text", text: "result-2" }],
      isError: false,
      timestamp: 3,
    } as never);
    assistant(sm, "assistant-2");
    user(sm, "user-3");
    assistant(sm, "assistant-3");
    user(sm, "incomplete-user-4");

    const result = retainLastCompleteUserTurns(sm, 2);

    expect(result).toEqual({ ok: true, value: { retainedTurns: 2, removedEntries: 3 } });
    expect(roles(sm)).toEqual(["user", "assistant", "toolResult", "assistant", "user", "assistant"]);
    expect(visibleTexts(sm)).toEqual(expect.arrayContaining(["user-2", "result-2", "assistant-2", "user-3", "assistant-3"]));
    expect(visibleTexts(sm)).not.toEqual(expect.arrayContaining(["user-1", "incomplete-user-4"]));
  });

  it("keeps only the selected active branch and is idempotent", () => {
    const sm = SessionManager.inMemory("/tmp/test-workspace");
    user(sm, "root-user");
    const rootAssistant = assistant(sm, "root-assistant");
    user(sm, "abandoned-user");
    assistant(sm, "abandoned-assistant");
    sm.branch(rootAssistant);
    user(sm, "active-user");
    assistant(sm, "active-assistant");

    const first = retainLastCompleteUserTurns(sm, 1);
    const snapshot = JSON.stringify(sm.getEntries());
    const second = retainLastCompleteUserTurns(sm, 1);

    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: true, value: { retainedTurns: 1, removedEntries: 0 } });
    expect(JSON.stringify(sm.getEntries())).toBe(snapshot);
    expect(visibleTexts(sm)).toEqual(["active-user", "active-assistant"]);
  });

  it("persists the bounded branch through a real nested-layout reopen", () => {
    const path = tempSessionPath();
    const sm = SessionManager.open(path, join(path, ".."));
    user(sm, "user-1");
    assistant(sm, "assistant-1");
    user(sm, "user-2");
    assistant(sm, "assistant-2");
    user(sm, "user-3");
    assistant(sm, "assistant-3");

    expect(retainLastCompleteUserTurns(sm, 2).ok).toBe(true);

    const reopened = SessionManager.open(path, join(path, ".."));
    expect(visibleTexts(reopened)).toEqual(["user-2", "assistant-2", "user-3", "assistant-3"]);
    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain("user-1");
    expect(raw).toContain("user-2");
  });

  it("rejects an invalid history bound without mutating the session", () => {
    const sm = SessionManager.inMemory("/tmp/test-workspace");
    user(sm, "user-1");
    assistant(sm, "assistant-1");
    const before = JSON.stringify(sm.getEntries());

    expect(retainLastCompleteUserTurns(sm, 0)).toEqual({
      ok: false,
      error: { errorKind: "validation", message: "History turn bound must be between 1 and 20" },
    });
    expect(JSON.stringify(sm.getEntries())).toBe(before);
  });
});
