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

function makeLiveSessionLayout() {
  const dataDir = mkdtempSync(resolve(tmpdir(), "comis-conversation-audit-"));
  temporaryDirectories.push(dataDir);
  const sessionDirectory = resolve(
    dataDir,
    "workspace",
    "sessions",
    "default",
    "telegram@3atelegram-bot@3a678314278",
  );
  mkdirSync(sessionDirectory, { recursive: true });
  const sessionFile = resolve(
    sessionDirectory,
    "platform_sender~peer~platform_sender.jsonl",
  );
  const trajectoryFile = `${sessionFile}.trajectory.jsonl`;
  const sessionId = "default:default:telegram:peer:platform_sender";
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
        messages: [{ channelId: "678314278", channelType: "telegram" }],
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

  it("fails closed when a JSONL evidence line is malformed", () => {
    const dataDir = mkdtempSync(resolve(tmpdir(), "comis-conversation-jsonl-"));
    temporaryDirectories.push(dataDir);
    const evidenceFile = resolve(dataDir, "evidence.jsonl");
    writeFileSync(evidenceFile, "{\"type\":\"model.completed\"}\n{broken\n", { mode: 0o600 });

    expect(() => readJsonlEvidence(evidenceFile)).toThrow(
      "evidence.jsonl contains malformed JSON on line 2",
    );
  });

  it("reports missing model-session evidence as a hard coverage failure on keyless turns", async () => {
    const layout = makeLiveSessionLayout();
    rmSync(layout.sessionFile);

    const output = await auditChatConversation({
      dataDir: layout.dataDir,
      chatId: "678314278",
      loadWireRecords: async () => [{ method: "sendMessage", messageId: 71, text: "auth failed" }],
      loadIncidentReport: async () => ({ cost: { costUsd: 0 }, failures: [] }),
    });

    expect(output.report.verdict).toBe("fail");
    expect(output.report.violations).toContainEqual(expect.objectContaining({
      code: "session_evidence_empty",
      severity: "hard",
    }));
  });
});
