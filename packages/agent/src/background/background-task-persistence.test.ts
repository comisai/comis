// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createConversationRef, safePath } from "@comis/core";
import {
  persistTaskSync,
  persistTaskAtomically,
  loadTask,
  recoverTasks,
  removeTaskFile,
  TASK_DIR_NAME,
} from "./background-task-persistence.js";
import type { BackgroundTaskOrigin, PersistedTaskState } from "./background-task-types.js";

function buildOrigin(overrides: Partial<BackgroundTaskOrigin> & { agentId?: string } = {}): BackgroundTaskOrigin {
  const agentId = overrides.agentId ?? "default";
  const endpoint = { channelType: "echo", channelInstanceId: "test-instance", conversationId: "test", conversationKind: "direct" as const };
  const turnScope = { conversation: { tenantId: "default", agentId, partition: { kind: "endpoint-conversation-principal" as const, endpoint, principalId: "user1" } }, principal: { principalId: "user1" }, endpoint };
  const conversationRef = createConversationRef(turnScope.conversation);
  if (!conversationRef.ok) throw conversationRef.error;
  return {
    turnScope,
    conversationRef: conversationRef.value,
    deliveryOrigin: { channelType: "echo", channelId: "test", userId: "user1", tenantId: "default" },
    traceId: null,
    responseLocalePolicy: { source: "unset", enforceLocale: false },
    backgroundHopCount: 0,
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "agentId")),
  };
}

describe("background-task-persistence", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = safePath(tmpdir(), `comis-bg-test-${randomUUID()}`);
    mkdirSync(dataDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("exports TASK_DIR_NAME constant", () => {
    expect(TASK_DIR_NAME).toBe("background-tasks");
  });

  describe("persistTaskSync / loadTask round-trip", () => {
    it.each(["write", "sync", "rename"] as const)(
      "preserves the prior durable task when atomic %s fails",
      (failure) => {
        const prior: PersistedTaskState = {
          id: "atomic-task",
          toolName: "exec_command",
          status: "completed",
          startedAt: 1,
          completedAt: 2,
          origin: buildOrigin({ agentId: "agent-a" }),
          continuationExecutionId: "execution-a",
          dispatchAttempts: 0,
          dispatchState: "pending",
        };
        persistTaskSync(dataDir, prior);
        const attempted = persistTaskAtomically(
          dataDir,
          { ...prior, dispatchState: "ready_to_deliver" },
          {
            open: openSync,
            write: (fd, content) => {
              if (failure === "write") throw new Error("injected write failure");
              writeFileSync(fd, content);
            },
            sync: (fd) => {
              if (failure === "sync") throw new Error("injected sync failure");
              fsyncSync(fd);
            },
            close: closeSync,
            rename: (from, to) => {
              if (failure === "rename") throw new Error("injected rename failure");
              renameSync(from, to);
            },
            unlink: unlinkSync,
          },
        );
        expect(attempted.ok).toBe(false);
        expect(loadTask(dataDir, "agent-a", prior.id)?.dispatchState).toBe("pending");
      },
    );

    it("returns the directory fsync failure after bounded retries", () => {
      const prior: PersistedTaskState = {
        id: "atomic-directory-task",
        toolName: "exec_command",
        status: "completed",
        startedAt: 1,
        completedAt: 2,
        origin: buildOrigin({ agentId: "agent-a" }),
        continuationExecutionId: "execution-directory",
        dispatchAttempts: 0,
        dispatchState: "pending",
      };
      persistTaskSync(dataDir, prior);
      const directoryDescriptors = new Set<number>();
      const attempted = persistTaskAtomically(
        dataDir,
        { ...prior, dispatchState: "ready_to_deliver" },
        {
          open: (path, flags, mode) => {
            const fd = openSync(path, flags, mode);
            if (flags === "r") directoryDescriptors.add(fd);
            return fd;
          },
          write: writeFileSync,
          sync: (fd) => {
            if (directoryDescriptors.has(fd)) throw new Error("injected directory sync failure");
            fsyncSync(fd);
          },
          close: closeSync,
          rename: renameSync,
          unlink: unlinkSync,
        },
      );
      expect(attempted.ok).toBe(false);
      if (attempted.ok) return;
      expect(attempted.error.message).toBe("injected directory sync failure");
      expect(loadTask(dataDir, "agent-a", prior.id)?.dispatchState).toBe("ready_to_deliver");
    });

    it("commits atomically when the Node permission model disables fsync", () => {
      const prior: PersistedTaskState = {
        id: "atomic-permission-model-task",
        toolName: "web_fetch",
        status: "running",
        startedAt: 1,
        origin: buildOrigin({ agentId: "agent-a" }),
        continuationExecutionId: "execution-permission-model",
        dispatchAttempts: 0,
        dispatchState: "pending",
      };
      persistTaskSync(dataDir, prior);
      const fsyncUnavailable = Object.assign(
        new Error("fsync API is disabled when Permission Model is enabled."),
        { code: "ERR_ACCESS_DENIED", permission: "", resource: "" },
      );

      const attempted = persistTaskAtomically(
        dataDir,
        { ...prior, dispatchState: "ready_to_deliver" },
        {
          open: openSync,
          write: writeFileSync,
          sync: () => {
            throw fsyncUnavailable;
          },
          close: closeSync,
          rename: renameSync,
          unlink: unlinkSync,
        },
      );

      expect(attempted.ok).toBe(true);
      if (!attempted.ok) return;
      expect(attempted.value.kind).toBe("committed_without_fsync");
      expect(loadTask(dataDir, "agent-a", prior.id)?.dispatchState).toBe("ready_to_deliver");
    });

    it("writes and reads back a task", () => {
      const task: PersistedTaskState = {
        id: "task-1",
        toolName: "exec_command",
        status: "running",
        startedAt: 1000,
        origin: buildOrigin({ agentId: "agent-a" }),
      };
      persistTaskSync(dataDir, task);
      const loaded = loadTask(dataDir, "agent-a", "task-1");
      expect(loaded).toEqual(task);
    });

    it("creates nested agent directory", () => {
      const task: PersistedTaskState = {
        id: "task-2",
        toolName: "web_fetch",
        status: "running",
        startedAt: 2000,
        origin: buildOrigin({ agentId: "nested-agent" }),
      };
      persistTaskSync(dataDir, task);
      expect(existsSync(safePath(safePath(dataDir, "nested-agent"), "task-2.json"))).toBe(true);
    });

    it("returns undefined for missing task", () => {
      expect(loadTask(dataDir, "no-agent", "no-task")).toBeUndefined();
    });
  });

  describe("recoverTasks", () => {
    it("marks running tasks as failed with recovery message", () => {
      const running: PersistedTaskState = {
        id: "t1",
        toolName: "tool1",
        status: "running",
        startedAt: 1000,
        origin: buildOrigin({ agentId: "a1" }),
        continuationExecutionId: "t1",
        dispatchAttempts: 0,
      };
      const completed: PersistedTaskState = {
        id: "t2",
        toolName: "tool2",
        status: "completed",
        startedAt: 1000,
        completedAt: 2000,
        result: "done",
        origin: buildOrigin({ agentId: "a1" }),
        continuationExecutionId: "t2",
        dispatchAttempts: 0,
      };
      persistTaskSync(dataDir, running);
      persistTaskSync(dataDir, completed);

      const recovered = recoverTasks(dataDir);
      expect(recovered.tasks).toHaveLength(2);

      const t1 = recovered.tasks.find((t) => t.id === "t1");
      expect(t1?.status).toBe("running");
      expect(t1?.error).toBeUndefined();
      expect(t1?.completedAt).toBeUndefined();

      const t2 = recovered.tasks.find((t) => t.id === "t2");
      expect(t2?.status).toBe("completed");
    });

    it("handles multiple agent directories", () => {
      persistTaskSync(dataDir, {
        id: "t1",
        toolName: "tool1",
        status: "running",
        startedAt: 1000,
        origin: buildOrigin({ agentId: "a1" }),
        continuationExecutionId: "t1",
        dispatchAttempts: 0,
      });
      persistTaskSync(dataDir, {
        id: "t2",
        toolName: "tool2",
        status: "running",
        startedAt: 2000,
        origin: buildOrigin({ agentId: "a2" }),
        continuationExecutionId: "t2",
        dispatchAttempts: 0,
      });

      const recovered = recoverTasks(dataDir);
      expect(recovered.tasks).toHaveLength(2);
      expect(recovered.tasks.every((t) => t.status === "running")).toBe(true);
    });

    it("returns an empty scan for a nonexistent dataDir", () => {
      const recovered = recoverTasks(`/tmp/nonexistent-${randomUUID()}`);
      expect(recovered).toEqual({ tasks: [], failures: [] });
    });

    it("returns a closed read failure and recovers on the next scan", () => {
      persistTaskSync(dataDir, {
        id: "transient-read",
        toolName: "exec",
        status: "completed",
        startedAt: 1,
        completedAt: 2,
        origin: buildOrigin({ agentId: "a1" }),
        continuationExecutionId: "transient-read",
        dispatchAttempts: 0,
        dispatchState: "delivered",
      });
      let failRead = true;
      const ops = {
        readdir: readdirSync,
        stat: statSync,
        read: (path: string) => {
          if (failRead) {
            failRead = false;
            throw new Error("injected read failure");
          }
          return readFileSync(path, "utf-8");
        },
      };

      expect(recoverTasks(dataDir, ops)).toEqual({
        tasks: [],
        failures: [{ kind: "task_read" }],
      });
      expect(recoverTasks(dataDir, ops).tasks).toEqual([
        expect.objectContaining({ id: "transient-read" }),
      ]);
    });

    it("preserves recovery status on disk for the manager owner", () => {
      persistTaskSync(dataDir, {
        id: "t1",
        toolName: "tool1",
        status: "running",
        startedAt: 1000,
        origin: buildOrigin({ agentId: "a1" }),
        continuationExecutionId: "t1",
        dispatchAttempts: 0,
      });
      recoverTasks(dataDir);

      const raw = readFileSync(safePath(safePath(dataDir, "a1"), "t1.json"), "utf-8");
      const onDisk = JSON.parse(raw) as PersistedTaskState;
      expect(onDisk.status).toBe("running");
    });

    it("reports files missing durable task identity", () => {
      // Write a completely malformed file (no id or toolName)
      const agentDir = safePath(dataDir, "bad-agent");
      mkdirSync(agentDir, { recursive: true });
      const filePath = safePath(agentDir, "malformed.json");
      writeFileSync(filePath, JSON.stringify({ status: "running", startedAt: 1000 }, null, 2), "utf-8");

      const recovered = recoverTasks(dataDir);
      expect(recovered.tasks).toEqual([]);
      expect(recovered.failures).toEqual([{ kind: "task_validation" }]);
    });

    it("reports tasks whose origin lacks canonical turn authority", () => {
      const agentDir = safePath(dataDir, "default");
      mkdirSync(agentDir, { recursive: true });
      const filePath = safePath(agentDir, "stale-origin.json");
      writeFileSync(filePath, JSON.stringify({
        id: "stale-origin",
        toolName: "exec",
        status: "completed",
        startedAt: 1000,
        completedAt: 2000,
        origin: {
          agentId: "default",
          sessionKey: "default:echo:test:user1",
          channelType: "echo",
          channelId: "test",
          traceId: null,
          backgroundHopCount: 0,
        },
      }, null, 2), "utf-8");

      expect(recoverTasks(dataDir)).toEqual({
        tasks: [],
        failures: [{ kind: "task_validation" }],
      });
    });

    it("skips non-directory entries in dataDir without losing legitimate agent tasks", () => {
      // Create a legitimate agent directory with one task.
      const task: PersistedTaskState = {
        id: "wr-04-task",
        toolName: "exec",
        status: "completed",
        startedAt: 1000,
        completedAt: 2000,
        result: "ok",
        origin: buildOrigin({ agentId: "real-agent" }),
        continuationExecutionId: "wr-04-task",
        dispatchAttempts: 0,
      };
      persistTaskSync(dataDir, task);

      // Create a stale file in dataDir alongside the agent directory.
      // Simulates a lock file, README, or accidental top-level file
      // (readdirSync(safePath(dataDir, "stale.lock")) would throw ENOTDIR).
      const stalePath = safePath(dataDir, "stale.lock");
      writeFileSync(stalePath, "not-a-directory", "utf-8");

      // Recovery must return the legitimate task.
      const recovered = recoverTasks(dataDir);
      expect(recovered.tasks).toHaveLength(1);
      expect(recovered.tasks[0]!.id).toBe("wr-04-task");
      expect(recovered.tasks[0]!.origin.turnScope.conversation.agentId).toBe("real-agent");

      // The stale file is untouched.
      expect(existsSync(stalePath)).toBe(true);
      expect(readFileSync(stalePath, "utf-8")).toBe("not-a-directory");
    });

    it("empty dataDir with only stale files returns empty array (no throw)", () => {
      // dataDir contains ONLY non-directory entries — no agent dirs at all.
      writeFileSync(safePath(dataDir, "lock1"), "x", "utf-8");
      writeFileSync(safePath(dataDir, "lock2"), "y", "utf-8");

      const recovered = recoverTasks(dataDir);
      expect(recovered).toEqual({ tasks: [], failures: [] });
    });
  });

  describe("removeTaskFile", () => {
    it("deletes an existing task file", () => {
      const task: PersistedTaskState = {
        id: "del-1",
        toolName: "tool",
        status: "completed",
        startedAt: 1000,
        completedAt: 2000,
        origin: buildOrigin({ agentId: "a1" }),
      };
      persistTaskSync(dataDir, task);
      expect(existsSync(safePath(safePath(dataDir, "a1"), "del-1.json"))).toBe(true);

      removeTaskFile(dataDir, "a1", "del-1");
      expect(existsSync(safePath(safePath(dataDir, "a1"), "del-1.json"))).toBe(false);
    });

    it("silently ignores missing files", () => {
      expect(() => removeTaskFile(dataDir, "a1", "nonexistent")).not.toThrow();
    });
  });

  describe("background-task-persistence file/dir mode invariants", () => {
    it("creates the per-agent parent directory with mode 0o700 on persistTaskSync", () => {
      const task: PersistedTaskState = {
        id: "mode-task-1",
        toolName: "exec",
        status: "running",
        startedAt: 1000,
        origin: buildOrigin({ agentId: "mode-agent" }),
      };
      persistTaskSync(dataDir, task);

      const agentDir = safePath(dataDir, "mode-agent");
      expect(statSync(agentDir).mode & 0o777).toBe(0o700);
    });

    it("writes task JSON files with mode 0o600 on persistTaskSync", () => {
      const task: PersistedTaskState = {
        id: "mode-task-file",
        toolName: "exec",
        status: "running",
        startedAt: 1000,
        origin: buildOrigin({ agentId: "mode-agent-file" }),
      };
      persistTaskSync(dataDir, task);

      const filePath = safePath(safePath(dataDir, "mode-agent-file"), "mode-task-file.json");
      expect(statSync(filePath).mode & 0o777).toBe(0o600);
    });

    it("preserves mode 0o600 after recovery rewrites a running task to failed", () => {
      const running: PersistedTaskState = {
        id: "mode-recovery",
        toolName: "exec",
        status: "running",
        startedAt: 1000,
        origin: buildOrigin({ agentId: "mode-recover-agent" }),
      };
      persistTaskSync(dataDir, running);
      recoverTasks(dataDir);

      const filePath = safePath(safePath(dataDir, "mode-recover-agent"), "mode-recovery.json");
      expect(statSync(filePath).mode & 0o777).toBe(0o600);
    });
  });

  describe("persistTaskSync persists dispatchState", () => {
    it("round-trips a ready protected outbox through the BackgroundTask path", () => {
      // Use the BackgroundTask path (object has _promise) to exercise
      // toPersistedState — the helper that strips unknown fields. Because
      // dispatchState is part of PersistedTaskState + toPersistedState, the
      // field survives the round-trip.
      const taskRecord: Record<string, unknown> = {
        id: "task-disp-1",
        toolName: "exec",
        status: "completed",
        startedAt: 1,
        completedAt: 2,
        origin: buildOrigin({ agentId: "agent-disp" }),
        dispatchState: "ready_to_deliver",
        continuationExecutionId: "task-disp-1",
        dispatchAttempts: 1,
        continuationOutbox: {
          kind: "continuation",
          response: "exact response",
          executionId: "execution-a",
          idempotencyKey: "continuation-a",
          deliveryProtection: "ledger",
        },
        _promise: Promise.resolve(),
      };
      // Cast through unknown so the test file stays buildable.
      persistTaskSync(
        dataDir,
        taskRecord as unknown as import("./background-task-types.js").BackgroundTask,
      );

      const filePath = safePath(safePath(dataDir, "agent-disp"), "task-disp-1.json");
      const onDisk = JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>;
      // PersistedTaskState carries dispatchState, so the round-trip preserves it.
      expect(onDisk.dispatchState).toBe("ready_to_deliver");
      expect(onDisk.continuationOutbox).toEqual(taskRecord.continuationOutbox);
    });
  });
});
