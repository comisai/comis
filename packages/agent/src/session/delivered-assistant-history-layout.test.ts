// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertToLlm, type SessionManager } from "@earendil-works/pi-coding-agent";
import {
  conversationScopeToSessionKey,
  createConversationLocator,
  createFileLock,
  formatSessionKey,
  type ConversationScope,
} from "@comis/core";
import { writeTrajectoryPointerFileBestEffort } from "@comis/observability";
import { afterEach, describe, expect, it } from "vitest";
import { createComisSessionManager } from "./comis-session-manager.js";
import { createDeliveredAssistantHistoryAdapter } from "./delivered-assistant-history.js";
import { repairOrphanedMessages } from "./orphaned-message-repair.js";
import { projectPendingDeliveredAssistantHistory } from "./pending-delivered-assistant-history.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function appendAssistant(sessionManager: SessionManager, text: string, timestamp: number): void {
  sessionManager.appendMessage({
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
    timestamp,
  } as never);
}

describe("delivered assistant history in the production session layout", () => {
  it("persists and projects one role-neutral delivery through the real resolver and SDK path", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "comis-delivered-history-layout-"));
    directories.push(dataDir);
    const workspaceDir = join(dataDir, "workspace");
    const sessionBaseDir = join(workspaceDir, "sessions");
    const scope: ConversationScope = {
      tenantId: "tenant_a",
      agentId: "agent_a",
      partition: {
        kind: "endpoint-conversation",
        endpoint: {
          channelType: "telegram",
          channelInstanceId: "telegram_primary",
          conversationId: "chat_a",
          conversationKind: "direct",
        },
      },
    };
    const locator = createConversationLocator(scope);
    const key = conversationScopeToSessionKey(scope);
    if (!locator.ok || !key.ok) throw new Error("test conversation authority is invalid");
    const formattedKey = formatSessionKey(key.value);
    const manager = createComisSessionManager({
      sessionBaseDir,
      lockDir: join(workspaceDir, ".locks"),
      cwd: workspaceDir,
      dataDir,
      fileLock: createFileLock(),
    });

    const initialWrite = await manager.withSession(key.value, async (sdk) => {
      sdk.appendMessage({ role: "user", content: "initial request", timestamp: 1 } as never);
      appendAssistant(sdk, "ordinary assistant response", 2);
    });
    expect(initialWrite.ok).toBe(true);
    const sessionFile = manager.getSessionPath(key.value);
    expect(sessionFile).toBe(join(
      dataDir,
      "workspace",
      "sessions",
      "tenant_a",
      "telegram@3atelegram_primary@3achat_a",
      "conversation.jsonl",
    ));
    expect(statSync(sessionFile).mode & 0o777).toBe(0o600);
    const runtimeFile = `${sessionFile}.trajectory.jsonl`;
    writeFileSync(runtimeFile, "", { mode: 0o600 });
    writeTrajectoryPointerFileBestEffort({ sessionFile, sessionId: formattedKey, runtimeFile });
    manager.writeSessionMetadata(key.value, {
      traceId: "trace-layout",
      runId: "run-layout",
      sessionKey: formattedKey,
    });
    const metadataFile = sessionFile.replace(/\.jsonl$/u, "_session-metadata.json");
    const pointerFile = `${sessionFile}.trajectory-path.json`;
    expect(existsSync(pointerFile)).toBe(true);
    expect(existsSync(metadataFile)).toBe(true);
    expect(statSync(pointerFile).mode & 0o777).toBe(0o600);
    expect(statSync(metadataFile).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(pointerFile, "utf8"))).toMatchObject({
      traceSchema: "comis-trajectory-pointer",
      schemaVersion: 1,
      sessionId: formattedKey,
      runtimeFile,
    });
    expect(JSON.parse(readFileSync(metadataFile, "utf8"))).toMatchObject({
      traceId: "trace-layout",
      runId: "run-layout",
      sessionKey: formattedKey,
    });

    const adapter = createDeliveredAssistantHistoryAdapter({
      resolveSessionManager: (agentId) => agentId === "agent_a" ? manager : undefined,
      isAccepting: () => true,
    });
    const input = {
      conversation: locator.value,
      deliveredText: "scheduled output already seen by the user",
      sourceExecutionId: "execution_layout",
      attemptId: "attempt_layout",
      lastPlatformMessageId: "message_layout",
      deliveredAtMs: 1_700_000_000_000,
    };
    await expect(adapter.append(input)).resolves.toEqual({ ok: true, value: "appended" });
    await expect(adapter.append(input)).resolves.toEqual({ ok: true, value: "already_present" });
    await expect(adapter.append({ ...input, deliveredText: "conflicting output" })).resolves.toMatchObject({
      ok: false,
      error: { code: "conflict", errorKind: "precondition" },
    });

    const projected = await manager.withSession(key.value, async (sdk) => {
      const repair = repairOrphanedMessages(sdk);
      const sdkMessages = sdk.buildSessionContext().messages;
      const providerMessages = convertToLlm(sdkMessages);
      const projection = projectPendingDeliveredAssistantHistory(sdk, locator.value);
      return { repair, sdkMessages, providerMessages, projection };
    });
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(projected.value.repair.repaired).toBe(false);
    expect(JSON.stringify(projected.value.sdkMessages)).not.toContain(input.deliveredText);
    expect(JSON.stringify(projected.value.providerMessages)).not.toContain(input.deliveredText);
    expect(projected.value.projection).toMatchObject({
      ok: true,
      value: { diagnostics: { projectedEntries: 1 } },
    });
    expect(projected.value.projection.ok && projected.value.projection.value.compiledContext)
      .toContain(input.deliveredText);
    expect(projected.value.projection.ok && projected.value.projection.value.compiledContext)
      .toContain("not a new user request");

    const ordinaryTurn = await manager.withSession(key.value, async (sdk) => {
      sdk.appendMessage({ role: "user", content: "next request", timestamp: 3 } as never);
      appendAssistant(sdk, "next ordinary assistant response", 4);
      return projectPendingDeliveredAssistantHistory(sdk, locator.value);
    });
    expect(ordinaryTurn).toMatchObject({
      ok: true,
      value: {
        ok: true,
        value: { compiledContext: "", diagnostics: { projectedEntries: 0 } },
      },
    });
  });
});
