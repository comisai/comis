// SPDX-License-Identifier: Apache-2.0
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ContextStorePort } from "@comis/core";
import { ok } from "@comis/shared";
import type { CronRuntimeExecutionInput } from "@comis/scheduler";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
import { resolveCronTurnIdentity } from "./cron-root-registrar.js";
import { createCronSessionPolicy } from "./cron-session-policy.js";

const NOW_MS = 1_800_000_000_000;

function input(strategy: "fresh" | "rolling" = "rolling"):
Extract<CronRuntimeExecutionInput, { kind: "agent_turn" }> {
  return {
    executionId: "11111111-1111-4111-8111-111111111111",
    scheduledForMs: NOW_MS,
    trigger: "scheduled",
    kind: "agent_turn",
    rootRunId: "root-cron-11111111-1111-4111-8111-111111111111",
    job: {
      id: "job-a",
      name: "Status",
      agentId: "agent-a",
      source: "authored",
      schedule: { kind: "every", everyMs: 60_000, anchorMs: NOW_MS },
      lifecycle: { status: "scheduled", nextRunAtMs: NOW_MS + 60_000, consecutiveDependencyErrors: 0 },
      payload: { kind: "agent_turn", message: "status" },
      sessionPolicy: strategy === "fresh"
        ? { strategy: "fresh" }
        : { strategy: "rolling", maxHistoryTurns: 2 },
      continuationMode: "none",
    },
  };
}

function user(sm: SessionManager, text: string): void {
  sm.appendMessage({ role: "user", content: text, timestamp: 1 } as never);
}

function assistant(sm: SessionManager, text: string): void {
  sm.appendMessage({
    role: "assistant",
    content: [{ type: "text", text }],
    api: "messages",
    provider: "example",
    model: "test-model",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: 2,
  } as never);
}

function makeStore(): ContextStorePort & { rows: Array<{ role: string; parts: unknown[] }> } {
  const rows: Array<{ role: string; parts: unknown[] }> = [];
  let cursor: { epochAnchor: string; ingestedLiveLen: number } | null = null;
  return {
    rows,
    append: vi.fn((entry) => rows.push({ role: entry.role, parts: entry.parts })),
    getMessages: vi.fn(() => rows.map((row, index) => ({
      id: `message-${index}`,
      conversationRef: "cv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      seq: index,
      role: row.role,
      tokenCount: 1,
      createdAt: NOW_MS,
      parts: row.parts,
    })) as never),
    runOnConversation: vi.fn(async (_ref, fn) => fn()),
    deleteConversationLcd: vi.fn(() => { const count = rows.length; rows.splice(0); cursor = null; return count; }),
    getIngestCursor: vi.fn(() => cursor),
    upsertIngestCursor: vi.fn((_scope, next) => { cursor = next; }),
  } as unknown as ContextStorePort & { rows: Array<{ role: string; parts: unknown[] }> };
}

function makeDeps() {
  const sm = SessionManager.inMemory("/tmp/test-workspace");
  user(sm, "user-1"); assistant(sm, "assistant-1");
  user(sm, "user-2"); assistant(sm, "assistant-2");
  user(sm, "user-3"); assistant(sm, "assistant-3");
  const adapter = {
    withSession: vi.fn(async (_sessionKey, fn) => ok(await fn(sm))),
    destroySession: vi.fn(async () => undefined),
  };
  return {
    tenantId: "tenant-a",
    clock: createFakeClock(NOW_MS),
    contextStore: makeStore(),
    piSessionAdapters: new Map([["agent-a", adapter]]),
    logger: {
      debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn(), audit: vi.fn(),
    } as never,
    _sm: sm,
    _adapter: adapter,
  };
}

describe("cron synthetic session policy", () => {
  beforeEach(() => vi.clearAllMocks());

  it("bounds the real active SDK branch and canonical LCD before and after rolling turns", async () => {
    const deps = makeDeps();
    const policy = createCronSessionPolicy(deps);
    const requestInput = input("rolling");
    const identity = resolveCronTurnIdentity("tenant-a", requestInput.job);
    if (!identity.ok) throw identity.error;
    const request = {
      input: requestInput,
      sessionKey: identity.value.displaySessionKey,
      signal: new AbortController().signal,
    };

    expect(await policy.before(request)).toEqual(ok(undefined));
    expect(deps._sm.buildSessionContext().messages).toHaveLength(4);
    expect(deps.contextStore.rows).toHaveLength(4);

    user(deps._sm, "user-4");
    assistant(deps._sm, "assistant-4");
    expect(await policy.after(request)).toEqual(ok(undefined));
    const visible = deps._sm.buildSessionContext().messages.map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content.map((part) => "text" in part ? part.text : "").join(""));
    expect(visible).toEqual(["user-3", "assistant-3", "user-4", "assistant-4"]);
    expect(deps.contextStore.rows).toHaveLength(4);
    expect(deps._adapter.withSession).toHaveBeenCalledTimes(2);
  });

  it("fresh policy deletes both stores before the model and leaves the settled turn intact afterward", async () => {
    const deps = makeDeps();
    deps.contextStore.rows.push({ role: "user", parts: [] });
    const policy = createCronSessionPolicy(deps);
    const requestInput = input("fresh");
    const identity = resolveCronTurnIdentity("tenant-a", requestInput.job);
    if (!identity.ok) throw identity.error;
    const request = { input: requestInput, sessionKey: identity.value.displaySessionKey, signal: new AbortController().signal };

    expect(await policy.before(request)).toEqual(ok(undefined));
    expect(deps._adapter.destroySession).toHaveBeenCalledWith(identity.value.displaySessionKey);
    expect(deps.contextStore.rows).toHaveLength(0);

    expect(await policy.after(request)).toEqual(ok(undefined));
    expect(deps._adapter.destroySession).toHaveBeenCalledTimes(1);
  });

  it("fails closed before model dispatch when the owning SDK adapter is missing", async () => {
    const deps = makeDeps();
    deps.piSessionAdapters.clear();
    const policy = createCronSessionPolicy(deps);
    const requestInput = input("rolling");
    const identity = resolveCronTurnIdentity("tenant-a", requestInput.job);
    if (!identity.ok) throw identity.error;

    const result = await policy.before({
      input: requestInput,
      sessionKey: identity.value.displaySessionKey,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({ ok: false, error: { code: "precondition_failed", errorKind: "precondition" } });
  });
});
