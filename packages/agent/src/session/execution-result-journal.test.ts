// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createFileLock, safePath, type SessionKey } from "@comis/core";
import { createComisSessionManager } from "./comis-session-manager.js";
import {
  appendExecutionResultJournal,
  readExecutionResultJournal,
} from "./execution-result-journal.js";

describe("execution result journal restart recovery", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories) {
      rmSync(directory, { recursive: true, force: true });
    }
    directories.length = 0;
  });

  it("reopens the exact finalized result through a fresh session manager", async () => {
    const root = mkdtempSync(safePath(tmpdir(), "comis-execution-journal-"));
    directories.push(root);
    const sessionBaseDir = safePath(root, "sessions");
    const lockDir = safePath(root, "locks");
    const sessionKey: SessionKey = {
      tenantId: "default",
      userId: "user_a",
      channelId: "telegram:chat_a",
      agentId: "agent_a",
    };
    const firstManager = createComisSessionManager({
      sessionBaseDir,
      lockDir,
      cwd: root,
      fileLock: createFileLock(),
    });

    const appended = await firstManager.withSession(sessionKey, async (sdk) => {
      sdk.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "completed turn" }],
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
        timestamp: 1,
      } as never);
      return appendExecutionResultJournal(sdk, {
        journalKey: "continuation-a",
        executionId: "execution-a",
        response: "exact finalized response",
      });
    });
    expect(appended).toEqual({ ok: true, value: { ok: true, value: undefined } });

    const restartedManager = createComisSessionManager({
      sessionBaseDir,
      lockDir,
      cwd: root,
      fileLock: createFileLock(),
    });
    await expect(readExecutionResultJournal(
      restartedManager,
      sessionKey,
      "continuation-a",
    )).resolves.toEqual({
      ok: true,
      value: {
        journalKey: "continuation-a",
        executionId: "execution-a",
        response: "exact finalized response",
      },
    });
  });
});
