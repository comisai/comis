// SPDX-License-Identifier: Apache-2.0
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  auditChatConversation,
  readJsonlEvidence,
} from "./conversation-audit.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeLiveSessionLayout(options: { chatId?: string; threadId?: string } = {}) {
  const dataDir = mkdtempSync(resolve(tmpdir(), "comis-conversation-audit-"));
  temporaryDirectories.push(dataDir);
  const chatId = options.chatId ?? "678314278";
  const sessionDirectory = resolve(
    dataDir,
    "workspace",
    "sessions",
    "default",
    `telegram@3atelegram-bot@3a${chatId}`,
  );
  mkdirSync(sessionDirectory, { recursive: true });
  const sessionFile = resolve(
    sessionDirectory,
    "platform_sender~peer~platform_sender.jsonl",
  );
  const trajectoryFile = `${sessionFile}.trajectory.jsonl`;
  const sessionId = "default:default:telegram:peer:platform_sender"
    + (options.threadId === undefined ? "" : `:thread:${options.threadId}`);
  writeFileSync(
    sessionFile,
    `${JSON.stringify({ role: "user", content: "שלום" })}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    trajectoryFile,
    [
      {
        type: "approval.requested",
        traceId: "trace_ok",
        ts: "2026-08-07T16:47:00.000Z",
        data: { requestId: "approval_ok" },
      },
      {
        type: "approval.resolved",
        traceId: "trace_ok",
        ts: "2026-08-07T16:47:01.000Z",
        data: { requestId: "approval_ok", approved: true },
      },
      {
        type: "model.completed",
        traceId: "trace_ok",
        ts: "2026-08-07T16:47:02.000Z",
        data: { promptTokens: 200, completionTokens: 20 },
      },
    ].map((record) => JSON.stringify(record)).join("\n") + "\n",
    { mode: 0o600 },
  );
  writeFileSync(
    `${sessionFile}.trajectory-path.json`,
    `${JSON.stringify({
      traceSchema: "comis-trajectory-pointer",
      schemaVersion: 1,
      sessionId,
      runtimeFile: trajectoryFile,
    })}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    sessionFile.replace(/\.jsonl$/, "~ledger~inbound.jsonl"),
    `${JSON.stringify({
      customType: "comis.inbound-message-provenance",
      data: {
        messages: [{ channelId: chatId, channelType: "telegram" }],
      },
    })}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    sessionFile.replace(/\.jsonl$/, "_session-metadata.json"),
    `${JSON.stringify({ sessionKey: sessionId, updatedAt: 1 })}\n`,
    { mode: 0o600 },
  );
  return { dataDir, sessionFile, trajectoryFile, sessionId };
}

describe("live conversation audit assembly", () => {
  it("drives the real nested session resolver and reconciles all evidence lenses", async () => {
    const layout = makeLiveSessionLayout();
    const loadedRefs: string[] = [];
    const output = await auditChatConversation({
      dataDir: layout.dataDir,
      chatId: "678314278",
      contract: {
        expectedLocale: "he",
        forbiddenSurfaceTexts: ["Background work is still running"],
        budgets: { maxModelCalls: 2, maxInputTokens: 1_000, maxCostUsd: 1 },
      },
      loadWireRecords: async () => [
        {
          method: "sendMessage",
          messageId: 71,
          text: "נדרש אישור",
          replyMarkup: {
            inline_keyboard: [[{ text: "אישור", callback_data: "capability" }]],
          },
        },
        {
          method: "editMessageText",
          messageId: 71,
          text: "אושר",
          replyMarkup: { inline_keyboard: [] },
        },
      ],
      loadIncidentReport: async (sessionId) => {
        loadedRefs.push(sessionId);
        return { cost: { costUsd: 0.02 }, failures: [] };
      },
    });

    expect(loadedRefs).toEqual([layout.sessionId]);
    expect(output.artifacts).toEqual({
      sessionFile: layout.sessionFile,
      trajectoryFile: layout.trajectoryFile,
      sessionId: layout.sessionId,
    });
    expect(output.report).toMatchObject({
      verdict: "pass",
      metrics: { modelCalls: 1, inputTokens: 200, costUsd: 0.02 },
    });
  });

  it("isolates a forum thread session and its thread-bound wire records", async () => {
    const layout = makeLiveSessionLayout({ chatId: "-1001234567890", threadId: "101" });
    const output = await auditChatConversation({
      dataDir: layout.dataDir,
      chatId: "-1001234567890",
      threadId: "101",
      contract: {
        expectedLocale: "en",
        forbiddenSurfaceTexts: ["CROSS_THREAD_MARKER"],
      },
      loadWireRecords: async () => [
        {
          method: "sendMessage",
          messageId: 71,
          messageThreadId: 101,
          text: "OWN_THREAD_MARKER",
        },
        {
          method: "editMessageText",
          messageId: 71,
          text: "OWN_THREAD_MARKER_DONE",
        },
        {
          method: "sendMessage",
          messageId: 72,
          messageThreadId: 102,
          text: "CROSS_THREAD_MARKER",
        },
        {
          method: "deleteMessage",
          messageId: 72,
        },
      ],
      loadIncidentReport: async () => ({ cost: { costUsd: 0 }, failures: [] }),
    });

    expect(output.artifacts.sessionId).toBe(layout.sessionId);
    expect(output.report).toMatchObject({ verdict: "pass", violations: [] });
  });

  it("fails closed when a JSONL evidence line is malformed", () => {
    const dataDir = mkdtempSync(resolve(tmpdir(), "comis-conversation-jsonl-"));
    temporaryDirectories.push(dataDir);
    const evidenceFile = resolve(dataDir, "evidence.jsonl");
    writeFileSync(evidenceFile, "{\"type\":\"model.completed\"}\n{broken\n", { mode: 0o600 });

    expect(() => readJsonlEvidence(evidenceFile)).toThrow(
      "evidence.jsonl contains malformed JSON on line 2",
    );
  });

  it("reports trajectory-only coverage for a terminal keyless pre-model turn", async () => {
    const layout = makeLiveSessionLayout();
    rmSync(layout.sessionFile);
    const traceId = "trace_keyless";
    writeFileSync(
      layout.trajectoryFile,
      [
        { type: "prompt.submitted", traceId, ts: "2026-08-07T16:47:00.000Z", data: {} },
        {
          type: "session.summary",
          traceId,
          ts: "2026-08-07T16:47:01.000Z",
          data: { degraded: true, turnCount: 0, endReason: "error" },
        },
        {
          type: "delivery.dispatched",
          traceId,
          ts: "2026-08-07T16:47:02.000Z",
          data: {
            origin: "agent-runtime-failure",
            status: "success",
            totalChunks: 1,
            deliveredChunks: 1,
            failedChunks: 0,
          },
        },
        {
          type: "activity.turn_finalized",
          traceId,
          ts: "2026-08-07T16:47:03.000Z",
          data: { outcome: "failure", errorKind: "auth" },
        },
      ].map((record) => JSON.stringify(record)).join("\n") + "\n",
      { mode: 0o600 },
    );

    const output = await auditChatConversation({
      dataDir: layout.dataDir,
      chatId: "678314278",
      loadWireRecords: async () => [{ method: "sendMessage", messageId: 71, text: "auth failed" }],
      loadIncidentReport: async () => ({ cost: { costUsd: 0 }, failures: [] }),
    });

    expect(output.report).toMatchObject({
      verdict: "pass",
      coverage: { sessionEvidence: "trajectory_only_pre_model_failure" },
      violations: [],
    });
  });
});
