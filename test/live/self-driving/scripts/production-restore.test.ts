import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
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
import { describe, expect, it, vi } from "vitest";

import type { ProductionBinarySshBridge } from "./production-binary-ssh.js";
import type {
  ProductionRemoteExecutor,
  ProductionRemoteInvocation,
} from "./production-bootstrap.js";
import type { ProductionReplayProfile } from "./production-profile.js";
import {
  buildProductionRestorePlan,
  commitProductionRestore,
  prepareProductionRestore,
} from "./production-restore.js";
import {
  buildProductionSnapshotPlan,
  deriveProductionSnapshotTreeIdentity,
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
    treeIdentitySha256: "0".repeat(64),
    entries,
    exclusions: [],
  };
  return { ...value, treeIdentitySha256: deriveProductionSnapshotTreeIdentity(value) };
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
    treeIdentitySha256: "0".repeat(64),
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
    treeIdentitySha256:
      overrides.treeIdentitySha256 ?? deriveProductionSnapshotTreeIdentity(merged),
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

function makeDeps(options: {
  readonly failLabel?: string;
  readonly failTransfer?: boolean;
  readonly stdoutLabel?: string;
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
    expect(plan.stream.source.args).toContain(
      "/run/comis-self-driving/restore-a1/stream-restore.sh",
    );
    expect(plan.stream.target.args).toContain(
      "/run/comis-self-driving/restore-restore-a1/receive.sh",
    );
    expect(plan.restoreAttestation).toEqual({
      schemaVersion: 1,
      state: "committed",
      dataDirSha256: "ef4e180fa56124fe7af6dcb50b03994870d4d25d5ad3f9198f1d24373be1c6cf",
      snapshotManifestSha256: plan.manifestSha256,
      restoredTreeDigestSha256: makeManifest().treeIdentitySha256,
      entryCount: makeManifest().entries.length,
      bytes: 6_344,
    });

    for (const command of [
      plan.targetPrepare,
      plan.targetVerifyAndPromote,
      plan.targetRollback,
      plan.targetCommit,
    ]) {
      expect(command.stdin).toContain("sha256sum /etc/machine-id");
      expect(command.stdin).toContain("environment-role");
      expect(command.stdin).toContain("IPAddressDeny=any");
      expect(command.stdin).toContain("systemctl is-active");
      expect(command.stdin).toContain("systemctl is-enabled");
      expect(command.stdin).toContain("exec 1>/dev/null");
      expect(command.stdin).not.toMatch(/systemctl\s+(start|restart|enable)\b/u);
    }
    expect(plan.targetPrepare.stdin).toContain('"$enabled_state" != disabled');
    expect(plan.targetPrepare.stdin).toContain("install -d -m 0700 -o root -g root");
    expect(plan.targetPrepare.stdin).toContain("maximum_bytes");
    expect(plan.targetPrepare.stdin).toContain("receive.sh");
    expect(plan.targetPrepare.stdin).not.toContain("COMIS_GATEWAY_TOKEN");
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
    expect(script).toContain('mv -- "$seal_incoming" "$seal_path"');
    expect(result.value.targetCommit.stdin).toContain("source-env.original");
    expect(result.value.targetCommit.stdin).toContain("committed");
    expect(result.value.targetCommit.stdin).toContain(
      "trap rollback_commit EXIT HUP INT TERM",
    );
    expect(result.value.targetCommit.stdin).toContain("committed-rollback");
    expect(result.value.targetCommit.stdin).toContain('"$committed_rollback/seal"');
    expect(result.value.targetCommit.stdin).not.toContain('rm -rf -- "$rollback_data"');
    expect(result.value.targetRollback.stdin).toContain('mv -- "$rollback_data" "$data_dir"');
    expect(result.value.targetRollback.stdin).toContain('mv -- "$seal_rollback" "$seal_path"');
    expect(result.value.targetRollback.stdin).toContain("committed-rollback");
    expect(result.value.targetRollback.stdin).toContain("transaction_marker");
    expect(result.value.targetRollback.stdin.indexOf("transaction_marker")).toBeLessThan(
      result.value.targetRollback.stdin.indexOf('rm -rf -- "$incoming_data"'),
    );
  });

  it("streams without controller plaintext and waits for explicit commit attestation", async () => {
    const deps = makeDeps();
    const result = await prepareProductionRestore(makeRequest(), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state).toBe("awaiting-attestation");
    expect(result.value.bytesTransferred).toBe(8192);
    expect(deps.transfer).toHaveBeenCalledWith(
      expect.objectContaining({ label: "snapshot-archive", maximumBytes: expect.any(Number) }),
    );
    expect(deps.run.mock.calls.map(([invocation]) => invocation.label)).toEqual([
      "prepare-snapshot-restore-target",
      "prepare-snapshot-stream-source",
      "verify-and-promote-snapshot-target",
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
      },
      deps.executor,
    );
    expect(committed).toEqual({
      ok: true,
      value: { runId: "restore-a1", state: "committed" },
    });
    expect(deps.run.mock.calls.map(([invocation]) => invocation.label)).toEqual([
      "commit-snapshot-target",
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

  it("rolls back a promoted target when the attested commit command faults", async () => {
    const prepareDeps = makeDeps();
    const prepared = await prepareProductionRestore(makeRequest(), prepareDeps);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const commitDeps = makeDeps({ failLabel: "commit-snapshot-target" });

    const result = await commitProductionRestore(
      prepared.value,
      {
        decision: "commit",
        runId: prepared.value.runId,
        targetMachineIdSha256: prepared.value.targetMachineIdSha256,
        manifestSha256: prepared.value.manifestSha256,
        bytesTransferred: prepared.value.bytesTransferred,
      },
      commitDeps.executor,
    );

    expect(result.ok).toBe(false);
    expect(commitDeps.run.mock.calls.map(([invocation]) => invocation.label)).toEqual([
      "commit-snapshot-target",
      "rollback-snapshot-target",
    ]);
  });

  it("emits only syntactically valid silent shell programs", () => {
    const result = buildProductionRestorePlan(makeRequest());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const command of [
      result.value.targetPrepare,
      result.value.sourceStreamPrepare,
      result.value.targetVerifyAndPromote,
      result.value.targetRollback,
      result.value.targetCommit,
      result.value.sourceCleanup,
    ]) {
      const syntax = spawnSync("bash", ["-n"], { input: command.stdin, encoding: "utf8" });
      expect(syntax.status, `${command.label}: ${syntax.stderr}`).toBe(0);
      expect(command.stdin).not.toContain("set -x");
    }
  });
});
