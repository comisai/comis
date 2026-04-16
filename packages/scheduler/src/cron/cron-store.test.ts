import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { CronJob } from "./cron-types.js";
import { createCronStore } from "./cron-store.js";
import type { SchedulerLogger } from "../shared-types.js";
import { createMockLogger as _createMockLogger } from "../../../../test/support/mock-logger.js";

const createMockLogger = (): SchedulerLogger => _createMockLogger() as unknown as SchedulerLogger;


function makeTmpPath(): string {
  const dir = path.join(os.tmpdir(), `cron-store-test-${process.pid}-${Date.now()}`);
  return path.join(dir, "jobs.json");
}

function makeJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: overrides.id ?? `job-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name: overrides.name ?? "test job",
    agentId: overrides.agentId ?? "agent-1",
    schedule: overrides.schedule ?? { kind: "every", everyMs: 60_000 },
    payload: overrides.payload ?? { kind: "system_event", text: "hello" },
    sessionTarget: overrides.sessionTarget ?? "isolated",
    enabled: overrides.enabled ?? true,
    consecutiveErrors: overrides.consecutiveErrors ?? 0,
    createdAtMs: overrides.createdAtMs ?? Date.now(),
    ...(overrides.nextRunAtMs !== undefined ? { nextRunAtMs: overrides.nextRunAtMs } : {}),
    ...(overrides.lastRunAtMs !== undefined ? { lastRunAtMs: overrides.lastRunAtMs } : {}),
  };
}

describe("CronStore", () => {
  let filePath: string;

  beforeEach(() => {
    filePath = makeTmpPath();
  });

  afterEach(() => {
    // Clean up temp files
    const dir = path.dirname(filePath);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("load returns empty array when file does not exist", async () => {
    const store = createCronStore(filePath);
    const jobs = await store.load();
    expect(jobs).toEqual([]);
  });

  it("save + load round-trips jobs correctly", async () => {
    const store = createCronStore(filePath);
    const job1 = makeJob({ id: "job-1", name: "first" });
    const job2 = makeJob({ id: "job-2", name: "second" });
    await store.save([job1, job2]);
    const loaded = await store.load();
    expect(loaded).toHaveLength(2);
    expect(loaded[0].id).toBe("job-1");
    expect(loaded[1].id).toBe("job-2");
  });

  it("addJob appends to existing jobs", async () => {
    const store = createCronStore(filePath);
    const job1 = makeJob({ id: "job-1" });
    const job2 = makeJob({ id: "job-2" });
    await store.save([job1]);
    await store.addJob(job2);
    const loaded = await store.load();
    expect(loaded).toHaveLength(2);
    expect(loaded.map((j) => j.id)).toEqual(["job-1", "job-2"]);
  });

  it("removeJob removes by ID and returns true", async () => {
    const store = createCronStore(filePath);
    const job1 = makeJob({ id: "job-1" });
    const job2 = makeJob({ id: "job-2" });
    await store.save([job1, job2]);
    const removed = await store.removeJob("job-1");
    expect(removed).toBe(true);
    const loaded = await store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe("job-2");
  });

  it("removeJob returns false for unknown ID", async () => {
    const store = createCronStore(filePath);
    await store.save([makeJob({ id: "job-1" })]);
    const removed = await store.removeJob("nonexistent");
    expect(removed).toBe(false);
  });

  it("updateJob merges partial update and returns true", async () => {
    const store = createCronStore(filePath);
    const job = makeJob({ id: "job-1", name: "original", consecutiveErrors: 0 });
    await store.save([job]);
    const updated = await store.updateJob("job-1", { name: "updated", consecutiveErrors: 3 });
    expect(updated).toBe(true);
    const loaded = await store.load();
    expect(loaded[0].name).toBe("updated");
    expect(loaded[0].consecutiveErrors).toBe(3);
    // Unchanged fields preserved
    expect(loaded[0].id).toBe("job-1");
    expect(loaded[0].agentId).toBe("agent-1");
  });

  it("updateJob returns false for unknown ID", async () => {
    const store = createCronStore(filePath);
    await store.save([makeJob({ id: "job-1" })]);
    const updated = await store.updateJob("nonexistent", { name: "nope" });
    expect(updated).toBe(false);
  });

  it("save creates parent directory if needed", async () => {
    const deepPath = path.join(os.tmpdir(), `cron-deep-${Date.now()}`, "a", "b", "jobs.json");
    const store = createCronStore(deepPath);
    const job = makeJob({ id: "job-1" });
    await store.save([job]);
    const loaded = await store.load();
    expect(loaded).toHaveLength(1);
    // Clean up
    fs.rmSync(path.join(os.tmpdir(), `cron-deep-${Date.now()}`), { recursive: true, force: true });
  });

  it("save cleans up tmp files (atomic write)", async () => {
    const store = createCronStore(filePath);
    await store.save([makeJob({ id: "job-1" })]);
    // Check that no .tmp files remain in the directory
    const dir = path.dirname(filePath);
    const files = fs.readdirSync(dir);
    const tmpFiles = files.filter((f) => f.endsWith(".tmp"));
    expect(tmpFiles).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // Migration of legacy camelCase payload_kind values
  // -----------------------------------------------------------------------

  it("load normalizes legacy camelCase payload_kind values", async () => {
    const store = createCronStore(filePath);
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });

    // Write jobs with legacy camelCase payload_kind values directly to the JSON file
    const legacyJobs = [
      {
        id: "legacy-1",
        name: "legacy systemEvent job",
        agentId: "agent-1",
        schedule: { kind: "every", everyMs: 60_000 },
        payload: { kind: "systemEvent", text: "old format" },
        sessionTarget: "isolated",
        enabled: true,
        consecutiveErrors: 0,
        createdAtMs: Date.now(),
      },
      {
        id: "legacy-2",
        name: "legacy agentTurn job",
        agentId: "agent-1",
        schedule: { kind: "cron", expr: "0 9 * * *" },
        payload: { kind: "agentTurn", message: "old format" },
        sessionTarget: "isolated",
        enabled: true,
        consecutiveErrors: 0,
        createdAtMs: Date.now(),
      },
    ];
    fs.writeFileSync(filePath, JSON.stringify(legacyJobs, null, 2), "utf-8");

    // Load via the store -- migration shim should normalize
    const loaded = await store.load();
    expect(loaded).toHaveLength(2);
    expect(loaded[0].payload.kind).toBe("system_event");
    expect(loaded[1].payload.kind).toBe("agent_turn");
    // Other fields preserved
    expect(loaded[0].id).toBe("legacy-1");
    expect(loaded[1].id).toBe("legacy-2");
  });

  // -----------------------------------------------------------------------
  // File-level locking for mutations
  // -----------------------------------------------------------------------

  it("addJob completes successfully with locking", async () => {
    const store = createCronStore(filePath);
    const job1 = makeJob({ id: "lock-j1" });
    const job2 = makeJob({ id: "lock-j2" });
    await store.addJob(job1);
    await store.addJob(job2);
    const loaded = await store.load();
    expect(loaded).toHaveLength(2);
    expect(loaded.map((j) => j.id)).toEqual(["lock-j1", "lock-j2"]);
  });

  it("removeJob completes successfully with locking", async () => {
    const store = createCronStore(filePath);
    await store.addJob(makeJob({ id: "rm-j1" }));
    await store.addJob(makeJob({ id: "rm-j2" }));
    const removed = await store.removeJob("rm-j1");
    expect(removed).toBe(true);
    const loaded = await store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe("rm-j2");
  });

  it("lock file is derived from store file path", async () => {
    // The lock file should be at filePath + ".lock"
    const store = createCronStore(filePath);
    await store.addJob(makeJob({ id: "lock-derive" }));
    // After an addJob, the lock sentinel should have been created
    const lockPath = `${filePath}.lock`;
    const lockExists = fs.existsSync(lockPath);
    expect(lockExists).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Re-validation on updateJob
  // -----------------------------------------------------------------------

  it("updateJob with valid partial update succeeds and passes Zod", async () => {
    const store = createCronStore(filePath);
    const job = makeJob({ id: "val-j1", name: "original", consecutiveErrors: 0 });
    await store.save([job]);
    const updated = await store.updateJob("val-j1", { name: "valid-updated", consecutiveErrors: 5 });
    expect(updated).toBe(true);
    const loaded = await store.load();
    expect(loaded[0].name).toBe("valid-updated");
    expect(loaded[0].consecutiveErrors).toBe(5);
  });

  it("updateJob with invalid partial update throws ZodError", async () => {
    const store = createCronStore(filePath);
    const job = makeJob({ id: "val-j2", name: "original" });
    await store.save([job]);
    // Force an invalid update through type coercion
    await expect(
      store.updateJob("val-j2", { enabled: "not-a-boolean" as unknown as boolean }),
    ).rejects.toThrow();
  });

  // -----------------------------------------------------------------------
  // Corruption warnings via logger
  // -----------------------------------------------------------------------

  it("load on corrupt JSON file warns via logger", async () => {
    const logger = createMockLogger();
    const store = createCronStore(filePath, logger);
    // Write corrupt JSON to the file
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, "{not valid json!!!", "utf-8");
    const jobs = await store.load();
    expect(jobs).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        hint: expect.stringContaining("invalid JSON"),
        errorKind: "validation",
      }),
      "Cron store corruption detected",
    );
  });

  it("load on file with invalid schema warns via logger", async () => {
    const logger = createMockLogger();
    const store = createCronStore(filePath, logger);
    // Write valid JSON but invalid schema data
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify([{ bad: "data" }]), "utf-8");
    const jobs = await store.load();
    expect(jobs).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        hint: expect.stringContaining("schema validation"),
        errorKind: "validation",
      }),
      "Cron store schema validation failed",
    );
  });

  it("load on missing file returns empty array without warning", async () => {
    const logger = createMockLogger();
    const store = createCronStore(filePath, logger);
    const jobs = await store.load();
    expect(jobs).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("load without logger does not throw on corruption", async () => {
    const store = createCronStore(filePath);
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, "{corrupt!", "utf-8");
    const jobs = await store.load();
    expect(jobs).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // Restrictive file permissions
  // -----------------------------------------------------------------------

  it("save writes file with mode 0o600", async () => {
    const store = createCronStore(filePath);
    await store.save([makeJob({ id: "perm-j1" })]);

    const stat = fs.statSync(filePath);
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  // -----------------------------------------------------------------------
  // Backup file creation
  // -----------------------------------------------------------------------

  it("creates backup file before overwriting", async () => {
    const store = createCronStore(filePath);
    const job1 = makeJob({ id: "bak-j1", name: "original" });
    await store.save([job1]);

    // Save again with different data
    const job2 = makeJob({ id: "bak-j2", name: "replacement" });
    await store.save([job2]);

    // Verify .bak file exists and contains the previous data
    const bakPath = `${filePath}.bak`;
    expect(fs.existsSync(bakPath)).toBe(true);

    const bakContent = JSON.parse(fs.readFileSync(bakPath, "utf-8")) as CronJob[];
    expect(bakContent).toHaveLength(1);
    expect(bakContent[0].id).toBe("bak-j1");
    expect(bakContent[0].name).toBe("original");

    // Current file should have the new data
    const currentContent = JSON.parse(fs.readFileSync(filePath, "utf-8")) as CronJob[];
    expect(currentContent).toHaveLength(1);
    expect(currentContent[0].id).toBe("bak-j2");
  });

  // -----------------------------------------------------------------------
  // Concurrent mutation serialization
  // -----------------------------------------------------------------------
  describe("Concurrent mutation serialization", () => {
    it("parallel addJob calls all succeed without lock errors", async () => {
      const store = createCronStore(filePath);
      const jobs = Array.from({ length: 5 }, (_, i) =>
        makeJob({ id: `parallel-${i}` }),
      );

      // Fire all 5 addJob calls simultaneously
      await Promise.all(jobs.map((job) => store.addJob(job)));

      const loaded = await store.load();
      expect(loaded).toHaveLength(5);
      const ids = loaded.map((j) => j.id).sort();
      expect(ids).toEqual(["parallel-0", "parallel-1", "parallel-2", "parallel-3", "parallel-4"]);
    });

    it("parallel mixed mutations succeed without lock errors", async () => {
      const store = createCronStore(filePath);
      // Pre-save 3 jobs
      const preJobs = Array.from({ length: 3 }, (_, i) =>
        makeJob({ id: `mix-${i}`, name: `original-${i}` }),
      );
      await store.save(preJobs);

      const newJob = makeJob({ id: "mix-new", name: "brand-new" });

      // Fire simultaneously: add new, remove mix-0, update mix-1
      await Promise.all([
        store.addJob(newJob),
        store.removeJob("mix-0"),
        store.updateJob("mix-1", { name: "updated-1" }),
      ]);

      const loaded = await store.load();
      const ids = loaded.map((j) => j.id).sort();
      // mix-0 removed, mix-1 still present (updated), mix-2 unchanged, mix-new added
      expect(ids).toEqual(["mix-1", "mix-2", "mix-new"]);
      const updated = loaded.find((j) => j.id === "mix-1");
      expect(updated?.name).toBe("updated-1");
    });

    it("parallel addJob calls preserve all writes (no lost updates)", async () => {
      const store = createCronStore(filePath);
      const jobs = Array.from({ length: 10 }, (_, i) =>
        makeJob({ id: `bulk-${i}` }),
      );

      // Fire all 10 addJob calls simultaneously
      await Promise.all(jobs.map((job) => store.addJob(job)));

      const loaded = await store.load();
      expect(loaded).toHaveLength(10);
      const ids = loaded.map((j) => j.id).sort();
      expect(ids).toEqual(
        Array.from({ length: 10 }, (_, i) => `bulk-${i}`).sort(),
      );
    });
  });
});
