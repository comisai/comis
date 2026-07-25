// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
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

async function fixture(
  interruptAt?: TaskAuthorityDurableStep,
  overrides: Partial<Parameters<typeof createTaskAuthorityMaintenance>[0]> = {},
): Promise<{
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
      ...overrides,
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

  it("rejects invalid split and colliding task authority paths", async () => {
    const relative = await fixture(undefined, { directory: "relative" });
    expect(await relative.authority.inspect()).toMatchObject({ ok: false, error: { code: "invalid_path" } });
    expect(await relative.authority.recoverPendingReset()).toMatchObject({ ok: false, error: { code: "invalid_path" } });
    expect(await relative.authority.reset({ expectedDigest: null, confirmed: true }))
      .toMatchObject({ ok: false, error: { code: "invalid_path" } });

    const split = await fixture(undefined, { storePath: join(tmpdir(), "other-tasks.json") });
    expect(await split.authority.inspect()).toMatchObject({ ok: false, error: { code: "invalid_path" } });
    const collisionBase = await fixture();
    const collision = createTaskAuthorityMaintenance({
      directory: collisionBase.directory,
      storePath: collisionBase.storePath,
      intentPath: collisionBase.storePath,
      storeLockPath: join(collisionBase.directory, "tasks.lock"),
      fileLock: lock(),
      clock: { now: () => 1, nowDate: () => new Date(1) },
      idFactory: () => "opaque-a",
    });
    expect(await collision.inspect()).toMatchObject({ ok: false, error: { code: "invalid_path" } });
  });

  it("maps task authority lock contention and failures", async () => {
    for (const [kind, expected] of [["locked", "lock_contended"], ["error", "lock_failed"]] as const) {
      const fileLock: FileLockPort = {
        ...lock(),
        withLock: async <T>(): Promise<Result<T, LockError>> => err({ kind, message: "expected lock failure" }),
      };
      const data = await fixture(undefined, { fileLock });
      expect(await data.authority.inspect()).toMatchObject({ ok: false, error: { code: expected } });
    }
  });

  it("reports absent pending malformed and oversized reset intents", async () => {
    const none = await fixture();
    expect(await none.authority.recoverPendingReset()).toEqual(ok({ status: "none" }));

    const pending = await fixture("intent_prepared");
    expect(await pending.authority.reset({ expectedDigest: null, confirmed: true }))
      .toMatchObject({ ok: false, error: { code: "interrupted" } });
    expect(await pending.authority.inspect()).toMatchObject({
      ok: true,
      value: { intent: { status: "pending", phase: "prepared" } },
    });
    expect(await pending.authority.reset({ expectedDigest: null, confirmed: true }))
      .toMatchObject({ ok: false, error: { code: "intent_present" } });

    const malformed = await fixture();
    await writeFile(malformed.intentPath, "{invalid", { mode: 0o600 });
    expect(await malformed.authority.inspect()).toMatchObject({ ok: true, value: { intent: { status: "invalid" } } });
    expect(await malformed.authority.recoverPendingReset()).toMatchObject({ ok: false, error: { code: "intent_invalid" } });

    const oversized = await fixture();
    await writeFile(oversized.intentPath, Buffer.alloc(65 * 1_024, 0x78), { mode: 0o600 });
    expect(await oversized.authority.inspect()).toMatchObject({ ok: true, value: { intent: { status: "invalid" } } });
  });

  it("rejects invalid digests opaque identifiers archives and durable tokens", async () => {
    const data = await fixture();
    expect(await data.authority.reset({ expectedDigest: "not-a-digest", confirmed: true }))
      .toMatchObject({ ok: false, error: { code: "invalid_input" } });

    const invalidId = await fixture(undefined, { idFactory: () => "../escape" });
    expect(await invalidId.authority.reset({ expectedDigest: null, confirmed: true }))
      .toMatchObject({ ok: false, error: { code: "invalid_input" } });

    const conflict = await fixture(undefined, { idFactory: () => "fixed-operation" });
    await writeFile(`${conflict.storePath}.fixed-operation.archive`, "existing", { mode: 0o600 });
    expect(await conflict.authority.reset({ expectedDigest: null, confirmed: true }))
      .toMatchObject({ ok: false, error: { code: "archive_conflict" } });

    let call = 0;
    const invalidToken = await fixture(undefined, { idFactory: () => ++call === 1 ? "operation-a" : "../escape" });
    expect(await invalidToken.authority.reset({ expectedDigest: null, confirmed: true }))
      .toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });

  it("maps thrown durable-step gates to an interrupted transaction", async () => {
    const thrown = await fixture(undefined, {
      durableStepGate: async () => { throw new Error("expected gate rejection"); },
    });
    expect(await thrown.authority.reset({ expectedDigest: null, confirmed: true }))
      .toMatchObject({ ok: false, error: { code: "interrupted" } });
  });

  it("rejects directory authority paths and malformed intent semantics", async () => {
    const directoryAuthority = await fixture();
    await mkdir(directoryAuthority.storePath);
    expect(await directoryAuthority.authority.inspect()).toMatchObject({ ok: false, error: { code: "invalid_path" } });

    const semantics = await fixture();
    const invalidIntent = {
      formatVersion: 1,
      operationId: "operation-a",
      expectedDigest: null,
      archiveName: "wrong.archive",
      phase: "prepared",
      createdAtMs: 1,
    };
    await writeFile(semantics.intentPath, `${JSON.stringify(invalidIntent)}\n`, { mode: 0o600 });
    expect(await semantics.authority.inspect()).toMatchObject({ ok: true, value: { intent: { status: "invalid" } } });
  });

  it("propagates invalid intent store and archive authorities from reset operations", async () => {
    const invalidIntent = await fixture();
    await mkdir(invalidIntent.intentPath);
    expect(await invalidIntent.authority.recoverPendingReset()).toMatchObject({
      ok: false,
      error: { code: "invalid_path" },
    });
    expect(await invalidIntent.authority.reset({ expectedDigest: null, confirmed: true })).toMatchObject({
      ok: false,
      error: { code: "invalid_path" },
    });

    const invalidStore = await fixture();
    await mkdir(invalidStore.storePath);
    expect(await invalidStore.authority.reset({ expectedDigest: null, confirmed: true })).toMatchObject({
      ok: false,
      error: { code: "invalid_path" },
    });

    const invalidArchive = await fixture(undefined, { idFactory: () => "operation-a" });
    await mkdir(`${invalidArchive.storePath}.operation-a.archive`);
    expect(await invalidArchive.authority.reset({ expectedDigest: null, confirmed: true })).toMatchObject({
      ok: false,
      error: { code: "invalid_path" },
    });
  });

  it("propagates durable token failures from each roll-forward intent phase", async () => {
    for (const failingCall of [3, 4, 5, 6]) {
      let call = 0;
      const data = await fixture(undefined, {
        idFactory: () => ++call === failingCall ? "../escape" : `opaque-${call}`,
      });
      expect(await data.authority.reset({ expectedDigest: null, confirmed: true })).toMatchObject({
        ok: false,
        error: { code: "invalid_input" },
      });
    }
  });

  it("rejects unsafe reset intent time before archive mutation", async () => {
    const data = await fixture(undefined, {
      clock: { now: () => -1, nowDate: () => new Date(0) },
    });

    expect(await data.authority.reset({ expectedDigest: null, confirmed: true })).toMatchObject({
      ok: false,
      error: { code: "intent_invalid", errorKind: "validation" },
    });
  });

  it("detects authority and archive races between archival and replacement", async () => {
    let storePath = "";
    const changedAuthority = await fixture(undefined, {
      durableStepGate: async (step) => {
        if (step === "store_archived") await mkdir(storePath);
        return ok(undefined);
      },
    });
    storePath = changedAuthority.storePath;
    await writeFile(storePath, "before\n", { mode: 0o600 });
    expect(await changedAuthority.authority.reset({ expectedDigest: digest("before\n"), confirmed: true }))
      .toMatchObject({ ok: false, error: { code: "invalid_path" } });

    let archivePath = "";
    const changedArchive = await fixture(undefined, {
      idFactory: () => "operation-a",
      durableStepGate: async (step) => {
        if (step === "store_archived") await writeFile(archivePath, "changed\n", { mode: 0o600 });
        return ok(undefined);
      },
    });
    archivePath = `${changedArchive.storePath}.operation-a.archive`;
    await writeFile(changedArchive.storePath, "before\n", { mode: 0o600 });
    expect(await changedArchive.authority.reset({ expectedDigest: digest("before\n"), confirmed: true }))
      .toMatchObject({ ok: false, error: { code: "intent_ambiguous" } });

    let newArchivePath = "";
    const unexpectedArchive = await fixture(undefined, {
      idFactory: () => "operation-a",
      durableStepGate: async (step) => {
        if (step === "store_archived") await writeFile(newArchivePath, "unexpected\n", { mode: 0o600 });
        return ok(undefined);
      },
    });
    newArchivePath = `${unexpectedArchive.storePath}.operation-a.archive`;
    expect(await unexpectedArchive.authority.reset({ expectedDigest: null, confirmed: true }))
      .toMatchObject({ ok: false, error: { code: "intent_ambiguous" } });
  });

  it("fails closed when authority facts change at each finalization boundary", async () => {
    let storePath = "";
    const storeChangedBeforeArchive = await fixture(undefined, {
      durableStepGate: async (step) => {
        if (step === "intent_prepared") {
          await rm(storePath, { force: true });
          await mkdir(storePath);
        }
        return ok(undefined);
      },
    });
    storePath = storeChangedBeforeArchive.storePath;
    await writeFile(storePath, "before\n", { mode: 0o600 });
    expect(await storeChangedBeforeArchive.authority.reset({
      expectedDigest: digest("before\n"),
      confirmed: true,
    })).toMatchObject({ ok: false, error: { code: "invalid_path" } });

    let archivePath = "";
    const archiveChangedBeforeArchive = await fixture(undefined, {
      idFactory: () => "operation-a",
      durableStepGate: async (step) => {
        if (step === "intent_prepared") await mkdir(archivePath);
        return ok(undefined);
      },
    });
    archivePath = `${archiveChangedBeforeArchive.storePath}.operation-a.archive`;
    await writeFile(archiveChangedBeforeArchive.storePath, "before\n", { mode: 0o600 });
    expect(await archiveChangedBeforeArchive.authority.reset({
      expectedDigest: digest("before\n"),
      confirmed: true,
    })).toMatchObject({ ok: false, error: { code: "invalid_path" } });

    let unexpectedArchivePath = "";
    const unexpectedArchive = await fixture(undefined, {
      idFactory: () => "operation-a",
      durableStepGate: async (step) => {
        if (step === "intent_prepared") {
          await writeFile(unexpectedArchivePath, "unexpected\n", { mode: 0o600 });
        }
        return ok(undefined);
      },
    });
    unexpectedArchivePath = `${unexpectedArchive.storePath}.operation-a.archive`;
    expect(await unexpectedArchive.authority.reset({ expectedDigest: null, confirmed: true }))
      .toMatchObject({ ok: false, error: { code: "intent_ambiguous" } });

    let replacementArchivePath = "";
    const invalidReplacementArchive = await fixture(undefined, {
      idFactory: () => "operation-a",
      durableStepGate: async (step) => {
        if (step === "store_archived") {
          await rm(replacementArchivePath, { force: true });
          await mkdir(replacementArchivePath);
        }
        return ok(undefined);
      },
    });
    replacementArchivePath = `${invalidReplacementArchive.storePath}.operation-a.archive`;
    await writeFile(invalidReplacementArchive.storePath, "before\n", { mode: 0o600 });
    expect(await invalidReplacementArchive.authority.reset({
      expectedDigest: digest("before\n"),
      confirmed: true,
    })).toMatchObject({ ok: false, error: { code: "invalid_path" } });

    let completedStorePath = "";
    const missingAfterCompletion = await fixture(undefined, {
      durableStepGate: async (step) => {
        if (step === "completion_recorded") await rm(completedStorePath, { force: true });
        return ok(undefined);
      },
    });
    completedStorePath = missingAfterCompletion.storePath;
    expect(await missingAfterCompletion.authority.reset({ expectedDigest: null, confirmed: true }))
      .toMatchObject({ ok: false, error: { code: "intent_ambiguous" } });

    let invalidCompletedStorePath = "";
    const invalidAfterCompletion = await fixture(undefined, {
      durableStepGate: async (step) => {
        if (step === "completion_recorded") {
          await rm(invalidCompletedStorePath, { force: true });
          await mkdir(invalidCompletedStorePath);
        }
        return ok(undefined);
      },
    });
    invalidCompletedStorePath = invalidAfterCompletion.storePath;
    expect(await invalidAfterCompletion.authority.reset({ expectedDigest: null, confirmed: true }))
      .toMatchObject({ ok: false, error: { code: "invalid_path" } });

    let intentPath = "";
    const unremovableIntent = await fixture(undefined, {
      durableStepGate: async (step) => {
        if (step === "completion_recorded") {
          await rm(intentPath, { force: true });
          await mkdir(intentPath);
        }
        return ok(undefined);
      },
    });
    intentPath = unremovableIntent.intentPath;
    expect(await unremovableIntent.authority.reset({ expectedDigest: null, confirmed: true }))
      .toMatchObject({ ok: false, error: { code: "io" } });
  });
});
