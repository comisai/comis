import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { err, ok } from "@comis/shared";

import type { ProductionBinarySshBridge } from "./production-binary-ssh.js";
import type {
  ProductionRemoteExecutor,
  ProductionRemoteInvocation,
} from "./production-bootstrap.js";
import {
  buildProductionRuntimeClonePlan,
  cloneProductionRuntime,
} from "./production-runtime-clone.js";
import type { ProductionReplayProfile } from "./production-profile.js";
import type { RuntimeArtifactAttestation } from "./production-runtime.js";

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

const source: RuntimeArtifactAttestation = {
  digestSha256: "c".repeat(64),
  entryCount: 84_128,
  bytes: 3_269_438_185,
  packageRoot: "/opt/source/node_modules/comisai",
  version: "1.0.53",
};

const target: RuntimeArtifactAttestation = {
  digestSha256: "d".repeat(64),
  entryCount: 84_131,
  bytes: 3_269_453_213,
  packageRoot: "/srv/target/node_modules/comisai",
  version: "1.0.53",
};

describe("production runtime clone transaction", () => {
  it("builds a direct encrypted stream with identity guards and per-host SSH ports", () => {
    const result = buildProductionRuntimeClonePlan({
      runId: "runtime-capture-a1",
      profile,
      source,
      target,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const plan = result.value;

    expect(plan.sourcePrepare).toMatchObject({
      host: "source-host",
      port: 2222,
      args: [
        "sudo",
        "bash",
        "-s",
        "--",
        "a".repeat(64),
        "/opt/source/node_modules/comisai",
        "runtime-capture-a1",
      ],
    });
    expect(plan.targetPrepare).toMatchObject({
      host: "target-host",
      port: 2202,
    });
    expect(plan.stream.source).toMatchObject({ host: "source-host", port: 2222 });
    expect(plan.stream.target).toMatchObject({ host: "target-host", port: 2202 });
    expect(plan.stream.maximumBytes).toBeGreaterThan(source.bytes);
    expect(plan.stream.source.args).toContain(
      "/run/comis-self-driving/runtime-runtime-capture-a1/read.sh",
    );
    expect(plan.stream.target.args).toContain(
      "/var/lib/comis-self-driving/runtime-runtime-capture-a1/receive.sh",
    );
    expect(plan.sourcePrepare.stdin).toContain("command -v zstd");
    expect(plan.sourcePrepare.stdin).toContain("--zstd");
    expect(plan.sourcePrepare.stdin).toContain("reader.pid");
    expect(plan.targetPrepare.stdin).toContain("command -v zstd");
    expect(plan.targetPrepare.stdin).toContain("--zstd");
    expect(plan.targetPrepare.stdin).toContain("receiver.pid");
    expect(plan.sourcePrepare.stdin).toContain("sha256sum /etc/machine-id");
    expect(plan.sourcePrepare.stdin).toContain("install -d -m 0700 -o root -g root");
    expect(plan.sourcePrepare.stdin).toContain("trap cleanup_source_prepare EXIT HUP INT TERM");
    expect(plan.sourcePrepare.stdin).not.toContain("/opt/source/node_modules/comisai");
    expect(plan.targetPrepare.stdin).toContain("environment-role");
    expect(plan.targetPrepare.stdin).toContain("IPAddressDeny=any");
    expect(plan.targetPrepare.stdin).toContain("systemctl is-active");
    expect(plan.targetPrepare.stdin).toContain("systemctl is-enabled");
    expect(plan.targetPrepare.stdin).toContain("trap cleanup_target_prepare EXIT HUP INT TERM");
    expect(plan.targetPrepare.stdin).not.toContain("/srv/target/node_modules/comisai");
  });

  it("uses an atomic promotion with a retained rollback tree until commit", () => {
    const result = buildProductionRuntimeClonePlan({
      runId: "runtime-promote-a1",
      profile,
      source,
      target,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const promote = result.value.targetPromote.stdin;
    expect(promote).toContain("trap rollback_promote EXIT HUP INT TERM");
    expect(promote).toContain('mv -- "$package_root" "$rollback_root"');
    expect(promote).toContain('mv -- "$staged_root" "$package_root"');
    expect(promote).toContain("chown -hR");
    expect(promote).toContain("environment-role");
    expect(promote).toContain("IPAddressDeny=any");
    expect(result.value.targetCommit.stdin).toContain('rm -rf -- "$rollback_root"');
    expect(result.value.targetRollback.stdin).toContain('mv -- "$rollback_root" "$package_root"');
    expect(result.value.targetBootGuard.stdin).toContain("daemon-entrypoint.js");
    expect(result.value.targetBootGuard.stdin).toContain("systemctl show");
    expect(result.value.targetBootGuard.stdin).toContain("environment-role");
    expect(result.value.targetBootGuard.stdin).not.toContain("systemctl start");
    expect(result.value.targetCommit.stdin).not.toContain("systemctl start");
    expect(result.value.targetRollback.stdin).not.toContain("systemctl start");
  });

  it("cleans only run-scoped source and target staging paths", () => {
    const result = buildProductionRuntimeClonePlan({
      runId: "runtime-clean-a1",
      profile,
      source,
      target,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sourceCleanup.stdin).toContain(
      'rm -rf -- "/run/comis-self-driving/runtime-$run_id"',
    );
    expect(result.value.sourceCleanup.stdin).toContain("kill -TERM");
    expect(result.value.targetRollback.stdin).toContain(
      '"/var/lib/comis-self-driving/runtime-$run_id"',
    );
    expect(result.value.targetRollback.stdin).toContain("kill -TERM");
    expect(result.value.sourceCleanup.stdin).not.toContain("/srv/source/.comis");
    expect(result.value.targetRollback.stdin).not.toContain("/srv/target/.comis");
  });

  it("rejects unsafe, unnecessary, or version-incompatible clone requests", () => {
    expect(
      buildProductionRuntimeClonePlan({ runId: "../escape", profile, source, target }).ok,
    ).toBe(false);
    expect(
      buildProductionRuntimeClonePlan({
        runId: "runtime-same-a1",
        profile,
        source,
        target: {
          ...target,
          digestSha256: source.digestSha256,
          entryCount: source.entryCount,
          bytes: source.bytes,
        },
      }).ok,
    ).toBe(false);
    expect(
      buildProductionRuntimeClonePlan({
        runId: "runtime-version-a1",
        profile,
        source,
        target: { ...target, version: "1.0.54" },
      }).ok,
    ).toBe(false);
  });

  it("emits shell programs that pass a strict Bash syntax check", () => {
    const result = buildProductionRuntimeClonePlan({
      runId: "runtime-syntax-a1",
      profile,
      source,
      target,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const command of [
      result.value.sourcePrepare,
      result.value.targetPrepare,
      result.value.targetPromote,
      result.value.targetBootGuard,
      result.value.targetRollback,
      result.value.targetCommit,
      result.value.sourceCleanup,
    ]) {
      const syntax = spawnSync("bash", ["-n"], { input: command.stdin, encoding: "utf8" });
      expect(syntax.status, command.label).toBe(0);
    }
  });

  it("streams promotes re-attests and commits an exact runtime clone", async () => {
    const invocations: string[] = [];
    let targetProbeCount = 0;
    const executor: ProductionRemoteExecutor = {
      run: async (invocation) => {
        invocations.push(invocation.label);
        if (invocation.label === "runtime-attest-source") {
          return ok({ stdout: runtimeFacts(source), exitCode: 0 });
        }
        if (invocation.label === "runtime-attest-target") {
          targetProbeCount += 1;
          return ok({
            stdout: runtimeFacts(
              targetProbeCount === 1
                ? target
                : { ...source, packageRoot: target.packageRoot },
            ),
            exitCode: 0,
          });
        }
        return ok({ stdout: "", exitCode: 0 });
      },
    };
    const bridge: ProductionBinarySshBridge = {
      transfer: async () => ok({ bytesTransferred: 3_400_000_000 }),
    };

    const result = await cloneProductionRuntime({
      runId: "runtime-execute-a1",
      profile,
      executor,
      bridge,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        changed: true,
        bytesTransferred: 3_400_000_000,
        digestSha256: source.digestSha256,
      },
    });
    expect(invocations).toContain("prepare-runtime-source");
    expect(invocations).toContain("prepare-runtime-target");
    expect(invocations).toContain("promote-runtime-target");
    expect(invocations).toContain("verify-runtime-replay-gate-target");
    expect(invocations).toContain("cleanup-runtime-source");
    expect(invocations.at(-1)).toBe("commit-runtime-target");
    expect(invocations).not.toContain("rollback-runtime-target");
  });

  it("rolls back an exact package clone whose replay entrypoint is absent from the target unit", async () => {
    const invocations: ProductionRemoteInvocation[] = [];
    const executor = makeCloneExecutor(invocations, false, "verify-runtime-replay-gate-target");

    const result = await cloneProductionRuntime({
      runId: "runtime-gate-fail-a1",
      profile,
      executor,
      bridge: { transfer: async () => ok({ bytesTransferred: 42 }) },
    });

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "remote_failure", stage: "verify-runtime-replay-gate-target" },
    });
    const labels = invocations.map(({ label }) => label);
    expect(labels).toContain("promote-runtime-target");
    expect(labels).toContain("rollback-runtime-target");
    expect(labels).toContain("cleanup-runtime-source");
    expect(labels).not.toContain("commit-runtime-target");
  });

  it("rejects an already matching runtime when its target replay gate is not bootable", async () => {
    const invocations: ProductionRemoteInvocation[] = [];
    const matchingTarget = { ...source, packageRoot: target.packageRoot };
    const executor: ProductionRemoteExecutor = {
      run: async (invocation) => {
        invocations.push(invocation);
        if (invocation.label === "runtime-attest-source") {
          return ok({ stdout: runtimeFacts(source), exitCode: 0 });
        }
        if (invocation.label === "runtime-attest-target") {
          return ok({ stdout: runtimeFacts(matchingTarget), exitCode: 0 });
        }
        if (invocation.label === "verify-runtime-replay-gate-target") {
          return err({ kind: "remote", message: "private remote failure" });
        }
        return ok({ stdout: "", exitCode: 0 });
      },
    };

    const result = await cloneProductionRuntime({
      runId: "runtime-matching-gate-fail-a1",
      profile,
      executor,
      bridge: { transfer: async () => ok({ bytesTransferred: 0 }) },
    });

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "remote_failure", stage: "verify-runtime-replay-gate-target" },
    });
    expect(invocations.map(({ label }) => label).at(-1)).toBe(
      "verify-runtime-replay-gate-target",
    );
  });

  it("rolls back both run scopes when the encrypted stream fails", async () => {
    const invocations: ProductionRemoteInvocation[] = [];
    const executor = makeCloneExecutor(invocations, false);
    const result = await cloneProductionRuntime({
      runId: "runtime-transfer-fail-a1",
      profile,
      executor,
      bridge: {
        transfer: async () =>
          err({ kind: "remote_failure", message: "Binary transfer failed" }),
      },
    });

    expect(result.ok).toBe(false);
    expect(invocations.map(({ label }) => label)).toContain("rollback-runtime-target");
    expect(invocations.map(({ label }) => label)).toContain("cleanup-runtime-source");
    expect(invocations.map(({ label }) => label)).not.toContain("promote-runtime-target");
    expect(invocations.map(({ label }) => label)).not.toContain("commit-runtime-target");
  });

  it("retains no promoted runtime when post-transfer attestation diverges", async () => {
    const invocations: ProductionRemoteInvocation[] = [];
    const executor = makeCloneExecutor(invocations, true);
    const result = await cloneProductionRuntime({
      runId: "runtime-attest-fail-a1",
      profile,
      executor,
      bridge: { transfer: async () => ok({ bytesTransferred: 42 }) },
    });

    expect(result.ok).toBe(false);
    const labels = invocations.map(({ label }) => label);
    expect(labels).toContain("promote-runtime-target");
    expect(labels).toContain("rollback-runtime-target");
    expect(labels).toContain("cleanup-runtime-source");
    expect(labels).not.toContain("commit-runtime-target");
  });
});

function runtimeFacts(facts: RuntimeArtifactAttestation): string {
  return [
    "COMIS_RUNTIME_ATTESTATION_V1_BEGIN",
    `digestSha256=${facts.digestSha256}`,
    `entryCount=${facts.entryCount}`,
    `bytes=${facts.bytes}`,
    `packageRoot=${facts.packageRoot}`,
    `version=${facts.version}`,
    "COMIS_RUNTIME_ATTESTATION_V1_END",
    "",
  ].join("\n");
}

function makeCloneExecutor(
  invocations: ProductionRemoteInvocation[],
  keepTargetDivergent: boolean,
  failingStage?: string,
): ProductionRemoteExecutor {
  let targetProbeCount = 0;
  return {
    run: async (invocation) => {
      invocations.push(invocation);
      if (invocation.label === failingStage) {
        return err({ kind: "remote", message: "private remote failure" });
      }
      if (invocation.label === "runtime-attest-source") {
        return ok({ stdout: runtimeFacts(source), exitCode: 0 });
      }
      if (invocation.label === "runtime-attest-target") {
        targetProbeCount += 1;
        const facts =
          targetProbeCount === 1 || keepTargetDivergent
            ? target
            : { ...source, packageRoot: target.packageRoot };
        return ok({ stdout: runtimeFacts(facts), exitCode: 0 });
      }
      return ok({ stdout: "", exitCode: 0 });
    },
  };
}
