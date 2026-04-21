// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  persistTaskSync,
  loadTask,
  recoverTasks,
  removeTaskFile,
  TASK_DIR_NAME,
} from "./background-task-persistence.js";
import type { PersistedTaskState } from "./background-task-types.js";

describe("background-task-persistence", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = join(tmpdir(), `comis-bg-test-${randomUUID()}`);
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
        agentId: "agent-a",
        toolName: "exec_command",
        status: "running",
        startedAt: 1000,
      };
      persistTaskSync(dataDir, task);
      const loaded = loadTask(dataDir, "agent-a", "task-1");
      expect(loaded).toEqual(task);
    });

    it("creates nested agent directory", () => {
      const task: PersistedTaskState = {
        id: "task-2",
        agentId: "nested-agent",
        toolName: "web_fetch",
        status: "running",
        startedAt: 2000,
      };
      persistTaskSync(dataDir, task);
      expect(existsSync(join(dataDir, "nested-agent", "task-2.json"))).toBe(true);
    });

    it("returns undefined for missing task", () => {
      expect(loadTask(dataDir, "no-agent", "no-task")).toBeUndefined();
    });
  });

  describe("recoverTasks", () => {
    it("marks running tasks as failed with recovery message", () => {
      const running: PersistedTaskState = {
        id: "t1",
        agentId: "a1",
        toolName: "tool1",
        status: "running",
        startedAt: 1000,
      };
      const completed: PersistedTaskState = {
        id: "t2",
        agentId: "a1",
        toolName: "tool2",
        status: "completed",
        startedAt: 1000,
        completedAt: 2000,
        result: "done",
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
        agentId: "a1",
        toolName: "tool1",
        status: "running",
        startedAt: 1000,
      });
      persistTaskSync(dataDir, {
        id: "t2",
        agentId: "a2",
        toolName: "tool2",
        status: "running",
        startedAt: 2000,
      });

      const recovered = recoverTasks(dataDir);
      expect(recovered).toHaveLength(2);
      expect(recovered.every((t) => t.status === "failed")).toBe(true);
    });

    it("returns empty array for nonexistent dataDir", () => {
      const recovered = recoverTasks("/tmp/nonexistent-" + randomUUID());
      expect(recovered).toEqual([]);
    });

    it("persists recovery status change to disk", () => {
      persistTaskSync(dataDir, {
        id: "t1",
        agentId: "a1",
        toolName: "tool1",
        status: "running",
        startedAt: 1000,
      });
      recoverTasks(dataDir);

      // Verify the file on disk was updated
      const raw = readFileSync(join(dataDir, "a1", "t1.json"), "utf-8");
      const onDisk = JSON.parse(raw) as PersistedTaskState;
      expect(onDisk.status).toBe("failed");
    });
  });

  describe("removeTaskFile", () => {
    it("deletes an existing task file", () => {
      const task: PersistedTaskState = {
        id: "del-1",
        agentId: "a1",
        toolName: "tool",
        status: "completed",
        startedAt: 1000,
        completedAt: 2000,
      };
      persistTaskSync(dataDir, task);
      expect(existsSync(join(dataDir, "a1", "del-1.json"))).toBe(true);

      removeTaskFile(dataDir, "a1", "del-1");
      expect(existsSync(join(dataDir, "a1", "del-1.json"))).toBe(false);
    });

    it("silently ignores missing files", () => {
      expect(() => removeTaskFile(dataDir, "a1", "nonexistent")).not.toThrow();
    });
  });
});
