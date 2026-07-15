// SPDX-License-Identifier: Apache-2.0
import { err, ok, type Result } from "@comis/shared";

import type {
  ProductionRemoteExecutor,
  ProductionRemoteInvocation,
} from "./production-bootstrap.js";
import type { ProductionReplayProfile } from "./production-profile.js";
import {
  inspectRuntimeArtifactAttestations,
  inspectTargetRuntimeArtifactAttestation,
  type RuntimeArtifactAttestation,
  type RuntimeArtifactAttestationReport,
} from "./production-runtime.js";
import {
  buildRuntimeTreeProbeScript,
  parseRuntimeTreeFacts,
  type RuntimeTreeAttestation,
} from "./production-runtime-tree.js";
import {
  executeProductionServiceFingerprint,
  type ProductionServiceFingerprint,
} from "./production-service-fingerprint.js";
import {
  TOOLCHAIN_MAX_ENVELOPE_BYTES,
  TOOLCHAIN_ROOT_SHELL_PREFIX,
  buildToolchainProbeProgram,
  compareToolchainCompatibility,
  parseToolchainProbeOutput,
  type ToolchainCompatibilityReportV1,
  type ToolchainContractV1,
  type ToolchainRole,
} from "./production-toolchain-contract.js";

export interface ProductionRuntimeVaultCaptureEvidence {
  readonly sourceRuntime: RuntimeArtifactAttestation;
  readonly targetRuntime: RuntimeArtifactAttestation;
  readonly sourceTree: RuntimeTreeAttestation;
  readonly sourceToolchain: ToolchainContractV1;
  readonly targetToolchain: ToolchainContractV1;
  readonly sourceServiceFingerprint: ProductionServiceFingerprint;
  readonly targetServiceFingerprint: ProductionServiceFingerprint;
  readonly toolchainCompatibility: ToolchainCompatibilityReportV1;
}

export interface ProductionRuntimeVaultTargetEvidence {
  readonly targetRuntime: RuntimeArtifactAttestation;
  readonly targetToolchain: ToolchainContractV1;
  readonly targetServiceFingerprint: ProductionServiceFingerprint;
}

export interface ProductionRuntimeVaultEvidenceError {
  readonly kind: "evidence_failure";
  readonly stage:
    | "runtime-artifacts"
    | "target-runtime"
    | "source-runtime-tree"
    | "source-tree-binding"
    | "source-toolchain"
    | "target-toolchain"
    | "toolchain-compatibility"
    | "source-service-fingerprint"
    | "target-service-fingerprint";
  readonly message: string;
}

type EvidenceResult<T> = Result<T, unknown>;

export interface ProductionRuntimeVaultEvidenceDependencies {
  inspectRuntimes: (
    profile: ProductionReplayProfile,
    executor: ProductionRemoteExecutor,
  ) => Promise<EvidenceResult<RuntimeArtifactAttestationReport>>;
  inspectTargetRuntime: (
    profile: ProductionReplayProfile,
    executor: ProductionRemoteExecutor,
  ) => Promise<EvidenceResult<RuntimeArtifactAttestation>>;
  inspectSourceTree: (
    profile: ProductionReplayProfile,
    root: string,
    executor: ProductionRemoteExecutor,
  ) => Promise<EvidenceResult<RuntimeTreeAttestation>>;
  inspectToolchain: (
    role: ToolchainRole,
    profile: ProductionReplayProfile,
    executor: ProductionRemoteExecutor,
  ) => Promise<EvidenceResult<ToolchainContractV1>>;
  inspectServiceFingerprint: (
    role: ToolchainRole,
    profile: ProductionReplayProfile,
    executor: ProductionRemoteExecutor,
  ) => Promise<EvidenceResult<ProductionServiceFingerprint>>;
}

export interface ProductionRuntimeVaultEvidencePort {
  readonly capture: (
    profile: ProductionReplayProfile,
    executor: ProductionRemoteExecutor,
  ) => Promise<
    Result<ProductionRuntimeVaultCaptureEvidence, ProductionRuntimeVaultEvidenceError>
  >;
  readonly captureTarget: (
    profile: ProductionReplayProfile,
    executor: ProductionRemoteExecutor,
  ) => Promise<
    Result<ProductionRuntimeVaultTargetEvidence, ProductionRuntimeVaultEvidenceError>
  >;
}

function failure(
  stage: ProductionRuntimeVaultEvidenceError["stage"],
): Result<never, ProductionRuntimeVaultEvidenceError> {
  return err({
    kind: "evidence_failure",
    stage,
    message: `Runtime vault evidence capture failed during ${stage}`,
  });
}

function remoteInvocation(
  label: string,
  host: ProductionReplayProfile["source"] | ProductionReplayProfile["target"],
  args: readonly string[],
  stdin: string,
  stdoutLimitBytes?: number,
): ProductionRemoteInvocation {
  return {
    label,
    host: host.ssh,
    ...(host.sshPort !== undefined ? { port: host.sshPort } : {}),
    args,
    stdin,
    ...(stdoutLimitBytes !== undefined ? { stdoutLimitBytes } : {}),
    timeoutMs: 60_000,
  };
}

async function inspectSourceTree(
  profile: ProductionReplayProfile,
  root: string,
  executor: ProductionRemoteExecutor,
): Promise<EvidenceResult<RuntimeTreeAttestation>> {
  const invocation = remoteInvocation(
    "runtime-tree-attest-source",
    profile.source,
    [...TOOLCHAIN_ROOT_SHELL_PREFIX, root],
    buildRuntimeTreeProbeScript(),
    8 * 1024,
  );
  const remote = await executor.run(invocation);
  if (!remote.ok || remote.value.exitCode !== 0) return err(undefined);
  const parsed = parseRuntimeTreeFacts(remote.value.stdout);
  if (!parsed.ok || parsed.value.root !== root) return err(undefined);
  return parsed;
}

async function inspectToolchain(
  role: ToolchainRole,
  profile: ProductionReplayProfile,
  executor: ProductionRemoteExecutor,
): Promise<EvidenceResult<ToolchainContractV1>> {
  const host = role === "source" ? profile.source : profile.target;
  const program = buildToolchainProbeProgram(role, host.expectedMachineIdSha256);
  if (!program.ok) return program;
  const invocation = remoteInvocation(
    role === "source"
      ? "attest-runtime-vault-toolchain-source"
      : "attest-runtime-vault-toolchain-target",
    host,
    TOOLCHAIN_ROOT_SHELL_PREFIX,
    program.value,
    TOOLCHAIN_MAX_ENVELOPE_BYTES,
  );
  const remote = await executor.run(invocation);
  if (!remote.ok || remote.value.exitCode !== 0) return err(undefined);
  return parseToolchainProbeOutput(remote.value.stdout, {
    role,
    expectedMachineIdSha256: host.expectedMachineIdSha256,
  });
}

async function inspectServiceFingerprint(
  role: ToolchainRole,
  profile: ProductionReplayProfile,
  executor: ProductionRemoteExecutor,
): Promise<EvidenceResult<ProductionServiceFingerprint>> {
  const host = role === "source" ? profile.source : profile.target;
  return executeProductionServiceFingerprint(
    {
      host: host.ssh,
      ...(host.sshPort !== undefined ? { port: host.sshPort } : {}),
      role,
      expectedMachineIdSha256: host.expectedMachineIdSha256,
      service: host.service,
    },
    executor,
  );
}

const DEFAULT_DEPENDENCIES: ProductionRuntimeVaultEvidenceDependencies = {
  inspectRuntimes: inspectRuntimeArtifactAttestations,
  inspectTargetRuntime: inspectTargetRuntimeArtifactAttestation,
  inspectSourceTree,
  inspectToolchain,
  inspectServiceFingerprint,
};

export function createProductionRuntimeVaultEvidencePort(
  dependencies: ProductionRuntimeVaultEvidenceDependencies = DEFAULT_DEPENDENCIES,
): ProductionRuntimeVaultEvidencePort {
  return {
    capture: async (profile, executor) => {
      const runtimes = await dependencies.inspectRuntimes(profile, executor);
      if (!runtimes.ok) return failure("runtime-artifacts");
      const [sourceTree, sourceToolchain, targetToolchain, sourceService, targetService] =
        await Promise.all([
          dependencies.inspectSourceTree(
            profile,
            runtimes.value.source.packageRoot,
            executor,
          ),
          dependencies.inspectToolchain("source", profile, executor),
          dependencies.inspectToolchain("target", profile, executor),
          dependencies.inspectServiceFingerprint("source", profile, executor),
          dependencies.inspectServiceFingerprint("target", profile, executor),
        ]);
      if (!sourceTree.ok) return failure("source-runtime-tree");
      if (
        sourceTree.value.root !== runtimes.value.source.packageRoot ||
        sourceTree.value.version !== runtimes.value.source.version
      ) {
        return failure("source-tree-binding");
      }
      if (!sourceToolchain.ok) return failure("source-toolchain");
      if (!targetToolchain.ok) return failure("target-toolchain");
      const compatible = compareToolchainCompatibility(
        sourceToolchain.value,
        targetToolchain.value,
      );
      if (!compatible.ok) return failure("toolchain-compatibility");
      if (!sourceService.ok) return failure("source-service-fingerprint");
      if (!targetService.ok) return failure("target-service-fingerprint");
      return ok({
        sourceRuntime: runtimes.value.source,
        targetRuntime: runtimes.value.target,
        sourceTree: sourceTree.value,
        sourceToolchain: sourceToolchain.value,
        targetToolchain: targetToolchain.value,
        sourceServiceFingerprint: sourceService.value,
        targetServiceFingerprint: targetService.value,
        toolchainCompatibility: compatible.value,
      });
    },
    captureTarget: async (profile, executor) => {
      const [targetRuntime, targetToolchain, targetService] = await Promise.all([
        dependencies.inspectTargetRuntime(profile, executor),
        dependencies.inspectToolchain("target", profile, executor),
        dependencies.inspectServiceFingerprint("target", profile, executor),
      ]);
      if (!targetRuntime.ok) return failure("target-runtime");
      if (!targetToolchain.ok) return failure("target-toolchain");
      if (!targetService.ok) return failure("target-service-fingerprint");
      return ok({
        targetRuntime: targetRuntime.value,
        targetToolchain: targetToolchain.value,
        targetServiceFingerprint: targetService.value,
      });
    },
  };
}
