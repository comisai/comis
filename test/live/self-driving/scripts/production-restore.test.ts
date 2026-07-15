import { spawnSync } from "node:child_process";

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
  type ProductionSnapshotManifest,
} from "./production-snapshot.js";

const SOURCE_MACHINE = "a".repeat(64);
const TARGET_MACHINE = "b".repeat(64);
const FILE_HASH = "c".repeat(64);

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
  return {
    schemaVersion: 1,
    runId: "restore-a1",
    sourceMachineIdSha256: SOURCE_MACHINE,
    service: "comis",
    captureMode: "offline",
    captureStartedAtMs: 1_752_560_000_000,
    captureCompletedAtMs: 1_752_560_004_000,
    freezeDurationMs: 0,
    entries: [
      { path: "data", type: "directory", mode: "0700", size: 4096 },
      {
        path: "data/config.yaml",
        type: "file",
        mode: "0600",
        size: 128,
        sha256: FILE_HASH,
      },
      {
        path: "data/memory.db",
        type: "file",
        mode: "0600",
        size: 4096,
        sha256: FILE_HASH,
      },
      {
        path: "data/memory.db-wal",
        type: "file",
        mode: "0600",
        size: 2048,
        sha256: FILE_HASH,
      },
      {
        path: "data/runtime/python",
        type: "symlink",
        mode: "0777",
        size: 16,
        linkTarget: "/usr/bin/python3",
      },
      { path: "system", type: "directory", mode: "0700", size: 4096 },
      { path: "system/etc", type: "directory", mode: "0755", size: 4096 },
      { path: "system/etc/comis", type: "directory", mode: "0755", size: 4096 },
      {
        path: "system/etc/comis/env",
        type: "file",
        mode: "0640",
        size: 72,
        sha256: FILE_HASH,
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
    ...overrides,
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
      restoredTreeDigestSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
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
    expect(script).toContain("symlink_prefixes");
    expect(script).toContain("expected-manifest.json");
    expect(script).toContain("sha256sum");
    expect(script).toContain("lstat");
    expect(script).toContain("readlink");
    expect(script).toContain("excluded_paths");
    expect(script).toContain("SQLite format 3\\0");
    expect(script).toContain("PRAGMA quick_check");
    expect(script).toContain("PRAGMA integrity_check");
    expect(script).toContain("PRAGMA foreign_key_check");
    expect(script).not.toContain("print(row");
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
    expect(script).toContain("chown -hR");
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
