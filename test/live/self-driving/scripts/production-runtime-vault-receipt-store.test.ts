import { spawn, spawnSync } from "node:child_process";
import { constants } from "node:fs";
import {
  chmodSync,
  chownSync,
  closeSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
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
const linuxHelperToolchainAvailable = (() => {
  if (process.platform !== "linux") return false;
  const checked = spawnSync(
    "/usr/bin/python3",
    [
      "-I",
      "-S",
      "-c",
      "import os,sys; required=(os.open,os.mkdir,os.stat,os.unlink,os.link); " +
        "print(sys.version_info >= (3,12) and all(value in os.supports_dir_fd for value in required) " +
        "and os.stat in os.supports_follow_symlinks and os.link in os.supports_follow_symlinks " +
        "and hasattr(os, 'listxattr'))",
    ],
    { encoding: "utf8", timeout: 5000 },
  );
  return checked.status === 0 && checked.stdout === "True\n" && checked.stderr === "";
})();

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
    maximumArchiveBytes:
      runtimeTreeAttestation.bytes +
      runtimeTreeAttestation.entryCount * 16_384 +
      128 * 1024 * 1024,
    payloadPath: `/opt/comis-replay/runtimes/sha256/${runtimeTreeAttestation.digestSha256}/payload`,
    sourceService: "comis-source.service",
    sourceDataDir: "/srv/source/.comis",
    targetService: "comis-target.service",
    targetDataDir: "/srv/target/.comis",
    targetPackageRoot: targetRuntimeArtifact.packageRoot,
    targetControlDir: `/var/lib/comis-self-driving/runtime-vault/capture-${runId}-${attemptId}`,
    targetIncomingRoot: `/opt/comis-replay/runtimes/sha256/.incoming-${runId}-${attemptId}-${runtimeTreeAttestation.digestSha256}`,
    targetTransactionDir: `/var/lib/comis-self-driving/runtime-vault/transactions/${runId}-${attemptId}`,
    sourceToolchainRecoveryDigestSha256: "7".repeat(64),
    targetToolchainRecoveryDigestSha256: "8".repeat(64),
    sourceServiceRecoveryDigestSha256: "9".repeat(64),
    targetServiceRecoveryDigestSha256: "0".repeat(64),
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

function mutateTestXattr(path: string, operation: "set" | "remove"): void {
  const command =
    operation === "set"
      ? "os.setxattr(sys.argv[1], b'user.comis_receipt_test', b'present')"
      : "os.removexattr(sys.argv[1], b'user.comis_receipt_test')";
  const result = spawnSync(
    "/usr/bin/python3",
    ["-I", "-S", "-c", `import os,sys; ${command}`, path],
    { encoding: "utf8", timeout: 5000 },
  );
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
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
  it("keeps production descendant mutations inside one dirfd-locked transaction helper", () => {
    const source = readFileSync(
      new URL("./production-runtime-vault-receipt-store.ts", import.meta.url),
      "utf8",
    );
    const helperStart = source.indexOf("const LINUX_DIRFD_TRANSACTION_HELPER");
    const helperEnd = source.indexOf("\n`;", helperStart);
    const helper = source.slice(helperStart, helperEnd);
    const primaryStart = source.indexOf(
      "export function createProductionRuntimeVaultReceiptStore(\n",
    );
    const primaryEnd = source.indexOf(
      "export function createProductionRuntimeVaultReceiptStoreForTests(\n",
      primaryStart,
    );
    const primary = source.slice(primaryStart, primaryEnd);

    expect(helperStart).toBeGreaterThanOrEqual(0);
    expect(helperEnd).toBeGreaterThan(helperStart);
    expect(helper).toContain("dir_fd=parent_fd");
    expect(helper).toContain("src_dir_fd=parent_fd");
    expect(helper).toContain("dst_dir_fd=parent_fd");
    expect(helper).toContain("fcntl.flock");
    expect(helper).toContain("os.unlink(incoming_name, dir_fd=parent_fd)");
    expect(helper).toContain("def run_probe(root_fd):");
    expect(helper).toContain("os.listxattr(descriptor)");
    expect(primaryStart).toBeGreaterThan(helperEnd);
    expect(primaryEnd).toBeGreaterThan(primaryStart);
    expect(primary).toContain("invokeLinuxDirfdHelper");
    expect(primary).toContain("rootGuard.descriptor");
    expect(primary).toContain("dispose");
    expect(primary).not.toMatch(/\b(?:mkdirSync|linkSync|unlinkSync)\(/u);
    expect(primary).not.toContain("persistReceipt");
    expect(source).toContain('const PINNED_INTERPRETER_PATH = "/proc/self/fd/4"');
    expect(source).toContain("computeDescriptorSha256");
  });

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

  it.runIf(process.platform === "linux" && !linuxHelperToolchainAvailable)(
    "fails closed when Linux lacks the required Python dirfd toolchain",
    () => {
      expect(
        createProductionRuntimeVaultReceiptStore({
          stateRoot: makeRoot(),
          authorityKey: AUTHORITY_KEY,
        }),
      ).toMatchObject({
        ok: false,
        error: { kind: "unsupported_platform", field: "toolchain" },
      });
    },
  );

  it.runIf(linuxHelperToolchainAvailable)(
    "publishes and reads authenticated receipt state through the Linux helper",
    () => {
      const createdStore = createProductionRuntimeVaultReceiptStore({
        stateRoot: makeRoot(),
        authorityKey: AUTHORITY_KEY,
      });
      expect(createdStore.ok).toBe(true);
      if (!createdStore.ok) return;
      const input = makeReceiptInput();

      const created = createdStore.value.createAndPersistReceipt(input);

      expect(created).toMatchObject({
        ok: true,
        value: { status: "created", receipt: { runId: input.runId } },
      });
      if (!created.ok) return;
      expect(createdStore.value.readReceipt(input.runId, input.attemptId)).toEqual({
        ok: true,
        value: created.value.receipt,
      });
      expect(createdStore.value.recordTerminal(created.value.receipt, "not_started")).toMatchObject({
        ok: true,
        value: { status: "created" },
      });
      expect(createdStore.value.readTerminal(input.runId, input.attemptId)).toMatchObject({
        ok: true,
        value: { disposition: "not_started" },
      });
      expect(createdStore.value.dispose()).toEqual({ ok: true, value: undefined });
      expect(createdStore.value.dispose()).toEqual({ ok: true, value: undefined });
      expect(createdStore.value.readReceipt(input.runId, input.attemptId)).toMatchObject({
        ok: false,
        error: { kind: "invalid_request", field: "store" },
      });
    },
  );

  it.runIf(linuxHelperToolchainAvailable)(
    "functionally probes private dirfd lock link unlink and durability primitives",
    () => {
      const root = makeRoot();
      const createdStore = createProductionRuntimeVaultReceiptStore({
        stateRoot: root,
        authorityKey: AUTHORITY_KEY,
      });
      expect(createdStore.ok).toBe(true);
      if (!createdStore.ok) return;
      const probeDirectory = resolve(root, ".receipt-store-probe");

      expect(lstatSync(probeDirectory).mode & 0o777).toBe(0o700);
      expect(lstatSync(resolve(probeDirectory, ".receipt-store.lock")).mode & 0o777).toBe(
        0o600,
      );
      expect(existsSync(resolve(probeDirectory, "probe-final"))).toBe(false);
      expect(existsSync(resolve(probeDirectory, ".probe-incoming"))).toBe(false);
      expect(createdStore.value.dispose()).toEqual({ ok: true, value: undefined });
    },
  );

  it.runIf(linuxHelperToolchainAvailable)(
    "rejects a state-root name replacement after the production store is created",
    () => {
      const root = makeRoot();
      const createdStore = createProductionRuntimeVaultReceiptStore({
        stateRoot: root,
        authorityKey: AUTHORITY_KEY,
      });
      expect(createdStore.ok).toBe(true);
      if (!createdStore.ok) return;
      const displaced = `${root}-displaced`;
      renameSync(root, displaced);
      roots.push(displaced);
      mkdirSync(root, { mode: 0o700 });
      chmodSync(root, 0o700);

      expect(createdStore.value.createAndPersistReceipt(makeReceiptInput())).toMatchObject({
        ok: false,
        error: { kind: "unsafe_state_root" },
      });
      expect(existsSync(resolve(root, "runtime-vault-receipts"))).toBe(false);
      expect(existsSync(resolve(displaced, "runtime-vault-receipts"))).toBe(false);
      expect(createdStore.value.dispose()).toEqual({ ok: true, value: undefined });
    },
  );

  it.runIf(linuxHelperToolchainAvailable)(
    "rejects a deleted state root even when its device and inode can be reused",
    () => {
      const root = makeRoot();
      const original = lstatSync(root);
      const createdStore = createProductionRuntimeVaultReceiptStore({
        stateRoot: root,
        authorityKey: AUTHORITY_KEY,
      });
      expect(createdStore.ok).toBe(true);
      if (!createdStore.ok) return;

      rmSync(root, { recursive: true });
      let replacementMatchesOriginal = false;
      for (let attempt = 0; attempt < 1024; attempt += 1) {
        mkdirSync(root, { mode: 0o700 });
        chmodSync(root, 0o700);
        const replacement = lstatSync(root);
        if (replacement.dev === original.dev && replacement.ino === original.ino) {
          replacementMatchesOriginal = true;
          break;
        }
        rmSync(root, { recursive: true });
      }
      if (!existsSync(root)) {
        mkdirSync(root, { mode: 0o700 });
        chmodSync(root, 0o700);
      }

      expect(createdStore.value.createAndPersistReceipt(makeReceiptInput())).toMatchObject({
        ok: false,
        error: { kind: "unsafe_state_root" },
      });
      expect(existsSync(resolve(root, "runtime-vault-receipts"))).toBe(false);
      expect(createdStore.value.dispose()).toEqual({ ok: true, value: undefined });
      expect(replacementMatchesOriginal).toBe(false);
    },
  );

  it.runIf(linuxHelperToolchainAvailable)(
    "rejects extended metadata on the root and authoritative receipt file",
    () => {
      const rootWithMetadata = makeRoot();
      mutateTestXattr(rootWithMetadata, "set");
      expect(
        createProductionRuntimeVaultReceiptStore({
          stateRoot: rootWithMetadata,
          authorityKey: AUTHORITY_KEY,
        }),
      ).toMatchObject({ ok: false, error: { kind: "unsafe_state_root" } });

      const root = makeRoot();
      const createdStore = createProductionRuntimeVaultReceiptStore({
        stateRoot: root,
        authorityKey: AUTHORITY_KEY,
      });
      expect(createdStore.ok).toBe(true);
      if (!createdStore.ok) return;
      const created = createdStore.value.createAndPersistReceipt(makeReceiptInput());
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const paths = createdStore.value.paths(
        created.value.receipt.runId,
        created.value.receipt.attemptId,
      );
      expect(paths.ok).toBe(true);
      if (!paths.ok) return;
      mutateTestXattr(paths.value.receiptDirectory, "set");
      expect(
        createdStore.value.readReceipt(created.value.receipt.runId, created.value.receipt.attemptId),
      ).toMatchObject({ ok: false, error: { kind: "unsafe_directory" } });
      mutateTestXattr(paths.value.receiptDirectory, "remove");

      mutateTestXattr(created.value.path, "set");
      expect(
        createdStore.value.readReceipt(created.value.receipt.runId, created.value.receipt.attemptId),
      ).toMatchObject({ ok: false, error: { kind: "unsafe_file" } });
      expect(createdStore.value.dispose()).toEqual({ ok: true, value: undefined });

      const lockRoot = makeRoot();
      const lockStore = createProductionRuntimeVaultReceiptStore({
        stateRoot: lockRoot,
        authorityKey: AUTHORITY_KEY,
      });
      expect(lockStore.ok).toBe(true);
      if (!lockStore.ok) return;
      expect(lockStore.value.dispose()).toEqual({ ok: true, value: undefined });
      mutateTestXattr(resolve(lockRoot, ".receipt-store-probe", ".receipt-store.lock"), "set");
      expect(
        createProductionRuntimeVaultReceiptStore({
          stateRoot: lockRoot,
          authorityKey: AUTHORITY_KEY,
        }),
      ).toMatchObject({ ok: false, error: { kind: "unsafe_directory" } });
    },
  );

  it.runIf(linuxHelperToolchainAvailable)(
    "returns a typed lock timeout while another process owns the attempt transaction",
    async () => {
      const root = makeRoot();
      const createdStore = createProductionRuntimeVaultReceiptStore({
        stateRoot: root,
        authorityKey: AUTHORITY_KEY,
      });
      expect(createdStore.ok).toBe(true);
      if (!createdStore.ok) return;
      const created = createdStore.value.createAndPersistReceipt(makeReceiptInput());
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const receiptPaths = createdStore.value.paths(
        created.value.receipt.runId,
        created.value.receipt.attemptId,
      );
      expect(receiptPaths.ok).toBe(true);
      if (!receiptPaths.ok) return;
      const lockPath = resolve(receiptPaths.value.receiptDirectory, ".receipt-store.lock");
      const holder = spawn(
        "/usr/bin/python3",
        [
          "-I",
          "-S",
          "-c",
          "import fcntl,sys,time; value=open(sys.argv[1], 'r+b'); fcntl.flock(value, fcntl.LOCK_EX); print('locked', flush=True); time.sleep(4)",
          lockPath,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      const ready = new Promise<void>((resolveReady, rejectReady) => {
        const timer = setTimeout(() => rejectReady(new Error("lock holder readiness timed out")), 5000);
        holder.once("error", rejectReady);
        holder.stdout.once("data", (value: Buffer) => {
          clearTimeout(timer);
          value.toString("utf8") === "locked\n"
            ? resolveReady()
            : rejectReady(new Error("lock holder emitted an unexpected readiness frame"));
        });
      });
      try {
        await ready;
        expect(
          createdStore.value.readReceipt(
            created.value.receipt.runId,
            created.value.receipt.attemptId,
          ),
        ).toMatchObject({
          ok: false,
          error: { kind: "operation_locked" },
        });
      } finally {
        if (holder.exitCode === null && holder.signalCode === null) {
          const exited = new Promise<void>((resolveExited) =>
            holder.once("exit", () => resolveExited()),
          );
          holder.kill("SIGKILL");
          await exited;
        }
        expect(createdStore.value.dispose()).toEqual({ ok: true, value: undefined });
      }
    },
    10_000,
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
      "not_started",
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

  it("rejects lossy invalid UTF-8 before terminal-record authentication", () => {
    const root = makeRoot();
    const store = makeStore(root);
    const receipt = makeReceipt();
    expect(store.persistReceipt(receipt).ok).toBe(true);
    const persisted = store.recordTerminal(receipt, "published");
    expect(persisted.ok).toBe(true);
    if (!persisted.ok) return;

    const raw = readFileSync(persisted.value.path);
    const dispositionOffset = raw.indexOf(Buffer.from("published", "utf8"));
    expect(dispositionOffset).toBeGreaterThanOrEqual(0);
    raw[dispositionOffset] = 0xff;
    writeFileSync(persisted.value.path, raw, { mode: 0o600 });

    expect(store.readTerminal(receipt.runId, receipt.attemptId)).toMatchObject({
      ok: false,
      error: { kind: "invalid_terminal_record" },
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

  it("disposes the portable receipt-store authority copy idempotently", () => {
    const root = makeRoot();
    const store = makeStore(root);
    const input = makeReceiptInput();

    expect(store.dispose()).toEqual({ ok: true, value: undefined });
    expect(store.dispose()).toEqual({ ok: true, value: undefined });
    expect(store.createAndPersistReceipt(input)).toMatchObject({
      ok: false,
      error: { kind: "invalid_request", field: "store" },
    });
    expect(existsSync(resolve(root, "runtime-vault-receipts"))).toBe(false);
  });
});
