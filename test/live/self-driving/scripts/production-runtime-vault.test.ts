import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { err, ok } from "@comis/shared";

import type { ProductionBinarySshBridge } from "./production-binary-ssh.js";
import type {
  ProductionRemoteLeaseClient,
  ProductionRemoteLeaseRequest,
} from "./production-remote-lease.js";
import {
  TARGET_REPLAY_QUARANTINE_SHA256,
  type ProductionRemoteExecutor,
  type ProductionRemoteInvocation,
} from "./production-bootstrap.js";
import type { ProductionReplayProfile } from "./production-profile.js";
import type { RuntimeArtifactAttestation } from "./production-runtime.js";
import type { RuntimeTreeAttestation } from "./production-runtime-tree.js";
import {
  createProductionRuntimeVaultRecoveryReceipt,
  type ProductionRuntimeVaultRecoveryReceipt,
} from "./production-runtime-vault-authority.js";
import type {
  ProductionRuntimeVaultReceiptStore,
  ProductionRuntimeVaultTerminalDisposition,
  ProductionRuntimeVaultTerminalRecord,
} from "./production-runtime-vault-receipt-store.js";
import {
  PRODUCTION_SERVICE_FINGERPRINT_BEGIN,
  PRODUCTION_SERVICE_FINGERPRINT_END,
  computeProductionServiceRecoveryDigest,
  type ProductionServiceFingerprint,
} from "./production-service-fingerprint.js";
import {
  TOOLCHAIN_HELPERS,
  TOOLCHAIN_ROOT_SCRIPT_PREFIX,
  TOOLCHAIN_ROOT_SHELL_PREFIX,
  createToolchainContractV1,
  serializeToolchainContract,
  type ToolchainContractV1,
  type ToolchainRole,
} from "./production-toolchain-contract.js";
import {
  RUNTIME_VAULT_FORWARD_PHASES,
  RUNTIME_VAULT_TRANSACTION_STATUS_BEGIN,
  RUNTIME_VAULT_TRANSACTION_STATUS_END,
  type ProductionRuntimeVaultJournalPhase,
} from "./production-runtime-vault-transaction.js";
import {
  RUNTIME_VAULT_STATUS_BEGIN,
  RUNTIME_VAULT_STATUS_END,
  buildProductionRuntimeVaultPlan,
  buildProductionRuntimeVaultPlanBase,
  inspectProductionRuntimeVault,
  recoverProductionRuntimeVault,
  sealProductionRuntime,
} from "./production-runtime-vault.js";

const profile: ProductionReplayProfile = {
  source: {
    ssh: "source-host",
    sshPort: 2222,
    role: "production",
    comisUser: "comis",
    dataDir: "/srv/source/.comis",
    service: "comis-source",
    expectedMachineIdSha256: "a".repeat(64),
  },
  target: {
    ssh: "target-host",
    sshPort: 2202,
    role: "test",
    comisUser: "comis-test",
    dataDir: "/srv/target/.comis",
    service: "comis-target",
    expectedMachineIdSha256: "b".repeat(64),
  },
};

const sourceRuntime: RuntimeArtifactAttestation = {
  digestSha256: "c".repeat(64),
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
  tzdataSha256: "1".repeat(64),
  launcherKind: "systemd",
  applicationLauncherSha256: "2".repeat(64),
  confinementKind: "source",
  confinementSha256: "none",
  browserStatus: "available",
  browserSha256: "3".repeat(64),
  mediaStatus: "available",
  mediaSha256: "4".repeat(64),
  nativeToolsStatus: "available",
  nativeToolsSha256: "5".repeat(64),
};

const targetRuntime: RuntimeArtifactAttestation = {
  ...sourceRuntime,
  digestSha256: "d".repeat(64),
  entryCount: 84_170,
  bytes: 3_269_453_213,
  packageRoot: "/opt/target/node_modules/comisai",
  version: "1.1.0",
  kernelRelease: "6.8.0-72-generic",
  nodeAbi: "128",
  timezone: "Etc/UTC",
  confinementKind: "target_quarantine",
  confinementSha256: TARGET_REPLAY_QUARANTINE_SHA256,
};

const sourceTree: RuntimeTreeAttestation = {
  digestSha256: "e".repeat(64),
  entryCount: 91_456,
  bytes: 3_269_438_185,
  root: sourceRuntime.packageRoot,
  version: sourceRuntime.version,
};

const attemptId = "6".repeat(32);
const authorityDigestSha256 = "7".repeat(64);
const receiptAuthorityKey = Buffer.from("runtime-vault-test-authority-key-material", "utf8");

function testToolchain(
  role: ToolchainRole,
  bootIdSha256 = (role === "source" ? "1" : "2").repeat(64),
  kernelIdentitySha256 = "3".repeat(64),
): ToolchainContractV1 {
  const created = createToolchainContractV1({
    role,
    machineIdSha256:
      role === "source"
        ? profile.source.expectedMachineIdSha256
        : profile.target.expectedMachineIdSha256,
    bootIdSha256,
    kernelIdentitySha256,
    tools: Object.entries(TOOLCHAIN_HELPERS).map(([name, path], index) => ({
      name: name as keyof typeof TOOLCHAIN_HELPERS,
      path,
      resolvedPath: path,
      ownerUid: 0 as const,
      ownerGid: 0 as const,
      modeOctal: "0755",
      pathChainRootOwned: true as const,
      pathChainNonWritable: true as const,
      pathIdentitySha256: (index % 10).toString().repeat(64),
      binarySha256: ((index + 1) % 10).toString().repeat(64),
      versionSha256: ((index + 2) % 10).toString().repeat(64),
    })),
  });
  expect(created.ok).toBe(true);
  if (!created.ok) throw new Error("test toolchain contract is invalid");
  return created.value;
}

const sourceToolchain = testToolchain("source");
const targetToolchain = testToolchain("target");

function serviceFingerprint(
  role: ToolchainRole,
  bootIdSha256 = (role === "source" ? "4" : "5").repeat(64),
  executionDefinitionSha256 = "7".repeat(64),
): ProductionServiceFingerprint {
  const machineIdSha256 =
    role === "source"
      ? profile.source.expectedMachineIdSha256
      : profile.target.expectedMachineIdSha256;
  const service = role === "source" ? profile.source.service : profile.target.service;
  const unit = service.endsWith(".service") ? service : `${service}.service`;
  const value = {
    schema: "comis-production-service-fingerprint" as const,
    schemaVersion: 1 as const,
    role,
    machineIdSha256,
    bootIdSha256,
    unitSha256: createHash("sha256").update(unit, "utf8").digest("hex"),
    propertySnapshotSha256: "6".repeat(64),
    executionDefinitionSha256,
    loadState: "loaded" as const,
    activeState: "inactive" as const,
    subState: "dead" as const,
    mainPid: 0 as const,
    controlPid: 0 as const,
    execMainPid: 0 as const,
    stabilityMethod: "bounded_double_scan" as const,
    stable: true as const,
  };
  const fingerprintSha256 = createHash("sha256")
    .update("comis-production-service-fingerprint-v1\0", "utf8")
    .update(value.role, "utf8")
    .update("\0", "utf8")
    .update(value.machineIdSha256, "utf8")
    .update("\0", "utf8")
    .update(value.bootIdSha256, "utf8")
    .update("\0", "utf8")
    .update(value.unitSha256, "utf8")
    .update("\0", "utf8")
    .update(value.propertySnapshotSha256, "utf8")
    .update("\0", "utf8")
    .update(value.executionDefinitionSha256, "utf8")
    .update("\0", "utf8")
    .digest("hex");
  return { ...value, fingerprintSha256 };
}

const sourceServiceFingerprint = serviceFingerprint("source");
const targetServiceFingerprint = serviceFingerprint("target");

function makeRecoveryReceipt(runId: string): ProductionRuntimeVaultRecoveryReceipt {
  const base = buildProductionRuntimeVaultPlanBase({
    runId,
    attemptId,
    profile,
    sourceRuntime,
    targetRuntime,
    sourceTree,
  });
  const sourceServiceRecovery = computeProductionServiceRecoveryDigest(
    sourceServiceFingerprint,
  );
  const targetServiceRecovery = computeProductionServiceRecoveryDigest(
    targetServiceFingerprint,
  );
  expect(base.ok).toBe(true);
  expect(sourceServiceRecovery.ok).toBe(true);
  expect(targetServiceRecovery.ok).toBe(true);
  if (!base.ok || !sourceServiceRecovery.ok || !targetServiceRecovery.ok) {
    throw new Error("test recovery receipt prerequisites are invalid");
  }
  const created = createProductionRuntimeVaultRecoveryReceipt(
    {
      schemaVersion: 1,
      runId,
      attemptId,
      sourceMachineIdSha256: profile.source.expectedMachineIdSha256,
      targetMachineIdSha256: profile.target.expectedMachineIdSha256,
      sourceRuntimeArtifact: sourceRuntime,
      targetRuntimeArtifact: targetRuntime,
      runtimeTreeAttestation: sourceTree,
      maximumArchiveBytes: base.value.maximumArchiveBytes,
      payloadPath: base.value.payloadPath,
      sourceService: profile.source.service,
      sourceDataDir: profile.source.dataDir,
      targetService: profile.target.service,
      targetDataDir: profile.target.dataDir,
      targetPackageRoot: targetRuntime.packageRoot,
      targetControlDir: base.value.targetControlDir,
      targetIncomingRoot: base.value.targetIncomingRoot,
      targetTransactionDir: base.value.targetTransactionDir,
      sourceToolchainRecoveryDigestSha256:
        sourceToolchain.toolchainRecoveryDigestSha256,
      targetToolchainRecoveryDigestSha256:
        targetToolchain.toolchainRecoveryDigestSha256,
      sourceServiceRecoveryDigestSha256: sourceServiceRecovery.value,
      targetServiceRecoveryDigestSha256: targetServiceRecovery.value,
      createdAtMs: 1_752_560_123_456,
    },
    receiptAuthorityKey,
  );
  expect(created.ok).toBe(true);
  if (!created.ok) throw new Error("test recovery receipt is invalid");
  return created.value;
}

function makeMemoryReceiptStore(
  receipt: ProductionRuntimeVaultRecoveryReceipt | undefined = undefined,
  events: string[] = [],
  initialTerminal: ProductionRuntimeVaultTerminalDisposition | undefined = undefined,
): ProductionRuntimeVaultReceiptStore {
  let stored = receipt;
  const makeTerminal = (
    value: ProductionRuntimeVaultRecoveryReceipt,
    disposition: ProductionRuntimeVaultTerminalDisposition,
  ): ProductionRuntimeVaultTerminalRecord => ({
    schema: "comis-runtime-vault-terminal-record",
    schemaVersion: 1,
    runId: value.runId,
    attemptId: value.attemptId,
    disposition,
    authorityKeyIdSha256: value.seal.authorityKeyIdSha256,
    receiptAuthorityDigestSha256: value.seal.authorityDigestSha256,
    receiptDigestSha256: "0".repeat(64),
    authenticationTagSha256: "1".repeat(64),
  });
  let terminal =
    receipt !== undefined && initialTerminal !== undefined
      ? makeTerminal(receipt, initialTerminal)
      : undefined;
  return {
    createAndPersistReceipt(input) {
      events.push("receipt:create");
      const created = createProductionRuntimeVaultRecoveryReceipt(
        input,
        receiptAuthorityKey,
      );
      if (!created.ok) {
        return err({
          kind: "invalid_receipt" as const,
          field: "receipt" as const,
          message: "test receipt creation failed",
        });
      }
      stored = created.value;
      return ok({
        status: "created" as const,
        path: "/controller/runtime-vault-receipt.json",
        receipt: created.value,
      });
    },
    paths(runId, requestedAttemptId) {
      return ok({
        receiptDirectory: `/controller/${runId}/${requestedAttemptId}`,
        receiptPath: `/controller/${runId}/${requestedAttemptId}/recovery-receipt.json`,
        receiptIncomingPath:
          `/controller/${runId}/${requestedAttemptId}/.recovery-receipt.json.incoming`,
        terminalPath: `/controller/${runId}/${requestedAttemptId}/terminal.json`,
        terminalIncomingPath: `/controller/${runId}/${requestedAttemptId}/.terminal.json.incoming`,
      });
    },
    readReceipt() {
      events.push("receipt:read");
      return stored === undefined
        ? err({
            kind: "not_found" as const,
            field: "receipt" as const,
            message: "test receipt is absent",
          })
        : ok(stored);
    },
    recordTerminal(boundReceipt, disposition) {
      events.push(`terminal:${disposition}`);
      if (terminal !== undefined && terminal.disposition !== disposition) {
        return err({
          kind: "conflict" as const,
          field: "terminalRecord" as const,
          message: "test terminal disposition conflicts",
        });
      }
      const status = terminal === undefined ? "created" : "already_present";
      terminal = makeTerminal(boundReceipt, disposition);
      return ok({ status, path: "/controller/terminal.json" });
    },
    readTerminal() {
      events.push("terminal:read");
      return ok(terminal);
    },
    dispose() {
      events.push("receipt:dispose");
      return ok(undefined);
    },
  };
}

function transactionObservation(
  transactionIdentitySha256: string,
  phases: readonly ProductionRuntimeVaultJournalPhase[],
  finalState: "absent" | "exact" | "conflict",
  authority = authorityDigestSha256,
): string {
  return [
    RUNTIME_VAULT_TRANSACTION_STATUS_BEGIN,
    "transactionState=present",
    "manifestState=valid",
    `authorityDigestSha256=${authority}`,
    `transactionIdentitySha256=${transactionIdentitySha256}`,
    ...phases.map((phase) => `phase=${phase}`),
    `finalState=${finalState}`,
    RUNTIME_VAULT_TRANSACTION_STATUS_END,
    "",
  ].join("\n");
}

function makeLeaseClient(
  requests: ProductionRemoteLeaseRequest[] = [],
  releases: string[] = [],
): ProductionRemoteLeaseClient {
  return {
    acquire: async (request) => {
      requests.push(request);
      return ok({
        release: async () => {
          releases.push(request.label);
          return ok({ exitCode: 0 as const });
        },
      });
    },
  };
}

describe("production runtime content addressed vault", () => {
  it("derives authenticated receipt paths before an authority digest exists", () => {
    const result = buildProductionRuntimeVaultPlanBase({
      runId: "runtime-vault-base-a1",
      profile,
      attemptId,
      sourceRuntime,
      targetRuntime,
      sourceTree,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        payloadPath: `/opt/comis-replay/runtimes/sha256/${sourceTree.digestSha256}/payload`,
        maximumArchiveBytes:
          sourceTree.bytes + sourceTree.entryCount * 16_384 + 128 * 1024 * 1024,
        targetControlDir:
          `/var/lib/comis-self-driving/runtime-vault/capture-runtime-vault-base-a1-${attemptId}`,
        targetIncomingRoot:
          `/opt/comis-replay/runtimes/sha256/.incoming-runtime-vault-base-a1-${attemptId}-${sourceTree.digestSha256}`,
        targetTransactionDir:
          `/var/lib/comis-self-driving/runtime-vault/transactions/runtime-vault-base-a1-${attemptId}`,
      },
    });
  });

  it("builds an additive vault stream without requiring a replay entrypoint", () => {
    const result = buildProductionRuntimeVaultPlan({
      runId: "runtime-vault-a1",
      profile,
      attemptId,
      authorityDigestSha256,
      sourceRuntime,
      targetRuntime,
      sourceTree,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const plan = result.value;
    const finalRoot = `/opt/comis-replay/runtimes/sha256/${sourceTree.digestSha256}`;

    expect(plan.payloadPath).toBe(`${finalRoot}/payload`);
    expect(plan.transactionIdentitySha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(plan.controllerLease).toMatchObject({
      label: "runtime-vault-controller",
      host: profile.target.ssh,
      readyLine: `COMIS_RUNTIME_VAULT_CONTROLLER_READY_${attemptId}`,
    });
    expect(plan.controllerLease.args).toContain(attemptId);
    expect(plan.controllerLease.args).toContain(authorityDigestSha256);
    expect(plan.controllerLease.args).toContain(plan.transactionIdentitySha256);
    expect(plan.controllerLease.remoteProgram).toContain("COMIS_RUNTIME_CONTROLLER_LOCK");
    expect(plan.controllerLease.remoteProgram).toContain("flock -n 8");
    expect(plan.controllerLease.remoteProgram).toContain(
      'install -d -m 0700 -o root -g root "$transaction_parent"',
    );
    expect(
      plan.controllerLease.remoteProgram.indexOf(
        'install -d -m 0700 -o root -g root "$transaction_parent"',
      ),
    ).toBeLessThan(plan.controllerLease.remoteProgram.indexOf(plan.controllerLease.readyLine));
    expect(plan.controllerLease.args.slice(0, TOOLCHAIN_ROOT_SHELL_PREFIX.length)).toEqual(
      TOOLCHAIN_ROOT_SHELL_PREFIX,
    );
    expect(plan.stream.source).toMatchObject({
      host: profile.source.ssh,
      port: profile.source.sshPort,
      args: [
        ...TOOLCHAIN_ROOT_SHELL_PREFIX,
        profile.source.expectedMachineIdSha256,
        profile.source.service,
        sourceTree.root,
        sourceTree.digestSha256,
        String(sourceTree.entryCount),
        String(sourceTree.bytes),
        sourceTree.version,
      ],
    });
    expect(plan.stream.sourceStdin).toContain("tar --create");
    expect(plan.stream.sourceStdin).toContain("--zstd");
    expect(plan.stream.sourceStdin).toContain("unshare --mount");
    expect(plan.stream.sourceStdin).toContain("remount,bind,ro,noatime,nodiratime");
    expect(plan.stream.sourceStdin).toContain("findmnt");
    expect(plan.stream.sourceStdin).toContain("--pax-option=delete=atime,delete=ctime");
    expect(plan.stream.sourceStdin).not.toContain("--atime-preserve");
    expect(plan.stream.sourceStdin).not.toContain("daemon-entrypoint.js");
    expect(plan.stream.sourceStdin).not.toContain("daemon.js");
    expect(plan.stream.maximumBytes).toBeGreaterThan(sourceTree.bytes);
    expect(plan.stream.target.args).toContain(
      `/var/lib/comis-self-driving/runtime-vault/capture-runtime-vault-a1-${attemptId}/receive.sh`,
    );
    expect(plan.stream.target.args.slice(0, TOOLCHAIN_ROOT_SCRIPT_PREFIX.length)).toEqual(
      TOOLCHAIN_ROOT_SCRIPT_PREFIX,
    );
    expect(plan.stream.target.args.slice(0, 2)).not.toEqual(["sudo", "bash"]);
    expect(plan.targetPrepare.args).toContain(targetRuntime.packageRoot);
    expect(plan.targetPrepare.stdin).toContain("environment-role");
    expect(plan.targetPrepare.stdin).toContain(
      'transaction_dir="$transaction_parent/$run_id-$attempt_id"',
    );
    expect(plan.targetFinishPublish.stdin).toContain(
      "runtime_journal_finish_forward published",
    );
    expect(plan.targetFinishPublish.stdin).toContain(
      "runtime_journal_finish_forward cleanup_complete",
    );
    expect(plan.targetFinishPublish.stdin).not.toContain(
      "runtime_journal_append published",
    );
    expect(
      plan.targetFinishPublish.stdin.indexOf(
        "runtime_journal_finish_forward published",
      ),
    ).toBeLessThan(plan.targetFinishPublish.stdin.indexOf('rm -rf -- "$control_dir"'));
    expect(plan.targetFinishPublish.stdin.indexOf('rm -rf -- "$control_dir"')).toBeLessThan(
      plan.targetFinishPublish.stdin.lastIndexOf(
        "runtime_journal_finish_forward cleanup_complete",
      ),
    );
    expect(plan.targetPrepare.stdin).toContain("systemctl is-active");
    expect(plan.targetPrepare.stdin).toContain("systemctl is-enabled");
    expect(plan.targetPrepare.stdin).toContain(TARGET_REPLAY_QUARANTINE_SHA256);
    expect(plan.targetPrepare.stdin).toContain("PrivateNetwork");
    expect(plan.targetPrepare.stdin).toContain("flock -n");
    expect(plan.targetPrepare.stdin).toContain("os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW");
    expect(plan.targetPrepare.stdin).toContain("value.st_nlink != 1");
    expect(plan.targetPrepare.stdin).toContain("os.listxattr(lock_path");
    expect(plan.targetPrepare.stdin).not.toContain('chmod 0600 "$operation_lock"');
    expect(plan.targetPrepare.stdin).toContain("expected_transaction_identity");
    expect(plan.targetPrepare.stdin).not.toContain("json.dumps(sys.argv[1:]");
    expect(plan.targetPrepare.stdin).toContain("expected_authority_digest");
    expect(plan.targetPrepare.stdin).toContain("COMIS_RUNTIME_TRANSACTION_MANIFEST");
    expect(plan.targetPrepare.stdin).toContain("runtime_journal_initialize");
    expect(plan.targetPrepare.stdin).toContain(
      "runtime_journal_append prepare_intent",
    );
    expect(plan.targetPrepare.stdin).toContain("runtime_journal_append prepared");
    expect(plan.stream.target.args.join(" ")).toContain("receive.sh");
    expect(plan.targetPrepare.stdin).toContain("runtime_journal_append receive_intent");
    expect(plan.targetPrepare.stdin).toContain("runtime_journal_append received");
    expect(plan.targetVerify.stdin).toContain("runtime_journal_append verify_intent");
    expect(plan.targetVerify.stdin).toContain("runtime_journal_append verified");
    expect(plan.targetPublish.stdin).toContain("runtime_journal_append publish_intent");
    expect(plan.targetPublish.stdin).toContain("runtime_journal_append published");
    expect(plan.targetPublish.stdin).toContain("runtime_journal_append cleanup_complete");
    expect(plan.targetRollback.stdin).toContain("runtime_journal_append rollback_intent");
    expect(plan.targetRollback.stdin).toContain("runtime_journal_append rolled_back");
    expect(plan.targetTransactionStatus.label).toBe(
      "observe-runtime-vault-transaction-target",
    );
    expect(plan.targetTransactionStatus.stdin).toContain(
      "COMIS_RUNTIME_VAULT_TRANSACTION_STATUS_V1_BEGIN",
    );
    expect(plan.targetTransactionStatus.stdin).toContain("final_state=conflict");
    expect(plan.targetFinishPublish.stdin).not.toContain('rm -rf -- "$final_root"');
    expect(plan.targetPrepare.stdin).toContain(
      "install -d -m 0700 -o root -g root /opt/comis-replay",
    );
    expect(plan.targetPrepare.stdin).toContain("mount_overlap_status=0");
    expect(plan.targetPrepare.stdin).toContain("|| mount_overlap_status=$?");
    expect(plan.targetPrepare.stdin).toContain('"$target_package_root"');
    expect(plan.targetPrepare.stdin).toContain("coordination_parent=/var/lib/comis-self-driving");
    expect(plan.targetPrepare.stdin).toContain('exec 9<>"$operation_lock"');
    expect(plan.targetPrepare.stdin.match(/if ! flock -n 9/g)?.length).toBeGreaterThanOrEqual(2);
    for (const command of [
      plan.targetPrepare,
      plan.targetVerify,
      plan.targetPublish,
      plan.targetRollback,
      plan.targetTransactionStatus,
      plan.targetFinishPublish,
    ]) {
      expect(command.args.slice(0, TOOLCHAIN_ROOT_SHELL_PREFIX.length)).toEqual(
        TOOLCHAIN_ROOT_SHELL_PREFIX,
      );
      expect(command.stdin, command.label).toContain(
        "COMIS_RUNTIME_CONTROLLER_LEASE_HELD_GUARD",
      );
    }
    for (const command of [
      plan.targetVerify,
      plan.targetPublish,
      plan.targetRollback,
      plan.targetTransactionStatus,
      plan.targetFinishPublish,
    ]) {
      expect(command.stdin, command.label).toContain("COMIS_RUNTIME_OPERATION_LOCK_GUARD");
      expect(command.stdin, command.label).toContain("os.O_NOFOLLOW");
      expect(command.stdin, command.label).toContain("opened.st_ino");
    }
    expect(plan.targetRollback.stdin).not.toContain(
      "COMIS_RUNTIME_CONTROLLER_LEASE_ACQUIRE_GUARD",
    );
  });

  it("never mutates the installed package or normal service", () => {
    const result = buildProductionRuntimeVaultPlan({
      runId: "runtime-preserve-a1",
      profile,
      attemptId,
      authorityDigestSha256,
      sourceRuntime,
      targetRuntime,
      sourceTree,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const targetPrograms = [
      result.value.targetPrepare.stdin,
      result.value.targetVerify.stdin,
      result.value.targetPublish.stdin,
      result.value.targetRollback.stdin,
    ].join("\n");

    expect(targetPrograms).not.toContain("rollback_root");
    expect(targetPrograms).not.toMatch(
      /systemctl\s+(?:start|stop|restart|enable|disable|kill|mask|unmask)/u,
    );
    expect(targetPrograms).not.toMatch(/(?:rm|mv|chown)[^\n]*package_root/u);
    expect(targetPrograms).not.toContain("daemon-entrypoint.js");
    expect(targetPrograms).not.toContain("daemon.js");
    expect(result.value.targetRollback.stdin).not.toContain('rm -rf -- "$final_root"');
    expect(result.value.targetRollback.stdin).not.toContain("kill -TERM");
    expect(result.value.targetRollback.stdin).not.toContain("receiver_pid");
  });

  it("extracts defensively and publishes with no replacement plus durable barriers", () => {
    const result = buildProductionRuntimeVaultPlan({
      runId: "runtime-publish-a1",
      profile,
      attemptId,
      authorityDigestSha256,
      sourceRuntime,
      targetRuntime,
      sourceTree,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const prepare = result.value.targetPrepare.stdin;
    expect(prepare).toContain("tarfile.data_filter");
    expect(prepare).toMatch(/filtered\s*=\s*filtered\.replace\([\s\S]*mode=member\.mode & 0o1777/u);
    expect(prepare).toContain("duplicate archive path");
    expect(prepare).toContain("hard link is not supported");
    expect(prepare).toContain("expected_entry_count");
    expect(prepare).toContain("expected_bytes");
    expect(prepare).toContain("class BoundedReader");
    expect(prepare).toContain("maximum_uncompressed_bytes");
    expect(prepare).toContain("setuid or setgid archive mode");
    expect(prepare).toContain("COMIS_RUNTIME_HEADROOM_GUARD");
    expect(prepare).toContain('runtime_headroom /opt "$maximum_archive_bytes"');
    expect(prepare).toContain("os.statvfs(path)");
    const receiver = heredoc(prepare, "COMIS_RUNTIME_RECEIVER");
    expect(receiver).toContain('runtime_headroom /opt "$maximum_archive_bytes"');

    const publish = result.value.targetPublish.stdin;
    expect(publish).toContain("COMIS_RUNTIME_HEADROOM_GUARD");
    expect(publish).toContain("runtime_headroom /opt 134217728 1024");
    expect(publish).toContain("RENAME_NOREPLACE");
    expect(publish).toContain('sync -f "$incoming_root"');
    expect(publish).toContain('sync -f "$vault_root"');
    expect(publish).toContain('sync -f "$final_root"');
    expect(publish.indexOf("RENAME_NOREPLACE")).toBeLessThan(
      publish.lastIndexOf('rm -f -- "$active_capture" "$identity_path"'),
    );
  });

  it("fails the target preflight when bytes or inodes cannot fit the runtime", () => {
    const result = buildProductionRuntimeVaultPlan({
      runId: "runtime-headroom-a1",
      profile,
      attemptId,
      authorityDigestSha256,
      sourceRuntime,
      targetRuntime,
      sourceTree,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const guard = heredoc(
      result.value.targetPrepare.stdin,
      "COMIS_RUNTIME_HEADROOM_GUARD",
    );
    const workspace = mkdtempSync(join(tmpdir(), "comis-runtime-headroom-"));
    try {
      const canonicalWorkspace = realpathSync(workspace);
      const enough = spawnSync("python3", ["-", canonicalWorkspace, "0", "0"], {
        input: guard,
        encoding: "utf8",
      });
      expect(enough.status, enough.stderr).toBe(0);
      const exhausted = spawnSync(
        "python3",
        [
          "-",
          canonicalWorkspace,
          String(Number.MAX_SAFE_INTEGER),
          String(Number.MAX_SAFE_INTEGER),
        ],
        { input: guard, encoding: "utf8" },
      );
      expect(exhausted.status).not.toBe(0);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("preserves root entry ownership modes and nanosecond mtimes in a real extraction", () => {
    const result = buildProductionRuntimeVaultPlan({
      runId: "runtime-roundtrip-a1",
      profile,
      attemptId,
      authorityDigestSha256,
      sourceRuntime,
      targetRuntime,
      sourceTree: { ...sourceTree, entryCount: 4, bytes: 7 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const extractor = heredoc(
      result.value.targetPrepare.stdin,
      "COMIS_RUNTIME_SAFE_EXTRACTOR",
    );
    const workspace = mkdtempSync(join(tmpdir(), "comis-runtime-vault-"));
    try {
      const currentIdentity = lstatSync(workspace);
      const extractorPath = join(workspace, "extract.py");
      const payloadPath = join(workspace, "payload");
      const archivePath = join(workspace, "payload.tar");
      writeFileSync(extractorPath, extractor, { mode: 0o700 });
      chmodSync(workspace, 0o700);
      const archive = spawnSync(
        "python3",
        [
          "-c",
          buildMetadataArchiveProgram(),
          archivePath,
          String(currentIdentity.uid),
          String(currentIdentity.gid),
        ],
        { encoding: "utf8" },
      );
      expect(archive.status, archive.stderr).toBe(0);
      const extracted = spawnSync(
        "python3",
        [extractorPath, payloadPath, "4", "7", "65536"],
        {
        input: readFileSync(archivePath),
        encoding: "utf8",
        },
      );
      expect(extracted.status, extracted.stderr).toBe(0);

      expect(metadata(payloadPath)).toEqual({ mode: 0o1777, mtimeNs: 1_700_000_000_123_456_789n });
      expect(metadata(join(payloadPath, "nested"))).toEqual({
        mode: 0o750,
        mtimeNs: 1_700_000_001_123_456_789n,
      });
      expect(metadata(join(payloadPath, "nested/file.txt"))).toEqual({
        mode: 0o664,
        mtimeNs: 1_700_000_002_123_456_789n,
      });
      const linkMetadata = metadata(join(payloadPath, "link"));
      if (process.platform === "linux") expect(linkMetadata.mode).toBe(0o777);
      expect(linkMetadata.mtimeNs).toBe(1_700_000_003_123_456_789n);
      for (const path of [payloadPath, join(payloadPath, "nested"), join(payloadPath, "nested/file.txt"), join(payloadPath, "link")]) {
        const value = lstatSync(path);
        expect(value.uid).toBe(currentIdentity.uid);
        expect(value.gid).toBe(currentIdentity.gid);
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("accepts repeated safety filtering of the same extracted directory objects", () => {
    const result = buildProductionRuntimeVaultPlan({
      runId: "runtime-directory-refilter-a1",
      profile,
      attemptId,
      authorityDigestSha256,
      sourceRuntime,
      targetRuntime,
      sourceTree: { ...sourceTree, entryCount: 4, bytes: 7 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const workspace = mkdtempSync(join(tmpdir(), "comis-runtime-refilter-"));
    try {
      const extractorPath = join(workspace, "extract.py");
      const payloadPath = join(workspace, "payload");
      const archivePath = join(workspace, "payload.tar");
      writeFileSync(
        extractorPath,
        heredoc(result.value.targetPrepare.stdin, "COMIS_RUNTIME_SAFE_EXTRACTOR"),
        { mode: 0o700 },
      );
      const currentIdentity = lstatSync(workspace);
      const archive = spawnSync(
        "python3",
        [
          "-c",
          buildMetadataArchiveProgram(),
          archivePath,
          String(currentIdentity.uid),
          String(currentIdentity.gid),
        ],
        { encoding: "utf8" },
      );
      expect(archive.status, archive.stderr).toBe(0);

      const extracted = spawnSync(
        "python3",
        [
          "-c",
          buildDirectoryRefilterProgram(),
          extractorPath,
          payloadPath,
          "4",
          "7",
          "65536",
        ],
        { input: readFileSync(archivePath), encoding: "utf8" },
      );

      expect(extracted.status, extracted.stderr).toBe(0);
      expect(existsSync(join(payloadPath, "nested/file.txt"))).toBe(true);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("rejects decompressed archive overhead before a compact stream can expand without bound", () => {
    const result = buildProductionRuntimeVaultPlan({
      runId: "runtime-expand-limit-a1",
      profile,
      attemptId,
      authorityDigestSha256,
      sourceRuntime,
      targetRuntime,
      sourceTree: { ...sourceTree, entryCount: 4, bytes: 7 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const workspace = mkdtempSync(join(tmpdir(), "comis-runtime-limit-"));
    try {
      const extractorPath = join(workspace, "extract.py");
      const payloadPath = join(workspace, "payload");
      const archivePath = join(workspace, "payload.tar");
      writeFileSync(
        extractorPath,
        heredoc(result.value.targetPrepare.stdin, "COMIS_RUNTIME_SAFE_EXTRACTOR"),
        { mode: 0o700 },
      );
      const currentIdentity = lstatSync(workspace);
      const archive = spawnSync(
        "python3",
        [
          "-c",
          buildMetadataArchiveProgram(32_768),
          archivePath,
          String(currentIdentity.uid),
          String(currentIdentity.gid),
        ],
        { encoding: "utf8" },
      );
      expect(archive.status, archive.stderr).toBe(0);
      const extracted = spawnSync(
        "python3",
        [extractorPath, payloadPath, "4", "7", "4096"],
        { input: readFileSync(archivePath), encoding: "utf8" },
      );
      expect(extracted.status).not.toBe(0);
      expect(existsSync(payloadPath)).toBe(false);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("rejects oversized names deep trees unsupported pax fields sparse files and undeclared parents", () => {
    const result = buildProductionRuntimeVaultPlan({
      runId: "runtime-archive-boundaries-a1",
      profile,
      attemptId,
      authorityDigestSha256,
      sourceRuntime,
      targetRuntime,
      sourceTree,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const workspace = mkdtempSync(join(tmpdir(), "comis-runtime-archive-boundaries-"));
    try {
      const extractorPath = join(workspace, "extract.py");
      const archivePath = join(workspace, "payload.tar");
      writeFileSync(
        extractorPath,
        heredoc(result.value.targetPrepare.stdin, "COMIS_RUNTIME_SAFE_EXTRACTOR"),
        { mode: 0o700 },
      );
      const currentIdentity = lstatSync(workspace);
      const cases = [
        {
          scenario: "path_too_long",
          entryCount: 2,
          bytes: 0,
          error: "archive path exceeds 4096 bytes",
        },
        {
          scenario: "tree_too_deep",
          entryCount: 258,
          bytes: 0,
          error: "archive path exceeds 256 components",
        },
        {
          scenario: "link_target_too_long",
          entryCount: 2,
          bytes: 0,
          error: "symbolic link target exceeds 4096 bytes",
        },
        {
          scenario: "unsupported_pax",
          entryCount: 2,
          bytes: 1,
          error: "unsupported pax key for archive member",
        },
        {
          scenario: "linkpath_on_regular_file",
          entryCount: 2,
          bytes: 1,
          error: "unsupported pax key for archive member",
        },
        {
          scenario: "sparse_file",
          entryCount: 2,
          bytes: 1,
          error: "sparse archive member is not supported",
        },
        {
          scenario: "undeclared_parent",
          entryCount: 2,
          bytes: 1,
          error: "archive parent directory was not declared",
        },
        {
          scenario: "duplicate_directory",
          entryCount: 3,
          bytes: 0,
          error: "duplicate archive path",
        },
      ] as const;

      for (const archiveCase of cases) {
        const payloadPath = join(workspace, `payload-${archiveCase.scenario}`);
        const archive = spawnSync(
          "python3",
          [
            "-c",
            buildBoundaryArchiveProgram(),
            archivePath,
            archiveCase.scenario,
            String(currentIdentity.uid),
            String(currentIdentity.gid),
          ],
          { encoding: "utf8" },
        );
        expect(archive.status, `${archiveCase.scenario}: ${archive.stderr}`).toBe(0);
        const extracted = spawnSync(
          "python3",
          [
            extractorPath,
            payloadPath,
            String(archiveCase.entryCount),
            String(archiveCase.bytes),
            "1048576",
          ],
          { input: readFileSync(archivePath), encoding: "utf8" },
        );
        expect(extracted.status, archiveCase.scenario).not.toBe(0);
        expect(extracted.stderr, archiveCase.scenario).toContain(archiveCase.error);
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("accepts only the supported pax path linkpath and nanosecond mtime fields", () => {
    const result = buildProductionRuntimeVaultPlan({
      runId: "runtime-supported-pax-a1",
      profile,
      attemptId,
      authorityDigestSha256,
      sourceRuntime,
      targetRuntime,
      sourceTree,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const workspace = mkdtempSync(join(tmpdir(), "comis-runtime-supported-pax-"));
    try {
      const extractorPath = join(workspace, "extract.py");
      const payloadPath = join(workspace, "payload");
      const archivePath = join(workspace, "payload.tar");
      writeFileSync(
        extractorPath,
        heredoc(result.value.targetPrepare.stdin, "COMIS_RUNTIME_SAFE_EXTRACTOR"),
        { mode: 0o700 },
      );
      const currentIdentity = lstatSync(workspace);
      const archive = spawnSync(
        "python3",
        [
          "-c",
          buildBoundaryArchiveProgram(),
          archivePath,
          "supported_pax",
          String(currentIdentity.uid),
          String(currentIdentity.gid),
        ],
        { encoding: "utf8" },
      );
      expect(archive.status, archive.stderr).toBe(0);
      const extracted = spawnSync(
        "python3",
        [extractorPath, payloadPath, "4", "1", "1048576"],
        { input: readFileSync(archivePath), encoding: "utf8" },
      );
      expect(extracted.status, extracted.stderr).toBe(0);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("rejects a single oversized pax or gnu metadata header before reading its body", () => {
    const result = buildProductionRuntimeVaultPlan({
      runId: "runtime-metadata-header-limit-a1",
      profile,
      attemptId,
      authorityDigestSha256,
      sourceRuntime,
      targetRuntime,
      sourceTree,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const workspace = mkdtempSync(join(tmpdir(), "comis-runtime-metadata-header-"));
    try {
      const extractorPath = join(workspace, "extract.py");
      const archivePath = join(workspace, "payload.tar");
      writeFileSync(
        extractorPath,
        heredoc(result.value.targetPrepare.stdin, "COMIS_RUNTIME_SAFE_EXTRACTOR"),
        { mode: 0o700 },
      );
      for (const scenario of ["huge_pax_header", "huge_gnu_longname_header"] as const) {
        const archive = spawnSync(
          "python3",
          ["-c", buildBoundaryArchiveProgram(), archivePath, scenario, "0", "0"],
          { encoding: "utf8" },
        );
        expect(archive.status, `${scenario}: ${archive.stderr}`).toBe(0);
        const extracted = spawnSync(
          "python3",
          [extractorPath, join(workspace, `payload-${scenario}`), "1", "0", "1073741824"],
          { input: readFileSync(archivePath), encoding: "utf8" },
        );
        expect(extracted.status, scenario).not.toBe(0);
        expect(extracted.stderr, scenario).toContain(
          "archive metadata header exceeds 16384 bytes",
        );
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("rejects unsafe identities and every shell program passes Bash syntax", () => {
    expect(
      buildProductionRuntimeVaultPlan({
        runId: "../escape",
        profile,
        attemptId,
        authorityDigestSha256,
        sourceRuntime,
        targetRuntime,
        sourceTree,
      }).ok,
    ).toBe(false);
    const metacharacterRoot = "/opt/runtime $(printf injected)/node_modules/comisai";
    const metacharacterPlan = buildProductionRuntimeVaultPlan({
      runId: "runtime-literal-root",
      profile,
      attemptId,
      authorityDigestSha256,
      sourceRuntime: { ...sourceRuntime, packageRoot: metacharacterRoot },
      targetRuntime,
      sourceTree: { ...sourceTree, root: metacharacterRoot },
    });
    expect(metacharacterPlan.ok).toBe(true);
    if (metacharacterPlan.ok) {
      expect(metacharacterPlan.value.stream.source.args).toContain(metacharacterRoot);
      expect(metacharacterPlan.value.stream.sourceStdin).not.toContain(metacharacterRoot);
    }
    expect(
      buildProductionRuntimeVaultPlan({
        runId: "runtime-target-overlap",
        profile,
        attemptId,
        authorityDigestSha256,
        sourceRuntime,
        targetRuntime: {
          ...targetRuntime,
          packageRoot: "/opt/comis-replay/node_modules/comisai",
        },
        sourceTree,
      }).ok,
    ).toBe(false);
    expect(
      buildProductionRuntimeVaultPlan({
        runId: "runtime-root-mismatch",
        profile,
        attemptId,
        authorityDigestSha256,
        sourceRuntime,
        targetRuntime,
        sourceTree: { ...sourceTree, root: "/different/root" },
      }).ok,
    ).toBe(false);
    const result = buildProductionRuntimeVaultPlan({
      runId: "runtime-syntax-a1",
      profile,
      attemptId,
      authorityDigestSha256,
      sourceRuntime,
      targetRuntime,
      sourceTree,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const command of [
      result.value.targetPrepare,
      result.value.targetVerify,
      result.value.targetPublish,
      result.value.targetRollback,
      result.value.targetTransactionStatus,
      result.value.targetFinishPublish,
    ]) {
      expect(command.stdin, command.label).toContain("COMIS_RUNTIME_DYNAMIC_MOUNT_GUARD");
      expect(command.stdin, command.label).toContain("COMIS_RUNTIME_MOUNT_GUARD");
      const syntax = spawnSync("bash", ["-n"], { input: command.stdin, encoding: "utf8" });
      expect(syntax.status, command.label).toBe(0);
    }
    expect(result.value.targetPrepare.stdin).toContain(
      '"$coordination_root" "$target_data" "$target_package_root"',
    );
    expect(result.value.targetPrepare.stdin).toContain(
      'realpath -m -- "$guarded_path"',
    );
    expect(
      spawnSync("bash", ["-n"], {
        input: result.value.stream.sourceStdin,
        encoding: "utf8",
      }).status,
    ).toBe(0);
  });

  it("publishes a stable source tree while preserving the target installation", async () => {
    const invocations: ProductionRemoteInvocation[] = [];
    const leaseRequests: ProductionRemoteLeaseRequest[] = [];
    const leaseReleases: string[] = [];
    const executor = makeExecutor(invocations, ["absent", "present"]);
    const bridge: ProductionBinarySshBridge = {
      transfer: async () => ok({ bytesTransferred: 1_400_000_000 }),
    };

    const result = await sealProductionRuntime({
      runId: "runtime-execute-a1",
      attemptId,
      createdAtMs: 1_752_560_123_456,
      profile,
      executor,
      bridge,
      leaseClient: makeLeaseClient(leaseRequests, leaseReleases),
      receiptStore: makeMemoryReceiptStore(),
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        disposition: "published",
        bytesTransferred: 1_400_000_000,
        payload: {
          digestSha256: sourceTree.digestSha256,
          entryCount: sourceTree.entryCount,
          bytes: sourceTree.bytes,
          version: sourceTree.version,
        },
        payloadPath: `/opt/comis-replay/runtimes/sha256/${sourceTree.digestSha256}/payload`,
        compatibility: {
          compatible: true,
        },
        sourceConsistency: {
          method: "bounded_multi_scan",
          atomicSnapshot: false,
        },
        targetInstallationPreserved: true,
        normalServiceTouched: false,
      },
    });
    const labels = invocations.map(({ label }) => label);
    expect(labels).toContain("prepare-runtime-vault-target");
    expect(labels).toContain("verify-runtime-vault-target");
    expect(labels).toContain("publish-runtime-vault-target");
    expect(labels).not.toContain("rollback-runtime-vault-target");
    expect(labels).toContain("runtime-vault-status-target");
    expect(leaseRequests).toHaveLength(1);
    expect(leaseReleases).toEqual(["runtime-vault-controller"]);
  });

  it("persists authenticated recovery authority before any durable target action", async () => {
    const invocations: ProductionRemoteInvocation[] = [];
    const events: string[] = [];
    let leaseAttempted = false;
    let transferAttempted = false;
    const baseStore = makeMemoryReceiptStore(undefined, events);
    const receiptStore: ProductionRuntimeVaultReceiptStore = {
      ...baseStore,
      createAndPersistReceipt() {
        events.push("receipt:create");
        return err({
          kind: "io_failure" as const,
          operation: "test_persist",
          message: "test receipt persistence failed",
        });
      },
    };

    const result = await sealProductionRuntime({
      runId: "runtime-receipt-failure-a1",
      attemptId,
      createdAtMs: 1_752_560_123_456,
      profile,
      executor: makeExecutor(invocations, ["absent"]),
      bridge: {
        transfer: async () => {
          transferAttempted = true;
          return ok({ bytesTransferred: 1 });
        },
      },
      leaseClient: {
        acquire: async () => {
          leaseAttempted = true;
          return err({ kind: "remote_failure", message: "must not run" });
        },
      },
      receiptStore,
    } as unknown as Parameters<typeof sealProductionRuntime>[0]);

    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: "receipt_failure",
        stage: "persist-runtime-vault-receipt",
      },
    });
    expect(events).toEqual(["receipt:create"]);
    expect(leaseAttempted).toBe(false);
    expect(transferAttempted).toBe(false);
    expect(
      invocations.map(({ label }) => label).filter((label) =>
        [
          "prepare-runtime-vault-target",
          "verify-runtime-vault-target",
          "publish-runtime-vault-target",
          "rollback-runtime-vault-target",
        ].includes(label),
      ),
    ).toEqual([]);
  });

  it("rejects a signed receipt that does not bind the measured seal input", async () => {
    const invocations: ProductionRemoteInvocation[] = [];
    let leaseAttempted = false;
    let transferAttempted = false;
    const baseStore = makeMemoryReceiptStore();
    const receiptStore: ProductionRuntimeVaultReceiptStore = {
      ...baseStore,
      createAndPersistReceipt(input) {
        const persisted = baseStore.createAndPersistReceipt(input);
        expect(persisted.ok).toBe(true);
        const mismatched = createProductionRuntimeVaultRecoveryReceipt(
          { ...input, createdAtMs: input.createdAtMs + 1 },
          receiptAuthorityKey,
        );
        expect(mismatched.ok).toBe(true);
        if (!persisted.ok || !mismatched.ok) {
          throw new Error("test receipt prerequisites are invalid");
        }
        return ok({ ...persisted.value, receipt: mismatched.value });
      },
    };

    const result = await sealProductionRuntime({
      runId: "runtime-receipt-binding-a1",
      attemptId,
      createdAtMs: 1_752_560_123_456,
      profile,
      executor: makeExecutor(invocations, ["absent"]),
      bridge: {
        transfer: async () => {
          transferAttempted = true;
          return ok({ bytesTransferred: 42 });
        },
      },
      leaseClient: {
        acquire: async () => {
          leaseAttempted = true;
          return err({ kind: "remote_failure", message: "must not run" });
        },
      },
      receiptStore,
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: "attestation_failure",
        stage: "bind-runtime-vault-receipt-input",
      },
    });
    expect(leaseAttempted).toBe(false);
    expect(transferAttempted).toBe(false);
    expect(invocations.map(({ label }) => label)).not.toContain(
      "prepare-runtime-vault-target",
    );
  });

  it("holds one receipt-bound lease through publication and terminal persistence", async () => {
    const order: string[] = [];
    const base = makeExecutor([], ["absent", "present"]);
    const executor: ProductionRemoteExecutor = {
      run: async (invocation) => {
        order.push(`remote:${invocation.label}`);
        return base.run(invocation);
      },
    };
    const result = await sealProductionRuntime({
      runId: "runtime-seal-order-a1",
      attemptId,
      createdAtMs: 1_752_560_123_456,
      profile,
      executor,
      bridge: {
        transfer: async () => {
          order.push("stream:transfer");
          return ok({ bytesTransferred: 42 });
        },
      },
      leaseClient: {
        acquire: async () => {
          order.push("lease:acquire");
          return ok({
            release: async () => {
              order.push("lease:release");
              return ok({ exitCode: 0 as const });
            },
          });
        },
      },
      receiptStore: makeMemoryReceiptStore(undefined, order),
    });

    expect(result.ok).toBe(true);
    const occurrences = (event: string): readonly number[] =>
      order.flatMap((value, index) => (value === event ? [index] : []));
    const occurrence = (event: string, index: number): number => {
      const value = occurrences(event).at(index);
      expect(value, `${event} occurrence ${index}`).toBeDefined();
      return value ?? -1;
    };
    const fullEvidenceLabels = [
      "remote:runtime-attest-source",
      "remote:runtime-attest-target",
      "remote:runtime-tree-attest-source",
      "remote:attest-runtime-vault-toolchain-source",
      "remote:attest-runtime-vault-toolchain-target",
      "remote:fingerprint-source-service",
      "remote:fingerprint-target-service",
    ] as const;
    for (const label of fullEvidenceLabels) {
      expect(occurrences(label)).toHaveLength(3 + (label.includes("target") ? 1 : 0));
    }
    const captureBounds = (captureIndex: number): readonly [number, number] => {
      const positions = fullEvidenceLabels.map((label) => occurrence(label, captureIndex));
      return [Math.min(...positions), Math.max(...positions)];
    };
    const initialEvidence = captureBounds(0);
    const underLeaseEvidence = captureBounds(1);
    const beforePublishEvidence = captureBounds(2);
    const finalTargetEvidence = [
      occurrence("remote:runtime-attest-target", 3),
      occurrence("remote:attest-runtime-vault-toolchain-target", 3),
      occurrence("remote:fingerprint-target-service", 3),
    ] as const;
    const receiptIndex = order.indexOf("receipt:create");
    const leaseIndex = order.indexOf("lease:acquire");
    const observations = occurrences("remote:observe-runtime-vault-transaction-target");
    const statusProbes = occurrences("remote:runtime-vault-status-target");
    const prepareIndex = order.indexOf("remote:prepare-runtime-vault-target");
    const transferIndex = order.indexOf("stream:transfer");
    const verifyIndex = order.indexOf("remote:verify-runtime-vault-target");
    const publishIndex = order.indexOf("remote:publish-runtime-vault-target");
    const terminalIndex = order.indexOf("terminal:published");
    const releaseIndex = order.indexOf("lease:release");
    expect(observations).toHaveLength(2);
    expect(statusProbes).toHaveLength(2);
    expect(initialEvidence[1]).toBeLessThan(receiptIndex);
    expect(receiptIndex).toBeLessThan(leaseIndex);
    expect(leaseIndex).toBeLessThan(underLeaseEvidence[0]);
    expect(underLeaseEvidence[1]).toBeLessThan(observations[0]);
    expect(observations[0]).toBeLessThan(statusProbes[0]);
    expect(statusProbes[0]).toBeLessThan(prepareIndex);
    expect(prepareIndex).toBeLessThan(transferIndex);
    expect(transferIndex).toBeLessThan(verifyIndex);
    expect(verifyIndex).toBeLessThan(beforePublishEvidence[0]);
    expect(beforePublishEvidence[1]).toBeLessThan(publishIndex);
    expect(publishIndex).toBeLessThan(observations[1]);
    expect(observations[1]).toBeLessThan(statusProbes[1]);
    expect(statusProbes[1]).toBeLessThan(Math.min(...finalTargetEvidence));
    expect(Math.max(...finalTargetEvidence)).toBeLessThan(terminalIndex);
    expect(terminalIndex).toBeLessThan(releaseIndex);
  });

  it("recovers exclusively from authenticated receipt and target evidence", async () => {
    const runId = "runtime-target-only-recovery-a1";
    const receipt = makeRecoveryReceipt(runId);
    const invocations: ProductionRemoteInvocation[] = [];
    const base = makeExecutor(invocations, ["absent"]);
    const executor: ProductionRemoteExecutor = {
      run: async (invocation) => {
        if (
          invocation.host === profile.source.ssh ||
          invocation.label.includes("source")
        ) {
          invocations.push(invocation);
          return err({ kind: "remote", message: "source is unavailable" });
        }
        return base.run(invocation);
      },
    };

    const result = await recoverProductionRuntimeVault({
      runId,
      attemptId,
      profile,
      executor,
      leaseClient: makeLeaseClient(),
      receiptStore: makeMemoryReceiptStore(receipt),
    } as unknown as Parameters<typeof recoverProductionRuntimeVault>[0]);

    expect(result).toMatchObject({
      ok: true,
      value: {
        disposition: "not_started",
        payload: { digestSha256: sourceTree.digestSha256 },
        sourceConsistency: {
          method: "authenticated_receipt_only",
          atomicSnapshot: false,
        },
      },
    });
    expect(
      invocations.filter(
        ({ host, label }) => host === profile.source.ssh || label.includes("source"),
      ),
    ).toEqual([]);
  });

  it("authorizes recovery across reboot but rejects target toolchain drift", async () => {
    const rebootRunId = "runtime-reboot-recovery-a1";
    const rebootedToolchain = testToolchain("target", "8".repeat(64));
    const rebootedService = serviceFingerprint("target", "9".repeat(64));
    const rebooted = await recoverProductionRuntimeVault({
      runId: rebootRunId,
      attemptId,
      profile,
      executor: makeExecutor([], ["absent"], {
        targetToolchain: rebootedToolchain,
        targetServiceFingerprint: rebootedService,
      }),
      leaseClient: makeLeaseClient(),
      receiptStore: makeMemoryReceiptStore(makeRecoveryReceipt(rebootRunId)),
    });
    expect(rebooted).toMatchObject({
      ok: true,
      value: { disposition: "not_started" },
    });

    const driftRunId = "runtime-toolchain-drift-a1";
    let leaseAttempted = false;
    const drifted = await recoverProductionRuntimeVault({
      runId: driftRunId,
      attemptId,
      profile,
      executor: makeExecutor([], ["absent"], {
        targetToolchain: testToolchain(
          "target",
          targetToolchain.bootIdSha256,
          "a".repeat(64),
        ),
      }),
      leaseClient: {
        acquire: async () => {
          leaseAttempted = true;
          return err({ kind: "remote_failure", message: "must not run" });
        },
      },
      receiptStore: makeMemoryReceiptStore(makeRecoveryReceipt(driftRunId)),
    });
    expect(drifted).toMatchObject({
      ok: false,
      error: {
        kind: "attestation_failure",
        stage: "authorize-runtime-vault-target-recovery",
      },
    });
    expect(leaseAttempted).toBe(false);
  });

  it("leaves foreign target authority untouched and unterminated", async () => {
    const runId = "runtime-foreign-recovery-a1";
    const invocations: ProductionRemoteInvocation[] = [];
    const events: string[] = [];
    const base = makeExecutor(invocations, ["absent"]);
    const executor: ProductionRemoteExecutor = {
      run: async (invocation) => {
        if (invocation.label === "observe-runtime-vault-transaction-target") {
          invocations.push(invocation);
          return ok({
            stdout: transactionObservation(
              "f".repeat(64),
              ["prepare_intent", "prepared"],
              "absent",
            ),
            exitCode: 0,
          });
        }
        return base.run(invocation);
      },
    };
    const result = await recoverProductionRuntimeVault({
      runId,
      attemptId,
      profile,
      executor,
      leaseClient: makeLeaseClient(),
      receiptStore: makeMemoryReceiptStore(makeRecoveryReceipt(runId), events),
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: "foreign_transaction",
        stage: "classify-runtime-vault-transaction",
      },
    });
    expect(invocations.map(({ label }) => label)).not.toContain(
      "rollback-runtime-vault-target",
    );
    expect(invocations.map(({ label }) => label)).not.toContain(
      "finish-runtime-vault-publication-target",
    );
    expect(events).not.toContain("terminal:blocked_corrupt");
    expect(events).not.toContain("terminal:rolled_back");
    expect(events).not.toContain("terminal:published");
  });

  it("rejects contradictory terminal records before any reconciliation mutation", async () => {
    const sealRunId = "runtime-terminal-seal-contradiction-a1";
    const sealReceipt = makeRecoveryReceipt(sealRunId);
    const sealInvocations: ProductionRemoteInvocation[] = [];
    const sealed = await sealProductionRuntime({
      runId: sealRunId,
      attemptId,
      createdAtMs: sealReceipt.createdAtMs,
      profile,
      executor: makeExecutor(sealInvocations, ["absent"]),
      bridge: { transfer: async () => ok({ bytesTransferred: 42 }) },
      leaseClient: makeLeaseClient(),
      receiptStore: makeMemoryReceiptStore(sealReceipt, [], "rolled_back"),
    });
    expect(sealed).toMatchObject({
      ok: false,
      error: {
        kind: "attestation_failure",
        stage: "verify-runtime-vault-terminal-before-reconciliation",
      },
    });
    expect(sealInvocations.map(({ label }) => label)).not.toContain(
      "prepare-runtime-vault-target",
    );

    const recoveryRunId = "runtime-terminal-recovery-contradiction-a1";
    const recoveryReceipt = makeRecoveryReceipt(recoveryRunId);
    const recoveryInvocations: ProductionRemoteInvocation[] = [];
    const base = makeExecutor(recoveryInvocations, ["absent"]);
    const recovered = await recoverProductionRuntimeVault({
      runId: recoveryRunId,
      attemptId,
      profile,
      executor: {
        run: async (invocation) => {
          if (invocation.label === "observe-runtime-vault-transaction-target") {
            recoveryInvocations.push(invocation);
            return ok({
              stdout: transactionObservation(
                invocation.args.at(-1) ?? "0".repeat(64),
                ["prepare_intent", "prepared"],
                "absent",
                recoveryReceipt.seal.authorityDigestSha256,
              ),
              exitCode: 0,
            });
          }
          return base.run(invocation);
        },
      },
      leaseClient: makeLeaseClient(),
      receiptStore: makeMemoryReceiptStore(
        recoveryReceipt,
        [],
        "published",
      ),
    });
    expect(recovered).toMatchObject({
      ok: false,
      error: {
        kind: "attestation_failure",
        stage: "verify-runtime-vault-terminal-before-reconciliation",
      },
    });
    expect(recoveryInvocations.map(({ label }) => label)).not.toContain(
      "rollback-runtime-vault-target",
    );
    expect(recoveryInvocations.map(({ label }) => label)).not.toContain(
      "finish-runtime-vault-publication-target",
    );
  });

  it("keeps a receipt-only recovered attempt closed when seal is retried", async () => {
    const runId = "runtime-terminal-not-started-retry-a1";
    const receipt = makeRecoveryReceipt(runId);
    const receiptStore = makeMemoryReceiptStore(receipt);
    const recovered = await recoverProductionRuntimeVault({
      runId,
      attemptId,
      profile,
      executor: makeExecutor([], ["absent"]),
      leaseClient: makeLeaseClient(),
      receiptStore,
    });
    expect(recovered).toMatchObject({
      ok: true,
      value: { disposition: "not_started" },
    });

    const invocations: ProductionRemoteInvocation[] = [];
    let transferAttempted = false;
    const sealed = await sealProductionRuntime({
      runId,
      attemptId,
      createdAtMs: receipt.createdAtMs,
      profile,
      executor: makeExecutor(invocations, ["absent"]),
      bridge: {
        transfer: async () => {
          transferAttempted = true;
          return ok({ bytesTransferred: 42 });
        },
      },
      leaseClient: makeLeaseClient(),
      receiptStore,
    });

    expect(sealed).toMatchObject({
      ok: false,
      error: {
        kind: "attestation_failure",
        stage: "resume-runtime-vault-seal",
      },
    });
    expect(transferAttempted).toBe(false);
    expect(invocations.map(({ label }) => label)).not.toContain(
      "prepare-runtime-vault-target",
    );
  });

  it("rechecks attempt closure after waiting for the target lease", async () => {
    const runId = "runtime-terminal-lease-race-a1";
    const receipt = makeRecoveryReceipt(runId);
    const baseStore = makeMemoryReceiptStore(receipt, [], "not_started");
    let terminalReads = 0;
    const receiptStore: ProductionRuntimeVaultReceiptStore = {
      ...baseStore,
      readTerminal(requestedRunId, requestedAttemptId) {
        terminalReads += 1;
        return terminalReads === 1
          ? ok(undefined)
          : baseStore.readTerminal(requestedRunId, requestedAttemptId);
      },
    };
    const invocations: ProductionRemoteInvocation[] = [];
    let transferAttempted = false;

    const result = await sealProductionRuntime({
      runId,
      attemptId,
      createdAtMs: receipt.createdAtMs,
      profile,
      executor: makeExecutor(invocations, ["absent"]),
      bridge: {
        transfer: async () => {
          transferAttempted = true;
          return ok({ bytesTransferred: 42 });
        },
      },
      leaseClient: makeLeaseClient(),
      receiptStore,
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: "attestation_failure",
        stage: "resume-runtime-vault-seal",
      },
    });
    expect(terminalReads).toBe(2);
    expect(transferAttempted).toBe(false);
    expect(invocations.map(({ label }) => label)).not.toContain(
      "prepare-runtime-vault-target",
    );
  });

  it("keeps an older not-started attempt valid after the payload is published", async () => {
    const runId = "runtime-older-attempt-same-payload-a1";
    const receipt = makeRecoveryReceipt(runId);
    const invocations: ProductionRemoteInvocation[] = [];
    const result = await recoverProductionRuntimeVault({
      runId,
      attemptId,
      profile,
      executor: makeExecutor(invocations, ["present"]),
      leaseClient: makeLeaseClient(),
      receiptStore: makeMemoryReceiptStore(receipt, [], "not_started"),
    });

    expect(result).toMatchObject({
      ok: true,
      value: { disposition: "not_started" },
    });
    const labels = invocations.map(({ label }) => label);
    expect(labels).not.toContain("prepare-runtime-vault-target");
    expect(labels).not.toContain("rollback-runtime-vault-target");
    expect(labels).not.toContain("finish-runtime-vault-publication-target");
  });

  it("keeps an older rolled-back attempt valid after the payload is published", async () => {
    const runId = "runtime-older-rollback-same-payload-a1";
    const receipt = makeRecoveryReceipt(runId);
    const invocations: ProductionRemoteInvocation[] = [];
    const terminalEvents: string[] = [];
    const base = makeExecutor(invocations, ["present"]);
    const executor: ProductionRemoteExecutor = {
      run: async (invocation) => {
        if (invocation.label === "observe-runtime-vault-transaction-target") {
          invocations.push(invocation);
          return ok({
            stdout: transactionObservation(
              invocation.args.at(-1) ?? "0".repeat(64),
              ["prepare_intent", "prepared", "rollback_intent", "rolled_back"],
              "exact",
              receipt.seal.authorityDigestSha256,
            ),
            exitCode: 0,
          });
        }
        return base.run(invocation);
      },
    };

    const result = await recoverProductionRuntimeVault({
      runId,
      attemptId,
      profile,
      executor,
      leaseClient: makeLeaseClient(),
      receiptStore: makeMemoryReceiptStore(receipt, terminalEvents),
    });

    expect(result).toMatchObject({
      ok: true,
      value: { disposition: "rolled_back" },
    });
    const labels = invocations.map(({ label }) => label);
    expect(labels).not.toContain("prepare-runtime-vault-target");
    expect(labels).not.toContain("rollback-runtime-vault-target");
    expect(labels).not.toContain("finish-runtime-vault-publication-target");
    expect(terminalEvents).toContain("terminal:rolled_back");
  });

  it("finishes an older rollback marker without removing a later published payload", async () => {
    const runId = "runtime-finish-old-rollback-same-payload-a1";
    const receipt = makeRecoveryReceipt(runId);
    const invocations: ProductionRemoteInvocation[] = [];
    const terminalEvents: string[] = [];
    const base = makeExecutor(invocations, ["present"]);
    let observationCount = 0;
    const executor: ProductionRemoteExecutor = {
      run: async (invocation) => {
        if (invocation.label === "observe-runtime-vault-transaction-target") {
          observationCount += 1;
          invocations.push(invocation);
          return ok({
            stdout: transactionObservation(
              invocation.args.at(-1) ?? "0".repeat(64),
              observationCount === 1
                ? ["prepare_intent", "prepared", "rollback_intent"]
                : [
                    "prepare_intent",
                    "prepared",
                    "rollback_intent",
                    "rolled_back",
                  ],
              "exact",
              receipt.seal.authorityDigestSha256,
            ),
            exitCode: 0,
          });
        }
        return base.run(invocation);
      },
    };

    const result = await recoverProductionRuntimeVault({
      runId,
      attemptId,
      profile,
      executor,
      leaseClient: makeLeaseClient(),
      receiptStore: makeMemoryReceiptStore(receipt, terminalEvents),
    });

    expect(result).toMatchObject({
      ok: true,
      value: { disposition: "rolled_back" },
    });
    const labels = invocations.map(({ label }) => label);
    expect(labels).toContain("rollback-runtime-vault-target");
    expect(labels).not.toContain("finish-runtime-vault-publication-target");
    const rollback = invocations.find(
      ({ label }) => label === "rollback-runtime-vault-target",
    );
    expect(rollback?.stdin).not.toContain('rm -rf -- "$final_root"');
    expect(rollback?.stdin).not.toContain(
      'if [ -e "$final_root" ] || [ -L "$final_root" ]; then exit 91; fi',
    );
    expect(terminalEvents).toContain("terminal:rolled_back");
  });

  it("reuses an exact existing payload without transfer or target mutation", async () => {
    const invocations: ProductionRemoteInvocation[] = [];
    let transferred = false;
    const result = await sealProductionRuntime({
      runId: "runtime-reuse-a1",
      attemptId,
      createdAtMs: 1_752_560_123_456,
      profile,
      executor: makeExecutor(invocations, ["present", "present"]),
      bridge: {
        transfer: async () => {
          transferred = true;
          return ok({ bytesTransferred: 1 });
        },
      },
      leaseClient: makeLeaseClient(),
      receiptStore: makeMemoryReceiptStore(),
    });

    expect(result).toMatchObject({
      ok: true,
      value: { disposition: "reused_existing", bytesTransferred: 0 },
    });
    expect(transferred).toBe(false);
    const labels = invocations.map(({ label }) => label);
    expect(labels).not.toContain("prepare-runtime-vault-target");
    expect(labels).not.toContain("verify-runtime-vault-target");
    expect(labels).not.toContain("publish-runtime-vault-target");
  });

  it("refuses target preparation when the continuous controller lease is unavailable", async () => {
    const invocations: ProductionRemoteInvocation[] = [];
    const result = await sealProductionRuntime({
      runId: "runtime-lease-busy-a1",
      attemptId,
      createdAtMs: 1_752_560_123_456,
      profile,
      executor: makeExecutor(invocations, ["absent"]),
      bridge: { transfer: async () => ok({ bytesTransferred: 1 }) },
      leaseClient: {
        acquire: async () =>
          err({ kind: "remote_failure", message: "Controller lease is held" }),
      },
      receiptStore: makeMemoryReceiptStore(),
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: "lease_failure",
        stage: "acquire-runtime-vault-lease",
        outcome: { kind: "remote_failure" },
      },
    });
    expect(invocations.map(({ label }) => label)).not.toContain(
      "prepare-runtime-vault-target",
    );
  });

  it("retains the capture failure when controller lease cleanup also fails", async () => {
    const result = await sealProductionRuntime({
      runId: "runtime-lease-release-failure-a1",
      attemptId,
      createdAtMs: 1_752_560_123_456,
      profile,
      executor: makeExecutor([], ["absent"]),
      bridge: {
        transfer: async () => err({ kind: "remote_failure", message: "private" }),
      },
      leaseClient: {
        acquire: async () =>
          ok({
            release: async () =>
              err({ kind: "deadline", message: "Lease release deadline elapsed" }),
          }),
      },
      receiptStore: makeMemoryReceiptStore(),
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: "lease_release_failure",
        stage: "release-runtime-vault-lease",
        outcome: { kind: "deadline" },
        primary: { kind: "transfer_failure", stage: "stream-runtime-vault" },
      },
    });
  });

  it("accepts a published payload only through a strict root inventory and mount attestation", async () => {
    const invocations: ProductionRemoteInvocation[] = [];
    const result = await inspectProductionRuntimeVault(
      { profile, runtimeDigestSha256: sourceTree.digestSha256 },
      makeExecutor(invocations, ["present"]),
    );

    expect(result.ok).toBe(true);
    const status = invocations.find(({ label }) => label === "runtime-vault-status-target");
    expect(status).toBeDefined();
    expect(status?.stdin).toContain("unexpected runtime vault root inventory");
    expect(status?.stdin).toContain("st_nlink != 1");
    expect(status?.stdin).toContain("os.listxattr");
    expect(status?.stdin).toContain("COMIS_RUNTIME_FINAL_MOUNT_GUARD");
    expect(status?.stdin).toContain("TARGET_RUNTIME_VAULT_ANCESTORS");
    expect(status?.stdin).toContain("for path in (final_root, attestation_path):");
    expect(status?.stdin).toContain("payload = os.lstat(payload_path)");
  });

  it("rolls back only staging when the transfer or staged identity fails", async () => {
    const transferInvocations: ProductionRemoteInvocation[] = [];
    const transferFailure = await sealProductionRuntime({
      runId: "runtime-transfer-fail-a1",
      attemptId,
      createdAtMs: 1_752_560_123_456,
      profile,
      executor: makeExecutor(transferInvocations, ["absent"]),
      bridge: {
        transfer: async () => err({ kind: "remote_failure", message: "private" }),
      },
      leaseClient: makeLeaseClient(),
      receiptStore: makeMemoryReceiptStore(),
    });
    expect(transferFailure.ok).toBe(false);
    expect(transferInvocations.map(({ label }) => label)).toContain(
      "rollback-runtime-vault-target",
    );

    const verifyInvocations: ProductionRemoteInvocation[] = [];
    const stagedMismatch = await sealProductionRuntime({
      runId: "runtime-verify-fail-a1",
      attemptId,
      createdAtMs: 1_752_560_123_456,
      profile,
      executor: makeExecutor(verifyInvocations, ["absent"], {
        stagedTree: { ...sourceTree, digestSha256: "f".repeat(64) },
      }),
      bridge: { transfer: async () => ok({ bytesTransferred: 42 }) },
      leaseClient: makeLeaseClient(),
      receiptStore: makeMemoryReceiptStore(),
    });
    expect(stagedMismatch.ok).toBe(false);
    expect(verifyInvocations.map(({ label }) => label)).toContain(
      "rollback-runtime-vault-target",
    );
    expect(verifyInvocations.map(({ label }) => label)).not.toContain(
      "publish-runtime-vault-target",
    );
  });

  it("finishes publication when the remote acknowledgement is lost after rename", async () => {
    for (const publishOutcome of [
      "transport_after_commit",
      "bad_ack_after_commit",
    ] as const) {
      const invocations: ProductionRemoteInvocation[] = [];
      const terminalEvents: string[] = [];
      const result = await sealProductionRuntime({
        runId: `runtime-publish-uncertain-${publishOutcome}`,
        attemptId,
        createdAtMs: 1_752_560_123_456,
        profile,
        executor: makeExecutor(invocations, ["absent", "present"], {
          publishOutcome,
        }),
        bridge: { transfer: async () => ok({ bytesTransferred: 42 }) },
        leaseClient: makeLeaseClient(),
        receiptStore: makeMemoryReceiptStore(undefined, terminalEvents),
      });

      expect(result).toMatchObject({
        ok: true,
        value: { disposition: "published", bytesTransferred: 42 },
      });
      expect(invocations.map(({ label }) => label)).not.toContain(
        "rollback-runtime-vault-target",
      );
      expect(invocations.map(({ label }) => label)).toContain(
        "finish-runtime-vault-publication-target",
      );
      expect(terminalEvents).toContain("terminal:published");
    }
  });

  it("recovers a published target after terminal-record persistence fails", async () => {
    const runId = "runtime-terminal-store-recovery-a1";
    const baseStore = makeMemoryReceiptStore();
    let rejectTerminal = true;
    const receiptStore: ProductionRuntimeVaultReceiptStore = {
      ...baseStore,
      recordTerminal(receipt, disposition) {
        if (rejectTerminal) {
          return err({
            kind: "io_failure" as const,
            operation: "test_terminal_write",
            message: "test terminal write failed",
          });
        }
        return baseStore.recordTerminal(receipt, disposition);
      },
    };
    const sealed = await sealProductionRuntime({
      runId,
      attemptId,
      createdAtMs: 1_752_560_123_456,
      profile,
      executor: makeExecutor([], ["absent", "present"]),
      bridge: { transfer: async () => ok({ bytesTransferred: 42 }) },
      leaseClient: makeLeaseClient(),
      receiptStore,
    });

    expect(sealed).toMatchObject({
      ok: false,
      error: {
        kind: "receipt_failure",
        stage: "record-runtime-vault-terminal",
        primary: null,
      },
    });

    rejectTerminal = false;
    const recovered = await recoverProductionRuntimeVault({
      runId,
      attemptId,
      profile,
      executor: makeExecutor([], ["present"], { publishedAtStart: true }),
      leaseClient: makeLeaseClient(),
      receiptStore,
    });
    expect(recovered).toMatchObject({
      ok: true,
      value: { disposition: "published" },
    });
  });

  it("preserves the primary failure when rollback terminal persistence fails", async () => {
    const baseStore = makeMemoryReceiptStore();
    const receiptStore: ProductionRuntimeVaultReceiptStore = {
      ...baseStore,
      recordTerminal() {
        return err({
          kind: "io_failure" as const,
          operation: "test_terminal_write",
          message: "test terminal write failed",
        });
      },
    };

    const result = await sealProductionRuntime({
      runId: "runtime-primary-terminal-store-failure-a1",
      attemptId,
      createdAtMs: 1_752_560_123_456,
      profile,
      executor: makeExecutor([], ["absent"]),
      bridge: {
        transfer: async () =>
          err({ kind: "remote_failure", message: "test transfer failed" }),
      },
      leaseClient: makeLeaseClient(),
      receiptStore,
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: "receipt_failure",
        stage: "record-runtime-vault-terminal",
        primary: { kind: "transfer_failure", stage: "stream-runtime-vault" },
      },
    });
  });

  it("never reports success when lease release fails after publication", async () => {
    const terminalEvents: string[] = [];
    const result = await sealProductionRuntime({
      runId: "runtime-success-release-failure-a1",
      attemptId,
      createdAtMs: 1_752_560_123_456,
      profile,
      executor: makeExecutor([], ["absent", "present"]),
      bridge: { transfer: async () => ok({ bytesTransferred: 42 }) },
      leaseClient: {
        acquire: async () =>
          ok({
            release: async () =>
              err({ kind: "deadline", message: "test lease release failed" }),
          }),
      },
      receiptStore: makeMemoryReceiptStore(undefined, terminalEvents),
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: "lease_release_failure",
        stage: "release-runtime-vault-lease",
        primary: null,
      },
    });
    expect(terminalEvents).toContain("terminal:published");
  });

  it("never rolls back another invocation when target preparation did not establish ownership", async () => {
    const invocations: ProductionRemoteInvocation[] = [];
    const executor = makeExecutor(invocations, ["absent"], { failedStage: "prepare-runtime-vault-target" });
    const result = await sealProductionRuntime({
      runId: "runtime-prepare-contended-a1",
      attemptId,
      createdAtMs: 1_752_560_123_456,
      profile,
      executor,
      bridge: { transfer: async () => ok({ bytesTransferred: 42 }) },
      leaseClient: makeLeaseClient(),
      receiptStore: makeMemoryReceiptStore(),
    });

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: "remote_failure",
        stage: "prepare-runtime-vault-target",
        outcome: { kind: "remote_exit", exitCode: 82 },
      },
    });
    expect(invocations.map(({ label }) => label)).toContain("prepare-runtime-vault-target");
    expect(invocations.map(({ label }) => label)).not.toContain(
      "rollback-runtime-vault-target",
    );
  });

  it("never converts a pre-publication failure into reuse or publication success", async () => {
    for (const observedDisposition of ["reused_existing", "published"] as const) {
      const invocations: ProductionRemoteInvocation[] = [];
      const terminalEvents: string[] = [];
      const base = makeExecutor(invocations, ["absent", "present"]);
      let observationCount = 0;
      const executor: ProductionRemoteExecutor = {
        run: async (invocation) => {
          if (invocation.label === "observe-runtime-vault-transaction-target") {
            observationCount += 1;
            if (observationCount === 2) {
              invocations.push(invocation);
              return ok({
                stdout:
                  observedDisposition === "reused_existing"
                    ? [
                        RUNTIME_VAULT_TRANSACTION_STATUS_BEGIN,
                        "transactionState=absent",
                        "finalState=exact",
                        RUNTIME_VAULT_TRANSACTION_STATUS_END,
                        "",
                      ].join("\n")
                    : transactionObservation(
                        invocation.args.at(-1) ?? "0".repeat(64),
                        RUNTIME_VAULT_FORWARD_PHASES,
                        "exact",
                        invocation.args.at(-2) ?? "0".repeat(64),
                      ),
                exitCode: 0,
              });
            }
          }
          return base.run(invocation);
        },
      };

      const result = await sealProductionRuntime({
        runId: `runtime-prepublish-no-success-${observedDisposition}`,
        attemptId,
        createdAtMs: 1_752_560_123_456,
        profile,
        executor,
        bridge: {
          transfer: async () =>
            err({ kind: "remote_failure", message: "test transfer failed" }),
        },
        leaseClient: makeLeaseClient(),
        receiptStore: makeMemoryReceiptStore(undefined, terminalEvents),
      });

      expect(result).toMatchObject({
        ok: false,
        error: {
          kind: "reconciliation_failure",
          primary: { kind: "transfer_failure", stage: "stream-runtime-vault" },
        },
      });
      expect(terminalEvents).not.toContain("terminal:published");
      expect(terminalEvents).not.toContain("terminal:reused_existing");
    }
  });

  it("preserves the first post-publication transaction failure without reobserving", async () => {
    for (const failureKind of ["foreign_transaction", "blocked_corrupt"] as const) {
      const invocations: ProductionRemoteInvocation[] = [];
      const terminalEvents: string[] = [];
      const base = makeExecutor(invocations, ["absent", "present"]);
      let observationCount = 0;
      const executor: ProductionRemoteExecutor = {
        run: async (invocation) => {
          if (invocation.label === "observe-runtime-vault-transaction-target") {
            observationCount += 1;
            if (observationCount === 2) {
              invocations.push(invocation);
              return ok({
                stdout:
                  failureKind === "foreign_transaction"
                    ? transactionObservation(
                        invocation.args.at(-1) ?? "0".repeat(64),
                        RUNTIME_VAULT_FORWARD_PHASES,
                        "exact",
                        "f".repeat(64),
                      )
                    : [
                        RUNTIME_VAULT_TRANSACTION_STATUS_BEGIN,
                        "transactionState=present",
                        "manifestState=corrupt",
                        "finalState=exact",
                        RUNTIME_VAULT_TRANSACTION_STATUS_END,
                        "",
                      ].join("\n"),
                exitCode: 0,
              });
            }
          }
          return base.run(invocation);
        },
      };

      const result = await sealProductionRuntime({
        runId: `runtime-postpublish-first-failure-${failureKind}`,
        attemptId,
        createdAtMs: 1_752_560_123_456,
        profile,
        executor,
        bridge: { transfer: async () => ok({ bytesTransferred: 42 }) },
        leaseClient: makeLeaseClient(),
        receiptStore: makeMemoryReceiptStore(undefined, terminalEvents),
      });

      expect(result).toMatchObject({
        ok: false,
        error: { kind: failureKind },
      });
      expect(observationCount).toBe(2);
      expect(terminalEvents).not.toContain("terminal:published");
    }
  });

  it("retains both the primary failure and reconciliation failure evidence", async () => {
    const invocations: ProductionRemoteInvocation[] = [];
    const base = makeExecutor(invocations, ["absent"]);
    const executor: ProductionRemoteExecutor = {
      run: async (invocation) =>
        invocation.label === "rollback-runtime-vault-target"
          ? ok({ stdout: "", exitCode: 91 })
          : base.run(invocation),
    };
    const result = await sealProductionRuntime({
      runId: "runtime-double-failure-a1",
      attemptId,
      createdAtMs: 1_752_560_123_456,
      profile,
      executor,
      bridge: { transfer: async () => err({ kind: "remote_failure", message: "private" }) },
      leaseClient: makeLeaseClient(),
      receiptStore: makeMemoryReceiptStore(),
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: "reconciliation_failure",
        primary: { kind: "transfer_failure", stage: "stream-runtime-vault" },
        reconciliation: {
          kind: "remote_failure",
          stage: "rollback-runtime-vault-target",
          outcome: { kind: "remote_exit", exitCode: 91 },
        },
      },
    });
  });

  it("reconciles every partial claim while preserving an exact published payload", () => {
    const result = buildProductionRuntimeVaultPlan({
      runId: "runtime-crash-prefix-a1",
      profile,
      attemptId,
      authorityDigestSha256,
      sourceRuntime,
      targetRuntime,
      sourceTree,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rollback = result.value.targetRollback.stdin;
    expect(rollback).toContain("COMIS_RUNTIME_PARTIAL_CLAIM_GUARD");
    expect(rollback).toContain('"$identity_incoming"');
    expect(rollback).toContain("identity_value.st_nlink != 2");
    expect(rollback).toContain("active_value.st_nlink != 1");
    expect(rollback).toContain("COMIS_RUNTIME_RECOVERY_FINAL_INVENTORY");
    expect(rollback).toContain('stat -c \'%s\' "$final_root/payload.attestation"');
    expect(rollback).toContain('facts="$(probe_tree "$payload_path")"');
    expect(rollback).not.toContain('rm -rf -- "$final_root"');
    expect(rollback.indexOf("COMIS_RUNTIME_RECOVERY_FINAL_INVENTORY")).toBeLessThan(
      rollback.indexOf('rm -rf -- "$incoming_root" "$control_dir"'),
    );
    expect(result.value.targetRollback.label).toBe("rollback-runtime-vault-target");
    expect(result.value.targetRollback.stdin).toContain(
      "COMIS_RUNTIME_OPERATION_LOCK_GUARD",
    );
    expect(result.value.targetRollback.stdin).toContain(
      'if [ ! -e "$operation_lock" ] && [ ! -L "$operation_lock" ]; then',
    );
  });

  it("accepts only the exact durable marker crash prefixes during reconciliation", () => {
    const result = buildProductionRuntimeVaultPlan({
      runId: "runtime-marker-prefix-a1",
      profile,
      attemptId,
      authorityDigestSha256,
      sourceRuntime,
      targetRuntime,
      sourceTree,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const guard = heredoc(
      result.value.targetRollback.stdin,
      "COMIS_RUNTIME_PARTIAL_CLAIM_GUARD",
    );
    const expected = "9".repeat(64);
    const workspace = mkdtempSync(join(tmpdir(), "comis-runtime-claim-"));
    try {
      const run = (name: string, setup: (paths: readonly string[]) => void) => {
        const root = join(workspace, name);
        mkdirSync(root, { mode: 0o700 });
        const paths = [
          join(root, "identity.incoming"),
          join(root, "identity"),
          join(root, "active"),
          join(root, "control"),
          join(root, "incoming"),
        ] as const;
        setup(paths);
        const identity = lstatSync(root);
        const localGuard = guard
          .replaceAll("value.st_uid != 0", `value.st_uid != ${identity.uid}`)
          .replaceAll("value.st_gid != 0", `value.st_gid != ${identity.gid}`)
          .replaceAll("os.listxattr(path, follow_symlinks=False)", "[]");
        return spawnSync("python3", ["-", expected, ...paths], {
          input: localGuard,
          encoding: "utf8",
        });
      };
      const exactIdentity = run("identity-only", ([, identity]) => {
        writeFileSync(identity, `${expected}\n`, { mode: 0o400 });
      });
      expect(exactIdentity.status, exactIdentity.stderr).toBe(0);

      const partialIncoming = run("partial-incoming", ([incoming]) => {
        writeFileSync(incoming, expected.slice(0, 17), { mode: 0o400 });
      });
      expect(partialIncoming.status, partialIncoming.stderr).toBe(0);

      const linkedClaim = run("linked-claim", ([, identity, active]) => {
        writeFileSync(identity, `${expected}\n`, { mode: 0o400 });
        linkSync(identity, active);
      });
      expect(linkedClaim.status, linkedClaim.stderr).toBe(0);

      const unrelatedPartial = run("unrelated-partial", ([incoming]) => {
        writeFileSync(incoming, "not-the-transaction", { mode: 0o400 });
      });
      expect(unrelatedPartial.status).not.toBe(0);

      const hiddenHardlink = run("hidden-hardlink", ([, identity]) => {
        writeFileSync(identity, `${expected}\n`, { mode: 0o400 });
        linkSync(identity, join(dirname(identity), "hidden"));
      });
      expect(hiddenHardlink.status).not.toBe(0);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("recovers rollback and publication crash points under receipt authority", async () => {
    const rollbackRunId = "runtime-target-rollback-recovery-a1";
    const rollbackReceipt = makeRecoveryReceipt(rollbackRunId);
    const rollbackLabels: string[] = [];
    const rollbackBase = makeExecutor([], ["absent"]);
    let rollbackObservation = 0;
    const rolledBack = await recoverProductionRuntimeVault({
      runId: rollbackRunId,
      attemptId,
      profile,
      executor: {
        run: async (invocation) => {
          rollbackLabels.push(invocation.label);
          if (invocation.label === "observe-runtime-vault-transaction-target") {
            rollbackObservation += 1;
            return ok({
              stdout: transactionObservation(
                invocation.args.at(-1) ?? "0".repeat(64),
                rollbackObservation === 1
                  ? ["prepare_intent", "prepared"]
                  : [
                      "prepare_intent",
                      "prepared",
                      "rollback_intent",
                      "rolled_back",
                    ],
                "absent",
                rollbackReceipt.seal.authorityDigestSha256,
              ),
              exitCode: 0,
            });
          }
          if (invocation.label === "rollback-runtime-vault-target") {
            return ok({ stdout: "", exitCode: 0 });
          }
          return rollbackBase.run(invocation);
        },
      },
      leaseClient: makeLeaseClient(),
      receiptStore: makeMemoryReceiptStore(rollbackReceipt),
    });
    expect(rolledBack).toMatchObject({
      ok: true,
      value: { disposition: "rolled_back" },
    });
    expect(rollbackLabels).toContain("rollback-runtime-vault-target");

    const publishRunId = "runtime-target-publish-recovery-a1";
    const publishReceipt = makeRecoveryReceipt(publishRunId);
    const publishLabels: string[] = [];
    const publishBase = makeExecutor([], ["present"]);
    let publishObservation = 0;
    const published = await recoverProductionRuntimeVault({
      runId: publishRunId,
      attemptId,
      profile,
      executor: {
        run: async (invocation) => {
          publishLabels.push(invocation.label);
          if (invocation.label === "observe-runtime-vault-transaction-target") {
            publishObservation += 1;
            return ok({
              stdout: transactionObservation(
                invocation.args.at(-1) ?? "0".repeat(64),
                publishObservation === 1
                  ? RUNTIME_VAULT_FORWARD_PHASES.slice(0, 7)
                  : RUNTIME_VAULT_FORWARD_PHASES,
                "exact",
                publishReceipt.seal.authorityDigestSha256,
              ),
              exitCode: 0,
            });
          }
          if (invocation.label === "finish-runtime-vault-publication-target") {
            return ok({ stdout: "published_recovered\n", exitCode: 0 });
          }
          return publishBase.run(invocation);
        },
      },
      leaseClient: makeLeaseClient(),
      receiptStore: makeMemoryReceiptStore(publishReceipt),
    });
    expect(published).toMatchObject({
      ok: true,
      value: { disposition: "published" },
    });
    expect(publishLabels).toContain("finish-runtime-vault-publication-target");
  });

  it("blocks corrupt transaction evidence without invoking target mutation", async () => {
    const runId = "runtime-target-corrupt-a1";
    const receipt = makeRecoveryReceipt(runId);
    const labels: string[] = [];
    const terminalEvents: string[] = [];
    const base = makeExecutor([], ["absent"]);
    const result = await recoverProductionRuntimeVault({
      runId,
      attemptId,
      profile,
      executor: {
        run: async (invocation) => {
          labels.push(invocation.label);
          return invocation.label === "observe-runtime-vault-transaction-target"
            ? ok({
                stdout: [
                  RUNTIME_VAULT_TRANSACTION_STATUS_BEGIN,
                  "transactionState=present",
                  "manifestState=corrupt",
                  "finalState=absent",
                  RUNTIME_VAULT_TRANSACTION_STATUS_END,
                  "",
                ].join("\n"),
                exitCode: 0,
              })
            : base.run(invocation);
        },
      },
      leaseClient: makeLeaseClient(),
      receiptStore: makeMemoryReceiptStore(receipt, terminalEvents),
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: "blocked_corrupt",
        stage: "classify-runtime-vault-transaction",
      },
    });
    expect(labels).toContain("observe-runtime-vault-transaction-target");
    expect(labels).not.toContain("rollback-runtime-vault-target");
    expect(labels).not.toContain("finish-runtime-vault-publication-target");
    expect(terminalEvents).toContain("terminal:blocked_corrupt");
  });

  it("reports authenticated absent and reused target recovery states without replay", async () => {
    const rolledBackInvocations: ProductionRemoteInvocation[] = [];
    const absentRunId = "runtime-recover-rollback-a1";
    const rolledBack = await recoverProductionRuntimeVault({
      runId: absentRunId,
      attemptId,
      profile,
      executor: makeExecutor(rolledBackInvocations, ["absent"]),
      leaseClient: makeLeaseClient(),
      receiptStore: makeMemoryReceiptStore(makeRecoveryReceipt(absentRunId)),
    });
    expect(rolledBack).toMatchObject({
      ok: true,
      value: {
        disposition: "not_started",
        payload: { digestSha256: sourceTree.digestSha256 },
      },
    });
    expect(rolledBackInvocations.map(({ label }) => label)).not.toContain(
      "runtime-tree-attest-source",
    );

    const publishedInvocations: ProductionRemoteInvocation[] = [];
    const publishedRunId = "runtime-recover-published-a1";
    const published = await recoverProductionRuntimeVault({
      runId: publishedRunId,
      attemptId,
      profile,
      executor: makeExecutor(publishedInvocations, ["present"]),
      leaseClient: makeLeaseClient(),
      receiptStore: makeMemoryReceiptStore(makeRecoveryReceipt(publishedRunId)),
    });
    expect(published).toMatchObject({
      ok: true,
      value: {
        disposition: "reused_existing",
        payload: { digestSha256: sourceTree.digestSha256 },
      },
    });
  });

  it("prevents publication when the source changes during capture", async () => {
    const invocations: ProductionRemoteInvocation[] = [];
    const result = await sealProductionRuntime({
      runId: "runtime-source-drift-a1",
      attemptId,
      createdAtMs: 1_752_560_123_456,
      profile,
      executor: makeExecutor(invocations, ["absent"], {
        finalSourceTree: { ...sourceTree, digestSha256: "f".repeat(64) },
      }),
      bridge: { transfer: async () => ok({ bytesTransferred: 42 }) },
      leaseClient: makeLeaseClient(),
      receiptStore: makeMemoryReceiptStore(),
    });

    expect(result.ok).toBe(false);
    const labels = invocations.map(({ label }) => label);
    expect(labels).not.toContain("prepare-runtime-vault-target");
    expect(labels).not.toContain("rollback-runtime-vault-target");
    expect(labels).not.toContain("publish-runtime-vault-target");
  });

  it("rejects independent evidence drift at both pre-mutation barriers", async () => {
    const driftedSourceRuntime = { ...sourceRuntime, digestSha256: "8".repeat(64) };
    const driftedTargetRuntime = { ...targetRuntime, digestSha256: "9".repeat(64) };
    const driftedSourceTree = { ...sourceTree, digestSha256: "a".repeat(64) };
    const driftedSourceToolchain = testToolchain("source", "b".repeat(64));
    const driftedTargetToolchain = testToolchain("target", "c".repeat(64));
    const driftedSourceService = serviceFingerprint("source", "d".repeat(64));
    const driftedTargetService = serviceFingerprint("target", "f".repeat(64));
    const scenarios: readonly {
      readonly name: string;
      readonly firstBarrier: Parameters<typeof makeExecutor>[2];
      readonly secondBarrier: Parameters<typeof makeExecutor>[2];
    }[] = [
      {
        name: "source-runtime",
        firstBarrier: { sourceRuntimeSequence: [sourceRuntime, driftedSourceRuntime] },
        secondBarrier: {
          sourceRuntimeSequence: [sourceRuntime, sourceRuntime, driftedSourceRuntime],
        },
      },
      {
        name: "target-runtime",
        firstBarrier: { targetRuntimeSequence: [targetRuntime, driftedTargetRuntime] },
        secondBarrier: {
          targetRuntimeSequence: [targetRuntime, targetRuntime, driftedTargetRuntime],
        },
      },
      {
        name: "source-tree",
        firstBarrier: { sourceTreeSequence: [sourceTree, driftedSourceTree] },
        secondBarrier: {
          sourceTreeSequence: [sourceTree, sourceTree, driftedSourceTree],
        },
      },
      {
        name: "source-toolchain",
        firstBarrier: {
          sourceToolchainSequence: [sourceToolchain, driftedSourceToolchain],
        },
        secondBarrier: {
          sourceToolchainSequence: [
            sourceToolchain,
            sourceToolchain,
            driftedSourceToolchain,
          ],
        },
      },
      {
        name: "target-toolchain",
        firstBarrier: {
          targetToolchainSequence: [targetToolchain, driftedTargetToolchain],
        },
        secondBarrier: {
          targetToolchainSequence: [
            targetToolchain,
            targetToolchain,
            driftedTargetToolchain,
          ],
        },
      },
      {
        name: "source-service",
        firstBarrier: {
          sourceServiceSequence: [sourceServiceFingerprint, driftedSourceService],
        },
        secondBarrier: {
          sourceServiceSequence: [
            sourceServiceFingerprint,
            sourceServiceFingerprint,
            driftedSourceService,
          ],
        },
      },
      {
        name: "target-service",
        firstBarrier: {
          targetServiceSequence: [targetServiceFingerprint, driftedTargetService],
        },
        secondBarrier: {
          targetServiceSequence: [
            targetServiceFingerprint,
            targetServiceFingerprint,
            driftedTargetService,
          ],
        },
      },
    ];

    for (const scenario of scenarios) {
      for (const [barrier, overrides] of [
        ["first", scenario.firstBarrier],
        ["second", scenario.secondBarrier],
      ] as const) {
        const invocations: ProductionRemoteInvocation[] = [];
        const result = await sealProductionRuntime({
          runId: `runtime-drift-${scenario.name}-${barrier}`,
          attemptId,
          createdAtMs: 1_752_560_123_456,
          profile,
          executor: makeExecutor(invocations, ["absent"], overrides),
          bridge: { transfer: async () => ok({ bytesTransferred: 42 }) },
          leaseClient: makeLeaseClient(),
          receiptStore: makeMemoryReceiptStore(),
        });
        expect(result.ok, `${scenario.name}/${barrier}`).toBe(false);
        const labels = invocations.map(({ label }) => label);
        expect(labels, `${scenario.name}/${barrier}`).not.toContain(
          "publish-runtime-vault-target",
        );
        if (barrier === "first") {
          expect(labels, scenario.name).not.toContain("prepare-runtime-vault-target");
        } else {
          expect(labels, scenario.name).toContain("rollback-runtime-vault-target");
        }
      }
    }
  });
});

function heredoc(program: string, marker: string): string {
  const prefix = `<<'${marker}'\n`;
  const start = program.indexOf(prefix);
  expect(start).toBeGreaterThanOrEqual(0);
  const contentStart = start + prefix.length;
  const end = program.indexOf(`\n${marker}\n`, contentStart);
  expect(end).toBeGreaterThan(contentStart);
  return `${program.slice(contentStart, end)}\n`;
}

function metadata(path: string): { readonly mode: number; readonly mtimeNs: bigint } {
  const value = lstatSync(path, { bigint: true });
  return { mode: Number(value.mode & 0o7777n), mtimeNs: value.mtimeNs };
}

function buildDirectoryRefilterProgram(): string {
  return String.raw`import runpy
import sys
import tarfile

extractor_path = sys.argv[1]
extractor_args = sys.argv[2:]
original_extractall = tarfile.TarFile.extractall

def extractall_with_directory_refilter(
    archive,
    path=".",
    members=None,
    *,
    numeric_owner=False,
    filter=None,
):
    directories = []

    def record(member, destination):
        filtered = filter(member, destination)
        if member.isdir():
            directories.append(member)
        return filtered

    original_extractall(
        archive,
        path,
        members,
        numeric_owner=numeric_owner,
        filter=record,
    )
    for directory in directories:
        filter(directory, path)

tarfile.TarFile.extractall = extractall_with_directory_refilter
sys.argv = [extractor_path, *extractor_args]
runpy.run_path(extractor_path, run_name="__main__")
`;
}

function buildMetadataArchiveProgram(globalHeaderBytes = 0): string {
  return String.raw`import io
import os
import sys
import tarfile

archive_path = sys.argv[1]
uid = int(sys.argv[2])
gid = int(sys.argv[3])

def add(archive, name, kind, mode, mtime, data=b"", linkname=""):
    member = tarfile.TarInfo(name)
    member.type = kind
    member.mode = mode
    member.uid = uid
    member.gid = gid
    member.uname = "ignored"
    member.gname = "ignored"
    member.mtime = int(mtime.split(".")[0])
    member.pax_headers = {"mtime": mtime}
    member.linkname = linkname
    member.size = len(data)
    archive.addfile(member, io.BytesIO(data) if data else None)

open_options = {}
if ${globalHeaderBytes} > 0:
    open_options["pax_headers"] = {"comment": "x" * ${globalHeaderBytes}}

with tarfile.open(archive_path, "w", format=tarfile.PAX_FORMAT, **open_options) as archive:
    add(archive, ".", tarfile.DIRTYPE, 0o1777, "1700000000.123456789")
    add(archive, "./nested", tarfile.DIRTYPE, 0o750, "1700000001.123456789")
    add(archive, "./nested/file.txt", tarfile.REGTYPE, 0o664, "1700000002.123456789", b"payload")
    add(archive, "./link", tarfile.SYMTYPE, 0o777, "1700000003.123456789", linkname="nested/file.txt")
`;
}

function buildBoundaryArchiveProgram(): string {
  return String.raw`import io
import sys
import tarfile

archive_path = sys.argv[1]
scenario = sys.argv[2]
uid = int(sys.argv[3])
gid = int(sys.argv[4])

def member(name, kind, mode=0o700, data=b"", linkname="", pax_headers=None):
    value = tarfile.TarInfo(name)
    value.type = kind
    value.mode = mode
    value.uid = uid
    value.gid = gid
    value.mtime = 1700000000
    value.size = len(data)
    value.linkname = linkname
    value.pax_headers = {"mtime": "1700000000.123456789"}
    if pax_headers:
        value.pax_headers.update(pax_headers)
    return value, io.BytesIO(data) if data else None

def add(archive, *args, **kwargs):
    value, data = member(*args, **kwargs)
    archive.addfile(value, data)

if scenario in ("huge_pax_header", "huge_gnu_longname_header"):
    value = tarfile.TarInfo("./metadata")
    value.type = (
        tarfile.XHDTYPE if scenario == "huge_pax_header" else tarfile.GNUTYPE_LONGNAME
    )
    value.mode = 0o600
    value.uid = uid
    value.gid = gid
    value.mtime = 1700000000
    value.size = 536870912
    with open(archive_path, "wb") as output:
        output.write(value.tobuf(format=tarfile.USTAR_FORMAT))
    raise SystemExit(0)

with tarfile.open(archive_path, "w", format=tarfile.PAX_FORMAT) as archive:
    add(archive, ".", tarfile.DIRTYPE)
    if scenario == "path_too_long":
        add(archive, "p" * 4097, tarfile.REGTYPE)
    elif scenario == "tree_too_deep":
        parts = []
        for _index in range(257):
            parts.append("d")
            add(archive, "/".join(parts), tarfile.DIRTYPE)
    elif scenario == "link_target_too_long":
        add(archive, "link", tarfile.SYMTYPE, mode=0o777, linkname="t" * 4097)
    elif scenario == "unsupported_pax":
        add(archive, "file", tarfile.REGTYPE, data=b"x", pax_headers={"atime": "1"})
    elif scenario == "linkpath_on_regular_file":
        add(archive, "file", tarfile.REGTYPE, data=b"x", pax_headers={"linkpath": "target"})
    elif scenario == "sparse_file":
        add(
            archive,
            "file",
            tarfile.REGTYPE,
            data=b"x",
            pax_headers={"GNU.sparse.map": "0,1"},
        )
    elif scenario == "undeclared_parent":
        add(archive, "missing/file", tarfile.REGTYPE, data=b"x")
    elif scenario == "duplicate_directory":
        add(archive, "directory", tarfile.DIRTYPE)
        add(archive, "directory", tarfile.DIRTYPE)
    elif scenario == "supported_pax":
        directory = "d" * 120
        add(archive, directory, tarfile.DIRTYPE)
        add(archive, directory + "/file", tarfile.REGTYPE, data=b"x")
        add(archive, "link", tarfile.SYMTYPE, mode=0o777, linkname=directory + "/file")
    else:
        raise ValueError("unknown scenario")
`;
}

function runtimeFacts(facts: RuntimeArtifactAttestation): string {
  return [
    "COMIS_RUNTIME_ATTESTATION_V1_BEGIN",
    `digestSha256=${facts.digestSha256}`,
    `entryCount=${facts.entryCount}`,
    `bytes=${facts.bytes}`,
    `packageRoot=${facts.packageRoot}`,
    `version=${facts.version}`,
    `osId=${facts.osId}`,
    `osVersion=${facts.osVersion}`,
    `architecture=${facts.architecture}`,
    `kernelRelease=${facts.kernelRelease}`,
    `libcKind=${facts.libcKind}`,
    `libcVersion=${facts.libcVersion}`,
    `nodeVersion=${facts.nodeVersion}`,
    `nodeAbi=${facts.nodeAbi}`,
    `timezone=${facts.timezone}`,
    `tzdataSha256=${facts.tzdataSha256}`,
    `launcherKind=${facts.launcherKind}`,
    `applicationLauncherSha256=${facts.applicationLauncherSha256}`,
    `confinementKind=${facts.confinementKind}`,
    `confinementSha256=${facts.confinementSha256}`,
    `browserStatus=${facts.browserStatus}`,
    `browserSha256=${facts.browserSha256}`,
    `mediaStatus=${facts.mediaStatus}`,
    `mediaSha256=${facts.mediaSha256}`,
    `nativeToolsStatus=${facts.nativeToolsStatus}`,
    `nativeToolsSha256=${facts.nativeToolsSha256}`,
    "COMIS_RUNTIME_ATTESTATION_V1_END",
    "",
  ].join("\n");
}

function treeFacts(facts: RuntimeTreeAttestation): string {
  return [
    "COMIS_RUNTIME_TREE_ATTESTATION_V2_BEGIN",
    `digestSha256=${facts.digestSha256}`,
    `entryCount=${facts.entryCount}`,
    `bytes=${facts.bytes}`,
    `root=${facts.root}`,
    `version=${facts.version}`,
    "COMIS_RUNTIME_TREE_ATTESTATION_V2_END",
    "",
  ].join("\n");
}

function toolchainFacts(contract: ToolchainContractV1): string {
  const serialized = serializeToolchainContract(contract);
  expect(serialized.ok).toBe(true);
  if (!serialized.ok) throw new Error("test toolchain envelope is invalid");
  return serialized.value;
}

function serviceFacts(fingerprint: ProductionServiceFingerprint): string {
  return [
    PRODUCTION_SERVICE_FINGERPRINT_BEGIN,
    JSON.stringify(
      fingerprint,
      Object.keys(fingerprint).sort(),
    ),
    PRODUCTION_SERVICE_FINGERPRINT_END,
    "",
  ].join("\n");
}

function vaultStatus(
  state: "absent" | "present",
  facts: RuntimeTreeAttestation = sourceTree,
): string {
  return state === "absent"
    ? [RUNTIME_VAULT_STATUS_BEGIN, "state=absent", RUNTIME_VAULT_STATUS_END, ""].join("\n")
    : [
        RUNTIME_VAULT_STATUS_BEGIN,
        "state=present",
        `digestSha256=${facts.digestSha256}`,
        `entryCount=${facts.entryCount}`,
        `bytes=${facts.bytes}`,
        `root=/opt/comis-replay/runtimes/sha256/${facts.digestSha256}/payload`,
        `version=${facts.version}`,
        RUNTIME_VAULT_STATUS_END,
        "",
      ].join("\n");
}

function makeExecutor(
  invocations: ProductionRemoteInvocation[],
  statuses: Array<"absent" | "present">,
  overrides: {
    readonly stagedTree?: RuntimeTreeAttestation;
    readonly finalSourceTree?: RuntimeTreeAttestation;
    readonly failedStage?: string;
    readonly publishOutcome?: "transport_after_commit" | "bad_ack_after_commit";
    readonly publishedAtStart?: boolean;
    readonly targetToolchain?: ToolchainContractV1;
    readonly targetServiceFingerprint?: ProductionServiceFingerprint;
    readonly sourceRuntimeSequence?: readonly RuntimeArtifactAttestation[];
    readonly targetRuntimeSequence?: readonly RuntimeArtifactAttestation[];
    readonly sourceTreeSequence?: readonly RuntimeTreeAttestation[];
    readonly sourceToolchainSequence?: readonly ToolchainContractV1[];
    readonly targetToolchainSequence?: readonly ToolchainContractV1[];
    readonly sourceServiceSequence?: readonly ProductionServiceFingerprint[];
    readonly targetServiceSequence?: readonly ProductionServiceFingerprint[];
  } = {},
): ProductionRemoteExecutor {
  let sourceRuntimeProbe = 0;
  let targetRuntimeProbe = 0;
  let sourceTreeProbe = 0;
  let sourceToolchainProbe = 0;
  let targetToolchainProbe = 0;
  let sourceServiceProbe = 0;
  let targetServiceProbe = 0;
  let statusProbe = 0;
  let prepared = overrides.publishedAtStart === true;
  let published = overrides.publishedAtStart === true;
  let publicationUncertain = false;
  let rolledBack = false;
  return {
    run: async (invocation) => {
      invocations.push(invocation);
      if (invocation.label === overrides.failedStage) {
        return ok({ stdout: "", exitCode: 82 });
      }
      if (invocation.label === "runtime-attest-source") {
        const facts =
          overrides.sourceRuntimeSequence?.[
            Math.min(sourceRuntimeProbe, overrides.sourceRuntimeSequence.length - 1)
          ] ?? sourceRuntime;
        sourceRuntimeProbe += 1;
        return ok({ stdout: runtimeFacts(facts), exitCode: 0 });
      }
      if (invocation.label === "runtime-attest-target") {
        const facts =
          overrides.targetRuntimeSequence?.[
            Math.min(targetRuntimeProbe, overrides.targetRuntimeSequence.length - 1)
          ] ?? targetRuntime;
        targetRuntimeProbe += 1;
        return ok({ stdout: runtimeFacts(facts), exitCode: 0 });
      }
      if (invocation.label === "runtime-tree-attest-source") {
        const facts =
          overrides.sourceTreeSequence?.[
            Math.min(sourceTreeProbe, overrides.sourceTreeSequence.length - 1)
          ] ??
          (sourceTreeProbe > 0 && overrides.finalSourceTree !== undefined
            ? overrides.finalSourceTree
            : sourceTree);
        sourceTreeProbe += 1;
        return ok({ stdout: treeFacts(facts), exitCode: 0 });
      }
      if (invocation.label === "attest-runtime-vault-toolchain-source") {
        const facts =
          overrides.sourceToolchainSequence?.[
            Math.min(sourceToolchainProbe, overrides.sourceToolchainSequence.length - 1)
          ] ?? sourceToolchain;
        sourceToolchainProbe += 1;
        return ok({ stdout: toolchainFacts(facts), exitCode: 0 });
      }
      if (invocation.label === "attest-runtime-vault-toolchain-target") {
        const facts =
          overrides.targetToolchainSequence?.[
            Math.min(targetToolchainProbe, overrides.targetToolchainSequence.length - 1)
          ] ?? overrides.targetToolchain ?? targetToolchain;
        targetToolchainProbe += 1;
        return ok({
          stdout: toolchainFacts(facts),
          exitCode: 0,
        });
      }
      if (invocation.label === "fingerprint-source-service") {
        const facts =
          overrides.sourceServiceSequence?.[
            Math.min(sourceServiceProbe, overrides.sourceServiceSequence.length - 1)
          ] ?? sourceServiceFingerprint;
        sourceServiceProbe += 1;
        return ok({ stdout: serviceFacts(facts), exitCode: 0 });
      }
      if (invocation.label === "fingerprint-target-service") {
        const facts =
          overrides.targetServiceSequence?.[
            Math.min(targetServiceProbe, overrides.targetServiceSequence.length - 1)
          ] ?? overrides.targetServiceFingerprint ?? targetServiceFingerprint;
        targetServiceProbe += 1;
        return ok({
          stdout: serviceFacts(facts),
          exitCode: 0,
        });
      }
      if (invocation.label === "runtime-vault-status-target") {
        const state = statuses[Math.min(statusProbe, statuses.length - 1)] ?? "absent";
        statusProbe += 1;
        return ok({ stdout: vaultStatus(state), exitCode: 0 });
      }
      if (invocation.label === "observe-runtime-vault-transaction-target") {
        const authority = invocation.args.at(-2);
        const identity = invocation.args.at(-1);
        if (authority === undefined || identity === undefined) {
          return ok({ stdout: "", exitCode: 90 });
        }
        const initialFinalState = statuses[0] === "present" ? "exact" : "absent";
        if (!prepared && !published && !publicationUncertain && !rolledBack) {
          return ok({
            stdout: [
              RUNTIME_VAULT_TRANSACTION_STATUS_BEGIN,
              "transactionState=absent",
              `finalState=${initialFinalState}`,
              RUNTIME_VAULT_TRANSACTION_STATUS_END,
              "",
            ].join("\n"),
            exitCode: 0,
          });
        }
        const phases: readonly ProductionRuntimeVaultJournalPhase[] = published
          ? RUNTIME_VAULT_FORWARD_PHASES
          : publicationUncertain
            ? RUNTIME_VAULT_FORWARD_PHASES.slice(0, 7)
            : rolledBack
              ? ["prepare_intent", "prepared", "rollback_intent", "rolled_back"]
              : ["prepare_intent", "prepared"];
        return ok({
          stdout: [
            RUNTIME_VAULT_TRANSACTION_STATUS_BEGIN,
            "transactionState=present",
            "manifestState=valid",
            `authorityDigestSha256=${authority}`,
            `transactionIdentitySha256=${identity}`,
            ...phases.map((phase) => `phase=${phase}`),
            `finalState=${published || publicationUncertain ? "exact" : "absent"}`,
            RUNTIME_VAULT_TRANSACTION_STATUS_END,
            "",
          ].join("\n"),
          exitCode: 0,
        });
      }
      if (invocation.label === "prepare-runtime-vault-target") {
        prepared = true;
        return ok({ stdout: "", exitCode: 0 });
      }
      if (invocation.label === "verify-runtime-vault-target") {
        return ok({
          stdout: treeFacts({
            ...(overrides.stagedTree ?? sourceTree),
            root: `/opt/comis-replay/runtimes/sha256/.incoming-runtime-${sourceTree.digestSha256}/payload`,
          }),
          exitCode: 0,
        });
      }
      if (invocation.label === "publish-runtime-vault-target") {
        if (overrides.publishOutcome === "transport_after_commit") {
          publicationUncertain = true;
          return err({ kind: "remote", message: "publication acknowledgement was lost" });
        }
        if (overrides.publishOutcome === "bad_ack_after_commit") {
          publicationUncertain = true;
          return ok({ stdout: "unexpected\n", exitCode: 0 });
        }
        published = true;
        return ok({ stdout: "published\n", exitCode: 0 });
      }
      if (invocation.label === "finish-runtime-vault-publication-target") {
        publicationUncertain = false;
        published = true;
        return ok({ stdout: "published_recovered\n", exitCode: 0 });
      }
      if (invocation.label === "rollback-runtime-vault-target") {
        rolledBack = true;
        return ok({ stdout: "", exitCode: 0 });
      }
      return ok({ stdout: "", exitCode: 0 });
    },
  };
}
