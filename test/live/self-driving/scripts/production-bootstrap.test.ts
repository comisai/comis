import { err, ok, type Result } from "@comis/shared";
import { describe, expect, it } from "vitest";

import {
  buildTargetQuarantineScript,
  inspectProductionReplayHosts,
  prepareProductionReplayTarget,
  type ProductionRemoteInvocation,
  type ProductionRemoteResult,
} from "./production-bootstrap.js";
import type { ProductionHostFacts } from "./production-host.js";
import type { ProductionReplayProfile } from "./production-profile.js";

const SOURCE_MACHINE = "a".repeat(64);
const TARGET_MACHINE = "b".repeat(64);

function makeProfile(): ProductionReplayProfile {
  return {
    source: {
      ssh: "comis-harel",
      role: "production",
      comisUser: "comis",
      dataDir: "/home/comis/.comis",
      service: "comis",
      expectedMachineIdSha256: SOURCE_MACHINE,
    },
    target: {
      ssh: "comis-test2",
      role: "test",
      comisUser: "comis",
      dataDir: "/home/comis/.comis",
      service: "comis",
      expectedMachineIdSha256: TARGET_MACHINE,
    },
  };
}

function makeFacts(overrides: Partial<ProductionHostFacts> = {}): ProductionHostFacts {
  return {
    machineIdSha256: SOURCE_MACHINE,
    osId: "ubuntu",
    osVersion: "24.04",
    arch: "x86_64",
    sudoReady: true,
    systemdReady: true,
    freezeReady: true,
    bashReady: true,
    tarReady: true,
    rsyncReady: true,
    curlReady: true,
    nodeReady: true,
    npmReady: true,
    comisInstalled: true,
    comisVersion: "1.0.53",
    serviceState: "active",
    serviceEnabled: true,
    dataExists: true,
    dataMode: "700",
    dataBytes: 305_000_000,
    diskFreeBytes: 90_000_000_000,
    ...overrides,
  };
}

interface FakeExecutor {
  readonly invocations: ProductionRemoteInvocation[];
  readonly run: (
    invocation: ProductionRemoteInvocation,
  ) => Promise<Result<ProductionRemoteResult, { readonly kind: "remote"; readonly message: string }>>;
}

function serializeFacts(facts: ProductionHostFacts): string {
  return [
    `machineIdSha256=${facts.machineIdSha256}`,
    `environmentRole=${facts.environmentRole ?? ""}`,
    `osId=${facts.osId}`,
    `osVersion=${facts.osVersion}`,
    `arch=${facts.arch}`,
    `sudoReady=${facts.sudoReady}`,
    `systemdReady=${facts.systemdReady}`,
    `freezeReady=${facts.freezeReady}`,
    `bashReady=${facts.bashReady}`,
    `tarReady=${facts.tarReady}`,
    `rsyncReady=${facts.rsyncReady}`,
    `curlReady=${facts.curlReady}`,
    `nodeReady=${facts.nodeReady}`,
    `npmReady=${facts.npmReady}`,
    `comisInstalled=${facts.comisInstalled}`,
    `comisVersion=${facts.comisVersion ?? ""}`,
    `serviceState=${facts.serviceState}`,
    `serviceEnabled=${facts.serviceEnabled}`,
    `dataExists=${facts.dataExists}`,
    `dataMode=${facts.dataMode ?? ""}`,
    `dataBytes=${facts.dataBytes}`,
    `diskFreeBytes=${facts.diskFreeBytes}`,
    "",
  ].join("\n");
}

function makeExecutor(
  source: ProductionHostFacts,
  targetBefore: ProductionHostFacts,
  targetAfter: ProductionHostFacts,
  failLabel?: string,
): FakeExecutor {
  const invocations: ProductionRemoteInvocation[] = [];
  return {
    invocations,
    run: async (invocation) => {
      invocations.push(invocation);
      if (invocation.label === failLabel) {
        return err({ kind: "remote", message: "remote command failed" });
      }
      if (invocation.label === "probe-source") {
        return ok({ stdout: serializeFacts(source), exitCode: 0 });
      }
      if (invocation.label === "probe-target") {
        return ok({ stdout: serializeFacts(targetBefore), exitCode: 0 });
      }
      if (invocation.label === "probe-target-post") {
        return ok({ stdout: serializeFacts(targetAfter), exitCode: 0 });
      }
      return ok({ stdout: "", exitCode: 0 });
    },
  };
}

describe("production replay target bootstrap", () => {
  it("doctors both hosts using probes only", async () => {
    const source = makeFacts();
    const target = makeFacts({
      machineIdSha256: TARGET_MACHINE,
      comisInstalled: false,
      comisVersion: undefined,
      serviceState: "missing",
      serviceEnabled: false,
      dataExists: false,
      dataMode: undefined,
      dataBytes: 0,
    });
    const executor = makeExecutor(source, target, target);

    const result = await inspectProductionReplayHosts(makeProfile(), executor);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      source: { machineIdSha256: SOURCE_MACHINE, environmentRole: "production" },
      target: { machineIdSha256: TARGET_MACHINE, environmentRole: "unmarked" },
      targetMutationPurpose: "bootstrap",
    });
    expect(executor.invocations.map(({ label }) => label)).toEqual([
      "probe-source",
      "probe-target",
    ]);
  });

  it("marks and quarantines a fresh target before installing without a first daemon boot", async () => {
    const source = makeFacts();
    const targetBefore = makeFacts({
      machineIdSha256: TARGET_MACHINE,
      comisInstalled: false,
      comisVersion: undefined,
      serviceState: "missing",
      serviceEnabled: false,
      dataExists: false,
      dataMode: undefined,
      dataBytes: 0,
      nodeReady: false,
      npmReady: false,
    });
    const targetAfter = makeFacts({
      machineIdSha256: TARGET_MACHINE,
      environmentRole: "test",
      serviceState: "inactive",
      serviceEnabled: false,
    });
    const executor = makeExecutor(source, targetBefore, targetAfter);

    const result = await prepareProductionReplayTarget(
      makeProfile(),
      "#!/usr/bin/env bash\n# repository installer\n",
      executor,
    );

    expect(result).toEqual({
      ok: true,
      value: {
        installed: true,
        version: "1.0.53",
        targetMachineIdSha256: TARGET_MACHINE,
        serviceState: "inactive",
      },
    });
    expect(executor.invocations.map(({ label }) => label)).toEqual([
      "probe-source",
      "probe-target",
      "mark-target-role",
      "quarantine-target",
      "install-target",
      "probe-target-post",
      "commit-target-bootstrap",
    ]);
    const sourceInvocations = executor.invocations.filter(({ host }) => host === "comis-harel");
    expect(sourceInvocations).toHaveLength(1);
    expect(sourceInvocations[0]?.label).toBe("probe-source");

    const install = executor.invocations.find(({ label }) => label === "install-target");
    expect(install?.args).toContain("--no-service-start");
    expect(install?.args).toContain("--no-init");
    expect(install?.stdin).toContain("repository installer");
  });

  it("refuses an unpinned source before issuing any target mutation", async () => {
    const source = makeFacts({ machineIdSha256: "c".repeat(64) });
    const target = makeFacts({ machineIdSha256: TARGET_MACHINE });
    const executor = makeExecutor(source, target, target);

    const result = await prepareProductionReplayTarget(makeProfile(), "installer", executor);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("host_attestation");
    expect(executor.invocations.map(({ label }) => label)).toEqual(["probe-source"]);
  });

  it("stops immediately when target quarantine cannot be established", async () => {
    const source = makeFacts();
    const target = makeFacts({
      machineIdSha256: TARGET_MACHINE,
      comisInstalled: false,
      comisVersion: undefined,
      serviceState: "missing",
      dataExists: false,
      dataMode: undefined,
      dataBytes: 0,
    });
    const executor = makeExecutor(source, target, target, "quarantine-target");

    const result = await prepareProductionReplayTarget(makeProfile(), "installer", executor);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ kind: "remote_failure", stage: "quarantine-target" });
    expect(executor.invocations.map(({ label }) => label)).toEqual([
      "probe-source",
      "probe-target",
      "mark-target-role",
      "quarantine-target",
      "rollback-target-bootstrap",
    ]);
  });

  it("uninstalls a partial fresh-target install and restores its transaction on failure", async () => {
    const source = makeFacts();
    const target = makeFacts({
      machineIdSha256: TARGET_MACHINE,
      comisInstalled: false,
      comisVersion: undefined,
      serviceState: "missing",
      serviceEnabled: false,
      dataExists: false,
      dataMode: undefined,
      dataBytes: 0,
    });
    const executor = makeExecutor(source, target, target, "install-target");

    const result = await prepareProductionReplayTarget(makeProfile(), "installer", executor);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("remote_failure");
    expect(executor.invocations.map(({ label }) => label)).toEqual([
      "probe-source",
      "probe-target",
      "mark-target-role",
      "quarantine-target",
      "install-target",
      "rollback-target-install",
      "rollback-target-bootstrap",
    ]);
    const uninstall = executor.invocations.find(({ label }) => label === "rollback-target-install");
    expect(uninstall?.args).toContain("--remove-user");
  });

  it("installs a root-owned systemd egress deny policy and leaves the service stopped", () => {
    const script = buildTargetQuarantineScript();

    expect(script).toContain("IPAddressDeny=any");
    expect(script).toContain("RestrictAddressFamilies=AF_UNIX");
    expect(script).toContain("RuntimeDirectory=comis-replay");
    expect(script).toContain("RuntimeDirectoryMode=0700");
    expect(script).toContain("Environment=COMIS_REPLAY_RUNTIME_DIR=/run/comis-replay");
    expect(script).not.toContain("IPAddressAllow=");
    expect(script).toContain("systemctl disable --now");
    expect(script).toContain("systemctl is-active --quiet");
    expect(script).not.toContain("GWTOKEN");
    expect(script).not.toContain("secrets.db");
  });
});
