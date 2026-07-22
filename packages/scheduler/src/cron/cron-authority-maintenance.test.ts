// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
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

async function fixture(interruptAt?: CronAuthorityDurableStep): Promise<{
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
});
