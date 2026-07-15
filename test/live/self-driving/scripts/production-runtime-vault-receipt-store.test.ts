import { constants } from "node:fs";
import {
  chmodSync,
  chownSync,
  closeSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { RuntimeArtifactAttestation } from "./production-runtime.js";
import type { RuntimeTreeAttestation } from "./production-runtime-tree.js";
import {
  createProductionRuntimeVaultRecoveryReceipt,
  serializeProductionRuntimeVaultRecoveryReceipt,
  type ProductionRuntimeVaultRecoveryReceipt,
  type ProductionRuntimeVaultRecoveryReceiptInput,
} from "./production-runtime-vault-authority.js";
import {
  createProductionRuntimeVaultReceiptStore,
  createProductionRuntimeVaultReceiptStoreForTests,
  type ProductionRuntimeVaultReceiptStoreTestHarness,
} from "./production-runtime-vault-receipt-store.js";

const AUTHORITY_KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 11);
const roots: string[] = [];

const sourceRuntimeArtifact: RuntimeArtifactAttestation = {
  digestSha256: "a".repeat(64),
  entryCount: 84_161,
  bytes: 3_269_438_185,
  packageRoot: "/opt/source/node_modules/comisai",
  version: "1.0.53",
  osId: "ubuntu",
  osVersion: "24.04",
  architecture: "x86_64",
  kernelRelease: "6.8.0-71-generic",
  libcKind: "glibc",
  libcVersion: "2.39",
  nodeVersion: "22.17.1",
  nodeAbi: "127",
  timezone: "Asia/Jerusalem",
  tzdataSha256: "b".repeat(64),
  launcherKind: "systemd",
  applicationLauncherSha256: "c".repeat(64),
  confinementKind: "source",
  confinementSha256: "none",
  browserStatus: "available",
  browserSha256: "d".repeat(64),
  mediaStatus: "available",
  mediaSha256: "e".repeat(64),
  nativeToolsStatus: "available",
  nativeToolsSha256: "f".repeat(64),
};

const targetRuntimeArtifact: RuntimeArtifactAttestation = {
  ...sourceRuntimeArtifact,
  digestSha256: "1".repeat(64),
  packageRoot: "/opt/target/node_modules/comisai",
  version: "1.1.0",
  nodeAbi: "128",
  timezone: "Etc/UTC",
  confinementKind: "target_quarantine",
  confinementSha256: "2".repeat(64),
};

const runtimeTreeAttestation: RuntimeTreeAttestation = {
  digestSha256: "3".repeat(64),
  entryCount: 91_456,
  bytes: sourceRuntimeArtifact.bytes,
  root: sourceRuntimeArtifact.packageRoot,
  version: sourceRuntimeArtifact.version,
};

function makeReceiptInput(
  overrides: Partial<ProductionRuntimeVaultRecoveryReceiptInput> = {},
): ProductionRuntimeVaultRecoveryReceiptInput {
  const runId = overrides.runId ?? "runtime-vault-a1";
  const attemptId = overrides.attemptId ?? "4".repeat(32);
  return {
    schemaVersion: 1,
    runId,
    attemptId,
    sourceMachineIdSha256: "5".repeat(64),
    targetMachineIdSha256: "6".repeat(64),
    sourceRuntimeArtifact,
    targetRuntimeArtifact,
    runtimeTreeAttestation,
    maximumArchiveBytes: 7_000_000_000,
    payloadPath: `/opt/comis-replay/runtimes/sha256/${runtimeTreeAttestation.digestSha256}/payload`,
    sourceService: "comis-source.service",
    sourceDataDir: "/srv/source/.comis",
    targetService: "comis-target.service",
    targetDataDir: "/srv/target/.comis",
    targetPackageRoot: targetRuntimeArtifact.packageRoot,
    targetControlDir: `/var/lib/comis-self-driving/runtime-vault/capture-${runId}-${attemptId}`,
    targetIncomingRoot: `/opt/comis-replay/runtimes/sha256/.incoming-${runId}-${attemptId}-${runtimeTreeAttestation.digestSha256}`,
    targetTransactionDir: `/var/lib/comis-self-driving/runtime-vault/transactions/${attemptId}`,
    sourceToolchainDigestSha256: "7".repeat(64),
    targetToolchainDigestSha256: "8".repeat(64),
    sourceServiceFingerprintDigestSha256: "9".repeat(64),
    targetServiceFingerprintDigestSha256: "0".repeat(64),
    createdAtMs: 1_752_560_123_456,
    ...overrides,
  };
}

function makeReceipt(
  overrides: Partial<ProductionRuntimeVaultRecoveryReceiptInput> = {},
): ProductionRuntimeVaultRecoveryReceipt {
  const created = createProductionRuntimeVaultRecoveryReceipt(
    makeReceiptInput(overrides),
    AUTHORITY_KEY,
  );
  expect(created.ok).toBe(true);
  if (!created.ok) throw new Error("test receipt construction failed");
  return created.value;
}

function makeRoot(): string {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), "comis-receipt-store-")));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

function makeStore(
  root: string,
  options: Parameters<typeof createProductionRuntimeVaultReceiptStoreForTests>[0]["io"] = undefined,
): ProductionRuntimeVaultReceiptStoreTestHarness {
  const created = createProductionRuntimeVaultReceiptStoreForTests({
    stateRoot: root,
    authorityKey: AUTHORITY_KEY,
    io: options,
  });
  expect(created.ok).toBe(true);
  if (!created.ok) throw new Error("test receipt store construction failed");
  return created.value;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("production runtime vault controller receipt store", () => {
  it.runIf(process.platform !== "linux")(
    "fails closed on platforms without the Linux dirfd transaction helper",
    () => {
      expect(
        createProductionRuntimeVaultReceiptStore({
          stateRoot: makeRoot(),
          authorityKey: AUTHORITY_KEY,
        }),
      ).toMatchObject({
        ok: false,
        error: { kind: "unsupported_platform" },
      });
    },
  );
  it("durably persists and authenticates a strict receipt before target mutation", () => {
    const root = makeRoot();
    const store = makeStore(root);
    const receipt = makeReceipt();

    const persisted = store.persistReceipt(receipt);

    expect(persisted.ok).toBe(true);
    if (!persisted.ok) return;
    expect(persisted.value.status).toBe("created");
    expect(lstatSync(persisted.value.path).mode & 0o777).toBe(0o600);
    expect(lstatSync(persisted.value.path).nlink).toBe(1);
    expect(lstatSync(persisted.value.path).uid).toBe(process.geteuid?.());
    expect(lstatSync(resolve(root, "runtime-vault-receipts")).mode & 0o777).toBe(0o700);
    expect(lstatSync(resolve(root, "runtime-vault-receipts", receipt.runId)).mode & 0o777).toBe(
      0o700,
    );
    expect(
      lstatSync(resolve(root, "runtime-vault-receipts", receipt.runId, receipt.attemptId)).mode &
        0o777,
    ).toBe(0o700);
    expect(store.readReceipt(receipt.runId, receipt.attemptId)).toEqual({
      ok: true,
      value: receipt,
    });
  });

  it("creates and persists a receipt without exposing the store authority key", () => {
    const root = makeRoot();
    const store = makeStore(root);
    const input = makeReceiptInput();

    const created = store.createAndPersistReceipt(input);

    expect(created).toMatchObject({
      ok: true,
      value: {
        status: "created",
        receipt: { runId: input.runId, attemptId: input.attemptId },
      },
    });
    if (!created.ok) return;
    expect(store.readReceipt(input.runId, input.attemptId)).toEqual({
      ok: true,
      value: created.value.receipt,
    });
  });

  it("returns idempotent success only for the identical authenticated receipt bytes", () => {
    const store = makeStore(makeRoot());
    const receipt = makeReceipt();

    expect(store.persistReceipt(receipt)).toMatchObject({
      ok: true,
      value: { status: "created" },
    });
    expect(store.persistReceipt(receipt)).toMatchObject({
      ok: true,
      value: { status: "already_present" },
    });

    const conflicting = makeReceipt({ createdAtMs: receipt.createdAtMs + 1 });
    expect(store.persistReceipt(conflicting)).toMatchObject({
      ok: false,
      error: { kind: "conflict" },
    });
  });

  it("creates private receipt directories independently of the controller umask", () => {
    const root = makeRoot();
    const store = makeStore(root);
    const receipt = makeReceipt();
    const originalUmask = process.umask(0o777);
    const persisted = (() => {
      try {
        return store.persistReceipt(receipt);
      } finally {
        process.umask(originalUmask);
      }
    })();

    expect(persisted).toMatchObject({ ok: true, value: { status: "created" } });
    expect(lstatSync(resolve(root, "runtime-vault-receipts")).mode & 0o777).toBe(0o700);
  });

  it("rejects noncanonical roots and unsafe symlinked receipt directories", () => {
    const root = makeRoot();
    chmodSync(root, 0o755);
    expect(
      createProductionRuntimeVaultReceiptStoreForTests({
        stateRoot: root,
        authorityKey: AUTHORITY_KEY,
      }),
    ).toMatchObject({ ok: false, error: { kind: "unsafe_state_root" } });
    chmodSync(root, 0o700);

    const rootLink = `${root}-link`;
    symlinkSync(root, rootLink, "dir");
    const linkedRoot = createProductionRuntimeVaultReceiptStoreForTests({
      stateRoot: rootLink,
      authorityKey: AUTHORITY_KEY,
    });
    unlinkSync(rootLink);
    expect(linkedRoot).toMatchObject({
      ok: false,
      error: { kind: "unsafe_state_root" },
    });

    const outside = makeRoot();
    symlinkSync(outside, resolve(root, "runtime-vault-receipts"));
    const store = makeStore(root);
    expect(store.persistReceipt(makeReceipt())).toMatchObject({
      ok: false,
      error: { kind: "unsafe_directory" },
    });
  });

  it.runIf(typeof process.geteuid === "function" && process.geteuid() === 0)(
    "rejects state roots and receipt files owned by another effective user",
    () => {
      const root = makeRoot();
      const originalRoot = lstatSync(root);
      chownSync(root, 65_534, 65_534);
      const wrongRootOwner = createProductionRuntimeVaultReceiptStoreForTests({
        stateRoot: root,
        authorityKey: AUTHORITY_KEY,
      });
      chownSync(root, originalRoot.uid, originalRoot.gid);
      expect(wrongRootOwner).toMatchObject({
        ok: false,
        error: { kind: "unsafe_state_root" },
      });

      const store = makeStore(root);
      const receipt = makeReceipt();
      const persisted = store.persistReceipt(receipt);
      expect(persisted.ok).toBe(true);
      if (!persisted.ok) return;
      const originalFile = lstatSync(persisted.value.path);
      chownSync(persisted.value.path, 65_534, 65_534);
      const wrongFileOwner = store.readReceipt(receipt.runId, receipt.attemptId);
      chownSync(persisted.value.path, originalFile.uid, originalFile.gid);
      expect(wrongFileOwner).toMatchObject({
        ok: false,
        error: { kind: "unsafe_file" },
      });
    },
  );

  it("rejects receipt symlinks hardlinks and broadened file modes", () => {
    const root = makeRoot();
    const store = makeStore(root);
    const receipt = makeReceipt();
    const persisted = store.persistReceipt(receipt);
    expect(persisted.ok).toBe(true);
    if (!persisted.ok) return;

    const hardlink = resolve(root, "receipt-hardlink");
    linkSync(persisted.value.path, hardlink);
    expect(store.readReceipt(receipt.runId, receipt.attemptId)).toMatchObject({
      ok: false,
      error: { kind: "unsafe_file" },
    });
    unlinkSync(hardlink);

    chmodSync(persisted.value.path, 0o644);
    expect(store.readReceipt(receipt.runId, receipt.attemptId)).toMatchObject({
      ok: false,
      error: { kind: "unsafe_file" },
    });
    chmodSync(persisted.value.path, 0o600);

    const original = `${persisted.value.path}.original`;
    linkSync(persisted.value.path, original);
    unlinkSync(persisted.value.path);
    symlinkSync(original, persisted.value.path);
    expect(store.readReceipt(receipt.runId, receipt.attemptId)).toMatchObject({
      ok: false,
      error: { kind: "unsafe_file" },
    });
  });

  it("rejects truncated and authentication-tampered receipt contents", () => {
    const root = makeRoot();
    const store = makeStore(root);
    const receipt = makeReceipt();
    const persisted = store.persistReceipt(receipt);
    expect(persisted.ok).toBe(true);
    if (!persisted.ok) return;

    writeFileSync(persisted.value.path, "{\"truncated\":true}\n", { mode: 0o600 });
    expect(store.readReceipt(receipt.runId, receipt.attemptId)).toMatchObject({
      ok: false,
      error: { kind: "invalid_receipt" },
    });

    const replacement = makeReceipt({ createdAtMs: receipt.createdAtMs + 2 });
    writeFileSync(persisted.value.path, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });
    expect(store.readReceipt(receipt.runId, receipt.attemptId)).toMatchObject({
      ok: false,
      error: { kind: "invalid_receipt" },
    });
  });

  it("preserves a resumable incoming prefix without exposing a failed receipt write", () => {
    const root = makeRoot();
    let writes = 0;
    const failingStore = makeStore(root, {
      write(descriptor, data, offset, length) {
        writes += 1;
        if (writes > 1) throw new Error("simulated boundary failure");
        return writeSync(descriptor, data, offset, Math.min(length, 8));
      },
    });
    const receipt = makeReceipt();
    const paths = failingStore.paths(receipt.runId, receipt.attemptId);
    expect(paths.ok).toBe(true);
    if (!paths.ok) return;

    expect(failingStore.persistReceipt(receipt)).toMatchObject({
      ok: false,
      error: { kind: "io_failure" },
    });
    expect(existsSync(paths.value.receiptPath)).toBe(false);
    expect(readFileSync(paths.value.receiptIncomingPath)).toEqual(
      Buffer.from(serializeProductionRuntimeVaultRecoveryReceipt(receipt)).subarray(0, 8),
    );
    expect(makeStore(root).persistReceipt(receipt)).toMatchObject({
      ok: true,
      value: { status: "created" },
    });
    expect(existsSync(paths.value.receiptIncomingPath)).toBe(false);
  });

  it("creates one authenticated terminal disposition and preserves its receipt", () => {
    const root = makeRoot();
    const store = makeStore(root);
    const receipt = makeReceipt();
    const persisted = store.persistReceipt(receipt);
    expect(persisted.ok).toBe(true);
    if (!persisted.ok) return;

    const first = store.recordTerminal(receipt, "published");
    expect(first).toMatchObject({ ok: true, value: { status: "created" } });
    const repeated = store.recordTerminal(receipt, "published");
    expect(repeated).toMatchObject({ ok: true, value: { status: "already_present" } });
    expect(store.recordTerminal(receipt, "rolled_back")).toMatchObject({
      ok: false,
      error: { kind: "conflict" },
    });
    expect(store.readTerminal(receipt.runId, receipt.attemptId)).toMatchObject({
      ok: true,
      value: {
        disposition: "published",
        receiptAuthorityDigestSha256: receipt.seal.authorityDigestSha256,
      },
    });
    expect(existsSync(persisted.value.path)).toBe(true);
  });

  it("supports every closed terminal disposition and rejects unbound records", () => {
    const dispositions = [
      "published",
      "reused_existing",
      "rolled_back",
      "blocked_corrupt",
    ] as const;

    for (const [index, disposition] of dispositions.entries()) {
      const root = makeRoot();
      const store = makeStore(root);
      const receipt = makeReceipt({
        runId: `runtime-vault-${index}`,
        attemptId: `${index + 1}`.repeat(32),
      });
      expect(store.recordTerminal(receipt, disposition)).toMatchObject({
        ok: false,
        error: { kind: "not_found" },
      });
      expect(store.persistReceipt(receipt).ok).toBe(true);
      expect(store.recordTerminal(receipt, disposition).ok).toBe(true);
      expect(store.readTerminal(receipt.runId, receipt.attemptId)).toMatchObject({
        ok: true,
        value: { disposition },
      });
    }
  });

  it("rejects terminal tampering and resumes failed terminal writes without deleting receipts", () => {
    const root = makeRoot();
    const healthyStore = makeStore(root);
    const receipt = makeReceipt();
    const persisted = healthyStore.persistReceipt(receipt);
    expect(persisted.ok).toBe(true);
    if (!persisted.ok) return;

    const paths = healthyStore.paths(receipt.runId, receipt.attemptId);
    expect(paths.ok).toBe(true);
    if (!paths.ok) return;

    const failingStore = makeStore(root, {
      write() {
        throw new Error("simulated terminal write failure");
      },
    });
    expect(failingStore.recordTerminal(receipt, "blocked_corrupt")).toMatchObject({
      ok: false,
      error: { kind: "io_failure" },
    });
    expect(existsSync(paths.value.terminalPath)).toBe(false);
    expect(existsSync(paths.value.terminalIncomingPath)).toBe(true);
    expect(lstatSync(paths.value.terminalIncomingPath).size).toBe(0);
    expect(readFileSync(persisted.value.path, "utf8").length).toBeGreaterThan(0);

    expect(healthyStore.recordTerminal(receipt, "blocked_corrupt").ok).toBe(true);
    expect(existsSync(paths.value.terminalIncomingPath)).toBe(false);
    const descriptor = openSync(paths.value.terminalPath, constants.O_WRONLY | constants.O_TRUNC);
    writeSync(descriptor, Buffer.from("{\"tampered\":true}\n"));
    closeSync(descriptor);
    expect(healthyStore.readTerminal(receipt.runId, receipt.attemptId)).toMatchObject({
      ok: false,
      error: { kind: "invalid_terminal_record" },
    });
  });

  it("recovers receipt and terminal publication after link-before-unlink crashes", () => {
    const root = makeRoot();
    const healthyStore = makeStore(root);
    const receipt = makeReceipt();
    const paths = healthyStore.paths(receipt.runId, receipt.attemptId);
    expect(paths.ok).toBe(true);
    if (!paths.ok) return;

    const receiptCrashStore = makeStore(root, {
      write(descriptor, data, offset, length) {
        writeSync(descriptor, data, offset, length);
        return 0;
      },
    });
    expect(receiptCrashStore.persistReceipt(receipt)).toMatchObject({
      ok: false,
      error: { kind: "io_failure" },
    });
    expect(existsSync(paths.value.receiptPath)).toBe(false);
    linkSync(paths.value.receiptIncomingPath, paths.value.receiptPath);
    expect(lstatSync(paths.value.receiptIncomingPath).nlink).toBe(2);
    expect(healthyStore.persistReceipt(receipt)).toMatchObject({
      ok: true,
      value: { status: "already_present" },
    });
    expect(existsSync(paths.value.receiptIncomingPath)).toBe(false);
    expect(lstatSync(paths.value.receiptPath).nlink).toBe(1);

    const terminalCrashStore = makeStore(root, {
      write(descriptor, data, offset, length) {
        writeSync(descriptor, data, offset, length);
        return 0;
      },
    });
    expect(terminalCrashStore.recordTerminal(receipt, "published")).toMatchObject({
      ok: false,
      error: { kind: "io_failure" },
    });
    expect(existsSync(paths.value.terminalPath)).toBe(false);
    linkSync(paths.value.terminalIncomingPath, paths.value.terminalPath);
    expect(lstatSync(paths.value.terminalIncomingPath).nlink).toBe(2);
    expect(healthyStore.recordTerminal(receipt, "published")).toMatchObject({
      ok: true,
      value: { status: "already_present" },
    });
    expect(existsSync(paths.value.terminalIncomingPath)).toBe(false);
    expect(lstatSync(paths.value.terminalPath).nlink).toBe(1);
  });

  it("rejects unrelated incoming hardlinks beside an exact authoritative final file", () => {
    const root = makeRoot();
    const store = makeStore(root);
    const receipt = makeReceipt();
    const persisted = store.persistReceipt(receipt);
    expect(persisted.ok).toBe(true);
    if (!persisted.ok) return;
    const paths = store.paths(receipt.runId, receipt.attemptId);
    expect(paths.ok).toBe(true);
    if (!paths.ok) return;

    writeFileSync(
      paths.value.receiptIncomingPath,
      serializeProductionRuntimeVaultRecoveryReceipt(receipt),
      { mode: 0o600, flag: "wx" },
    );
    const unrelated = resolve(root, "unrelated-receipt-hardlink");
    linkSync(paths.value.receiptIncomingPath, unrelated);

    expect(store.persistReceipt(receipt)).toMatchObject({
      ok: false,
      error: { kind: "unsafe_file" },
    });
    expect(existsSync(paths.value.receiptIncomingPath)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
    expect(lstatSync(persisted.value.path).nlink).toBe(1);
  });

  it("does not disclose authority key or stored receipt bytes through boundary errors", () => {
    const root = makeRoot();
    const store = makeStore(root, {
      write() {
        throw new Error(`secret=${Buffer.from(AUTHORITY_KEY).toString("hex")}`);
      },
    });
    const receipt = makeReceipt();
    const result = store.persistReceipt(receipt);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const serializedError = JSON.stringify(result.error);
    expect(serializedError).not.toContain(Buffer.from(AUTHORITY_KEY).toString("hex"));
    expect(serializedError).not.toContain(receipt.seal.authenticationTagSha256);
    expect(serializedError).not.toContain(receipt.payloadPath);
  });

  it("rejects lossy invalid UTF-8 before canonical receipt authentication", () => {
    const root = makeRoot();
    const store = makeStore(root);
    const receipt = makeReceipt({ sourceDataDir: "/srv/source-\ufffd/.comis" });
    const persisted = store.persistReceipt(receipt);
    expect(persisted.ok).toBe(true);
    if (!persisted.ok) return;

    const raw = readFileSync(persisted.value.path);
    const replacement = Buffer.from("\ufffd", "utf8");
    const replacementOffset = raw.indexOf(replacement);
    expect(replacementOffset).toBeGreaterThanOrEqual(0);
    const invalid = Buffer.concat([
      raw.subarray(0, replacementOffset),
      Buffer.from([0xff]),
      raw.subarray(replacementOffset + replacement.length),
    ]);
    writeFileSync(persisted.value.path, invalid, { mode: 0o600 });

    expect(store.readReceipt(receipt.runId, receipt.attemptId)).toMatchObject({
      ok: false,
      error: { kind: "invalid_receipt" },
    });
  });

  it("serializes reentrant publication under one controller-local attempt lock", () => {
    const root = makeRoot();
    const receipt = makeReceipt();
    const innerStore = makeStore(root);
    let innerResult: ReturnType<typeof innerStore.persistReceipt> | undefined;
    let reentered = false;
    const outerStore = makeStore(root, {
      write(descriptor, data, offset, length) {
        if (!reentered) {
          reentered = true;
          innerResult = innerStore.persistReceipt(receipt);
        }
        return writeSync(descriptor, data, offset, length);
      },
    });

    expect(outerStore.persistReceipt(receipt)).toMatchObject({
      ok: true,
      value: { status: "created" },
    });
    expect(innerResult).toMatchObject({
      ok: false,
      error: { kind: "operation_locked" },
    });
    expect(outerStore.readReceipt(receipt.runId, receipt.attemptId)).toEqual({
      ok: true,
      value: receipt,
    });
  });

  it("returns typed invalid-request results for non-string run and attempt identifiers", () => {
    const store = makeStore(makeRoot());
    const malformedRun = 123 as unknown as string;
    const malformedAttempt = ["4".repeat(32)] as unknown as string;

    expect(store.paths(malformedRun, "4".repeat(32))).toMatchObject({
      ok: false,
      error: { kind: "invalid_request", field: "runId" },
    });
    expect(store.readReceipt(malformedRun, "4".repeat(32))).toMatchObject({
      ok: false,
      error: { kind: "invalid_request", field: "runId" },
    });
    expect(store.readTerminal("runtime-vault-a1", malformedAttempt)).toMatchObject({
      ok: false,
      error: { kind: "invalid_request", field: "attemptId" },
    });
  });

  it("returns typed failures for malformed runtime receipt inputs without filesystem mutation", () => {
    const root = makeRoot();
    const store = makeStore(root);
    const malformed = undefined as unknown as ProductionRuntimeVaultRecoveryReceipt;

    expect(store.persistReceipt(malformed)).toMatchObject({
      ok: false,
      error: { kind: "invalid_receipt" },
    });
    expect(store.recordTerminal(malformed, "published")).toMatchObject({
      ok: false,
      error: { kind: "invalid_receipt" },
    });
    expect(existsSync(resolve(root, "runtime-vault-receipts"))).toBe(false);
  });
});
