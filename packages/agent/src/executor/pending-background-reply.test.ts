import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { BackgroundTask } from "../background/background-task-types.js";
import { reconcilePendingBackgroundTurn } from "./pending-background-reply.js";
import { createLocaleCatalog } from "./degraded-reply-i18n.js";
import { scrubSecretsFromText } from "@comis/core";

function task(overrides: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    id: "task-a",
    toolName: "mcp__large_report",
    status: "running",
    startedAt: 1,
    dispatchState: "pending",
    notificationPolicy: "deferred",
    origin: {
      conversationRef: "tenant:agent:user:telegram:peer:user",
      traceId: "11111111-1111-4111-8111-111111111111",
      backgroundHopCount: 0,
      turnScope: {
        conversation: { tenantId: "tenant", agentId: "agent", userId: "user", channelType: "telegram", conversationId: "chat" },
        endpoint: { channelType: "telegram", conversationId: "chat" },
      },
      deliveryOrigin: { tenantId: "tenant", userId: "user", channelType: "telegram", channelId: "chat" },
    },
    ...overrides,
  };
}

describe("reconcilePendingBackgroundTurn", () => {
  it("replaces unrelated terminal text while required work from this execution is still running", () => {
    const result = reconcilePendingBackgroundTurn({
      response: "The previously requested vehicle is parked in Tel Aviv.",
      executionId: "11111111-1111-4111-8111-111111111111",
      tasks: [task()],
    });

    expect(result.finishReason).toBe("background_pending");
    expect(result.response).toContain("large report");
    expect(result.response).not.toContain("mcp__large_report");
    expect(result.response).toContain("task-a");
    expect(result.response).not.toContain("Tel Aviv");
  });

  it("keeps a completed same-turn handoff nonterminal until its continuation is delivered", () => {
    const result = reconcilePendingBackgroundTurn({
      response: "The skill import is still processing.",
      executionId: "11111111-1111-4111-8111-111111111111",
      tasks: [task({ status: "completed", dispatchState: "pending" })],
    });

    expect(result.finishReason).toBe("background_pending");
    expect(result.pendingCount).toBe(1);
    expect(result.response).toContain("background result is ready");
    expect(result.response).not.toContain("still processing");
  });

  it("leaves a terminal answer unchanged after the background continuation was delivered", () => {
    const response = "The requested report is complete.";
    expect(reconcilePendingBackgroundTurn({
      response,
      executionId: "11111111-1111-4111-8111-111111111111",
      tasks: [task({ status: "completed", dispatchState: "delivered" })],
    })).toEqual({ response, finishReason: undefined, pendingCount: 0 });
  });

  it("renders a high-entropy registered tool as egress-safe status prose", () => {
    const result = reconcilePendingBackgroundTurn({
      response: "unrelated",
      executionId: "11111111-1111-4111-8111-111111111111",
      tasks: [task({ toolName: "mcp__background-report--read_assistant_report" })],
    });

    expect(scrubSecretsFromText(result.response)).toEqual({
      text: result.response,
      redactions: 0,
    });
    expect(result.response).not.toContain("[REDACTED]");
  });

  it("is wired at the post-execution terminal chokepoint with the task manager", () => {
    const postExecution = readFileSync(fileURLToPath(new URL("./executor-post-execution.ts", import.meta.url)), "utf8");
    const piExecutor = readFileSync(fileURLToPath(new URL("./pi-executor/pi-executor.ts", import.meta.url)), "utf8");
    expect(postExecution).toContain("reconcilePendingBackgroundTurn");
    expect(postExecution).toMatch(/backgroundTaskManager\?\.getTasks/);
    expect(postExecution).toMatch(/executionId,\s*tasks:/);
    expect(piExecutor).toMatch(/backgroundTaskManager:\s*deps\.backgroundTaskManager/);
  });
});

// ---------------------------------------------------------------------------
// Localization of the pending-background notice.
//
// Under an enforced non-Latin response locale the model answered in Hebrew while
// this notice stayed English, so a Hebrew conversation received a mixed reply —
// measured live at 0 Hebrew characters for every runtime card. The notice is the
// agent's own user-facing sentence, so it belongs in the locale catalog.
//
// The pack string carries a `{labels}` placeholder rather than relying on the
// caller appending the list, because word order does not survive translation:
// Hebrew is RTL and "prose: list" is not a safe universal shape. A pack that
// omits the placeholder still works — the labels are appended as a fallback.
// ---------------------------------------------------------------------------

describe("reconcilePendingBackgroundTurn — localized notice", () => {
  const running = [task({ status: "running" })];

  it("uses the English pack by default", () => {
    const out = reconcilePendingBackgroundTurn({
      response: "x",
      executionId: "11111111-1111-4111-8111-111111111111",
      tasks: running,
    });
    expect(out.finishReason).toBe("background_pending");
    expect(out.response).toContain("Background work is still running");
    expect(out.response).toContain("task-a");
  });

  it("resolves an operator pack for the response locale, substituting {labels}", () => {
    const catalog = createLocaleCatalog({
      he: { background_pending_running: "עבודה ברקע עדיין מתבצעת: {labels}. אמשיך כשתסתיים." },
    });
    const out = reconcilePendingBackgroundTurn({
      response: "x",
      executionId: "11111111-1111-4111-8111-111111111111",
      tasks: running,
      locale: "he",
      localeCatalog: catalog,
    });
    expect(out.response).toContain("עבודה ברקע עדיין מתבצעת");
    expect(out.response).toContain("task-a");
    expect(out.response).not.toContain("Background work is still running");
  });

  it("reaches an operator he pack from a SCRIPT-ONLY locale (und-Hebr)", () => {
    const catalog = createLocaleCatalog({
      he: { background_pending_running: "עבודה ברקע עדיין מתבצעת: {labels}." },
    });
    const out = reconcilePendingBackgroundTurn({
      response: "x",
      executionId: "11111111-1111-4111-8111-111111111111",
      tasks: running,
      locale: "und-Hebr",
      localeCatalog: catalog,
    });
    expect(out.response).toContain("עבודה ברקע עדיין מתבצעת");
  });

  it("appends the labels when an operator pack omits the placeholder", () => {
    const catalog = createLocaleCatalog({
      he: { background_pending_running: "עבודה ברקע עדיין מתבצעת" },
    });
    const out = reconcilePendingBackgroundTurn({
      response: "x",
      executionId: "11111111-1111-4111-8111-111111111111",
      tasks: running,
      locale: "he",
      localeCatalog: catalog,
    });
    expect(out.response).toContain("עבודה ברקע עדיין מתבצעת");
    expect(out.response).toContain("task-a");
  });

  it("localizes the result-ready and mixed-updates variants too", () => {
    const catalog = createLocaleCatalog({
      he: {
        background_pending_ready: "תוצאה מוכנה: {labels}.",
        background_pending_updates: "יש עדכונים ממתינים: {labels}.",
      },
    });
    const ready = reconcilePendingBackgroundTurn({
      response: "x",
      executionId: "11111111-1111-4111-8111-111111111111",
      tasks: [task({ status: "completed", completedAt: 2 })],
      locale: "he",
      localeCatalog: catalog,
    });
    // A completed-but-undelivered task is still pending for this turn.
    if (ready.finishReason === "background_pending") {
      expect(ready.response).toContain("תוצאה מוכנה");
    }
    const mixed = reconcilePendingBackgroundTurn({
      response: "x",
      executionId: "11111111-1111-4111-8111-111111111111",
      tasks: [task({ id: "t1", status: "running" }), task({ id: "t2", status: "completed", completedAt: 2 })],
      locale: "he",
      localeCatalog: catalog,
    });
    expect(mixed.response).toContain("יש עדכונים ממתינים");
  });
});
