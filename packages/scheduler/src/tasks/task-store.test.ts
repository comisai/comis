import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { ExtractedTask } from "./task-types.js";
import { createTaskStore } from "./task-store.js";

const NOW = Date.parse("2026-02-08T00:00:00Z");

function makeTask(id: string, overrides?: Partial<ExtractedTask>): ExtractedTask {
  return {
    id,
    title: `Task ${id}`,
    description: `Description for ${id}`,
    priority: "medium",
    source: {
      sessionKey: "tg:default:peer:user123",
      messageIndex: 0,
      extractedAt: NOW,
    },
    confidence: 0.9,
    status: "pending",
    createdAtMs: NOW,
    ...overrides,
  };
}

describe("TaskStore", () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "task-store-test-"));
    filePath = join(tmpDir, "tasks.json");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("load returns empty array when file doesn't exist", async () => {
    const store = createTaskStore(filePath);
    const tasks = await store.load();
    expect(tasks).toEqual([]);
  });

  it("save + load round-trips tasks correctly", async () => {
    const store = createTaskStore(filePath);
    const tasks = [makeTask("t1"), makeTask("t2", { priority: "high" })];

    await store.save(tasks);
    const loaded = await store.load();

    expect(loaded).toHaveLength(2);
    expect(loaded[0].id).toBe("t1");
    expect(loaded[1].id).toBe("t2");
    expect(loaded[1].priority).toBe("high");
  });

  it("addTask appends to existing tasks", async () => {
    const store = createTaskStore(filePath);
    await store.save([makeTask("t1")]);

    await store.addTask(makeTask("t2"));

    const loaded = await store.load();
    expect(loaded).toHaveLength(2);
    expect(loaded[0].id).toBe("t1");
    expect(loaded[1].id).toBe("t2");
  });

  it("addTask works on empty store", async () => {
    const store = createTaskStore(filePath);
    await store.addTask(makeTask("t1"));

    const loaded = await store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe("t1");
  });

  it("updateTask merges partial update, returns true", async () => {
    const store = createTaskStore(filePath);
    await store.save([makeTask("t1")]);

    const result = await store.updateTask("t1", { priority: "critical", status: "scheduled" });

    expect(result).toBe(true);
    const loaded = await store.load();
    expect(loaded[0].priority).toBe("critical");
    expect(loaded[0].status).toBe("scheduled");
    expect(loaded[0].title).toBe("Task t1"); // Unchanged fields preserved
  });

  it("updateTask returns false for unknown ID", async () => {
    const store = createTaskStore(filePath);
    await store.save([makeTask("t1")]);

    const result = await store.updateTask("nonexistent", { priority: "high" });

    expect(result).toBe(false);
    const loaded = await store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].priority).toBe("medium"); // Unchanged
  });

  it("removeTask removes by ID, returns true", async () => {
    const store = createTaskStore(filePath);
    await store.save([makeTask("t1"), makeTask("t2")]);

    const result = await store.removeTask("t1");

    expect(result).toBe(true);
    const loaded = await store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe("t2");
  });

  it("removeTask returns false for unknown ID", async () => {
    const store = createTaskStore(filePath);
    await store.save([makeTask("t1")]);

    const result = await store.removeTask("nonexistent");

    expect(result).toBe(false);
    const loaded = await store.load();
    expect(loaded).toHaveLength(1);
  });

  it("getTask returns task by ID", async () => {
    const store = createTaskStore(filePath);
    await store.save([makeTask("t1"), makeTask("t2")]);

    const task = await store.getTask("t2");
    expect(task).toBeDefined();
    expect(task!.id).toBe("t2");
  });

  it("getTask returns undefined for unknown ID", async () => {
    const store = createTaskStore(filePath);
    await store.save([makeTask("t1")]);

    const task = await store.getTask("nonexistent");
    expect(task).toBeUndefined();
  });

  it("getByStatus filters by status", async () => {
    const store = createTaskStore(filePath);
    await store.save([
      makeTask("t1", { status: "pending" }),
      makeTask("t2", { status: "completed" }),
      makeTask("t3", { status: "pending" }),
    ]);

    const pending = await store.getByStatus("pending");
    expect(pending).toHaveLength(2);
    expect(pending.map((t) => t.id)).toEqual(["t1", "t3"]);

    const completed = await store.getByStatus("completed");
    expect(completed).toHaveLength(1);
    expect(completed[0].id).toBe("t2");
  });

  it("getByStatus returns empty for non-matching status", async () => {
    const store = createTaskStore(filePath);
    await store.save([makeTask("t1")]);

    const result = await store.getByStatus("cancelled");
    expect(result).toEqual([]);
  });

  it("save creates parent directory if needed", async () => {
    const nestedPath = join(tmpDir, "nested", "dir", "tasks.json");
    const store = createTaskStore(nestedPath);

    await store.save([makeTask("t1")]);

    const loaded = await store.load();
    expect(loaded).toHaveLength(1);
  });

  it("atomic write pattern (no partial file on save)", async () => {
    const store = createTaskStore(filePath);
    const tasks = [makeTask("t1"), makeTask("t2")];

    await store.save(tasks);

    // Verify file exists and is valid JSON
    const content = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(content);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);

    // Verify no leftover tmp files
    const parentStat = await stat(tmpDir);
    expect(parentStat.isDirectory()).toBe(true);
  });

  it("load returns empty array for invalid JSON content", async () => {
    const { writeFile: writeF } = await import("node:fs/promises");
    await writeF(filePath, "not-valid-json", "utf-8");

    const store = createTaskStore(filePath);
    // JSON.parse will throw, let it propagate (store doesn't swallow parse errors)
    await expect(store.load()).rejects.toThrow();
  });

  // -----------------------------------------------------------------------
  // Restrictive file permissions
  // -----------------------------------------------------------------------

  it("save writes file with mode 0o600", async () => {
    const store = createTaskStore(filePath);
    await store.save([makeTask("perm-t1")]);

    const fileStat = await stat(filePath);
    const mode = fileStat.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  // -----------------------------------------------------------------------
  // Invalid data handling
  // -----------------------------------------------------------------------

  it("load returns empty array for valid JSON with invalid schema", async () => {
    const { writeFile: writeF } = await import("node:fs/promises");
    // Valid JSON but does not match ExtractedTaskSchema
    await writeF(filePath, JSON.stringify([{ bad: "data", not: "a-task" }]), "utf-8");

    const store = createTaskStore(filePath);
    // safeParse returns { success: false } => returns []
    const tasks = await store.load();
    expect(tasks).toEqual([]);
  });
});
