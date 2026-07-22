// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClockPort, FileLockPort, LockError } from "@comis/core";
import { err, ok, type Result } from "@comis/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCronAuthorityMaintenance,
  type CronAuthorityDurableStep,
  type CronAuthorityMaintenance,
} from "./cron-authority-maintenance.js";
import { CronStoreRootSchema } from "./cron-store.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
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
  interruptAt?: CronAuthorityDurableStep,
  overrides: Partial<Parameters<typeof createCronAuthorityMaintenance>[0]> = {},
): Promise<{
  authority: CronAuthorityMaintenance;
  directory: string;
  storePath: string;
  ledgerPath: string;
  intentPath: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "comis-cron-authority-"));
  dirs.push(directory);
  let id = 0;
  const storePath = join(directory, "cron-jobs.json");
  const ledgerPath = join(directory, "cron-executions.jsonl");
  const intentPath = join(directory, "cron-reset-intent.json");
  const clock: ClockPort = {
    now: () => 12_345,
    nowDate: () => new Date(12_345),
  };
  return {
    authority: createCronAuthorityMaintenance({
      directory,
      storePath,
      ledgerPath,
      intentPath,
      storeLockPath: join(directory, "cron-jobs.lock"),
      ledgerLockPath: join(directory, "cron-executions.lock"),
      fileLock: lock(),
      clock,
      idFactory: () => `opaque-${++id}`,
      ...(interruptAt === undefined
        ? {}
        : {
          durableStepGate: async (step: CronAuthorityDurableStep) => step === interruptAt
            ? err({ code: "interrupted" as const, errorKind: "internal" as const, message: "Simulated process interruption" })
            : ok(undefined),
        }),
      ...overrides,
    }),
    directory,
    storePath,
    ledgerPath,
    intentPath,
  };
}

function digest(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("cron authority reset transaction", () => {
  it("reports exact raw digests and missing authorities without parsing them", async () => {
    const { authority, storePath } = await fixture();
    const bytes = Buffer.from("not-json\n", "utf8");
    await writeFile(storePath, bytes, { mode: 0o600 });

    expect(await authority.inspect()).toEqual(ok({
      store: { exists: true, bytes: bytes.byteLength, digest: digest(bytes) },
      ledger: { exists: false, bytes: 0, digest: null },
      intent: { status: "none" },
    }));
  });

  it("rejects a symlink instead of following it as an authority file", async () => {
    const { authority, directory, storePath } = await fixture();
    const target = join(directory, "unrelated.json");
    await writeFile(target, "unrelated\n", { mode: 0o600 });
    await symlink(target, storePath);

    expect(await authority.inspect()).toMatchObject({
      ok: false,
      error: { code: "invalid_path", errorKind: "validation" },
    });
  });

  it("reports an oversized intent digest while refusing to recover it", async () => {
    const { authority, intentPath } = await fixture();
    const bytes = Buffer.alloc(65 * 1_024, 0x78);
    await writeFile(intentPath, bytes, { mode: 0o600 });

    expect(await authority.inspect()).toMatchObject({
      ok: true,
      value: { intent: { status: "invalid", digest: digest(bytes) } },
    });
    expect(await authority.recoverPendingReset()).toMatchObject({
      ok: false,
      error: { code: "intent_invalid", errorKind: "validation" },
    });
  });

  it("archives exact bytes and creates strict empty authorities for an all reset", async () => {
    const { authority, directory, storePath, ledgerPath, intentPath } = await fixture();
    const storeBytes = Buffer.from("corrupt-store\n", "utf8");
    const ledgerBytes = Buffer.from("corrupt-ledger\n", "utf8");
    await writeFile(storePath, storeBytes, { mode: 0o644 });
    await writeFile(ledgerPath, ledgerBytes, { mode: 0o644 });

    const reset = await authority.reset({
      target: "all",
      expectedDigests: { store: digest(storeBytes), ledger: digest(ledgerBytes) },
      confirmed: true,
    });

    expect(reset).toMatchObject({
      ok: true,
      value: {
        target: "all",
        operationId: expect.stringMatching(/^opaque-/),
        beforeDigests: { store: digest(storeBytes), ledger: digest(ledgerBytes) },
        afterDigests: {
          store: expect.stringMatching(/^[a-f0-9]{64}$/),
          ledger: digest(Buffer.alloc(0)),
        },
      },
    });
    const root = CronStoreRootSchema.parse(JSON.parse(await readFile(storePath, "utf8")));
    expect(root).toMatchObject({ formatVersion: 1, jobs: [], activeClaims: [] });
    expect(root.agentSchedulerSeed).toMatch(/^opaque-/);
    expect(await readFile(ledgerPath)).toEqual(Buffer.alloc(0));
    const archives = (await readdir(directory)).filter((name) => name.endsWith(".archive")).sort();
    expect(archives).toHaveLength(2);
    expect(await Promise.all(archives.map(async (name) => readFile(join(directory, name))))).toEqual([
      ledgerBytes,
      storeBytes,
    ]);
    for (const archive of archives) expect((await stat(join(directory, archive))).mode & 0o777).toBe(0o600);
    await expect(readFile(intentPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(storePath)).mode & 0o777).toBe(0o600);
    expect((await stat(ledgerPath)).mode & 0o777).toBe(0o600);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
  });

  it("rejects missing confirmation and digest races before writing an intent", async () => {
    const { authority, storePath, intentPath } = await fixture();
    const bytes = Buffer.from("raw-store\n", "utf8");
    await writeFile(storePath, bytes, { mode: 0o600 });

    expect(await authority.reset({
      target: "store",
      expectedDigests: { store: digest(bytes) },
      confirmed: false,
    })).toMatchObject({ ok: false, error: { code: "confirmation_required" } });
    expect(await authority.reset({
      target: "store",
      expectedDigests: { store: digest("different") },
      confirmed: true,
    })).toMatchObject({ ok: false, error: { code: "digest_mismatch" } });
    expect(await readFile(storePath)).toEqual(bytes);
    await expect(readFile(intentPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses a null digest compare-and-set for a missing selected authority", async () => {
    const { authority, storePath } = await fixture();

    expect(await authority.reset({
      target: "store",
      expectedDigests: { store: null },
      confirmed: true,
    })).toMatchObject({ ok: true, value: { beforeDigests: { store: null } } });
    expect(CronStoreRootSchema.safeParse(JSON.parse(await readFile(storePath, "utf8"))).success).toBe(true);
  });

  it.each([
    "intent_prepared",
    "store_archived",
    "ledger_archived",
    "archives_recorded",
    "store_replaced",
    "ledger_replaced",
    "replacements_recorded",
    "completion_recorded",
  ] satisfies CronAuthorityDurableStep[])("rolls an unambiguous %s interruption forward", async (step) => {
    const interrupted = await fixture(step);
    const storeBytes = Buffer.from("store-before\n", "utf8");
    const ledgerBytes = Buffer.from("ledger-before\n", "utf8");
    await writeFile(interrupted.storePath, storeBytes, { mode: 0o600 });
    await writeFile(interrupted.ledgerPath, ledgerBytes, { mode: 0o600 });

    expect(await interrupted.authority.reset({
      target: "all",
      expectedDigests: { store: digest(storeBytes), ledger: digest(ledgerBytes) },
      confirmed: true,
    })).toMatchObject({ ok: false, error: { code: "interrupted" } });

    const recovered = createCronAuthorityMaintenance({
      directory: interrupted.directory,
      storePath: interrupted.storePath,
      ledgerPath: interrupted.ledgerPath,
      intentPath: interrupted.intentPath,
      storeLockPath: join(interrupted.directory, "cron-jobs.lock"),
      ledgerLockPath: join(interrupted.directory, "cron-executions.lock"),
      fileLock: lock(),
      clock: { now: () => 99_999, nowDate: () => new Date(99_999) },
      idFactory: (() => { let id = 100; return () => `recovery-${++id}`; })(),
    });
    expect(await recovered.recoverPendingReset()).toMatchObject({
      ok: true,
      value: { status: "recovered", target: "all" },
    });
    expect(CronStoreRootSchema.safeParse(JSON.parse(await readFile(interrupted.storePath, "utf8"))).success).toBe(true);
    expect(await readFile(interrupted.ledgerPath)).toEqual(Buffer.alloc(0));
    await expect(readFile(interrupted.intentPath)).rejects.toMatchObject({ code: "ENOENT" });
    const archiveBytes = await Promise.all(
      (await readdir(interrupted.directory))
        .filter((name) => name.endsWith(".archive"))
        .map(async (name) => readFile(join(interrupted.directory, name))),
    );
    expect(archiveBytes).toEqual(expect.arrayContaining([storeBytes, ledgerBytes]));
  });

  it("preserves an ambiguous intent and every authority byte for operator inspection", async () => {
    const interrupted = await fixture("intent_prepared");
    const storeBytes = Buffer.from("store-before\n", "utf8");
    const ledgerBytes = Buffer.from("ledger-before\n", "utf8");
    await writeFile(interrupted.storePath, storeBytes, { mode: 0o600 });
    await writeFile(interrupted.ledgerPath, ledgerBytes, { mode: 0o600 });
    expect((await interrupted.authority.reset({
      target: "all",
      expectedDigests: { store: digest(storeBytes), ledger: digest(ledgerBytes) },
      confirmed: true,
    })).ok).toBe(false);
    const changed = Buffer.from("concurrent-change\n", "utf8");
    await writeFile(interrupted.storePath, changed, { mode: 0o600 });

    expect(await interrupted.authority.recoverPendingReset()).toMatchObject({
      ok: false,
      error: { code: "intent_ambiguous", errorKind: "precondition" },
    });
    expect(await readFile(interrupted.storePath)).toEqual(changed);
    expect(await readFile(interrupted.ledgerPath)).toEqual(ledgerBytes);
    expect((await readFile(interrupted.intentPath)).byteLength).toBeGreaterThan(0);
  });

  it("rejects non-normalized split and colliding authority paths", async () => {
    const relative = await fixture(undefined, { directory: "relative" });
    expect(await relative.authority.inspect()).toMatchObject({ ok: false, error: { code: "invalid_path" } });
    expect(await relative.authority.recoverPendingReset()).toMatchObject({ ok: false, error: { code: "invalid_path" } });
    expect(await relative.authority.reset({
      target: "store", expectedDigests: { store: null }, confirmed: true,
    })).toMatchObject({ ok: false, error: { code: "invalid_path" } });

    const split = await fixture(undefined, { storePath: join(tmpdir(), "other-cron.json") });
    expect(await split.authority.inspect()).toMatchObject({ ok: false, error: { code: "invalid_path" } });

    const collisionBase = await fixture();
    const collision = createCronAuthorityMaintenance({
      directory: collisionBase.directory,
      storePath: collisionBase.storePath,
      ledgerPath: collisionBase.storePath,
      intentPath: collisionBase.intentPath,
      storeLockPath: join(collisionBase.directory, "store.lock"),
      ledgerLockPath: join(collisionBase.directory, "ledger.lock"),
      fileLock: lock(),
      clock: { now: () => 1, nowDate: () => new Date(1) },
      idFactory: () => "opaque-a",
    });
    expect(await collision.inspect()).toMatchObject({ ok: false, error: { code: "invalid_path" } });
  });

  it("maps outer and inner authority lock failures independently", async () => {
    for (const [failureCall, kind, expected] of [[1, "locked", "lock_contended"], [2, "error", "lock_failed"]] as const) {
      let call = 0;
      const fileLock: FileLockPort = {
        ...lock(),
        withLock: async <T>(_path: string, operation: () => Promise<T>): Promise<Result<T, LockError>> => {
          call += 1;
          return call === failureCall
            ? err({ kind, message: "expected lock failure" })
            : ok(await operation());
        },
      };
      const data = await fixture(undefined, { fileLock });
      expect(await data.authority.inspect()).toMatchObject({ ok: false, error: { code: expected } });
    }
  });

  it("reports pending malformed and absent intent states without mutating authority", async () => {
    const none = await fixture();
    expect(await none.authority.recoverPendingReset()).toEqual(ok({ status: "none" }));

    const pending = await fixture("intent_prepared");
    expect(await pending.authority.reset({
      target: "all",
      expectedDigests: { store: null, ledger: null },
      confirmed: true,
    })).toMatchObject({ ok: false, error: { code: "interrupted" } });
    expect(await pending.authority.inspect()).toMatchObject({
      ok: true,
      value: { intent: { status: "pending", phase: "prepared", target: "all" } },
    });
    expect(await pending.authority.reset({
      target: "all",
      expectedDigests: { store: null, ledger: null },
      confirmed: true,
    })).toMatchObject({ ok: false, error: { code: "intent_present" } });

    const malformed = await fixture();
    await writeFile(malformed.intentPath, "{invalid", { mode: 0o600 });
    expect(await malformed.authority.inspect()).toMatchObject({ ok: true, value: { intent: { status: "invalid" } } });
    expect(await malformed.authority.reset({
      target: "store", expectedDigests: { store: null }, confirmed: true,
    })).toMatchObject({ ok: false, error: { code: "intent_invalid" } });
  });

  it("rejects malformed expected digests and invalid opaque operation identifiers", async () => {
    const data = await fixture();
    expect(await data.authority.reset({
      target: "store", expectedDigests: { store: "not-a-digest" }, confirmed: true,
    })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(await data.authority.reset({
      target: "ledger", expectedDigests: { ledger: "not-a-digest" }, confirmed: true,
    })).toMatchObject({ ok: false, error: { code: "invalid_input" } });

    const invalidId = await fixture(undefined, { idFactory: () => "../escape" });
    expect(await invalidId.authority.reset({
      target: "store", expectedDigests: { store: null }, confirmed: true,
    })).toMatchObject({ ok: false, error: { code: "invalid_input" } });

    let call = 0;
    const invalidSeed = await fixture(undefined, { idFactory: () => ++call === 1 ? "operation-a" : "../escape" });
    expect(await invalidSeed.authority.reset({
      target: "store", expectedDigests: { store: null }, confirmed: true,
    })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });

  it("resets only the ledger while leaving store bytes byte-identical", async () => {
    const data = await fixture();
    const storeBytes = Buffer.from("store-authority\n", "utf8");
    const ledgerBytes = Buffer.from("ledger-authority\n", "utf8");
    await writeFile(data.storePath, storeBytes, { mode: 0o600 });
    await writeFile(data.ledgerPath, ledgerBytes, { mode: 0o600 });

    expect(await data.authority.reset({
      target: "ledger",
      expectedDigests: { ledger: digest(ledgerBytes) },
      confirmed: true,
    })).toMatchObject({ ok: true, value: { target: "ledger" } });
    expect(await readFile(data.storePath)).toEqual(storeBytes);
    expect(await readFile(data.ledgerPath)).toEqual(Buffer.alloc(0));
  });

  it("rejects pre-existing archive names before preparing reset intent", async () => {
    const data = await fixture(undefined, { idFactory: () => "fixed-operation" });
    await writeFile(`${data.storePath}.fixed-operation.archive`, "existing", { mode: 0o600 });
    expect(await data.authority.reset({
      target: "store", expectedDigests: { store: null }, confirmed: true,
    })).toMatchObject({ ok: false, error: { code: "archive_conflict" } });
  });

  it("maps thrown durable-step gates and invalid durable-file tokens", async () => {
    const thrown = await fixture(undefined, {
      durableStepGate: async () => { throw new Error("expected gate rejection"); },
    });
    expect(await thrown.authority.reset({
      target: "ledger", expectedDigests: { ledger: null }, confirmed: true,
    })).toMatchObject({ ok: false, error: { code: "interrupted" } });

    let call = 0;
    const invalidToken = await fixture(undefined, {
      idFactory: () => ++call === 1 ? "operation-a" : "../escape",
    });
    expect(await invalidToken.authority.reset({
      target: "ledger", expectedDigests: { ledger: null }, confirmed: true,
    })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });

  it("rejects directory authorities and malformed intent semantics", async () => {
    const directoryAuthority = await fixture();
    await mkdir(directoryAuthority.storePath);
    expect(await directoryAuthority.authority.inspect()).toMatchObject({ ok: false, error: { code: "invalid_path" } });

    const semantics = await fixture();
    const invalidIntent = {
      formatVersion: 1,
      operationId: "operation-a",
      target: "store",
      selectedTargets: ["ledger"],
      expectedDigests: { store: null, ledger: null },
      archiveNames: { store: null, ledger: "cron-executions.jsonl.operation-a.archive" },
      replacementStoreSeed: null,
      phase: "prepared",
      createdAtMs: 1,
    };
    await writeFile(semantics.intentPath, `${JSON.stringify(invalidIntent)}\n`, { mode: 0o600 });
    expect(await semantics.authority.inspect()).toMatchObject({ ok: true, value: { intent: { status: "invalid" } } });
  });

  it("propagates invalid store ledger intent and archive authorities", async () => {
    const invalidLedger = await fixture();
    await mkdir(invalidLedger.ledgerPath);
    expect(await invalidLedger.authority.inspect()).toMatchObject({ ok: false, error: { code: "invalid_path" } });

    const invalidIntent = await fixture();
    await mkdir(invalidIntent.intentPath);
    expect(await invalidIntent.authority.recoverPendingReset()).toMatchObject({
      ok: false,
      error: { code: "invalid_path" },
    });
    expect(await invalidIntent.authority.reset({
      target: "all", expectedDigests: { store: null, ledger: null }, confirmed: true,
    })).toMatchObject({ ok: false, error: { code: "invalid_path" } });

    const invalidStore = await fixture();
    await mkdir(invalidStore.storePath);
    expect(await invalidStore.authority.reset({
      target: "store", expectedDigests: { store: null }, confirmed: true,
    })).toMatchObject({ ok: false, error: { code: "invalid_path" } });

    const invalidArchive = await fixture(undefined, { idFactory: () => "operation-a" });
    await mkdir(`${invalidArchive.storePath}.operation-a.archive`);
    expect(await invalidArchive.authority.reset({
      target: "store", expectedDigests: { store: null }, confirmed: true,
    })).toMatchObject({ ok: false, error: { code: "invalid_path" } });
  });

  it("propagates durable token failures from every all-target roll-forward phase", async () => {
    for (const failingCall of [3, 4, 5, 6, 7, 8]) {
      let call = 0;
      const data = await fixture(undefined, {
        idFactory: () => ++call === failingCall ? "../escape" : `opaque-${call}`,
      });
      expect(await data.authority.reset({
        target: "all",
        expectedDigests: { store: null, ledger: null },
        confirmed: true,
      })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    }
  });

  it("rejects unsafe reset intent time before archive mutation", async () => {
    const data = await fixture(undefined, {
      clock: { now: () => -1, nowDate: () => new Date(0) },
    });

    expect(await data.authority.reset({
      target: "store", expectedDigests: { store: null }, confirmed: true,
    })).toMatchObject({ ok: false, error: { code: "intent_invalid", errorKind: "validation" } });
  });

  it("detects target and archive races between archival and replacement", async () => {
    let ledgerPath = "";
    const changedTarget = await fixture(undefined, {
      durableStepGate: async (step) => {
        if (step === "store_archived") await mkdir(ledgerPath);
        return ok(undefined);
      },
    });
    ledgerPath = changedTarget.ledgerPath;
    await writeFile(changedTarget.storePath, "store\n", { mode: 0o600 });
    expect(await changedTarget.authority.reset({
      target: "all",
      expectedDigests: { store: digest("store\n"), ledger: null },
      confirmed: true,
    })).toMatchObject({ ok: false, error: { code: "invalid_path" } });

    let archivePath = "";
    const changedArchive = await fixture(undefined, {
      idFactory: () => "operation-a",
      durableStepGate: async (step) => {
        if (step === "store_archived") await writeFile(archivePath, "changed\n", { mode: 0o600 });
        return ok(undefined);
      },
    });
    archivePath = `${changedArchive.storePath}.operation-a.archive`;
    await writeFile(changedArchive.storePath, "store\n", { mode: 0o600 });
    expect(await changedArchive.authority.reset({
      target: "store", expectedDigests: { store: digest("store\n") }, confirmed: true,
    })).toMatchObject({ ok: false, error: { code: "intent_ambiguous" } });

    let unexpectedPath = "";
    const unexpectedArchive = await fixture(undefined, {
      idFactory: () => "operation-a",
      durableStepGate: async (step) => {
        if (step === "store_archived") await writeFile(unexpectedPath, "unexpected\n", { mode: 0o600 });
        return ok(undefined);
      },
    });
    unexpectedPath = `${unexpectedArchive.storePath}.operation-a.archive`;
    expect(await unexpectedArchive.authority.reset({
      target: "store", expectedDigests: { store: null }, confirmed: true,
    })).toMatchObject({ ok: false, error: { code: "intent_ambiguous" } });
  });

  it("fails closed when cron authority facts change at every transaction boundary", async () => {
    let archivePath = "";
    const unexpectedArchive = await fixture(undefined, {
      idFactory: () => "operation-a",
      durableStepGate: async (step) => {
        if (step === "intent_prepared") await writeFile(archivePath, "unexpected\n", { mode: 0o600 });
        return ok(undefined);
      },
    });
    archivePath = `${unexpectedArchive.storePath}.operation-a.archive`;
    expect(await unexpectedArchive.authority.reset({
      target: "store", expectedDigests: { store: null }, confirmed: true,
    })).toMatchObject({ ok: false, error: { code: "intent_ambiguous" } });

    let storePath = "";
    const unexpectedAuthority = await fixture(undefined, {
      durableStepGate: async (step) => {
        if (step === "intent_prepared") await writeFile(storePath, "concurrent\n", { mode: 0o600 });
        return ok(undefined);
      },
    });
    storePath = unexpectedAuthority.storePath;
    expect(await unexpectedAuthority.authority.reset({
      target: "store", expectedDigests: { store: null }, confirmed: true,
    })).toMatchObject({ ok: false, error: { code: "intent_ambiguous" } });

    let changedStorePath = "";
    const invalidReplacementTarget = await fixture(undefined, {
      durableStepGate: async (step) => {
        if (step === "store_archived") await mkdir(changedStorePath);
        return ok(undefined);
      },
    });
    changedStorePath = invalidReplacementTarget.storePath;
    await writeFile(changedStorePath, "before\n", { mode: 0o600 });
    expect(await invalidReplacementTarget.authority.reset({
      target: "store", expectedDigests: { store: digest("before\n") }, confirmed: true,
    })).toMatchObject({ ok: false, error: { code: "invalid_path" } });

    let changedArchivePath = "";
    const invalidReplacementArchive = await fixture(undefined, {
      idFactory: () => "operation-a",
      durableStepGate: async (step) => {
        if (step === "store_archived") {
          await rm(changedArchivePath, { force: true });
          await mkdir(changedArchivePath);
        }
        return ok(undefined);
      },
    });
    changedArchivePath = `${invalidReplacementArchive.storePath}.operation-a.archive`;
    await writeFile(invalidReplacementArchive.storePath, "before\n", { mode: 0o600 });
    expect(await invalidReplacementArchive.authority.reset({
      target: "store", expectedDigests: { store: digest("before\n") }, confirmed: true,
    })).toMatchObject({ ok: false, error: { code: "invalid_path" } });

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
    expect(await unremovableIntent.authority.reset({
      target: "store", expectedDigests: { store: null }, confirmed: true,
    })).toMatchObject({ ok: false, error: { code: "io" } });

    let completedStorePath = "";
    const invalidCompletedStore = await fixture(undefined, {
      durableStepGate: async (step) => {
        if (step === "completion_recorded") {
          await rm(completedStorePath, { force: true });
          await mkdir(completedStorePath);
        }
        return ok(undefined);
      },
    });
    completedStorePath = invalidCompletedStore.storePath;
    expect(await invalidCompletedStore.authority.reset({
      target: "store", expectedDigests: { store: null }, confirmed: true,
    })).toMatchObject({ ok: false, error: { code: "invalid_path" } });

    let completedLedgerPath = "";
    const invalidCompletedLedger = await fixture(undefined, {
      durableStepGate: async (step) => {
        if (step === "completion_recorded") await mkdir(completedLedgerPath);
        return ok(undefined);
      },
    });
    completedLedgerPath = invalidCompletedLedger.ledgerPath;
    expect(await invalidCompletedLedger.authority.reset({
      target: "store", expectedDigests: { store: null }, confirmed: true,
    })).toMatchObject({ ok: false, error: { code: "invalid_path" } });
  });
});
