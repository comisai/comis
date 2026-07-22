// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClockPort, FileLockPort, LockError } from "@comis/core";
import { err, ok, type Result } from "@comis/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTaskAuthorityMaintenance,
  type TaskAuthorityDurableStep,
  type TaskAuthorityMaintenance,
} from "./task-authority-maintenance.js";
import { FollowupTaskStoreFileSchema } from "./task-types.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function lock(): FileLockPort {
  return {
    acquire: async () => ok(async () => undefined),
    release: async () => ok(undefined),
    withLock: async <T>(_path: string, fn: () => Promise<T>): Promise<Result<T, LockError>> => ok(await fn()),
    isLocked: async () => false,
    cleanupStaleLocks: async () => 0,
  };
}

async function fixture(interruptAt?: TaskAuthorityDurableStep): Promise<{
  authority: TaskAuthorityMaintenance;
  directory: string;
  storePath: string;
  intentPath: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "comis-task-authority-"));
  directories.push(directory);
  let id = 0;
  const storePath = join(directory, "tasks.json");
  const intentPath = join(directory, "tasks-reset-intent.json");
  const clock: ClockPort = { now: () => 12_345, nowDate: () => new Date(12_345) };
  return {
    authority: createTaskAuthorityMaintenance({
      directory,
      storePath,
      intentPath,
      storeLockPath: join(directory, "tasks.lock"),
      fileLock: lock(),
      clock,
      idFactory: () => `opaque-${++id}`,
      ...(interruptAt === undefined
        ? {}
        : {
          durableStepGate: async (step: TaskAuthorityDurableStep) => step === interruptAt
            ? err({ code: "interrupted" as const, errorKind: "internal" as const, message: "Simulated interruption" })
            : ok(undefined),
        }),
    }),
    directory,
    storePath,
    intentPath,
  };
}

function digest(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("follow-up task authority reset transaction", () => {
  it("reports exact raw evidence for a corrupt store without parsing it", async () => {
    const { authority, storePath } = await fixture();
    const bytes = Buffer.from("not-json\n", "utf8");
    await writeFile(storePath, bytes, { mode: 0o600 });

    expect(await authority.inspect()).toEqual(ok({
      store: { exists: true, bytes: bytes.byteLength, digest: digest(bytes) },
      intent: { status: "none" },
    }));
  });

  it("rejects symlinks instead of following task authority paths", async () => {
    const { authority, directory, storePath } = await fixture();
    const target = join(directory, "unrelated.json");
    await writeFile(target, "unrelated\n", { mode: 0o600 });
    await symlink(target, storePath);

    expect(await authority.inspect()).toMatchObject({
      ok: false,
      error: { code: "invalid_path", errorKind: "validation" },
    });
  });

  it("archives every corrupt byte and creates a strict empty task store", async () => {
    const { authority, directory, storePath, intentPath } = await fixture();
    const bytes = Buffer.from("corrupt-task-authority\n", "utf8");
    await writeFile(storePath, bytes, { mode: 0o644 });

    const reset = await authority.reset({ expectedDigest: digest(bytes), confirmed: true });

    expect(reset).toMatchObject({
      ok: true,
      value: {
        operationId: expect.stringMatching(/^opaque-/),
        beforeDigest: digest(bytes),
        afterDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(FollowupTaskStoreFileSchema.parse(JSON.parse(await readFile(storePath, "utf8"))))
      .toEqual({ formatVersion: 1, tasks: [], attempts: [], policySnapshots: [] });
    const archives = (await readdir(directory)).filter((name) => name.endsWith(".archive"));
    expect(archives).toHaveLength(1);
    expect(await readFile(join(directory, archives[0]!))).toEqual(bytes);
    expect((await stat(join(directory, archives[0]!))).mode & 0o777).toBe(0o600);
    expect((await stat(storePath)).mode & 0o777).toBe(0o600);
    await expect(readFile(intentPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects missing confirmation and digest races before mutation", async () => {
    const { authority, storePath, intentPath } = await fixture();
    const bytes = Buffer.from("raw-task-store\n", "utf8");
    await writeFile(storePath, bytes, { mode: 0o600 });

    expect(await authority.reset({ expectedDigest: digest(bytes), confirmed: false }))
      .toMatchObject({ ok: false, error: { code: "confirmation_required" } });
    expect(await authority.reset({ expectedDigest: digest("different"), confirmed: true }))
      .toMatchObject({ ok: false, error: { code: "digest_mismatch" } });
    expect(await readFile(storePath)).toEqual(bytes);
    await expect(readFile(intentPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    "intent_prepared",
    "store_archived",
    "archive_recorded",
    "store_replaced",
    "replacement_recorded",
    "completion_recorded",
  ] satisfies TaskAuthorityDurableStep[])("rolls an unambiguous %s interruption forward", async (step) => {
    const interrupted = await fixture(step);
    const bytes = Buffer.from("task-store-before\n", "utf8");
    await writeFile(interrupted.storePath, bytes, { mode: 0o600 });
    expect(await interrupted.authority.reset({ expectedDigest: digest(bytes), confirmed: true }))
      .toMatchObject({ ok: false, error: { code: "interrupted" } });

    const recovered = createTaskAuthorityMaintenance({
      directory: interrupted.directory,
      storePath: interrupted.storePath,
      intentPath: interrupted.intentPath,
      storeLockPath: join(interrupted.directory, "tasks.lock"),
      fileLock: lock(),
      clock: { now: () => 99_999, nowDate: () => new Date(99_999) },
      idFactory: (() => { let id = 100; return () => `recovery-${++id}`; })(),
    });
    expect(await recovered.recoverPendingReset()).toMatchObject({
      ok: true,
      value: { status: "recovered", beforeDigest: digest(bytes) },
    });
    expect(FollowupTaskStoreFileSchema.safeParse(JSON.parse(await readFile(interrupted.storePath, "utf8"))).success)
      .toBe(true);
    await expect(readFile(interrupted.intentPath)).rejects.toMatchObject({ code: "ENOENT" });
    const archive = (await readdir(interrupted.directory)).find((name) => name.endsWith(".archive"));
    expect(archive).toBeDefined();
    expect(await readFile(join(interrupted.directory, archive!))).toEqual(bytes);
  });

  it("preserves ambiguous intent and authority bytes for operator inspection", async () => {
    const interrupted = await fixture("intent_prepared");
    const bytes = Buffer.from("task-store-before\n", "utf8");
    await writeFile(interrupted.storePath, bytes, { mode: 0o600 });
    expect((await interrupted.authority.reset({ expectedDigest: digest(bytes), confirmed: true })).ok).toBe(false);
    const changed = Buffer.from("concurrent-change\n", "utf8");
    await writeFile(interrupted.storePath, changed, { mode: 0o600 });

    expect(await interrupted.authority.recoverPendingReset()).toMatchObject({
      ok: false,
      error: { code: "intent_ambiguous", errorKind: "precondition" },
    });
    expect(await readFile(interrupted.storePath)).toEqual(changed);
    expect((await readFile(interrupted.intentPath)).byteLength).toBeGreaterThan(0);
  });
});
