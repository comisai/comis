// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { safePath } from "@comis/core";
import {
  persistTaskSync,
  loadTask,
  recoverTasks,
  removeTaskFile,
  TASK_DIR_NAME,
} from "./background-task-persistence.js";
import type { BackgroundTaskOrigin, PersistedTaskState } from "./background-task-types.js";

function buildOrigin(overrides: Partial<BackgroundTaskOrigin> = {}): BackgroundTaskOrigin {
  return {
    agentId: "default",
    sessionKey: "default:echo:test:user1",
    channelType: "echo",
    channelId: "test",
    traceId: null,
    backgroundHopCount: 0,
    ...overrides,
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
      };
      const completed: PersistedTaskState = {
        id: "t2",
        toolName: "tool2",
        status: "completed",
        startedAt: 1000,
        completedAt: 2000,
        result: "done",
        origin: buildOrigin({ agentId: "a1" }),
      };
      persistTaskSync(dataDir, running);
      persistTaskSync(dataDir, completed);

      const recovered = recoverTasks(dataDir);
      expect(recovered).toHaveLength(2);

      const t1 = recovered.find((t) => t.id === "t1");
      expect(t1?.status).toBe("failed");
      expect(t1?.error).toBe("Daemon restarted while task was running");
      expect(t1?.completedAt).toBeGreaterThan(0);

      const t2 = recovered.find((t) => t.id === "t2");
      expect(t2?.status).toBe("completed");
    });

    it("handles multiple agent directories", () => {
      persistTaskSync(dataDir, {
        id: "t1",
        toolName: "tool1",
        status: "running",
        startedAt: 1000,
        origin: buildOrigin({ agentId: "a1" }),
      });
      persistTaskSync(dataDir, {
        id: "t2",
        toolName: "tool2",
        status: "running",
        startedAt: 2000,
        origin: buildOrigin({ agentId: "a2" }),
      });

      const recovered = recoverTasks(dataDir);
      expect(recovered).toHaveLength(2);
      expect(recovered.every((t) => t.status === "failed")).toBe(true);
    });

    it("returns empty array for nonexistent dataDir", () => {
      const recovered = recoverTasks(`/tmp/nonexistent-${randomUUID()}`);
      expect(recovered).toEqual([]);
    });

    it("persists recovery status change to disk", () => {
      persistTaskSync(dataDir, {
        id: "t1",
        toolName: "tool1",
        status: "running",
        startedAt: 1000,
        origin: buildOrigin({ agentId: "a1" }),
      });
      recoverTasks(dataDir);

      // Verify the file on disk was updated
      const raw = readFileSync(safePath(safePath(dataDir, "a1"), "t1.json"), "utf-8");
      const onDisk = JSON.parse(raw) as PersistedTaskState;
      expect(onDisk.status).toBe("failed");
    });

    it("skips files missing id or toolName (sanity guard)", () => {
      // Write a completely malformed file (no id or toolName)
      const agentDir = safePath(dataDir, "bad-agent");
      mkdirSync(agentDir, { recursive: true });
      const filePath = safePath(agentDir, "malformed.json");
      writeFileSync(filePath, JSON.stringify({ status: "running", startedAt: 1000 }, null, 2), "utf-8");

      const recovered = recoverTasks(dataDir);
      // Malformed file is skipped
      expect(recovered.find((t) => t.id === undefined)).toBeUndefined();
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
});
