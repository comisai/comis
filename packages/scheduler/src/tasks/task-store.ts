// SPDX-License-Identifier: Apache-2.0
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { safePath } from "@comis/core";
import { z } from "zod";
import type { ExtractedTask } from "./task-types.js";
import { ExtractedTaskSchema } from "./task-types.js";

const TaskArraySchema = z.array(ExtractedTaskSchema);

/**
 * TaskStore: Atomic JSON persistence for extracted tasks.
 *
 * Uses write-tmp + rename pattern for crash-safe persistence.
 * All mutations are serialized through load-modify-save cycles.
 */
export interface TaskStore {
  /** Load all tasks from disk. Returns empty array if file doesn't exist. */
  load(): Promise<ExtractedTask[]>;
  /** Save tasks to disk atomically (write-tmp + rename). */
  save(tasks: ExtractedTask[]): Promise<void>;
  /** Append a single task to the store. */
  addTask(task: ExtractedTask): Promise<void>;
  /** Merge a partial update into a task by ID. Returns true if found and updated, false otherwise. */
  updateTask(taskId: string, update: Partial<ExtractedTask>): Promise<boolean>;
  /** Remove a task by ID. Returns true if found and removed, false otherwise. */
  removeTask(taskId: string): Promise<boolean>;
  /** Get a single task by ID. Returns undefined if not found. */
  getTask(taskId: string): Promise<ExtractedTask | undefined>;
  /** Get all tasks matching a given status. */
  getByStatus(status: string): Promise<ExtractedTask[]>;
}

/**
 * Create a TaskStore backed by a JSON file at the given path.
 *
 * Uses atomic write (write to .tmp then rename) to prevent data corruption
 * on crash. Same pattern as CronStore.
 */
export function createTaskStore(filePath: string): TaskStore {
  async function load(): Promise<ExtractedTask[]> {
    let raw: string;
    try {
      raw = await readFile(filePath, "utf-8");
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw err;
    }

    const parsed = JSON.parse(raw) as unknown;
    const result = TaskArraySchema.safeParse(parsed);
    if (!result.success) {
      return [];
    }
    return result.data;
  }

  async function save(tasks: ExtractedTask[]): Promise<void> {
    const dir = dirname(filePath);
    await mkdir(dir, { recursive: true });

    const tmpPath = safePath(dir, `.task-store-${Date.now()}.tmp`);
    const data = JSON.stringify(tasks, null, 2);
    await writeFile(tmpPath, data, { encoding: "utf-8", mode: 0o600 });
    await rename(tmpPath, filePath);
  }

  async function addTask(task: ExtractedTask): Promise<void> {
    const tasks = await load();
    tasks.push(task);
    await save(tasks);
  }

  async function updateTask(taskId: string, update: Partial<ExtractedTask>): Promise<boolean> {
    const tasks = await load();
    const idx = tasks.findIndex((t) => t.id === taskId);
    if (idx === -1) return false;

    tasks[idx] = { ...tasks[idx], ...update };
    await save(tasks);
    return true;
  }

  async function removeTask(taskId: string): Promise<boolean> {
    const tasks = await load();
    const idx = tasks.findIndex((t) => t.id === taskId);
    if (idx === -1) return false;

    tasks.splice(idx, 1);
    await save(tasks);
    return true;
  }

  async function getTask(taskId: string): Promise<ExtractedTask | undefined> {
    const tasks = await load();
    return tasks.find((t) => t.id === taskId);
  }

  async function getByStatus(status: string): Promise<ExtractedTask[]> {
    const tasks = await load();
    return tasks.filter((t) => t.status === status);
  }

  return { load, save, addTask, updateTask, removeTask, getTask, getByStatus };
}
