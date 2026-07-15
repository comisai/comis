import { describe, expect, it, vi } from "vitest";

import { ok } from "@comis/shared";

import type { ProductionReplayProfile } from "./production-profile.js";
import type { RuntimeArtifactAttestation } from "./production-runtime.js";
import type { RuntimeTreeAttestation } from "./production-runtime-tree.js";
import type { ProductionServiceFingerprint } from "./production-service-fingerprint.js";
import {
  TOOLCHAIN_HELPERS,
  createToolchainContractV1,
  type ToolchainContractV1,
  type ToolchainRole,
} from "./production-toolchain-contract.js";
import {
  createProductionRuntimeVaultEvidencePort,
  type ProductionRuntimeVaultEvidenceDependencies,
} from "./production-runtime-vault-evidence.js";

const profile: ProductionReplayProfile = {
  source: {
    ssh: "source-host",
    role: "production",
    comisUser: "comis",
    dataDir: "/srv/source/.comis",
    service: "comis-source",
    expectedMachineIdSha256: "a".repeat(64),
  },
  target: {
    ssh: "target-host",
    role: "test",
    comisUser: "comis",
    dataDir: "/srv/target/.comis",
    service: "comis-target",
    expectedMachineIdSha256: "b".repeat(64),
  },
};

function runtime(root: string, digest: string): RuntimeArtifactAttestation {
  return {
    digestSha256: digest,
    entryCount: 10,
    bytes: 20,
    packageRoot: root,
    version: "1.0.0",
  } as unknown as RuntimeArtifactAttestation;
}

const sourceRuntime = runtime("/opt/source/node_modules/comisai", "c".repeat(64));
const targetRuntime = runtime("/opt/target/node_modules/comisai", "d".repeat(64));
const sourceTree: RuntimeTreeAttestation = {
  digestSha256: "e".repeat(64),
  entryCount: 11,
  bytes: 21,
  root: sourceRuntime.packageRoot,
  version: sourceRuntime.version,
};

function toolchain(role: ToolchainRole): ToolchainContractV1 {
  const created = createToolchainContractV1({
    role,
    machineIdSha256:
      role === "source"
        ? profile.source.expectedMachineIdSha256
        : profile.target.expectedMachineIdSha256,
    bootIdSha256: (role === "source" ? "1" : "2").repeat(64),
    kernelIdentitySha256: "3".repeat(64),
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

function fingerprint(role: "source" | "target"): ProductionServiceFingerprint {
  return {
    role,
    machineIdSha256:
      role === "source"
        ? profile.source.expectedMachineIdSha256
        : profile.target.expectedMachineIdSha256,
    fingerprintSha256: (role === "source" ? "4" : "5").repeat(64),
  } as unknown as ProductionServiceFingerprint;
}

function dependencies(): ProductionRuntimeVaultEvidenceDependencies {
  return {
    inspectRuntimes: vi.fn(async () =>
      ok({ source: sourceRuntime, target: targetRuntime }),
    ),
    inspectTargetRuntime: vi.fn(async () => ok(targetRuntime)),
    inspectSourceTree: vi.fn(async () => ok(sourceTree)),
    inspectToolchain: vi.fn(async (role) => ok(toolchain(role))),
    inspectServiceFingerprint: vi.fn(async (role) => ok(fingerprint(role))),
  };
}

describe("production runtime vault evidence port", () => {
  it("captures bound source and target evidence plus compatible toolchains", async () => {
    const deps = dependencies();
    const port = createProductionRuntimeVaultEvidencePort(deps);
    const result = await port.capture(profile, { run: vi.fn() });

    expect(result).toMatchObject({
      ok: true,
      value: {
        sourceRuntime,
        targetRuntime,
        sourceTree,
        sourceToolchain: { role: "source" },
        targetToolchain: { role: "target" },
        sourceServiceFingerprint: { role: "source" },
        targetServiceFingerprint: { role: "target" },
        toolchainCompatibility: { compatible: true },
      },
    });
    expect(deps.inspectSourceTree).toHaveBeenCalledWith(
      profile,
      sourceRuntime.packageRoot,
      expect.anything(),
    );
  });

  it("captures target recovery evidence without invoking a source probe", async () => {
    const deps = dependencies();
    const port = createProductionRuntimeVaultEvidencePort(deps);
    const result = await port.captureTarget(profile, { run: vi.fn() });

    expect(result).toMatchObject({
      ok: true,
      value: {
        targetRuntime,
        targetToolchain: { role: "target" },
        targetServiceFingerprint: { role: "target" },
      },
    });
    expect(deps.inspectRuntimes).not.toHaveBeenCalled();
    expect(deps.inspectSourceTree).not.toHaveBeenCalled();
    expect(deps.inspectToolchain).toHaveBeenCalledTimes(1);
    expect(deps.inspectToolchain).toHaveBeenCalledWith("target", profile, expect.anything());
    expect(deps.inspectServiceFingerprint).toHaveBeenCalledWith(
      "target",
      profile,
      expect.anything(),
    );
  });

  it("rejects a source tree that is not bound to its launcher artifact", async () => {
    const deps = dependencies();
    deps.inspectSourceTree = vi.fn(async () =>
      ok({ ...sourceTree, root: "/different/root" }),
    );
    const port = createProductionRuntimeVaultEvidencePort(deps);

    expect(await port.capture(profile, { run: vi.fn() })).toMatchObject({
      ok: false,
      error: { kind: "evidence_failure", stage: "source-tree-binding" },
    });
  });
});
