import { spawnSync } from "node:child_process";
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
import { TOOLCHAIN_ROOT_SHELL_PREFIX } from "./production-toolchain-contract.js";
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
  reconcileProductionRuntimeVaultTarget,
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

function transactionObservation(
  transactionIdentitySha256: string,
  phases: readonly ProductionRuntimeVaultJournalPhase[],
  finalState: "absent" | "exact" | "conflict",
): string {
  return [
    RUNTIME_VAULT_TRANSACTION_STATUS_BEGIN,
    "transactionState=present",
    "manifestState=valid",
    `authorityDigestSha256=${authorityDigestSha256}`,
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
          `/var/lib/comis-self-driving/runtime-vault/transactions/${attemptId}`,
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
    expect(plan.targetPrepare.args).toContain(targetRuntime.packageRoot);
    expect(plan.targetPrepare.stdin).toContain("environment-role");
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
    expect(plan.targetFinishPublish.stdin).toContain("runtime_journal_append published");
    expect(plan.targetFinishPublish.stdin).toContain(
      "runtime_journal_append cleanup_complete",
    );
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
      plan.targetReconcile,
    ]) {
      expect(command.stdin, command.label).toContain("COMIS_RUNTIME_OPERATION_LOCK_GUARD");
      expect(command.stdin, command.label).toContain("os.O_NOFOLLOW");
      expect(command.stdin, command.label).toContain("opened.st_ino");
    }
    expect(plan.targetReconcile.stdin).toContain(
      "COMIS_RUNTIME_CONTROLLER_LEASE_ACQUIRE_GUARD",
    );
    expect(plan.targetReconcile.stdin).not.toContain(
      "COMIS_RUNTIME_CONTROLLER_LEASE_HELD_GUARD",
    );
    expect(
      plan.targetReconcile.stdin.indexOf(
        "COMIS_RUNTIME_CONTROLLER_LEASE_ACQUIRE_GUARD",
      ),
    ).toBeLessThan(
      plan.targetReconcile.stdin.indexOf('if [ ! -e "$operation_lock" ]'),
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
      result.value.targetReconcile,
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
      authorityDigestSha256,
      profile,
      executor,
      bridge,
      leaseClient: makeLeaseClient(leaseRequests, leaseReleases),
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
          status: "unsupported",
          reason: "no_digest_pinned_adapter",
        },
        sourceConsistency: {
          method: "bounded_double_scan",
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
    expect(labels.at(-1)).toBe("runtime-vault-status-target");
    expect(leaseRequests).toHaveLength(1);
    expect(leaseReleases).toEqual(["runtime-vault-controller"]);
  });

  it("reuses an exact existing payload without transfer or target mutation", async () => {
    const invocations: ProductionRemoteInvocation[] = [];
    let transferred = false;
    const result = await sealProductionRuntime({
      runId: "runtime-reuse-a1",
      attemptId,
      authorityDigestSha256,
      profile,
      executor: makeExecutor(invocations, ["present", "present"]),
      bridge: {
        transfer: async () => {
          transferred = true;
          return ok({ bytesTransferred: 1 });
        },
      },
      leaseClient: makeLeaseClient(),
    });

    expect(result).toMatchObject({
      ok: true,
      value: { disposition: "reused", bytesTransferred: 0 },
    });
    expect(transferred).toBe(false);
    expect(invocations.map(({ label }) => label).filter((label) => label.includes("-target"))).toEqual([
      "runtime-attest-target",
      "runtime-vault-status-target",
      "runtime-attest-target",
      "runtime-vault-status-target",
    ]);
  });

  it("refuses target preparation when the continuous controller lease is unavailable", async () => {
    const invocations: ProductionRemoteInvocation[] = [];
    const result = await sealProductionRuntime({
      runId: "runtime-lease-busy-a1",
      attemptId,
      authorityDigestSha256,
      profile,
      executor: makeExecutor(invocations, ["absent"]),
      bridge: { transfer: async () => ok({ bytesTransferred: 1 }) },
      leaseClient: {
        acquire: async () =>
          err({ kind: "remote_failure", message: "Controller lease is held" }),
      },
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
      authorityDigestSha256,
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
      authorityDigestSha256,
      profile,
      executor: makeExecutor(transferInvocations, ["absent"]),
      bridge: {
        transfer: async () => err({ kind: "remote_failure", message: "private" }),
      },
      leaseClient: makeLeaseClient(),
    });
    expect(transferFailure.ok).toBe(false);
    expect(transferInvocations.map(({ label }) => label)).toContain(
      "rollback-runtime-vault-target",
    );

    const verifyInvocations: ProductionRemoteInvocation[] = [];
    const stagedMismatch = await sealProductionRuntime({
      runId: "runtime-verify-fail-a1",
      attemptId,
      authorityDigestSha256,
      profile,
      executor: makeExecutor(verifyInvocations, ["absent"], {
        stagedTree: { ...sourceTree, digestSha256: "f".repeat(64) },
      }),
      bridge: { transfer: async () => ok({ bytesTransferred: 42 }) },
      leaseClient: makeLeaseClient(),
    });
    expect(stagedMismatch.ok).toBe(false);
    expect(verifyInvocations.map(({ label }) => label)).toContain(
      "rollback-runtime-vault-target",
    );
    expect(verifyInvocations.map(({ label }) => label)).not.toContain(
      "publish-runtime-vault-target",
    );
  });

  it("never rolls back another invocation when target preparation did not establish ownership", async () => {
    const invocations: ProductionRemoteInvocation[] = [];
    const executor = makeExecutor(invocations, ["absent"], { failedStage: "prepare-runtime-vault-target" });
    const result = await sealProductionRuntime({
      runId: "runtime-prepare-contended-a1",
      attemptId,
      authorityDigestSha256,
      profile,
      executor,
      bridge: { transfer: async () => ok({ bytesTransferred: 42 }) },
      leaseClient: makeLeaseClient(),
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
      authorityDigestSha256,
      profile,
      executor,
      bridge: { transfer: async () => err({ kind: "remote_failure", message: "private" }) },
      leaseClient: makeLeaseClient(),
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: "rollback_failure",
        primary: { kind: "transfer_failure", stage: "stream-runtime-vault" },
        rollback: {
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
    expect(result.value.targetReconcile.label).toBe("reconcile-runtime-vault-target");
    expect(result.value.targetReconcile.stdin).toContain(
      "COMIS_RUNTIME_OPERATION_LOCK_GUARD",
    );
    expect(result.value.targetReconcile.stdin).toContain(
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
      result.value.targetReconcile.stdin,
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

  it("reconciles rollback and publication crash points under one continuous lease", async () => {
    const plan = buildProductionRuntimeVaultPlan({
      runId: "runtime-target-recovery-a1",
      profile,
      attemptId,
      authorityDigestSha256,
      sourceRuntime,
      targetRuntime,
      sourceTree,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;

    const rollbackLabels: string[] = [];
    let rollbackObservation = 0;
    const rolledBack = await reconcileProductionRuntimeVaultTarget({
      plan: plan.value,
      executor: {
        run: async (invocation) => {
          rollbackLabels.push(invocation.label);
          if (invocation.label === plan.value.targetTransactionStatus.label) {
            rollbackObservation += 1;
            return ok({
              stdout: transactionObservation(
                plan.value.transactionIdentitySha256,
                rollbackObservation === 1
                  ? ["prepare_intent", "prepared"]
                  : [
                      "prepare_intent",
                      "prepared",
                      "rollback_intent",
                      "rolled_back",
                    ],
                "absent",
              ),
              exitCode: 0,
            });
          }
          return ok({ stdout: "", exitCode: 0 });
        },
      },
      leaseClient: makeLeaseClient(),
    });
    expect(rolledBack).toEqual({
      ok: true,
      value: { disposition: "rolled_back" },
    });
    expect(rollbackLabels).toEqual([
      plan.value.targetTransactionStatus.label,
      plan.value.targetRollback.label,
      plan.value.targetTransactionStatus.label,
    ]);

    const publishLabels: string[] = [];
    let publishObservation = 0;
    const published = await reconcileProductionRuntimeVaultTarget({
      plan: plan.value,
      executor: {
        run: async (invocation) => {
          publishLabels.push(invocation.label);
          if (invocation.label === plan.value.targetTransactionStatus.label) {
            publishObservation += 1;
            return ok({
              stdout: transactionObservation(
                plan.value.transactionIdentitySha256,
                publishObservation === 1
                  ? RUNTIME_VAULT_FORWARD_PHASES.slice(0, 7)
                  : RUNTIME_VAULT_FORWARD_PHASES,
                "exact",
              ),
              exitCode: 0,
            });
          }
          return ok({ stdout: "published_recovered\n", exitCode: 0 });
        },
      },
      leaseClient: makeLeaseClient(),
    });
    expect(published).toEqual({
      ok: true,
      value: { disposition: "published" },
    });
    expect(publishLabels).toEqual([
      plan.value.targetTransactionStatus.label,
      plan.value.targetFinishPublish.label,
      plan.value.targetTransactionStatus.label,
    ]);
  });

  it("blocks corrupt transaction evidence without invoking target mutation", async () => {
    const plan = buildProductionRuntimeVaultPlan({
      runId: "runtime-target-corrupt-a1",
      profile,
      attemptId,
      authorityDigestSha256,
      sourceRuntime,
      targetRuntime,
      sourceTree,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const labels: string[] = [];
    const result = await reconcileProductionRuntimeVaultTarget({
      plan: plan.value,
      executor: {
        run: async (invocation) => {
          labels.push(invocation.label);
          return ok({
            stdout: [
              RUNTIME_VAULT_TRANSACTION_STATUS_BEGIN,
              "transactionState=present",
              "manifestState=corrupt",
              "finalState=absent",
              RUNTIME_VAULT_TRANSACTION_STATUS_END,
              "",
            ].join("\n"),
            exitCode: 0,
          });
        },
      },
      leaseClient: makeLeaseClient(),
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: "attestation_failure",
        stage: "classify-runtime-vault-transaction",
      },
    });
    expect(labels).toEqual([plan.value.targetTransactionStatus.label]);
  });

  it("provides an explicit interrupted transaction recovery result without starting replay", async () => {
    const rolledBackInvocations: ProductionRemoteInvocation[] = [];
    const rolledBack = await recoverProductionRuntimeVault({
      runId: "runtime-recover-rollback-a1",
      attemptId,
      authorityDigestSha256,
      profile,
      executor: makeExecutor(rolledBackInvocations, ["absent"]),
    });
    expect(rolledBack).toMatchObject({
      ok: true,
      value: {
        disposition: "staging_rolled_back",
        payload: { digestSha256: sourceTree.digestSha256 },
      },
    });
    expect(rolledBackInvocations.map(({ label }) => label)).toContain(
      "reconcile-runtime-vault-target",
    );

    const publishedInvocations: ProductionRemoteInvocation[] = [];
    const published = await recoverProductionRuntimeVault({
      runId: "runtime-recover-published-a1",
      attemptId,
      authorityDigestSha256,
      profile,
      executor: makeExecutor(publishedInvocations, ["present"]),
    });
    expect(published).toMatchObject({
      ok: true,
      value: {
        disposition: "published_recovered",
        payload: { digestSha256: sourceTree.digestSha256 },
      },
    });
  });

  it("prevents publication when the source changes during capture", async () => {
    const invocations: ProductionRemoteInvocation[] = [];
    const result = await sealProductionRuntime({
      runId: "runtime-source-drift-a1",
      attemptId,
      authorityDigestSha256,
      profile,
      executor: makeExecutor(invocations, ["absent"], {
        finalSourceTree: { ...sourceTree, digestSha256: "f".repeat(64) },
      }),
      bridge: { transfer: async () => ok({ bytesTransferred: 42 }) },
      leaseClient: makeLeaseClient(),
    });

    expect(result.ok).toBe(false);
    const labels = invocations.map(({ label }) => label);
    expect(labels).toContain("rollback-runtime-vault-target");
    expect(labels).not.toContain("publish-runtime-vault-target");
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
  } = {},
): ProductionRemoteExecutor {
  let sourceTreeProbe = 0;
  let statusProbe = 0;
  return {
    run: async (invocation) => {
      invocations.push(invocation);
      if (invocation.label === overrides.failedStage) {
        return ok({ stdout: "", exitCode: 82 });
      }
      if (invocation.label === "runtime-attest-source") {
        return ok({ stdout: runtimeFacts(sourceRuntime), exitCode: 0 });
      }
      if (invocation.label === "runtime-attest-target") {
        return ok({ stdout: runtimeFacts(targetRuntime), exitCode: 0 });
      }
      if (invocation.label === "runtime-tree-attest-source") {
        sourceTreeProbe += 1;
        const facts =
          sourceTreeProbe > 1 && overrides.finalSourceTree !== undefined
            ? overrides.finalSourceTree
            : sourceTree;
        return ok({ stdout: treeFacts(facts), exitCode: 0 });
      }
      if (invocation.label === "runtime-vault-status-target") {
        const state = statuses[Math.min(statusProbe, statuses.length - 1)] ?? "absent";
        statusProbe += 1;
        return ok({ stdout: vaultStatus(state), exitCode: 0 });
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
        return ok({ stdout: "published\n", exitCode: 0 });
      }
      return ok({ stdout: "", exitCode: 0 });
    },
  };
}
