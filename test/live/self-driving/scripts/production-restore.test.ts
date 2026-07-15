import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { err, ok } from "@comis/shared";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";

import type { ProductionBinarySshBridge } from "./production-binary-ssh.js";
import type {
  ProductionRemoteExecutor,
  ProductionRemoteInvocation,
} from "./production-bootstrap.js";
import { TARGET_REPLAY_QUARANTINE_SHA256 } from "./production-bootstrap.js";
import type { ProductionReplayProfile } from "./production-profile.js";
import { buildReplayQuarantineOverlay } from "./production-quarantine.js";
import {
  buildProductionRestorePlan,
  commitProductionRestore,
  inspectProductionRestore,
  parseProductionRestoreStatus,
  parseProductionReplayRestoreAttestation,
  prepareProductionRestore,
  rollbackProductionRestoreRecovery,
  resumeProductionRestore,
} from "./production-restore.js";
import {
  buildProductionSnapshotPlan,
  deriveProductionSnapshotDataTreeIdentity,
  deriveProductionSnapshotEnvironmentEvidenceIdentity,
  type ProductionSnapshotManifest,
} from "./production-snapshot.js";

const SOURCE_MACHINE = "a".repeat(64);
const TARGET_MACHINE = "b".repeat(64);
const FILE_HASH = "c".repeat(64);
const ACL_HASH = "d".repeat(64);
const XATTR_HASH = "e".repeat(64);
const CAPABILITY_HASH = "f".repeat(64);

const entryMetadata = {
  uid: 1001,
  gid: 1002,
  mtimeNs: "1752560000123456789",
  aclSha256: ACL_HASH,
  xattrSha256: XATTR_HASH,
  capabilitySha256: CAPABILITY_HASH,
} as const;

function manifestFromRealLayout(root: string): ProductionSnapshotManifest {
  const candidates: Array<
    ProductionSnapshotManifest["entries"][number] & {
      readonly absolutePath?: string;
      readonly inodeKey?: string;
    }
  > = [];
  const walk = (relative: string): void => {
    const absolutePath = join(root, ...relative.split("/"));
    const value = lstatSync(absolutePath, { bigint: true });
    const common = {
      path: relative,
      mode: Number(value.mode & 0o7777n).toString(8).padStart(4, "0"),
      size: Number(value.size),
      uid: Number(value.uid),
      gid: Number(value.gid),
      mtimeNs: value.mtimeNs.toString(),
    };
    if (value.isFile()) {
      candidates.push({
        ...common,
        type: "file",
        sha256: createHash("sha256").update(readFileSync(absolutePath)).digest("hex"),
        absolutePath,
        inodeKey: `${value.dev}:${value.ino}`,
      });
      return;
    }
    if (value.isSymbolicLink()) {
      candidates.push({ ...common, type: "symlink", linkTarget: readlinkSync(absolutePath) });
      return;
    }
    if (!value.isDirectory()) throw new Error("real layout fixture contains a special file");
    candidates.push({ ...common, type: "directory", size: 0 });
    for (const child of readdirSync(absolutePath).sort((left, right) =>
      Buffer.compare(Buffer.from(left), Buffer.from(right)),
    )) {
      walk(`${relative}/${child}`);
    }
  };
  walk("data");
  walk("system");
  candidates.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  const inodeTargets = new Map<string, string>();
  const entries = candidates.map(({ absolutePath: _absolutePath, inodeKey, ...entry }) => {
    if (entry.type !== "file" || inodeKey === undefined) return entry;
    const target = inodeTargets.get(inodeKey);
    if (target === undefined) {
      inodeTargets.set(inodeKey, entry.path);
      return entry;
    }
    const { sha256: _sha256, ...hardlink } = entry;
    return { ...hardlink, type: "hardlink" as const, hardlinkTarget: target };
  });
  const value: ProductionSnapshotManifest = {
    schemaVersion: 1,
    runId: "restore-real-layout-a1",
    sourceMachineIdSha256: SOURCE_MACHINE,
    service: "comis",
    captureMode: "offline",
    captureStartedAtMs: 1_752_560_000_000,
    captureCompletedAtMs: 1_752_560_000_100,
    freezeDurationMs: 0,
    metadataIdentity: {
      acl: "unavailable",
      xattr: "unavailable",
      capability: "unavailable",
      gaps: [
        { kind: "acl", reason: "source_tool_unavailable" },
        { kind: "xattr", reason: "source_tool_unavailable" },
        { kind: "capability", reason: "source_tool_unavailable" },
      ],
    },
    dataTreeIdentitySha256: "0".repeat(64),
    sourceEnvironmentEvidenceIdentitySha256: "0".repeat(64),
    entries,
    exclusions: [],
  };
  return {
    ...value,
    dataTreeIdentitySha256: deriveProductionSnapshotDataTreeIdentity(value),
    sourceEnvironmentEvidenceIdentitySha256:
      deriveProductionSnapshotEnvironmentEvidenceIdentity(value),
  };
}

const profile: ProductionReplayProfile = {
  source: {
    ssh: "source-host",
    sshPort: 2222,
    role: "production",
    comisUser: "comis",
    dataDir: "/home/comis/.comis",
    service: "comis",
    expectedMachineIdSha256: SOURCE_MACHINE,
  },
  target: {
    ssh: "target-host",
    sshPort: 2202,
    role: "test",
    comisUser: "comis-test",
    dataDir: "/home/comis-test/.comis",
    service: "comis-test",
    expectedMachineIdSha256: TARGET_MACHINE,
  },
};

function makeManifest(
  overrides: Partial<ProductionSnapshotManifest> = {},
): ProductionSnapshotManifest {
  const base: ProductionSnapshotManifest = {
    schemaVersion: 1,
    runId: "restore-a1",
    sourceMachineIdSha256: SOURCE_MACHINE,
    service: "comis",
    captureMode: "offline",
    captureStartedAtMs: 1_752_560_000_000,
    captureCompletedAtMs: 1_752_560_004_000,
    freezeDurationMs: 0,
    metadataIdentity: {
      acl: "captured",
      xattr: "captured",
      capability: "captured",
      gaps: [],
    },
    dataTreeIdentitySha256: "0".repeat(64),
    sourceEnvironmentEvidenceIdentitySha256: "0".repeat(64),
    entries: [
      { path: "data", type: "directory", mode: "0700", size: 0, ...entryMetadata },
      {
        path: "data/config.yaml",
        type: "file",
        mode: "0600",
        size: 128,
        sha256: FILE_HASH,
        ...entryMetadata,
      },
      {
        path: "data/memory.db",
        type: "file",
        mode: "0600",
        size: 4096,
        sha256: FILE_HASH,
        ...entryMetadata,
      },
      {
        path: "data/memory.db-wal",
        type: "file",
        mode: "0600",
        size: 2048,
        sha256: FILE_HASH,
        ...entryMetadata,
      },
      {
        path: "data/memory.db.copy",
        type: "hardlink",
        mode: "0600",
        size: 4096,
        hardlinkTarget: "data/memory.db",
        ...entryMetadata,
      },
      {
        path: "data/runtime/python",
        type: "symlink",
        mode: "0777",
        size: 10,
        linkTarget: "../python3",
        ...entryMetadata,
      },
      { path: "system", type: "directory", mode: "0700", size: 0, uid: 0, gid: 0, mtimeNs: entryMetadata.mtimeNs, aclSha256: ACL_HASH, xattrSha256: XATTR_HASH, capabilitySha256: CAPABILITY_HASH },
      { path: "system/etc", type: "directory", mode: "0755", size: 0, uid: 0, gid: 0, mtimeNs: entryMetadata.mtimeNs, aclSha256: ACL_HASH, xattrSha256: XATTR_HASH, capabilitySha256: CAPABILITY_HASH },
      { path: "system/etc/comis", type: "directory", mode: "0755", size: 0, uid: 0, gid: 0, mtimeNs: entryMetadata.mtimeNs, aclSha256: ACL_HASH, xattrSha256: XATTR_HASH, capabilitySha256: CAPABILITY_HASH },
      {
        path: "system/etc/comis/env",
        type: "file",
        mode: "0640",
        size: 72,
        sha256: FILE_HASH,
        uid: 0,
        gid: 1002,
        mtimeNs: entryMetadata.mtimeNs,
        aclSha256: ACL_HASH,
        xattrSha256: XATTR_HASH,
        capabilitySha256: CAPABILITY_HASH,
      },
    ],
    exclusions: [
      {
        path: "data/.daemon.lock",
        type: "file",
        mode: "0600",
        size: 12,
        reason: "daemon_lock",
      },
      {
        path: "data/memory.db-shm",
        type: "file",
        mode: "0600",
        size: 32768,
        reason: "sqlite_shm",
      },
      {
        path: "data/runtime.sock",
        type: "socket",
        mode: "0770",
        size: 0,
        reason: "runtime_socket",
      },
    ],
  };
  const merged = { ...base, ...overrides };
  return {
    ...merged,
    dataTreeIdentitySha256:
      overrides.dataTreeIdentitySha256 ?? deriveProductionSnapshotDataTreeIdentity(merged),
    sourceEnvironmentEvidenceIdentitySha256:
      overrides.sourceEnvironmentEvidenceIdentitySha256 ??
      deriveProductionSnapshotEnvironmentEvidenceIdentity(merged),
  };
}

function makeRequest(manifest: ProductionSnapshotManifest = makeManifest()) {
  const snapshot = buildProductionSnapshotPlan({
    runId: manifest.runId,
    expectedMachineIdSha256: manifest.sourceMachineIdSha256,
    service: manifest.service,
    dataDir: profile.source.dataDir,
    captureMode: manifest.captureMode,
  });
  if (!snapshot.ok) throw new Error("snapshot fixture must be valid");
  return {
    runId: manifest.runId,
    profile,
    snapshot: snapshot.value,
    manifestJson: JSON.stringify(manifest),
    agentIds: ["default", "research"],
  } as const;
}

function replayOverlaySha256(agentIds: readonly string[]): string {
  const overlay = buildReplayQuarantineOverlay(agentIds);
  if (!overlay.ok) throw new Error("replay overlay fixture must be valid");
  return createHash("sha256").update(overlay.value).digest("hex");
}

interface RestoreStatusFixtureOptions {
  readonly runId?: string;
  readonly targetMachineIdSha256?: string;
  readonly bytesTransferred?: number;
  readonly attestationOverrides?: Readonly<Record<string, unknown>>;
  readonly reencodeAttestation?: boolean;
}

function restoreStatusFixture(
  state: "promoted" | "authorized" | "finalizing" | "finalized",
  options: RestoreStatusFixtureOptions = {},
): string {
  const plan = buildProductionRestorePlan(makeRequest());
  if (!plan.ok) throw new Error("restore plan fixture must be valid");
  const runId = options.runId ?? "restore-a1";
  const targetMachineIdSha256 = options.targetMachineIdSha256 ?? TARGET_MACHINE;
  const attestation = {
    ...plan.value.restoreAttestationExpectation,
    runId,
    targetMachineIdSha256,
    effectiveEnvironmentContentSha256: "e".repeat(64),
    ...options.attestationOverrides,
  };
  const attestationRaw = options.reencodeAttestation
    ? `${JSON.stringify(attestation, null, 1)}\n`
    : `${JSON.stringify(attestation)}\n`;
  return `${JSON.stringify({
    schemaVersion: 1,
    runId,
    targetMachineIdSha256,
    state,
    bytesTransferred: options.bytesTransferred ?? 8192,
    restoreAttestationBase64: Buffer.from(attestationRaw).toString("base64"),
    restoreAttestationSha256: createHash("sha256").update(attestationRaw).digest("hex"),
  })}\n`;
}

function restorePhaseStatusFixture(
  state: "promoting" | "rolling_back" | "rolled_back",
): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    runId: "restore-a1",
    targetMachineIdSha256: TARGET_MACHINE,
    state,
    bytesTransferred: state === "rolled_back" ? null : 8192,
    restoreAttestationBase64: null,
    restoreAttestationSha256: null,
  })}\n`;
}

function makeDeps(options: {
  readonly failLabel?: string;
  readonly failTransfer?: boolean;
  readonly stdoutLabel?: string;
  readonly restoreAttestationStdout?: string;
  readonly restoreStatusState?: "promoted" | "authorized" | "finalizing" | "finalized";
  readonly restoreStatusStdout?: string;
} = {}): {
  readonly executor: ProductionRemoteExecutor;
  readonly bridge: ProductionBinarySshBridge;
  readonly run: ReturnType<typeof vi.fn>;
  readonly transfer: ReturnType<typeof vi.fn>;
} {
  const run = vi.fn(async (invocation: ProductionRemoteInvocation) => {
    if (invocation.label === options.failLabel) {
      return err({ kind: "remote" as const, message: "remote command failed" });
    }
    if (invocation.label === "read-promoted-snapshot-attestation") {
      const plan = buildProductionRestorePlan(makeRequest());
      if (!plan.ok) throw new Error("restore plan fixture must be valid");
      return ok({
        stdout:
          options.restoreAttestationStdout ??
          `${JSON.stringify({
            ...plan.value.restoreAttestationExpectation,
            effectiveEnvironmentContentSha256: "e".repeat(64),
          })}\n`,
        exitCode: 0,
      });
    }
    if (invocation.label === "inspect-snapshot-target") {
      return ok({
        stdout:
          options.restoreStatusStdout ??
          restoreStatusFixture(options.restoreStatusState ?? "authorized"),
        exitCode: 0,
      });
    }
    return ok({
      stdout: invocation.label === options.stdoutLabel ? "unexpected" : "",
      exitCode: 0,
    });
  });
  const transfer = vi.fn(async () =>
    options.failTransfer
      ? err({ kind: "remote_failure" as const, message: "binary transfer failed" })
      : ok({ bytesTransferred: 8192 }),
  );
  return {
    executor: { run },
    bridge: { transfer },
    run,
    transfer,
  };
}

describe("production snapshot restore transaction", () => {
  it("builds a port-aware bounded receiver from a strictly parsed snapshot manifest", () => {
    const result = buildProductionRestorePlan(makeRequest());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const plan = result.value;

    expect(plan.targetPrepare).toMatchObject({ host: "target-host", port: 2202 });
    expect(plan.sourceStreamPrepare).toMatchObject({ host: "source-host", port: 2222 });
    expect(plan.stream.source).toMatchObject({ host: "source-host", port: 2222 });
    expect(plan.stream.target).toMatchObject({ host: "target-host", port: 2202 });
    expect(plan.stream.maximumBytes).toBeGreaterThan(8192);
    expect(plan.minimumTargetFreeBytes).toBeGreaterThan(
      plan.stream.maximumBytes + plan.restoreAttestationExpectation.dataBytes,
    );
    expect(plan.targetPrepare.args).toContain(String(plan.minimumTargetFreeBytes));
    expect(plan.targetPrepare.stdin).toContain('minimum_free_bytes="$7"');
    expect(plan.targetPrepare.stdin).toContain('minimum_free_inodes="$8"');
    expect(plan.targetPrepare.stdin).toContain('minimum_etc_free_bytes="$9"');
    expect(plan.targetPrepare.stdin).toContain('minimum_etc_free_inodes="${10}"');
    expect(plan.targetPrepare.stdin).toContain(
      '[ "$available_bytes" -lt "$minimum_free_bytes" ]',
    );
    expect(plan.stream.source.args).toContain(
      "/run/comis-self-driving/restore-a1/stream-restore.sh",
    );
    expect(plan.stream.target.args).toContain(
      "/run/comis-self-driving/restore-restore-a1/receive.sh",
    );
    expect(plan.restoreAttestationExpectation).toEqual({
      schemaVersion: 1,
      state: "committed",
      runId: "restore-a1",
      targetMachineIdSha256: "b".repeat(64),
      baselineImmutable: true,
      dataDirSha256: "ef4e180fa56124fe7af6dcb50b03994870d4d25d5ad3f9198f1d24373be1c6cf",
      snapshotManifestSha256: plan.manifestSha256,
      restoredDataTreeDigestSha256: makeManifest().dataTreeIdentitySha256,
      sourceEnvironmentEvidenceIdentitySha256:
        makeManifest().sourceEnvironmentEvidenceIdentitySha256,
      replayOverlayContentSha256: replayOverlaySha256(["default", "research"]),
      dataEntryCount: 6,
      dataBytes: 6_272,
    });

    for (const command of [
      plan.targetPrepare,
      plan.targetVerifyAndPromote,
      plan.targetCommit,
      plan.targetFinalize,
    ]) {
      expect(command.stdin).toContain("sha256sum /etc/machine-id");
      expect(command.stdin).toContain("environment-role");
      expect(command.stdin).toContain(TARGET_REPLAY_QUARANTINE_SHA256);
      expect(command.stdin).toContain("systemctl is-active");
      expect(command.stdin).toContain("systemctl is-enabled");
      expect(command.stdin).toContain("exec 1>/dev/null");
      expect(command.stdin).not.toMatch(/systemctl\s+(start|restart|enable)\b/u);
    }
    expect(plan.targetRollback.stdin).toContain("sha256sum /etc/machine-id");
    expect(plan.targetRollback.stdin).toContain('systemctl stop "$unit"');
    expect(plan.targetRollback.stdin).toContain('systemctl disable "$unit"');
    expect(plan.targetRollback.stdin).not.toContain(TARGET_REPLAY_QUARANTINE_SHA256);
    expect(plan.targetPrepare.stdin).toContain('"$enabled_state" != disabled');
    expect(plan.targetPrepare.stdin).toContain("install -d -m 0700 -o root -g root");
    expect(plan.targetPrepare.stdin).toContain("maximum_bytes");
    expect(plan.targetPrepare.stdin).toContain("receive.sh");
    expect(plan.targetPrepare.stdin).not.toContain("COMIS_GATEWAY_TOKEN");
  });

  it("reserves every restore copy and executes the tenth preflight argument binding", () => {
    const request = makeRequest();
    const result = buildProductionRestorePlan(request);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const captured = JSON.parse(request.manifestJson) as ProductionSnapshotManifest;
    const extractedFileBytes = captured.entries.reduce(
      (total, entry) => total + (entry.type === "file" ? entry.size : 0),
      0,
    );
    const environmentBytes = captured.entries.find(
      (entry) => entry.path === "system/etc/comis/env" && entry.type === "file",
    )?.size;
    expect(environmentBytes).toBe(72);
    expect(result.value.minimumTargetFreeBytes).toBe(
      result.value.stream.maximumBytes +
        extractedFileBytes * 2 +
        (environmentBytes ?? 0) +
        Buffer.byteLength(request.manifestJson, "utf8") * 2 +
        64 * 1024 * 1024,
    );
    expect(result.value.minimumTargetFreeInodes).toBe(captured.entries.length + 128);
    expect(result.value.minimumEtcFreeBytes).toBe((environmentBytes ?? 0) + 64 * 1024 * 1024);
    expect(result.value.minimumEtcFreeInodes).toBe(32);
    expect(result.value.targetPrepare.stdin).toContain('df -Pi "$control_dir"');
    expect(result.value.targetPrepare.stdin).toContain("df -PB1 /etc/comis");
    expect(result.value.targetPrepare.stdin).toContain("df -Pi /etc/comis");
    expect(result.value.targetPrepare.stdin).toContain(
      'required_shared_bytes="$(( minimum_free_bytes + minimum_etc_free_bytes ))"',
    );

    const assignmentEnd = result.value.targetPrepare.stdin.indexOf("exec 1>/dev/null");
    expect(assignmentEnd).toBeGreaterThan(0);
    const bindingProbe = `${result.value.targetPrepare.stdin.slice(0, assignmentEnd)}printf '%s\\n' "$minimum_etc_free_inodes"\n`;
    const bound = spawnSync(
      "bash",
      ["-s", "--", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"],
      { input: bindingProbe, encoding: "utf8" },
    );
    expect(bound.status, bound.stderr).toBe(0);
    expect(bound.stdout).toBe("ten\n");
  });

  it("rejects manifest traversal and mismatched capture identities before remote work", () => {
    const unsafe = JSON.parse(JSON.stringify(makeManifest())) as Record<string, unknown>;
    const entries = unsafe["entries"] as Array<Record<string, unknown>>;
    entries[1]!["path"] = "../escape";
    const unsafeRequest = { ...makeRequest(), manifestJson: JSON.stringify(unsafe) };
    expect(buildProductionRestorePlan(unsafeRequest).ok).toBe(false);

    const wrongMachine = makeManifest({ sourceMachineIdSha256: "d".repeat(64) });
    expect(buildProductionRestorePlan(makeRequest(wrongMachine)).ok).toBe(false);

    const wrongRun = makeManifest({ runId: "other-run" });
    const wrongRunRequest = { ...makeRequest(), manifestJson: JSON.stringify(wrongRun) };
    expect(buildProductionRestorePlan({ ...wrongRunRequest, runId: "restore-a1" }).ok).toBe(
      false,
    );

    const forgedSnapshot = makeRequest();
    expect(
      buildProductionRestorePlan({
        ...forgedSnapshot,
        snapshot: {
          ...forgedSnapshot.snapshot,
          stream: { ...forgedSnapshot.snapshot.stream, stdin: "rm -rf -- /" },
        },
      }).ok,
    ).toBe(false);

    expect(
      buildProductionRestorePlan({
        ...makeRequest(),
        profile: {
          ...profile,
          target: { ...profile.target, dataDir: "/home/$(touch)/.comis" },
        },
      }).ok,
    ).toBe(false);

    expect(
      buildProductionRestorePlan({
        ...makeRequest(),
        profile: {
          ...profile,
          target: { ...profile.target, ssh: "source-host" },
        },
      }).ok,
    ).toBe(false);
  });

  it("rejects target data paths that overlap restore control roots", () => {
    const protectedPathCollisions = [
      "/etc",
      "/etc/comis",
      "/etc/comis/restore-data",
      "/var",
      "/var/lib/comis-self-driving",
      "/var/lib/comis-self-driving/restore-data",
      "/run",
      "/run/comis-self-driving",
      "/run/comis-self-driving/restore-data",
      "/.comis-self-driving",
      "/.comis-self-driving/restore-restore-a1",
    ] as const;
    const acceptedCollisions = protectedPathCollisions.filter((dataDir) => {
      const request = makeRequest();
      return buildProductionRestorePlan({
        ...request,
        profile: {
          ...request.profile,
          target: { ...request.profile.target, dataDir },
        },
      }).ok;
    });

    expect(acceptedCollisions).toEqual([]);
  });

  it("checks protected path overlap across the mount namespace", () => {
    const result = buildProductionRestorePlan(makeRequest());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const guardedScript of [
      result.value.targetPrepare.stdin,
      result.value.targetRollback.stdin,
    ]) {
      expect(guardedScript).toContain("/proc/self/mountinfo");
      expect(guardedScript).toContain("def mount_regions(path: str)");
      expect(guardedScript).toContain("mount.root");
      expect(guardedScript).toContain("mount.target");
      expect(guardedScript).toContain(
        'python3 - "$data_dir" /etc/comis "$coordination_root" "$runtime_root" "$state_root"',
      );
    }
  });

  it("cleans the source stage when strict manifest validation stops restore before target work", async () => {
    const deps = makeDeps();
    const request = makeRequest();
    const result = await prepareProductionRestore(
      { ...request, manifestJson: "{malformed" },
      deps,
    );

    expect(result.ok).toBe(false);
    expect(deps.transfer).not.toHaveBeenCalled();
    expect(deps.run.mock.calls.map(([invocation]) => invocation.label)).toEqual([
      "cleanup-snapshot-source",
    ]);
  });

  it("preflights archive members before extraction and verifies the complete staged tree", () => {
    const result = buildProductionRestorePlan(makeRequest());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const script = result.value.targetVerifyAndPromote.stdin;
    const scanIndex = script.indexOf("tarfile.open");
    const extractIndex = script.indexOf("tar --extract");

    expect(scanIndex).toBeGreaterThan(0);
    expect(extractIndex).toBeGreaterThan(scanIndex);
    expect(script).toContain("PurePosixPath");
    expect(script).toContain("member.isdev()");
    expect(script).toContain("member.isfifo()");
    expect(script).toContain("member.islnk()");
    expect(script).toContain('record["hardlinkTarget"]');
    expect(script).toContain('member.uid != record["uid"]');
    expect(script).toContain("symlink_prefixes");
    expect(script).toContain("expected-manifest.json");
    expect(script).toContain("sha256sum");
    expect(script).toContain("lstat");
    expect(script).toContain("readlink");
    expect(script).toContain("st_mtime_ns");
    expect(script).toContain("st_uid");
    expect(script).toContain("getfacl");
    expect(script).toContain("getfattr");
    expect(script).toContain("getcap");
    expect(script).toContain("st_ino");
    expect(script).toContain("excluded_paths");
    expect(script).toContain("SQLite format 3\\0");
    expect(script).toContain("PRAGMA quick_check");
    expect(script).toContain("PRAGMA integrity_check");
    expect(script).toContain("PRAGMA foreign_key_check");
    expect(script).not.toContain("print(row");
  });

  it("checks a WAL database from transaction-local scratch without mutating captured metadata", () => {
    const temporary = mkdtempSync(join(tmpdir(), "comis-restore-sqlite-"));
    let database: Database.Database | undefined;
    try {
      const origin = join(temporary, "origin.sqlite");
      database = new Database(origin);
      database.pragma("journal_mode = WAL");
      database.pragma("wal_autocheckpoint = 0");
      database.exec("CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
      database.prepare("INSERT INTO records (value) VALUES (?)").run("fixture");
      expect(lstatSync(`${origin}-wal`).isFile()).toBe(true);

      const capturedRoot = join(temporary, "captured");
      const dataDir = join(capturedRoot, "data");
      const systemDir = join(capturedRoot, "system", "etc", "comis");
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      mkdirSync(systemDir, { recursive: true, mode: 0o755 });
      copyFileSync(origin, join(dataDir, "memory.db"));
      copyFileSync(`${origin}-wal`, join(dataDir, "memory.db-wal"));
      writeFileSync(join(systemDir, "env"), "COMIS_DATA_DIR=/tmp/test\n", { mode: 0o640 });
      database.close();
      database = undefined;

      const manifest = manifestFromRealLayout(capturedRoot);
      const plan = buildProductionRestorePlan(makeRequest(manifest));
      expect(plan.ok).toBe(true);
      if (!plan.ok) return;
      const marker = "<<'PYTHON_VERIFY'\n";
      const start = plan.value.targetVerifyAndPromote.stdin.indexOf(marker);
      const end = plan.value.targetVerifyAndPromote.stdin.indexOf("\nPYTHON_VERIFY", start);
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      const verifier = plan.value.targetVerifyAndPromote.stdin.slice(
        start + marker.length,
        end,
      );
      const manifestPath = join(temporary, "manifest.json");
      writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
      const dataMtimeBefore = lstatSync(dataDir, { bigint: true }).mtimeNs;

      const verified = spawnSync("python3", ["-", capturedRoot, manifestPath], {
        input: verifier,
        encoding: "utf8",
      });

      expect(verified.status, verified.stderr).toBe(0);
      expect(lstatSync(dataDir, { bigint: true }).mtimeNs).toBe(dataMtimeBefore);
      expect(() => lstatSync(join(dataDir, "memory.db-shm"))).toThrow();
      expect(plan.value.targetVerifyAndPromote.stdin).toContain(
        'dir=os.path.dirname(root)',
      );
      expect(plan.value.targetVerifyAndPromote.stdin).not.toContain(
        'os.unlink(shared_memory)',
      );
    } finally {
      database?.close();
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("verifies a real nested session layout with hardlinks and rejects metadata divergence", () => {
    const temporary = mkdtempSync(join(tmpdir(), "comis-restore-layout-"));
    try {
      const root = join(temporary, "extracted");
      const sessionDir = join(root, "data", "workspace", "sessions", "tenant_a", "telegram");
      const systemDir = join(root, "system", "etc", "comis");
      mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
      mkdirSync(systemDir, { recursive: true, mode: 0o755 });
      const sessionPath = join(sessionDir, "session.jsonl");
      const hardlinkPath = join(sessionDir, "session.jsonl.copy");
      writeFileSync(sessionPath, '{"role":"user"}\n', { mode: 0o600 });
      linkSync(sessionPath, hardlinkPath);
      symlinkSync("session.jsonl", join(sessionDir, "latest"));
      writeFileSync(join(systemDir, "env"), "COMIS_DATA_DIR=/tmp/test\n", { mode: 0o640 });

      const manifest = manifestFromRealLayout(root);
      expect(
        manifest.entries.find(({ path }) => path.endsWith("session.jsonl.copy")),
      ).toMatchObject({ type: "hardlink", hardlinkTarget: expect.stringMatching(/session\.jsonl$/u) });
      const plan = buildProductionRestorePlan(makeRequest(manifest));
      expect(plan.ok).toBe(true);
      if (!plan.ok) return;
      const marker = "<<'PYTHON_VERIFY'\n";
      const start = plan.value.targetVerifyAndPromote.stdin.indexOf(marker);
      const end = plan.value.targetVerifyAndPromote.stdin.indexOf("\nPYTHON_VERIFY", start);
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      const verifier = plan.value.targetVerifyAndPromote.stdin.slice(start + marker.length, end);
      const manifestPath = join(temporary, "manifest.json");
      writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 });

      const verified = spawnSync("python3", ["-", root, manifestPath], {
        input: verifier,
        encoding: "utf8",
      });
      expect(verified.status, verified.stderr).toBe(0);

      chmodSync(sessionPath, 0o640);
      const divergent = spawnSync("python3", ["-", root, manifestPath], {
        input: verifier,
        encoding: "utf8",
      });
      expect(divergent.status).not.toBe(0);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("keeps the source environment immutable and promotes data and quarantine config atomically", () => {
    const result = buildProductionRestorePlan(makeRequest());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const script = result.value.targetVerifyAndPromote.stdin;

    expect(script).toContain("source-env.original");
    expect(script).toContain("chattr +i");
    expect(script).toContain("COMIS_CONFIG_PATHS=");
    expect(script).toContain("replay-quarantine.yaml");
    expect(script).not.toContain("chown -hR");
    expect(script).toContain('mv -- "$data_dir" "$rollback_data"');
    expect(script).toContain('mv -- "$incoming_data" "$data_dir"');
    expect(script).toContain("trap rollback_promote EXIT HUP INT TERM");
    expect(script).toContain("replay-restore-attestation.json");
    expect(script).not.toContain('mv -- "$seal_incoming" "$seal_path"');
    expect(script).toContain('mv -- "$seal_path" "$seal_rollback"');
    expect(script.indexOf('mv -- "$seal_path" "$seal_rollback"')).toBeLessThan(
      script.indexOf('mv -- "$data_dir" "$rollback_data"'),
    );
    expect(result.value.targetReadAttestation.stdin).toContain(
      'cat -- "$attestation_path"',
    );
    expect(result.value.targetCommit.stdin).toContain("source-env.original");
    expect(result.value.targetCommit.stdin).toContain("commit-authorized");
    expect(result.value.targetCommit.stdin).not.toContain('rm -rf -- "$rollback_data"');
    expect(result.value.targetFinalize.stdin).toContain("finalizing");
    expect(result.value.targetFinalize.stdin).toContain("finalized");
    expect(result.value.targetFinalize.stdin).toContain('chattr -i "$source_env_copy"');
    expect(result.value.targetFinalize.stdin).toContain('rm -rf -- "$rollback_data"');
    expect(result.value.targetFinalize.stdin).toContain('rm -f -- "$source_env_copy"');
    expect(result.value.targetFinalize.stdin).toContain('rm -f -- "$expected_manifest"');
    expect(result.value.targetFinalize.stdin).toContain('rm -f -- "$reattest_script"');
    expect(result.value.targetFinalize.stdin).toContain("commit-attestation.json");
    expect(result.value.targetFinalize.stdin).toContain(
      'mv -- "$seal_incoming" "$seal_path"',
    );
    expect(result.value.targetRollback.stdin).toContain('mv -- "$rollback_data" "$data_dir"');
    expect(result.value.targetRollback.stdin).toContain(
      'mv -- "$seal_rollback" "$seal_path"',
    );
    expect(result.value.targetRollback.stdin).toContain("finalizing");
    expect(result.value.targetRollback.stdin).toContain("finalized");
    expect(result.value.targetRollback.stdin).toContain("transaction_marker");
    expect(result.value.targetRollback.stdin.indexOf("transaction_marker")).toBeLessThan(
      result.value.targetRollback.stdin.indexOf('rm -rf -- "$incoming_data"'),
    );
  });

  it("journals promotion and rollback before every recoverable destructive phase", () => {
    const result = buildProductionRestorePlan(makeRequest());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const promote = result.value.targetVerifyAndPromote.stdin;
    const rollback = result.value.targetRollback.stdin;
    const status = result.value.targetStatus.stdin;
    expect(promote.indexOf("promoting.tmp")).toBeGreaterThan(0);
    expect(promote.indexOf("promoting.tmp")).toBeLessThan(
      promote.indexOf('mv -- "$seal_path" "$seal_rollback"'),
    );
    expect(promote.indexOf('rm -f -- "$promoting_marker"')).toBeGreaterThan(
      promote.indexOf('mv -- "$control_dir/installed.tmp" "$control_dir/installed"'),
    );
    expect(rollback.indexOf("rolling-back.tmp")).toBeGreaterThan(0);
    expect(rollback.indexOf("rolling-back.tmp")).toBeLessThan(
      rollback.indexOf('rm -rf -- "$data_dir"'),
    );
    expect(rollback).toContain('! -path "$rolling_back_marker"');
    expect(rollback.indexOf('mv -- "$control_dir/rolled-back.tmp" "$rolled_back_marker"')).toBeLessThan(
      rollback.lastIndexOf('rm -f -- "$active_restore" "$current_restore_incoming" "$owner_marker"'),
    );
    expect(
      rollback.lastIndexOf('rm -f -- "$active_restore" "$current_restore_incoming" "$owner_marker"'),
    ).toBeLessThan(
      rollback.lastIndexOf('rm -f -- "$rolling_back_marker"'),
    );
    expect(status.indexOf("if rolling_back:")).toBeLessThan(
      status.indexOf("if rolled_back:"),
    );
  });

  it("recovers every prepare identity publication prefix before active ownership", () => {
    const result = buildProductionRestorePlan(makeRequest());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const prepare = result.value.targetPrepare.stdin;
    const status = result.value.targetStatus.stdin;
    const rollback = result.value.targetRollback.stdin;
    const coordinationIdentitySync = prepare.indexOf('sync -f "$coordination_identity"');
    const transactionMarkerWrite = prepare.indexOf('> "$transaction_marker"');

    expect(coordinationIdentitySync).toBeGreaterThan(0);
    expect(coordinationIdentitySync).toBeLessThan(transactionMarkerWrite);
    for (const recoveryScript of [status, rollback]) {
      const preparePrefixBranch = recoveryScript.indexOf(
        'if { [ -e "$control_dir" ] && [ ! -L "$control_dir" ]; } && \\\n' +
          '   { [ ! -e "$active_restore" ] && [ ! -L "$active_restore" ]; }; then',
      );
      expect(preparePrefixBranch).toBeGreaterThan(0);
      expect(recoveryScript).toContain(
        '[ -e "$transaction_identity" ] || [ -L "$transaction_identity" ]',
      );
      expect(recoveryScript).toContain(
        '[ ! -e "$coordination_identity" ] && [ ! -L "$coordination_identity" ]',
      );
      expect(recoveryScript).toContain(
        '[ -e "$coordination_identity_candidate" ] || [ -L "$coordination_identity_candidate" ]',
      );
    }
  });

  it("binds terminal recovery to the requested data path and public seal", () => {
    const result = buildProductionRestorePlan(makeRequest());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const status = result.value.targetStatus.stdin;
    expect(status).toContain("comis-replay-data-dir-v1\\0");
    expect(status).toContain("seal_path");
    expect(status).toContain("seal_raw == attestation_raw");
    expect(status).toContain('attestation.get("dataDirSha256")');
    expect(status).toContain("transaction-identity");
    expect(result.value.targetRollback.stdin).toContain("transaction-identity");
    expect(result.value.targetPrepare.stdin.indexOf("transaction-identity")).toBeLessThan(
      result.value.targetPrepare.stdin.indexOf('ln -- "$owner_marker" "$active_restore"'),
    );
    expect(status).toContain('[ ! -e "$owner_marker" ]');
    expect(status).toContain('[ ! -e "$current_restore_incoming" ]');
    for (const artifact of [
      "runtime_dir",
      "incoming_data",
      "env_incoming",
      "env_rollback",
      "overlay_incoming",
      "overlay_rollback",
      "seal_incoming",
      "seal_rollback",
    ]) {
      expect(status).toContain(`[ ! -e "$${artifact}" ]`);
    }
    expect(status.indexOf("flock -n")).toBeLessThan(
      status.lastIndexOf('rm -f -- "$active_restore" "$current_restore_incoming" "$owner_marker"'),
    );
  });

  it("re-attests promoted data separately from transformed environment configuration", () => {
    const result = buildProductionRestorePlan(makeRequest());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.restoreAttestationExpectation).not.toHaveProperty(
      "restoredTreeDigestSha256",
    );
    expect(result.value.restoreAttestationExpectation).toMatchObject({
      restoredDataTreeDigestSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      sourceEnvironmentEvidenceIdentitySha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });

    const promoteScript = result.value.targetVerifyAndPromote.stdin;
    const promotionIndex = promoteScript.indexOf('mv -- "$incoming_data" "$data_dir"');
    const reattestationIndex = promoteScript.indexOf("PYTHON_REATTEST");
    expect(promotionIndex).toBeGreaterThan(0);
    expect(reattestationIndex).toBeGreaterThan(promotionIndex);
    expect(promoteScript).toContain("comis-snapshot-data-tree-v1\\0");
    expect(promoteScript).toContain("comis-snapshot-source-environment-v1\\0");
    expect(promoteScript).toContain("effectiveEnvironmentContentSha256");
    expect(promoteScript).toContain("source_env_copy");
    expect(result.value.targetCommit.stdin).toContain("commit-attestation.json");
    expect(result.value.targetCommit.stdin).toContain(
      'cmp -s -- "$commit_attestation" "$attestation_path"',
    );
  });

  it("computes post-promotion identity from the real nested target layout", () => {
    const temporary = mkdtempSync(join(tmpdir(), "comis-promoted-reattest-"));
    try {
      const capturedRoot = join(temporary, "captured");
      const sessionDir = join(
        capturedRoot,
        "data",
        "workspace",
        "sessions",
        "tenant_a",
        "telegram",
      );
      const systemDir = join(capturedRoot, "system", "etc", "comis");
      mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
      mkdirSync(systemDir, { recursive: true, mode: 0o755 });
      const sessionPath = join(sessionDir, "session.jsonl");
      writeFileSync(sessionPath, '{"role":"user"}\n', { mode: 0o600 });
      linkSync(sessionPath, join(sessionDir, "session.jsonl.copy"));
      symlinkSync("session.jsonl", join(sessionDir, "latest"));
      const nestedHardlinkDir = join(capturedRoot, "data", "a");
      mkdirSync(nestedHardlinkDir, { recursive: true, mode: 0o700 });
      const nestedHardlinkTarget = join(nestedHardlinkDir, "z");
      writeFileSync(nestedHardlinkTarget, "cross-directory hardlink\n", { mode: 0o600 });
      linkSync(nestedHardlinkTarget, join(capturedRoot, "data", "a-link"));
      const sourceEnvironment = join(systemDir, "env");
      writeFileSync(sourceEnvironment, "COMIS_DATA_DIR=/tmp/test\n", { mode: 0o640 });
      const effectiveEnvironment = join(temporary, "effective-env");
      const replayOverlay = join(temporary, "replay-quarantine.yaml");
      writeFileSync(replayOverlay, "channels:\n  telegram:\n    enabled: false\n", {
        mode: 0o640,
      });
      writeFileSync(
        effectiveEnvironment,
        `COMIS_DATA_DIR=/tmp/test\n\n\nCOMIS_CONFIG_PATHS=${join(capturedRoot, "data")}/config.yaml:/etc/comis/replay-quarantine.yaml\n`,
        { mode: 0o640 },
      );

      const manifest = manifestFromRealLayout(capturedRoot);
      const plan = buildProductionRestorePlan(makeRequest(manifest));
      expect(plan.ok).toBe(true);
      if (!plan.ok) return;
      const marker = "<<'PYTHON_REATTEST'\n";
      const start = plan.value.targetVerifyAndPromote.stdin.indexOf(marker);
      const end = plan.value.targetVerifyAndPromote.stdin.indexOf(
        "\nPYTHON_REATTEST",
        start,
      );
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      const verifier = plan.value.targetVerifyAndPromote.stdin.slice(
        start + marker.length,
        end,
      );
      const manifestPath = join(temporary, "manifest.json");
      const attestationPath = join(temporary, "attestation.json");
      const expectedOverlayShaPath = join(temporary, "replay-overlay.sha256");
      writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
      writeFileSync(
        expectedOverlayShaPath,
        `${createHash("sha256").update(readFileSync(replayOverlay)).digest("hex")}\n`,
        { mode: 0o400 },
      );

      const verified = spawnSync(
        "python3",
        [
          "-",
          join(capturedRoot, "data"),
          sourceEnvironment,
          effectiveEnvironment,
          replayOverlay,
          expectedOverlayShaPath,
          manifestPath,
          "restore-a1",
          "b".repeat(64),
          attestationPath,
        ],
        { input: verifier, encoding: "utf8" },
      );
      expect(verified.status, verified.stderr).toBe(0);
      const attestationRaw = readFileSync(attestationPath, "utf8");
      const parsedAttestation = parseProductionReplayRestoreAttestation(attestationRaw);
      expect(parsedAttestation.ok).toBe(true);
      if (!parsedAttestation.ok) return;
      expect(parsedAttestation.value).toMatchObject({
        restoredDataTreeDigestSha256: manifest.dataTreeIdentitySha256,
        sourceEnvironmentEvidenceIdentitySha256:
          manifest.sourceEnvironmentEvidenceIdentitySha256,
        effectiveEnvironmentContentSha256: createHash("sha256")
          .update(readFileSync(effectiveEnvironment))
          .digest("hex"),
        replayOverlayContentSha256: createHash("sha256")
          .update(readFileSync(replayOverlay))
          .digest("hex"),
      });
      const extended = {
        ...parsedAttestation.value,
        sourceEnvironmentBody: "must never enter the content-free seal",
      };
      expect(parseProductionReplayRestoreAttestation(JSON.stringify(extended)).ok).toBe(
        false,
      );

      writeFileSync(replayOverlay, "channels:\n  telegram:\n    enabled: true\n", {
        mode: 0o640,
      });
      const divergentOverlay = spawnSync(
        "python3",
        [
          "-",
          join(capturedRoot, "data"),
          sourceEnvironment,
          effectiveEnvironment,
          replayOverlay,
          expectedOverlayShaPath,
          manifestPath,
          "restore-a1",
          "b".repeat(64),
          join(temporary, "divergent-overlay-attestation.json"),
        ],
        { input: verifier, encoding: "utf8" },
      );
      expect(divergentOverlay.status).not.toBe(0);
      writeFileSync(replayOverlay, "channels:\n  telegram:\n    enabled: false\n", {
        mode: 0o640,
      });

      writeFileSync(sessionPath, '{"role":"assistant"}\n', { mode: 0o600 });
      const divergent = spawnSync(
        "python3",
        [
          "-",
          join(capturedRoot, "data"),
          sourceEnvironment,
          effectiveEnvironment,
          replayOverlay,
          expectedOverlayShaPath,
          manifestPath,
          "restore-a1",
          "b".repeat(64),
          join(temporary, "divergent-attestation.json"),
        ],
        { input: verifier, encoding: "utf8" },
      );
      expect(divergent.status).not.toBe(0);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("requires the target service numeric identity to match the captured data owner", () => {
    const result = buildProductionRestorePlan(makeRequest());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const command of [
      result.value.targetVerifyAndPromote,
      result.value.targetCommit,
    ]) {
      expect(command.stdin).toContain("expected_service_identity");
      expect(command.stdin).toContain('entry["path"] == "data"');
      expect(command.stdin).toContain('id -u "$service_user"');
      expect(command.stdin).toContain('id -g "$service_user"');
    }
  });

  it("requires the canonical quarantine file and effective systemd confinement", () => {
    const result = buildProductionRestorePlan(makeRequest());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const command of [
      result.value.targetPrepare,
      result.value.targetVerifyAndPromote,
      result.value.targetCommit,
    ]) {
      expect(command.stdin).toContain(TARGET_REPLAY_QUARANTINE_SHA256);
      expect(command.stdin).toContain("DropInPaths");
      expect(command.stdin).toContain('[ "$last_drop_in" != "$quarantine" ]');
      expect(command.stdin).toContain("require_effective_property PrivateNetwork yes");
      expect(command.stdin).toContain(
        "require_effective_property RestrictAddressFamilies AF_UNIX",
      );
      expect(command.stdin).toContain("require_effective_property ProtectSystem strict");
      expect(command.stdin).toContain("require_effective_property CapabilityBoundingSet ''");
      expect(command.stdin).toContain("require_effective_property AmbientCapabilities ''");
      expect(command.stdin).toContain("require_effective_property SocketBindDeny any");
      expect(command.stdin).toContain("require_effective_property RestrictNamespaces yes");
      expect(command.stdin).toContain(
        "require_effective_property ReadWritePaths /run/comis-replay",
      );
    }
  });

  it("rejects writable control directories and every reserved path alias", () => {
    const result = buildProductionRestorePlan(makeRequest());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const prepare = result.value.targetPrepare.stdin;
    const rollback = result.value.targetRollback.stdin;
    for (const guardedScript of [prepare, rollback]) {
      expect(guardedScript).toContain("[ ! -d /etc/comis ]");
      expect(guardedScript).toContain("etc_comis_mode=\"$(stat -c '%a' /etc/comis");
      expect(guardedScript).toContain("$(( 0$etc_comis_mode & 0022 ))");
      expect(guardedScript).not.toContain("find /etc/comis -maxdepth 0 -perm /022");
    }
    for (const artifact of [
      "env_incoming",
      "env_rollback",
      "overlay_incoming",
      "overlay_rollback",
      "seal_incoming",
      "seal_rollback",
    ]) {
      expect(prepare).toContain(
        `[ -e "$${artifact}" ] || [ -L "$${artifact}" ]`,
      );
    }
    for (const artifact of ["env_rollback", "overlay_rollback", "seal_rollback"]) {
      expect(rollback).toContain(
        `[ -f "$${artifact}" ] && [ ! -L "$${artifact}" ]`,
      );
      expect(rollback).toContain(`stat -c '%h' "$${artifact}"`);
    }
  });

  it("serializes every target mutation under one durable restore owner", () => {
    const result = buildProductionRestorePlan(makeRequest());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.targetPrepare.stdin).toContain(
      "coordination_root=/var/lib/comis-self-driving",
    );
    expect(result.value.targetPrepare.stdin).toContain(
      'active_restore="$coordination_root/active-restore"',
    );
    expect(result.value.targetPrepare.stdin).toContain(
      'ln -- "$owner_marker" "$active_restore"',
    );
    for (const command of [
      result.value.targetVerifyAndPromote,
      result.value.targetReadAttestation,
      result.value.targetRollback,
      result.value.targetCommit,
      result.value.targetFinalize,
    ]) {
      expect(command.stdin).toContain('flock -n 9');
      expect(command.stdin).toContain(
        'active_restore="$coordination_root/active-restore"',
      );
      expect(command.stdin).toContain(
        'stat -c \'%d:%i\' "$active_restore"',
      );
    }
    expect(result.value.targetRollback.stdin).toContain('rm -f -- "$active_restore"');
    expect(result.value.targetFinalize.stdin).toContain('rm -f -- "$active_restore"');
    expect(result.value.targetFinalize.stdin).toContain(
      'mv -- "$current_restore_incoming" "$current_restore"',
    );
  });

  it("takes exclusive ownership before checking or creating a restore directory", () => {
    const result = buildProductionRestorePlan(makeRequest());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const prepare = result.value.targetPrepare.stdin;
    const lockIndex = prepare.indexOf("if ! flock -n 9");
    const preflightIndex = prepare.indexOf(
      'if [ -e "$control_dir" ] || [ -L "$control_dir" ]',
    );
    const controlCreationIndex = prepare.indexOf('mkdir -m 0700 -- "$control_dir"');

    expect(lockIndex).toBeGreaterThan(0);
    expect(lockIndex).toBeLessThan(preflightIndex);
    expect(controlCreationIndex).toBeGreaterThan(preflightIndex);
    expect(prepare).not.toContain(
      '"$state_root" "$control_dir" "$extract_dir" "$coordination_root"',
    );
  });

  it("uses one run scoped global claim across every target data path", () => {
    const first = buildProductionRestorePlan(makeRequest());
    const secondRequest = makeRequest();
    const second = buildProductionRestorePlan({
      ...secondRequest,
      profile: {
        ...secondRequest.profile,
        target: {
          ...secondRequest.profile.target,
          dataDir: "/srv/comis-other",
        },
      },
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    const claimAssignment = 'coordination_identity="$coordination_root/restore-$run_id.identity"';
    expect(first.value.targetPrepare.stdin).toContain(claimAssignment);
    expect(second.value.targetPrepare.stdin).toContain(claimAssignment);
    expect(first.value.targetPrepare.stdin).not.toContain(
      'coordination_identity="$coordination_root/restore-$run_id-$expected_data_dir_sha256.identity"',
    );
    const candidateAssignment =
      'coordination_identity_candidate="$coordination_root/.restore-$run_id.identity.incoming"';
    expect(first.value.targetPrepare.stdin).toContain(candidateAssignment);
    expect(second.value.targetPrepare.stdin).toContain(candidateAssignment);
    expect(second.value.targetPrepare.stdin).toContain(
      'printf \'%s\\n\' "$expected_transaction_identity" > "$coordination_identity_scratch"',
    );
    expect(second.value.targetPrepare.stdin).toContain(
      'mv --no-clobber -- "$coordination_identity_candidate" "$coordination_identity"',
    );
  });

  it("publishes only a complete global claim and preserves foreign claims", () => {
    const result = buildProductionRestorePlan(makeRequest());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const prepare = result.value.targetPrepare.stdin;
    const scratch =
      'coordination_identity_scratch="$coordination_root/.restore-$run_id-$expected_data_dir_sha256.identity.scratch"';
    const candidate =
      'coordination_identity_candidate="$coordination_root/.restore-$run_id.identity.incoming"';
    const scratchSync = prepare.indexOf('sync -f "$coordination_identity_scratch"');
    const scratchDirectorySync = prepare.indexOf(
      'sync -f "$coordination_root"',
      scratchSync,
    );
    const candidateMove = prepare.indexOf(
      'mv --no-clobber -- "$coordination_identity_scratch" "$coordination_identity_candidate"',
    );
    const candidateSync = prepare.indexOf('sync -f "$coordination_identity_candidate"');
    const candidateDirectorySync = prepare.indexOf(
      'sync -f "$coordination_root"',
      candidateSync,
    );
    const claimMove = prepare.indexOf(
      'mv --no-clobber -- "$coordination_identity_candidate" "$coordination_identity"',
    );
    const claimDirectorySync = prepare.indexOf('sync -f "$coordination_root"', claimMove);

    expect(prepare).toContain(scratch);
    expect(prepare).toContain(candidate);
    expect(scratchSync).toBeGreaterThan(0);
    expect(scratchSync).toBeLessThan(scratchDirectorySync);
    expect(scratchDirectorySync).toBeLessThan(candidateMove);
    expect(candidateMove).toBeLessThan(candidateSync);
    expect(candidateSync).toBeGreaterThan(0);
    expect(candidateSync).toBeLessThan(candidateDirectorySync);
    expect(candidateDirectorySync).toBeLessThan(claimMove);
    expect(claimMove).toBeLessThan(claimDirectorySync);
    for (const recoveryScript of [
      result.value.targetStatus.stdin,
      result.value.targetRollback.stdin,
    ]) {
      expect(recoveryScript).toContain(candidate);
      expect(recoveryScript).toContain(
        '$(cat "$coordination_identity_candidate" 2>/dev/null || true)',
      );
      expect(recoveryScript).toContain('"$expected_transaction_identity" ]; then exit 79; fi');
      const mismatchStart = recoveryScript.indexOf(
        '[ "$(cat "$coordination_identity" 2>/dev/null || true)" != "$expected_transaction_identity" ]; then',
      );
      const mismatchEnd = recoveryScript.indexOf("\n  fi", mismatchStart);
      const mismatchBranch = recoveryScript.slice(mismatchStart, mismatchEnd);
      expect(mismatchStart).toBeGreaterThan(0);
      expect(mismatchBranch).toContain("exit 79");
      expect(mismatchBranch).not.toContain('rm -f -- "$coordination_identity"');
    }
  });

  it("makes the restore lock durable before publishing a claim candidate", () => {
    const result = buildProductionRestorePlan(makeRequest());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const prepare = result.value.targetPrepare.stdin;
    const lockAcquisition = prepare.indexOf("if ! flock -n 9");
    const lockSync = prepare.indexOf('sync -f "$operation_lock"', lockAcquisition);
    const lockDirectorySync = prepare.indexOf('sync -f "$coordination_root"', lockSync);
    const candidateWrite = prepare.indexOf('> "$coordination_identity_scratch"');

    expect(lockAcquisition).toBeGreaterThan(0);
    expect(lockAcquisition).toBeLessThan(lockSync);
    expect(lockSync).toBeLessThan(lockDirectorySync);
    expect(lockDirectorySync).toBeLessThan(candidateWrite);
  });

  it("returns a nonzero status for every prepare termination signal", () => {
    const result = buildProductionRestorePlan(makeRequest());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const prepare = result.value.targetPrepare.stdin;
    expect(prepare).toContain('cleanup_prepare() {\n  rc="$1"');
    expect(prepare).toContain("trap cleanup_prepare_on_exit EXIT");
    expect(prepare).toContain("trap 'cleanup_prepare 129' HUP");
    expect(prepare).toContain("trap 'cleanup_prepare 130' INT");
    expect(prepare).toContain("trap 'cleanup_prepare 143' TERM");
    expect(prepare).not.toContain("trap cleanup_prepare EXIT HUP INT TERM");
  });

  it("flushes every cleaned filesystem before removing the global claim", () => {
    const result = buildProductionRestorePlan(makeRequest());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const prepare = result.value.targetPrepare.stdin;
    const cleanupStart = prepare.indexOf("cleanup_prepare() {");
    const cleanupEnd = prepare.indexOf("cleanup_prepare_on_exit() {", cleanupStart);
    const cleanup = prepare.slice(cleanupStart, cleanupEnd);
    const claimRemoval = cleanup.indexOf('rm -f -- "$coordination_identity"');

    expect(cleanupStart).toBeGreaterThan(0);
    expect(cleanupEnd).toBeGreaterThan(cleanupStart);
    expect(claimRemoval).toBeGreaterThan(0);
    for (const [removal, filesystemSync] of [
      ['rm -rf -- "$incoming_data" "$control_dir"', 'sync -f "$state_root"'],
      ['rm -rf -- "$incoming_data" "$control_dir"', 'sync -f "$data_mount"'],
      ['rm -rf -- "$runtime_dir"', 'sync -f "$runtime_root"'],
      [
        '"$seal_incoming" "$seal_rollback"',
        "sync -f /etc/comis",
      ],
    ] as const) {
      const removalIndex = cleanup.indexOf(removal);
      const syncIndex = cleanup.indexOf(filesystemSync, removalIndex);
      expect(removalIndex).toBeGreaterThan(0);
      expect(removalIndex).toBeLessThan(syncIndex);
      expect(syncIndex).toBeLessThan(claimRemoval);
    }
  });

  it("arms cleanup ownership before each prepare namespace mutation", () => {
    const result = buildProductionRestorePlan(makeRequest());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const prepare = result.value.targetPrepare.stdin;
    for (const [ownershipFlag, mutation] of [
      [
        "coordination_identity_scratch_created=1",
        '> "$coordination_identity_scratch"',
      ],
      [
        "coordination_identity_candidate_created=1",
        'mv --no-clobber -- "$coordination_identity_scratch" "$coordination_identity_candidate"',
      ],
      [
        "coordination_identity_created=1",
        'mv --no-clobber -- "$coordination_identity_candidate" "$coordination_identity"',
      ],
      ["control_created=1", 'mkdir -m 0700 -- "$control_dir"'],
      ["runtime_created=1", 'mkdir -m 0700 -- "$runtime_dir"'],
      ["owner_created=1", '> "$owner_marker"'],
      ["active_created=1", 'ln -- "$owner_marker" "$active_restore"'],
    ] as const) {
      expect(prepare.indexOf(ownershipFlag)).toBeGreaterThan(0);
      expect(prepare.indexOf(ownershipFlag)).toBeLessThan(prepare.indexOf(mutation));
    }
  });

  it("publishes durable generation phases before destructive restore transitions", () => {
    const result = buildProductionRestorePlan(makeRequest());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const prepare = result.value.targetPrepare.stdin;
    const activePublicationIndex = prepare.indexOf(
      'ln -- "$owner_marker" "$active_restore"',
    );
    const stateRootSync = prepare.indexOf('sync -f "$state_root"');
    expect(stateRootSync).toBeGreaterThan(0);
    expect(stateRootSync).toBeLessThan(activePublicationIndex);
    expect(activePublicationIndex).toBeLessThan(
      prepare.indexOf('sync -f "$coordination_root"', activePublicationIndex),
    );

    const promote = result.value.targetVerifyAndPromote.stdin;
    expect(promote.indexOf('mv -- "$old_data_unlocked.tmp" "$old_data_unlocked"')).toBeLessThan(
      promote.indexOf('chattr -i "$data_dir"'),
    );
    expect(promote.indexOf('chattr -i "$data_dir"')).toBeLessThan(
      promote.indexOf('mv -- "$data_dir" "$rollback_data"'),
    );
    expect(promote).toContain(
      '[ -f "$old_data_unlocked" ] && [ ! -L "$old_data_unlocked" ]',
    );
    expect(promote.indexOf("chmod 0400 \"$control_dir/installed\"")).toBeLessThan(
      promote.lastIndexOf('sync -f "$control_dir"'),
    );

    const finalize = result.value.targetFinalize.stdin;
    expect(finalize.indexOf('mv -- "$current_restore_incoming" "$current_restore"')).toBeLessThan(
      finalize.indexOf('rm -f -- "$active_restore"'),
    );
    expect(finalize).toContain(
      'stat -c \'%d:%i\' "$current_restore"',
    );
    expect(finalize).toContain("targetMachineIdSha256");
    expect(finalize).toContain("restoreAttestationSha256");
  });

  it("makes every restore namespace durable before active publication", () => {
    const result = buildProductionRestorePlan(makeRequest());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const prepare = result.value.targetPrepare.stdin;
    const activePublication = prepare.indexOf('ln -- "$owner_marker" "$active_restore"');
    for (const [creation, parentSync] of [
      ['install -d -m 0700 -o root -g root "$coordination_root"', 'sync -f /var/lib'],
      ['install -d -m 0700 -o root -g root "$state_root" "$runtime_root"', 'sync -f "$data_mount"'],
      ['install -d -m 0700 -o root -g root "$state_root" "$runtime_root"', 'sync -f /run'],
      ['mkdir -m 0700 -- "$control_dir"', 'sync -f "$state_root"'],
      ['mkdir -m 0700 -- "$runtime_dir"', 'sync -f "$runtime_root"'],
    ] as const) {
      const creationIndex = prepare.indexOf(creation);
      const syncIndex = prepare.indexOf(parentSync, creationIndex);
      expect(creationIndex).toBeGreaterThan(0);
      expect(creationIndex).toBeLessThan(syncIndex);
      expect(syncIndex).toBeLessThan(activePublication);
    }
  });

  it("makes ownership marker contents durable before active publication", () => {
    const result = buildProductionRestorePlan(makeRequest());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const prepare = result.value.targetPrepare.stdin;
    const activePublication = prepare.indexOf('ln -- "$owner_marker" "$active_restore"');
    for (const [markerWrite, markerSync] of [
      ['> "$transaction_marker"', 'sync -f "$transaction_marker"'],
      ['> "$owner_marker"', 'sync -f "$owner_marker"'],
    ] as const) {
      const writeIndex = prepare.indexOf(markerWrite);
      const syncIndex = prepare.indexOf(markerSync, writeIndex);
      expect(writeIndex).toBeGreaterThan(0);
      expect(writeIndex).toBeLessThan(syncIndex);
      expect(syncIndex).toBeLessThan(activePublication);
    }
  });

  it("makes each finalized marker transition directory durable", () => {
    const result = buildProductionRestorePlan(makeRequest());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const finalize = result.value.targetFinalize.stdin;
    const finalizedPublication = finalize.indexOf(
      'mv -- "$control_dir/finalized.tmp" "$finalized_marker"',
    );
    const finalizedDirectorySync = finalize.indexOf(
      'sync -f "$control_dir"',
      finalizedPublication,
    );
    const finalizingRemoval = finalize.indexOf(
      'rm -f -- "$finalizing_marker"',
      finalizedPublication,
    );
    const removalDirectorySync = finalize.indexOf(
      'sync -f "$control_dir"',
      finalizingRemoval,
    );

    expect(finalizedPublication).toBeGreaterThan(0);
    expect(finalizedPublication).toBeLessThan(finalizedDirectorySync);
    expect(finalizedDirectorySync).toBeLessThan(finalizingRemoval);
    expect(finalizingRemoval).toBeLessThan(removalDirectorySync);
  });

  it("contains a drifted target before rollback without depending on activation confinement", () => {
    const result = buildProductionRestorePlan(makeRequest());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rollback = result.value.targetRollback.stdin;
    const lockAcquisition = rollback.indexOf("if ! flock -n 9");
    const claimAuthentication = rollback.indexOf(
      '[ "$(cat "$coordination_identity" 2>/dev/null || true)" != \\',
      lockAcquisition,
    );
    const serviceStop = rollback.indexOf('systemctl stop "$unit"');
    expect(lockAcquisition).toBeGreaterThan(0);
    expect(lockAcquisition).toBeLessThan(claimAuthentication);
    expect(claimAuthentication).toBeLessThan(serviceStop);
    expect(rollback).toContain('systemctl stop "$unit"');
    expect(rollback).toContain('systemctl kill --kill-who=all "$unit"');
    expect(rollback).toContain('systemctl disable "$unit"');
    expect(rollback).not.toContain("environment-role");
    expect(rollback).not.toContain(TARGET_REPLAY_QUARANTINE_SHA256);
    expect(rollback).toContain(
      'rm -f -- "$active_restore" "$current_restore_incoming" "$owner_marker"',
    );
    expect(rollback).toContain('sync -f "$coordination_root"');
  });

  it("observes and binds the promoted target seal before authorizing commit", async () => {
    const deps = makeDeps();
    const result = await prepareProductionRestore(makeRequest(), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.restoreAttestation).toMatchObject({
      restoredDataTreeDigestSha256: result.value.restoredDataTreeIdentitySha256,
      sourceEnvironmentEvidenceIdentitySha256:
        result.value.sourceEnvironmentEvidenceIdentitySha256,
    });
    expect(result.value.restoreAttestationSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(deps.run.mock.calls.map(([invocation]) => invocation.label)).toContain(
      "read-promoted-snapshot-attestation",
    );

    const malformedDeps = makeDeps({ restoreAttestationStdout: "{malformed" });
    const malformed = await prepareProductionRestore(makeRequest(), malformedDeps);
    expect(malformed.ok).toBe(false);
    expect(malformedDeps.run.mock.calls.map(([invocation]) => invocation.label)).toContain(
      "rollback-snapshot-target",
    );

    const mismatchPlan = buildProductionRestorePlan(makeRequest());
    expect(mismatchPlan.ok).toBe(true);
    if (!mismatchPlan.ok) return;
    const mismatchDeps = makeDeps({
      restoreAttestationStdout: `${JSON.stringify({
        ...mismatchPlan.value.restoreAttestationExpectation,
        restoredDataTreeDigestSha256: "f".repeat(64),
        effectiveEnvironmentContentSha256: "e".repeat(64),
      })}\n`,
    });
    const mismatch = await prepareProductionRestore(makeRequest(), mismatchDeps);
    expect(mismatch.ok).toBe(false);
    expect(mismatchDeps.run.mock.calls.map(([invocation]) => invocation.label)).toContain(
      "rollback-snapshot-target",
    );
  });

  it("parses only authenticated durable restore status with matching generation identity", () => {
    const plan = buildProductionRestorePlan(makeRequest());
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const attestationRaw = `${JSON.stringify({
      ...plan.value.restoreAttestationExpectation,
      effectiveEnvironmentContentSha256: "e".repeat(64),
    })}\n`;
    const status = {
      schemaVersion: 1,
      runId: "restore-a1",
      targetMachineIdSha256: TARGET_MACHINE,
      state: "finalized",
      bytesTransferred: 8192,
      restoreAttestationBase64: Buffer.from(attestationRaw).toString("base64"),
      restoreAttestationSha256: createHash("sha256").update(attestationRaw).digest("hex"),
    };

    const parsed = parseProductionRestoreStatus(`${JSON.stringify(status)}\n`);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toMatchObject({
        state: "finalized",
        bytesTransferred: 8192,
        restoreAttestation: { runId: "restore-a1", baselineImmutable: true },
      });
    }
    expect(
      parseProductionRestoreStatus(
        JSON.stringify({ ...status, restoreAttestationSha256: "f".repeat(64) }),
      ).ok,
    ).toBe(false);
    expect(
      parseProductionRestoreStatus(
        JSON.stringify({ ...status, targetMachineIdSha256: "c".repeat(64) }),
      ).ok,
    ).toBe(false);
    expect(parseProductionRestoreStatus(JSON.stringify({ ...status, secret: "no" })).ok).toBe(
      false,
    );
    expect(plan.value.targetStatus).toMatchObject({
      label: "inspect-snapshot-target",
      stdoutLimitBytes: 8192,
    });
    expect(parseProductionRestoreStatus(restorePhaseStatusFixture("promoting"))).toMatchObject({
      ok: true,
      value: { state: "promoting", bytesTransferred: 8192 },
    });
    expect(parseProductionRestoreStatus(restorePhaseStatusFixture("rolling_back"))).toMatchObject({
      ok: true,
      value: { state: "rolling_back", bytesTransferred: 8192 },
    });
    expect(
      parseProductionRestoreStatus(
        `${JSON.stringify({
          ...status,
          state: "rolling_back",
          bytesTransferred: null,
        })}\n`,
      ),
    ).toMatchObject({
      ok: true,
      value: {
        state: "rolling_back",
        bytesTransferred: null,
        restoreAttestation: { runId: "restore-a1" },
      },
    });
  });

  it("resumes a durably authorized restore after controller state is discarded", async () => {
    const labels: string[] = [];
    let statusReads = 0;
    const executor: ProductionRemoteExecutor = {
      run: async (invocation) => {
        labels.push(invocation.label);
        if (invocation.label === "inspect-snapshot-target") {
          statusReads += 1;
          return ok({
            stdout: restoreStatusFixture(statusReads === 1 ? "authorized" : "finalized"),
            exitCode: 0,
          });
        }
        return ok({ stdout: "", exitCode: 0 });
      },
    };

    const result = await resumeProductionRestore(
      { runId: "restore-a1", profile },
      executor,
    );

    expect(result).toMatchObject({ ok: true, value: { state: "committed", runId: "restore-a1" } });
    expect(labels).toEqual([
      "inspect-snapshot-target",
      "finalize-snapshot-target",
      "inspect-snapshot-target",
    ]);
    const inspected = await inspectProductionRestore(
      { runId: "restore-a1", profile },
      {
        run: async () => ok({ stdout: restoreStatusFixture("finalized"), exitCode: 0 }),
      },
    );
    expect(inspected).toMatchObject({ ok: true, value: { state: "finalized" } });
  });

  it("recovers an interrupted promotion by rolling it back from durable identity alone", async () => {
    const labels: string[] = [];
    let statusReads = 0;
    const result = await rollbackProductionRestoreRecovery(
      { runId: "restore-a1", profile },
      {
        run: async (invocation) => {
          labels.push(invocation.label);
          if (invocation.label === "inspect-snapshot-target") {
            statusReads += 1;
            return ok({
              stdout: restorePhaseStatusFixture(
                statusReads === 1 ? "promoting" : "rolled_back",
              ),
              exitCode: 0,
            });
          }
          return ok({ stdout: "", exitCode: 0 });
        },
      },
    );

    expect(result).toMatchObject({ ok: true, value: { state: "rolled_back" } });
    expect(labels).toEqual([
      "inspect-snapshot-target",
      "rollback-snapshot-target",
      "inspect-snapshot-target",
    ]);
  });

  it("streams without controller plaintext and waits for explicit commit attestation", async () => {
    const deps = makeDeps();
    const result = await prepareProductionRestore(makeRequest(), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state).toBe("awaiting-attestation");
    expect(result.value.bytesTransferred).toBe(8192);
    expect(result.value.targetCommit.args.at(-1)).toBe(
      result.value.restoreAttestationSha256,
    );
    expect(result.value.targetCommit.stdin).toContain(
      'approved_attestation_sha256="$6"',
    );
    expect(deps.transfer).toHaveBeenCalledWith(
      expect.objectContaining({ label: "snapshot-archive", maximumBytes: expect.any(Number) }),
    );
    expect(deps.run.mock.calls.map(([invocation]) => invocation.label)).toEqual([
      "prepare-snapshot-restore-target",
      "prepare-snapshot-stream-source",
      "verify-and-promote-snapshot-target",
      "read-promoted-snapshot-attestation",
      "cleanup-snapshot-source",
    ]);
    for (const [invocation] of deps.run.mock.calls) {
      expect(invocation).not.toHaveProperty("stdout");
    }
    expect(deps.run.mock.calls.some(([invocation]) => invocation.label.includes("commit"))).toBe(
      false,
    );

    deps.run.mockClear();
    const rejected = await commitProductionRestore(
      result.value,
      {
        decision: "commit",
        runId: result.value.runId,
        targetMachineIdSha256: result.value.targetMachineIdSha256,
        manifestSha256: "f".repeat(64),
        bytesTransferred: result.value.bytesTransferred,
        restoreAttestationSha256: result.value.restoreAttestationSha256,
      },
      deps.executor,
    );
    expect(rejected.ok).toBe(false);
    expect(deps.run).not.toHaveBeenCalled();

    const committed = await commitProductionRestore(
      result.value,
      {
        decision: "commit",
        runId: result.value.runId,
        targetMachineIdSha256: result.value.targetMachineIdSha256,
        manifestSha256: result.value.manifestSha256,
        bytesTransferred: result.value.bytesTransferred,
        restoreAttestationSha256: result.value.restoreAttestationSha256,
      },
      deps.executor,
    );
    expect(committed).toEqual({
      ok: true,
      value: {
        runId: "restore-a1",
        state: "committed",
        restoredDataTreeIdentitySha256:
          result.value.restoredDataTreeIdentitySha256,
        sourceEnvironmentEvidenceIdentitySha256:
          result.value.sourceEnvironmentEvidenceIdentitySha256,
      },
    });
    expect(deps.run.mock.calls.map(([invocation]) => invocation.label)).toEqual([
      "commit-snapshot-target",
      "finalize-snapshot-target",
    ]);
  });

  it.each([
    "prepare-snapshot-restore-target",
    "prepare-snapshot-stream-source",
    "verify-and-promote-snapshot-target",
  ])("rolls back and cleans source staging when %s faults", async (failLabel) => {
    const deps = makeDeps({ failLabel });
    const result = await prepareProductionRestore(makeRequest(), deps);

    expect(result.ok).toBe(false);
    expect(deps.run.mock.calls.map(([invocation]) => invocation.label)).toContain(
      "rollback-snapshot-target",
    );
    expect(deps.run.mock.calls.map(([invocation]) => invocation.label)).toContain(
      "cleanup-snapshot-source",
    );
  });

  it("rolls back and cleans source staging when the encrypted stream faults", async () => {
    const deps = makeDeps({ failTransfer: true });
    const result = await prepareProductionRestore(makeRequest(), deps);

    expect(result.ok).toBe(false);
    expect(deps.run.mock.calls.map(([invocation]) => invocation.label)).toContain(
      "rollback-snapshot-target",
    );
    expect(deps.run.mock.calls.map(([invocation]) => invocation.label)).toContain(
      "cleanup-snapshot-source",
    );
  });

  it("rolls back and cleans source staging when an injected bridge rejects", async () => {
    const deps = makeDeps();
    deps.transfer.mockImplementationOnce(async () => {
      throw new Error("bridge rejected");
    });
    const result = await prepareProductionRestore(makeRequest(), deps);

    expect(result.ok).toBe(false);
    expect(deps.run.mock.calls.map(([invocation]) => invocation.label)).toContain(
      "rollback-snapshot-target",
    );
    expect(deps.run.mock.calls.map(([invocation]) => invocation.label)).toContain(
      "cleanup-snapshot-source",
    );
  });

  it("treats remote stdout and source cleanup faults as protocol failures with rollback", async () => {
    for (const failure of [
      { stdoutLabel: "verify-and-promote-snapshot-target" },
      { failLabel: "cleanup-snapshot-source" },
    ]) {
      const deps = makeDeps(failure);
      const result = await prepareProductionRestore(makeRequest(), deps);

      expect(result.ok).toBe(false);
      expect(deps.run.mock.calls.map(([invocation]) => invocation.label)).toContain(
        "rollback-snapshot-target",
      );
    }
  });

  it("never rolls back after an ambiguous attested commit command outcome", async () => {
    const prepareDeps = makeDeps();
    const prepared = await prepareProductionRestore(makeRequest(), prepareDeps);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const commitDeps = makeDeps({
      failLabel: "commit-snapshot-target",
      restoreStatusState: "promoted",
    });

    const result = await commitProductionRestore(
      prepared.value,
      {
        decision: "commit",
        runId: prepared.value.runId,
        targetMachineIdSha256: prepared.value.targetMachineIdSha256,
        manifestSha256: prepared.value.manifestSha256,
        bytesTransferred: prepared.value.bytesTransferred,
        restoreAttestationSha256: prepared.value.restoreAttestationSha256,
      },
      commitDeps.executor,
    );

    expect(result.ok).toBe(false);
    expect(commitDeps.run.mock.calls.map(([invocation]) => invocation.label)).toEqual([
      "commit-snapshot-target",
      "inspect-snapshot-target",
      "commit-snapshot-target",
    ]);
    if (!result.ok) expect(result.error.kind).toBe("commit_state_unknown");
  });

  it("finalizes a durable authorization after the commit response is lost", async () => {
    const prepared = await prepareProductionRestore(makeRequest(), makeDeps());
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const deps = makeDeps({
      failLabel: "commit-snapshot-target",
      restoreStatusState: "authorized",
    });

    const result = await commitProductionRestore(
      prepared.value,
      {
        decision: "commit",
        runId: prepared.value.runId,
        targetMachineIdSha256: prepared.value.targetMachineIdSha256,
        manifestSha256: prepared.value.manifestSha256,
        bytesTransferred: prepared.value.bytesTransferred,
        restoreAttestationSha256: prepared.value.restoreAttestationSha256,
      },
      deps.executor,
    );

    expect(result.ok).toBe(true);
    expect(deps.run.mock.calls.map(([invocation]) => invocation.label)).toEqual([
      "commit-snapshot-target",
      "inspect-snapshot-target",
      "finalize-snapshot-target",
    ]);
  });

  it.each([
    ["authorized", "run", { runId: "restore-other" }],
    ["finalized", "run", { runId: "restore-other" }],
    ["authorized", "target machine", { targetMachineIdSha256: "9".repeat(64) }],
    ["finalized", "target machine", { targetMachineIdSha256: "9".repeat(64) }],
    ["authorized", "transferred bytes", { bytesTransferred: 8193 }],
    ["finalized", "transferred bytes", { bytesTransferred: 8193 }],
    [
      "authorized",
      "snapshot manifest",
      { attestationOverrides: { snapshotManifestSha256: "8".repeat(64) } },
    ],
    [
      "finalized",
      "snapshot manifest",
      { attestationOverrides: { snapshotManifestSha256: "8".repeat(64) } },
    ],
    [
      "authorized",
      "full restore attestation",
      { attestationOverrides: { restoredDataTreeDigestSha256: "7".repeat(64) } },
    ],
    [
      "finalized",
      "full restore attestation",
      { attestationOverrides: { restoredDataTreeDigestSha256: "7".repeat(64) } },
    ],
    ["authorized", "restore attestation digest", { reencodeAttestation: true }],
    ["finalized", "restore attestation digest", { reencodeAttestation: true }],
  ] satisfies ReadonlyArray<
    readonly [
      "authorized" | "finalized",
      string,
      RestoreStatusFixtureOptions,
    ]
  >)(
    "refuses an ambiguous %s status bound to a different %s",
    async (state, _difference, statusOptions) => {
      const prepared = await prepareProductionRestore(makeRequest(), makeDeps());
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;
      const deps = makeDeps({
        failLabel: "commit-snapshot-target",
        restoreStatusStdout: restoreStatusFixture(state, statusOptions),
      });

      const result = await commitProductionRestore(
        prepared.value,
        {
          decision: "commit",
          runId: prepared.value.runId,
          targetMachineIdSha256: prepared.value.targetMachineIdSha256,
          manifestSha256: prepared.value.manifestSha256,
          bytesTransferred: prepared.value.bytesTransferred,
          restoreAttestationSha256: prepared.value.restoreAttestationSha256,
        },
        deps.executor,
      );

      expect(result).toMatchObject({
        ok: false,
        error: { kind: "commit_state_unknown" },
      });
      expect(deps.run.mock.calls.map(([invocation]) => invocation.label)).toEqual([
        "commit-snapshot-target",
        "inspect-snapshot-target",
      ]);
    },
  );

  it("leaves a finalization failure retryable without attempting an unsafe rollback", async () => {
    const prepareDeps = makeDeps();
    const prepared = await prepareProductionRestore(makeRequest(), prepareDeps);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const commitDeps = makeDeps({ failLabel: "finalize-snapshot-target" });

    const result = await commitProductionRestore(
      prepared.value,
      {
        decision: "commit",
        runId: prepared.value.runId,
        targetMachineIdSha256: prepared.value.targetMachineIdSha256,
        manifestSha256: prepared.value.manifestSha256,
        bytesTransferred: prepared.value.bytesTransferred,
        restoreAttestationSha256: prepared.value.restoreAttestationSha256,
      },
      commitDeps.executor,
    );

    expect(result).toMatchObject({ ok: false, error: { kind: "finalization_failure" } });
    expect(commitDeps.run.mock.calls.map(([invocation]) => invocation.label)).toEqual([
      "commit-snapshot-target",
      "finalize-snapshot-target",
    ]);
  });

  it("emits only syntactically valid non-tracing shell programs", () => {
    const result = buildProductionRestorePlan(makeRequest());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const command of [
      result.value.targetPrepare,
      result.value.sourceStreamPrepare,
      result.value.targetVerifyAndPromote,
      result.value.targetReadAttestation,
      result.value.targetStatus,
      result.value.targetRollback,
      result.value.targetCommit,
      result.value.targetFinalize,
      result.value.sourceCleanup,
    ]) {
      const syntax = spawnSync("bash", ["-n"], { input: command.stdin, encoding: "utf8" });
      expect(syntax.status, `${command.label}: ${syntax.stderr}`).toBe(0);
      expect(command.stdin).not.toContain("set -x");
    }
  });
});
