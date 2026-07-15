import { err, ok } from "@comis/shared";
import { describe, expect, it, vi } from "vitest";

import {
  runProductionReplayProcess,
  runProductionReplayCli,
  type ProductionReplayCliDeps,
  type ProductionReplaySignalPort,
  type ProductionReplayTerminationSignal,
} from "./production-replay.js";
import { TARGET_REPLAY_QUARANTINE_SHA256 } from "./production-bootstrap.js";
import {
  EVIDENCE_FACTS_BEGIN,
  EVIDENCE_FACTS_END,
  PRODUCTION_EVIDENCE_IDS,
} from "./production-evidence.js";
import { RUNTIME_FACTS_BEGIN, RUNTIME_FACTS_END } from "./production-runtime.js";
import type {
  ProductionRuntimeVaultController,
  ProductionRuntimeVaultControllerRequest,
} from "./production-runtime-vault-controller.js";
import type {
  ProductionRuntimeVaultRecoveryReport,
  ProductionRuntimeVaultReport,
} from "./production-runtime-vault.js";
import {
  MESSAGES_ATTESTATION_BEGIN,
  MESSAGES_ATTESTATION_END,
} from "./production-messages.js";

const PROFILE = `
SOURCE_HOST=comis-harel
TARGET_HOST=comis-test2
SOURCE_SSH_PORT=2222
TARGET_SSH_PORT=2202
SOURCE_ROLE=production
TARGET_ROLE=test
SOURCE_COMIS_USER=comis
TARGET_COMIS_USER=comis
SOURCE_DATA=/home/comis/.comis
TARGET_DATA=/home/comis/.comis
SOURCE_SERVICE=comis
TARGET_SERVICE=comis
SOURCE_MACHINE_ID_SHA256=${"a".repeat(64)}
TARGET_MACHINE_ID_SHA256=${"b".repeat(64)}
GWTOKEN=should-never-appear
`;

const RUNTIME_ATTEMPT_ID = "0123456789abcdef0123456789abcdef";
const RECOVERY_AUTHORITY_DIGEST = "7".repeat(64);
const RECOVERY_AUTHORITY_KEY_ID = "8".repeat(64);

function runtimeFacts(
  digestSha256 = "c".repeat(64),
  targetQuarantine = false,
): string {
  return [
    RUNTIME_FACTS_BEGIN,
    `digestSha256=${digestSha256}`,
    "entryCount=120",
    "bytes=409600",
    "packageRoot=/home/comis/.npm-global/lib/node_modules/comisai",
    "version=1.0.53",
    "osId=ubuntu",
    "osVersion=24.04",
    "architecture=x86_64",
    "kernelRelease=6.8.0-71-generic",
    "libcKind=glibc",
    "libcVersion=2.39",
    "nodeVersion=22.17.1",
    "nodeAbi=127",
    "timezone=Asia/Jerusalem",
    `tzdataSha256=${"d".repeat(64)}`,
    "launcherKind=systemd",
    `applicationLauncherSha256=${"e".repeat(64)}`,
    `confinementKind=${targetQuarantine ? "target_quarantine" : "source"}`,
    `confinementSha256=${targetQuarantine ? TARGET_REPLAY_QUARANTINE_SHA256 : "none"}`,
    "browserStatus=available",
    `browserSha256=${"f".repeat(64)}`,
    "mediaStatus=available",
    `mediaSha256=${"1".repeat(64)}`,
    "nativeToolsStatus=available",
    `nativeToolsSha256=${"2".repeat(64)}`,
    RUNTIME_FACTS_END,
    "",
  ].join("\n");
}

function evidenceFacts(): string {
  return [
    EVIDENCE_FACTS_BEGIN,
    JSON.stringify({
      schema: "comis-production-evidence",
      schemaVersion: 1,
      consistency: "live_non_atomic",
      observedAtMs: 1_752_560_000_000,
      items: PRODUCTION_EVIDENCE_IDS.map((id) => ({
        id,
        configured: "unknown",
        availability: "unsupported",
        readability: "not_applicable",
        gapReason: "requires_runtime_api",
      })),
    }),
    EVIDENCE_FACTS_END,
    "",
  ].join("\n");
}

function messagesFacts(): string {
  return [
    MESSAGES_ATTESTATION_BEGIN,
    JSON.stringify({
      schema: "comis-offline-messages-attestation",
      schemaVersion: 1,
      channel: "telegram",
      limit: 10_000,
      count: 36,
      bytes: 22_075,
      digestSha256: "e".repeat(64),
      truncated: false,
    }),
    MESSAGES_ATTESTATION_END,
    "",
  ].join("\n");
}

function makeDeps(output: string[]): ProductionReplayCliDeps {
  return {
    readText: async (path) =>
      path.endsWith(".live-env")
        ? ok(PROFILE)
        : err({ kind: "io", message: "file unavailable" }),
    executor: {
      run: async () => err({ kind: "remote", message: "remote execution was not expected" }),
    },
    runtimeVault: () =>
      err({
        kind: "invalid_controller_options",
        stage: "create-runtime-vault-controller",
        message: "Runtime vault controller dependencies are unavailable",
      }),
    writeOutput: (line) => output.push(line),
  };
}

function sealedRuntimeReport(): ProductionRuntimeVaultReport {
  return {
    disposition: "published",
    bytesTransferred: 500_000,
    payload: {
      digestSha256: "9".repeat(64),
      entryCount: 153,
      bytes: 409_600,
      version: "1.0.53",
    },
    payloadPath: `/opt/comis-replay/runtimes/sha256/${"9".repeat(64)}/payload`,
    recoveryAuthorityDigestSha256: RECOVERY_AUTHORITY_DIGEST,
    recoveryAuthorityKeyIdSha256: RECOVERY_AUTHORITY_KEY_ID,
    compatibility: {
      compatible: true,
      schema: "comis-runtime-vault-toolchain-contract",
      schemaVersion: 1,
      schemaDigestSha256: "1".repeat(64),
      probeProgramSha256: "2".repeat(64),
      environmentSha256: "3".repeat(64),
      executionContractSha256: "4".repeat(64),
      featureDigestSha256: "5".repeat(64),
      sourceMachineIdSha256: "c".repeat(64),
      targetMachineIdSha256: "d".repeat(64),
      sourceToolchainDigestSha256: "e".repeat(64),
      targetToolchainDigestSha256: "f".repeat(64),
      sourceToolchainRecoveryDigestSha256: "0".repeat(64),
      targetToolchainRecoveryDigestSha256: "a".repeat(64),
    },
    sourceConsistency: { method: "bounded_multi_scan", atomicSnapshot: false },
    targetInstallationPreserved: true,
    normalServiceTouched: false,
  };
}

function recoveredRuntimeReport(): ProductionRuntimeVaultRecoveryReport {
  const sealed = sealedRuntimeReport();
  return {
    disposition: "published",
    payload: sealed.payload,
    payloadPath: sealed.payloadPath,
    recoveryAuthorityDigestSha256: RECOVERY_AUTHORITY_DIGEST,
    recoveryAuthorityKeyIdSha256: RECOVERY_AUTHORITY_KEY_ID,
    sourceConsistency: {
      method: "authenticated_receipt_only",
      atomicSnapshot: false,
    },
    targetInstallationPreserved: true,
    normalServiceTouched: false,
  };
}

function makeRuntimeController(overrides: {
  readonly seal?: ProductionRuntimeVaultController["seal"];
  readonly recover?: ProductionRuntimeVaultController["recover"];
  readonly dispose?: ProductionRuntimeVaultController["dispose"];
} = {}): ProductionRuntimeVaultController {
  return {
    seal: overrides.seal ?? (async () => ok(sealedRuntimeReport())),
    recover: overrides.recover ?? (async () => ok(recoveredRuntimeReport())),
    dispose: overrides.dispose ?? (() => ok(undefined)),
  };
}

function makeSignalPort(): ProductionReplaySignalPort & {
  readonly emit: (signal: ProductionReplayTerminationSignal) => void;
  readonly listenerCount: () => number;
} {
  const listeners = new Map<ProductionReplayTerminationSignal, Set<() => void>>();
  return {
    on(signal, listener) {
      const current = listeners.get(signal) ?? new Set<() => void>();
      current.add(listener);
      listeners.set(signal, current);
    },
    off(signal, listener) {
      listeners.get(signal)?.delete(listener);
    },
    emit(signal) {
      for (const listener of listeners.get(signal) ?? []) listener();
    },
    listenerCount() {
      return [...listeners.values()].reduce((total, current) => total + current.size, 0);
    },
  };
}

describe("production replay command controller", () => {
  it("prints a secret-free strict profile without executing SSH", async () => {
    const output: string[] = [];

    const exitCode = await runProductionReplayCli(["profile"], makeDeps(output));

    expect(exitCode).toBe(0);
    expect(output).toHaveLength(1);
    const rendered = output.join("\n");
    expect(rendered).toContain("comis-harel");
    expect(rendered).toContain("comis-test2");
    expect(rendered).not.toContain("GWTOKEN");
    expect(rendered).not.toContain("should-never-appear");
  });

  it("rejects unknown commands before reading files or contacting hosts", async () => {
    const output: string[] = [];
    let reads = 0;
    const deps = makeDeps(output);

    const exitCode = await runProductionReplayCli(["destroy-everything"], {
      ...deps,
      readText: async () => {
        reads += 1;
        return ok(PROFILE);
      },
    });

    expect(exitCode).toBe(2);
    expect(reads).toBe(0);
    expect(output.join("\n")).toContain("unknown_command");
  });

  it.each([
    [
      "clone-state",
      [
        "clone-state",
        "--run-id",
        "state-cli-a1",
        "--capture-mode",
        "offline",
        "--agent-id",
        "default",
      ],
    ],
    ["restore-status", ["restore-status", "--run-id", "state-cli-a1"]],
    ["restore-resume", ["restore-resume", "--run-id", "state-cli-a1"]],
    ["restore-rollback", ["restore-rollback", "--run-id", "state-cli-a1"]],
  ] as const)(
    "rejects unsupported %s command before profile or host I/O",
    async (_command, argv) => {
      const output: string[] = [];
      let reads = 0;
      let remoteCalls = 0;
      const deps = makeDeps(output);

      const exitCode = await runProductionReplayCli(argv, {
        ...deps,
        readText: async () => {
          reads += 1;
          return ok(PROFILE);
        },
        executor: {
          run: async () => {
            remoteCalls += 1;
            return err({ kind: "remote", message: "remote execution was not expected" });
          },
        },
      });

      expect(exitCode).toBe(2);
      expect(reads).toBe(0);
      expect(remoteCalls).toBe(0);
      const rendered = output.join("\n");
      expect(JSON.parse(rendered)).toMatchObject({
        ok: false,
        error: { kind: "unknown_command" },
      });
      for (const unsupported of [
        "clone-state",
        "restore-status",
        "restore-resume",
        "restore-rollback",
      ]) {
        expect(rendered).not.toContain(unsupported);
      }
    },
  );

  it("runtime-attest probes both hosts with their ports and prints content-free matching facts", async () => {
    const output: string[] = [];
    const invocations: Array<{
      label: string;
      host: string;
      port?: number;
      args: readonly string[];
      stdin: string;
    }> = [];
    const deps = makeDeps(output);

    const exitCode = await runProductionReplayCli(["runtime-attest"], {
      ...deps,
      executor: {
        run: async (invocation) => {
          invocations.push(invocation);
          return ok({
            stdout: runtimeFacts(
              "c".repeat(64),
              invocation.label === "runtime-attest-target",
            ),
            exitCode: 0,
          });
        },
      },
    });

    expect(exitCode).toBe(0);
    expect(invocations).toHaveLength(2);
    expect(invocations.map(({ label, host, port, args }) => ({ label, host, port, args }))).toEqual([
      {
        label: "runtime-attest-source",
        host: "comis-harel",
        port: 2222,
        args: ["sudo", "bash", "-s", "--", "comis", "source"],
      },
      {
        label: "runtime-attest-target",
        host: "comis-test2",
        port: 2202,
        args: ["sudo", "bash", "-s", "--", "comis", "target_quarantine"],
      },
    ]);
    expect(invocations[0]?.stdin).toBe(invocations[1]?.stdin);
    const rendered = JSON.parse(output.join("\n")) as Record<string, unknown>;
    expect(rendered).toEqual({
      ok: true,
      report: {
        source: parseRuntimeReportFacts(),
        target: parseRuntimeReportFacts(true),
      },
    });
    expect(output.join("\n")).not.toContain("should-never-appear");
    expect(output.join("\n")).not.toContain("package.json");
  });

  it("runtime-attest returns nonzero content-free JSON when target artifacts differ", async () => {
    const output: string[] = [];
    const deps = makeDeps(output);

    const exitCode = await runProductionReplayCli(["runtime-attest"], {
      ...deps,
      executor: {
        run: async (invocation) =>
          ok({
            stdout: runtimeFacts(
              invocation.label === "runtime-attest-source" ? "c".repeat(64) : "d".repeat(64),
              invocation.label === "runtime-attest-target",
            ),
            exitCode: 0,
          }),
      },
    });

    expect(exitCode).toBe(1);
    expect(JSON.parse(output.join("\n"))).toEqual({
      ok: false,
      error: {
        kind: "runtime_mismatch",
        field: "digestSha256",
        message: "Target runtime digestSha256 does not match the production source",
      },
    });
    expect(output.join("\n")).not.toContain("c".repeat(64));
    expect(output.join("\n")).not.toContain("d".repeat(64));
  });

  it("rejects the removed clone-runtime command before controller I/O", async () => {
    const output: string[] = [];
    let reads = 0;
    const deps = makeDeps(output);

    const exitCode = await runProductionReplayCli(
      ["clone-runtime", "--run-id", "runtime-cli-a1"],
      {
        ...deps,
        readText: async () => {
          reads += 1;
          return ok(PROFILE);
        },
      },
    );

    expect(exitCode).toBe(2);
    expect(reads).toBe(0);
    expect(JSON.parse(output.join("\n"))).toMatchObject({
      ok: false,
      error: { kind: "unknown_command" },
    });
  });

  it("requires a lowercase fixed-width attempt identity for runtime vault commands", async () => {
    const cases: readonly (readonly string[])[] = [
      ["seal-runtime", "--run-id", "runtime-cli-a1"],
      ["recover-runtime", "--attempt-id", RUNTIME_ATTEMPT_ID],
      [
        "seal-runtime",
        "--run-id",
        "runtime-cli-a1",
        "--attempt-id",
        RUNTIME_ATTEMPT_ID.toUpperCase(),
      ],
      [
        "recover-runtime",
        "--run-id",
        "runtime-cli-a1",
        "--attempt-id",
        "a".repeat(31),
      ],
    ];

    for (const argv of cases) {
      const output: string[] = [];
      const exitCode = await runProductionReplayCli(argv, makeDeps(output));

      expect(exitCode).toBe(2);
      expect(JSON.parse(output.join("\n"))).toMatchObject({
        ok: false,
        error: { kind: "invalid_arguments" },
      });
    }
  });

  it("rejects unsafe runtime run identities before profile or controller I/O", async () => {
    const cases = ["", "../escape", "-leading", "a".repeat(65), "run with spaces"];

    for (const runId of cases) {
      const output: string[] = [];
      let reads = 0;
      let compositions = 0;
      const deps = makeDeps(output);
      const argv = [
        "seal-runtime",
        "--run-id",
        runId,
        "--attempt-id",
        RUNTIME_ATTEMPT_ID,
      ];

      const exitCode = await runProductionReplayCli(argv, {
        ...deps,
        readText: async () => {
          reads += 1;
          return ok(PROFILE);
        },
        runtimeVault: () => {
          compositions += 1;
          return ok(makeRuntimeController());
        },
      });

      expect(exitCode).toBe(2);
      expect(reads).toBe(0);
      expect(compositions).toBe(0);
      expect(output.join("\n")).not.toContain("../escape");
    }
  });

  it("rejects duplicate singleton runtime arguments before controller I/O", async () => {
    const cases: readonly (readonly string[])[] = [
      [
        "seal-runtime",
        "--run-id",
        "runtime-cli-a1",
        "--run-id",
        "runtime-cli-a2",
        "--attempt-id",
        RUNTIME_ATTEMPT_ID,
      ],
      [
        "recover-runtime",
        "--run-id",
        "runtime-cli-a1",
        "--attempt-id",
        RUNTIME_ATTEMPT_ID,
        "--attempt-id",
        "f".repeat(32),
      ],
      [
        "recover-runtime",
        "--run-id",
        "runtime-cli-a1",
        "--attempt-id",
        RUNTIME_ATTEMPT_ID,
        "--env",
        "/first/profile",
        "--env",
        "/second/profile",
      ],
    ];

    for (const argv of cases) {
      const output: string[] = [];
      let reads = 0;
      let compositions = 0;
      const deps = makeDeps(output);
      const exitCode = await runProductionReplayCli(argv, {
        ...deps,
        readText: async () => {
          reads += 1;
          return ok(PROFILE);
        },
        runtimeVault: () => {
          compositions += 1;
          return ok(makeRuntimeController());
        },
      });

      expect(exitCode).toBe(2);
      expect(reads).toBe(0);
      expect(compositions).toBe(0);
      expect(JSON.parse(output.join("\n"))).toMatchObject({
        ok: false,
        error: { kind: "invalid_arguments" },
      });
    }
  });

  it("seals a runtime through a lazily composed controller and disposes before output", async () => {
    const output: string[] = [];
    const deps = makeDeps(output);
    const order: string[] = [];
    let sealRequest: ProductionRuntimeVaultControllerRequest | undefined;
    const dispose = vi.fn(() => {
      order.push("dispose");
      return ok(undefined);
    });

    const exitCode = await runProductionReplayCli(
      [
        "seal-runtime",
        "--run-id",
        "runtime-cli-a1",
        "--attempt-id",
        RUNTIME_ATTEMPT_ID,
      ],
      {
        ...deps,
        runtimeVault: () =>
          ok(
            makeRuntimeController({
              seal: async (request) => {
                order.push("seal");
                sealRequest = request;
                return ok(sealedRuntimeReport());
              },
              dispose,
            }),
          ),
        writeOutput: (line) => {
          order.push("output");
          output.push(line);
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(sealRequest).toMatchObject({
      runId: "runtime-cli-a1",
      attemptId: RUNTIME_ATTEMPT_ID,
      profile: expect.objectContaining({
        source: expect.objectContaining({ ssh: "comis-harel" }),
        target: expect.objectContaining({ ssh: "comis-test2" }),
      }),
    });
    expect(Object.keys(sealRequest ?? {}).sort()).toEqual(["attemptId", "profile", "runId"]);
    expect(sealRequest).not.toHaveProperty("authorityKey");
    expect(sealRequest).not.toHaveProperty("authorityDigestSha256");
    expect(order).toEqual(["seal", "dispose", "output"]);
    expect(dispose).toHaveBeenCalledOnce();
    const rendered = output.join("\n");
    expect(JSON.parse(rendered)).toMatchObject({
      ok: true,
      runId: "runtime-cli-a1",
      attemptId: RUNTIME_ATTEMPT_ID,
      report: {
        disposition: "published",
        bytesTransferred: 500_000,
        targetInstallationPreserved: true,
        normalServiceTouched: false,
      },
    });
    expect(rendered).not.toContain(RECOVERY_AUTHORITY_DIGEST);
    expect(rendered).not.toContain(RECOVERY_AUTHORITY_KEY_ID);
    expect(rendered).not.toContain("recoveryAuthority");
  });

  it("recovers a runtime through the controller without exposing its owned dependencies", async () => {
    const output: string[] = [];
    const deps = makeDeps(output);
    let recoverRequest: ProductionRuntimeVaultControllerRequest | undefined;
    const dispose = vi.fn(() => ok(undefined));

    const exitCode = await runProductionReplayCli(
      [
        "recover-runtime",
        "--run-id",
        "runtime-cli-a1",
        "--attempt-id",
        RUNTIME_ATTEMPT_ID,
      ],
      {
        ...deps,
        runtimeVault: () =>
          ok(
            makeRuntimeController({
              recover: async (request) => {
                recoverRequest = request;
                return ok(recoveredRuntimeReport());
              },
              dispose,
            }),
          ),
      },
    );

    expect(exitCode).toBe(0);
    expect(recoverRequest).toMatchObject({
      runId: "runtime-cli-a1",
      attemptId: RUNTIME_ATTEMPT_ID,
      profile: expect.objectContaining({
        source: expect.objectContaining({ ssh: "comis-harel" }),
        target: expect.objectContaining({ ssh: "comis-test2" }),
      }),
    });
    expect(Object.keys(recoverRequest ?? {}).sort()).toEqual(["attemptId", "profile", "runId"]);
    expect(recoverRequest).not.toHaveProperty("bridge");
    expect(recoverRequest).not.toHaveProperty("authorityKey");
    expect(recoverRequest).not.toHaveProperty("authorityDigestSha256");
    expect(dispose).toHaveBeenCalledOnce();
    const rendered = output.join("\n");
    expect(JSON.parse(rendered)).toMatchObject({
      ok: true,
      runId: "runtime-cli-a1",
      attemptId: RUNTIME_ATTEMPT_ID,
      report: {
        disposition: "published",
        targetInstallationPreserved: true,
        normalServiceTouched: false,
      },
    });
    expect(rendered).not.toContain(RECOVERY_AUTHORITY_DIGEST);
    expect(rendered).not.toContain(RECOVERY_AUTHORITY_KEY_ID);
    expect(rendered).not.toContain("recoveryAuthority");
  });

  it("fails runtime vault commands with correlated output when trusted composition is unavailable", async () => {
    const output: string[] = [];
    let reads = 0;
    let compositions = 0;
    const deps = makeDeps(output);

    const exitCode = await runProductionReplayCli(
      [
        "recover-runtime",
        "--run-id",
        "runtime-cli-a1",
        "--attempt-id",
        RUNTIME_ATTEMPT_ID,
      ],
      {
        ...deps,
        readText: async () => {
          reads += 1;
          return ok(PROFILE);
        },
        runtimeVault: () => {
          compositions += 1;
          return err({
            kind: "invalid_controller_options",
            stage: "create-runtime-vault-controller",
            message: "Runtime vault controller dependencies are unavailable",
          });
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(reads).toBe(1);
    expect(compositions).toBe(1);
    expect(JSON.parse(output.join("\n"))).toEqual({
      ok: false,
      command: "recover-runtime",
      runId: "runtime-cli-a1",
      attemptId: RUNTIME_ATTEMPT_ID,
      error: {
        kind: "invalid_controller_options",
        stage: "create-runtime-vault-controller",
        message: "Runtime vault controller dependencies are unavailable",
      },
    });
  });

  it("disposes after an operation failure and correlates the safe failure output", async () => {
    const output: string[] = [];
    const deps = makeDeps(output);
    const dispose = vi.fn(() => ok(undefined));

    const exitCode = await runProductionReplayCli(
      [
        "seal-runtime",
        "--run-id",
        "runtime-cli-a1",
        "--attempt-id",
        RUNTIME_ATTEMPT_ID,
      ],
      {
        ...deps,
        runtimeVault: () =>
          ok(
            makeRuntimeController({
              seal: async () =>
                err({
                  kind: "attestation_failure",
                  stage: "verify-runtime-vault-evidence-under-lease",
                  message: "Source or target evidence changed before mutation",
                }),
              dispose,
            }),
          ),
      },
    );

    expect(exitCode).toBe(1);
    expect(dispose).toHaveBeenCalledOnce();
    expect(JSON.parse(output.join("\n"))).toEqual({
      ok: false,
      command: "seal-runtime",
      runId: "runtime-cli-a1",
      attemptId: RUNTIME_ATTEMPT_ID,
      error: {
        kind: "attestation_failure",
        stage: "verify-runtime-vault-evidence-under-lease",
        message: "Source or target evidence changed before mutation",
      },
    });
  });

  it("turns a disposal failure into a correlated secret-free terminal failure", async () => {
    const output: string[] = [];
    const deps = makeDeps(output);
    const sensitiveCause = "controller-private-cause-must-not-render";

    const exitCode = await runProductionReplayCli(
      [
        "recover-runtime",
        "--run-id",
        "runtime-cli-a1",
        "--attempt-id",
        RUNTIME_ATTEMPT_ID,
      ],
      {
        ...deps,
        runtimeVault: () =>
          ok(
            makeRuntimeController({
              dispose: () =>
                err({
                  kind: "receipt_store_failure",
                  stage: "dispose-runtime-vault-receipt-store",
                  message: "Runtime vault controller authority state is unavailable",
                  cause: {
                    kind: "io_failure",
                    operation: sensitiveCause,
                    message: sensitiveCause,
                  },
                }),
            }),
          ),
      },
    );

    expect(exitCode).toBe(1);
    const rendered = output.join("\n");
    expect(JSON.parse(rendered)).toEqual({
      ok: false,
      command: "recover-runtime",
      runId: "runtime-cli-a1",
      attemptId: RUNTIME_ATTEMPT_ID,
      error: {
        kind: "receipt_store_failure",
        stage: "dispose-runtime-vault-receipt-store",
        message: "Runtime vault controller authority state is unavailable",
      },
    });
    expect(rendered).not.toContain(sensitiveCause);
    expect(rendered).not.toContain("cause");
  });

  it("disposes after an unexpected operation rejection without rendering its cause", async () => {
    const output: string[] = [];
    const deps = makeDeps(output);
    const dispose = vi.fn(() => ok(undefined));
    const sensitiveCause = "unexpected-operation-secret";

    const exitCode = await runProductionReplayCli(
      [
        "seal-runtime",
        "--run-id",
        "runtime-cli-a1",
        "--attempt-id",
        RUNTIME_ATTEMPT_ID,
      ],
      {
        ...deps,
        runtimeVault: () => ok(makeRuntimeController({
          seal: async () => Promise.reject(new Error(sensitiveCause)),
          dispose,
        })),
      },
    );

    expect(exitCode).toBe(1);
    expect(dispose).toHaveBeenCalledOnce();
    const rendered = output.join("\n");
    expect(JSON.parse(rendered)).toMatchObject({
      ok: false,
      error: { kind: "runtime_vault_boundary_failure", stage: "operation" },
    });
    expect(rendered).not.toContain(sensitiveCause);
  });

  it("contains an unexpected disposal throw without hiding successful operation reconciliation", async () => {
    const output: string[] = [];
    const deps = makeDeps(output);
    const sensitiveCause = "unexpected-disposal-secret";

    const exitCode = await runProductionReplayCli(
      [
        "recover-runtime",
        "--run-id",
        "runtime-cli-a1",
        "--attempt-id",
        RUNTIME_ATTEMPT_ID,
      ],
      {
        ...deps,
        runtimeVault: () => ok(makeRuntimeController({
          dispose: () => {
            throw new Error(sensitiveCause);
          },
        })),
      },
    );

    expect(exitCode).toBe(1);
    const rendered = output.join("\n");
    expect(JSON.parse(rendered)).toMatchObject({
      ok: false,
      error: { kind: "runtime_vault_boundary_failure", stage: "dispose" },
    });
    expect(rendered).not.toContain(sensitiveCause);
    expect(rendered).not.toContain(RECOVERY_AUTHORITY_DIGEST);
  });

  it("contains an unexpected controller factory throw without rendering its cause", async () => {
    const output: string[] = [];
    const deps = makeDeps(output);
    const sensitiveCause = "unexpected-factory-secret";

    const exitCode = await runProductionReplayCli(
      [
        "recover-runtime",
        "--run-id",
        "runtime-cli-a1",
        "--attempt-id",
        RUNTIME_ATTEMPT_ID,
      ],
      {
        ...deps,
        runtimeVault: () => {
          throw new Error(sensitiveCause);
        },
      },
    );

    expect(exitCode).toBe(1);
    const rendered = output.join("\n");
    expect(JSON.parse(rendered)).toMatchObject({
      ok: false,
      error: { kind: "runtime_vault_boundary_failure", stage: "composition" },
    });
    expect(rendered).not.toContain(sensitiveCause);
  });

  it("rejects caller-supplied runtime authority material without rendering it", async () => {
    for (const flag of ["--authority-key", "--authority-digest"] as const) {
      const output: string[] = [];
      const supplied = `${flag}-must-not-be-rendered`;

      const exitCode = await runProductionReplayCli(
        [
          "seal-runtime",
          "--run-id",
          "runtime-cli-a1",
          "--attempt-id",
          RUNTIME_ATTEMPT_ID,
          flag,
          supplied,
        ],
        makeDeps(output),
      );

      expect(exitCode).toBe(2);
      expect(output.join("\n")).not.toContain(supplied);
    }
  });

  it("returns matching offline channel history attestations without message bodies", async () => {
    const output: string[] = [];
    const labels: string[] = [];
    const deps = makeDeps(output);

    const exitCode = await runProductionReplayCli(
      ["messages-attest", "--channel", "telegram"],
      {
        ...deps,
        executor: {
          run: async (invocation) => {
            labels.push(invocation.label);
            return ok({ stdout: messagesFacts(), exitCode: 0 });
          },
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(labels).toEqual(["messages-attest-source", "messages-attest-target"]);
    expect(JSON.parse(output.join("\n"))).toMatchObject({
      ok: true,
      report: {
        exact: true,
        source: { channel: "telegram", count: 36, bytes: 22_075 },
        target: { channel: "telegram", count: 36, bytes: 22_075 },
      },
    });
    expect(output.join("\n")).not.toContain("PRIVATE_USER_PROMPT");
  });

  it("returns a content-safe source evidence inventory from the explicit package root", async () => {
    const output: string[] = [];
    const invocations: Array<{ host: string; port?: number; args: readonly string[] }> = [];
    const deps = makeDeps(output);

    const exitCode = await runProductionReplayCli(
      [
        "evidence-source",
        "--package-root",
        "/home/comis/.npm-global/lib/node_modules/comisai",
      ],
      {
        ...deps,
        executor: {
          run: async (invocation) => {
            invocations.push({
              host: invocation.host,
              ...(invocation.port !== undefined ? { port: invocation.port } : {}),
              args: invocation.args,
            });
            return ok({ stdout: evidenceFacts(), exitCode: 0 });
          },
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(invocations).toEqual([
      {
        host: "comis-harel",
        port: 2222,
        args: [
          "bash",
          "-s",
          "--",
          "/home/comis/.comis",
          "/home/comis/.npm-global/lib/node_modules/comisai",
          "comis",
        ],
      },
    ]);
    const rendered = JSON.parse(output.join("\n")) as Record<string, unknown>;
    expect(rendered).toMatchObject({ ok: true });
    expect(output.join("\n")).not.toContain("should-never-appear");
  });

  it("returns a content-safe target evidence inventory after state restoration", async () => {
    const output: string[] = [];
    const invocations: Array<{ host: string; port?: number; args: readonly string[] }> = [];
    const deps = makeDeps(output);

    const exitCode = await runProductionReplayCli(
      [
        "evidence-target",
        "--package-root",
        "/home/comis/.npm-global/lib/node_modules/comisai",
      ],
      {
        ...deps,
        executor: {
          run: async (invocation) => {
            invocations.push({
              host: invocation.host,
              ...(invocation.port !== undefined ? { port: invocation.port } : {}),
              args: invocation.args,
            });
            return ok({ stdout: evidenceFacts(), exitCode: 0 });
          },
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(invocations).toEqual([
      {
        host: "comis-test2",
        port: 2202,
        args: [
          "bash",
          "-s",
          "--",
          "/home/comis/.comis",
          "/home/comis/.npm-global/lib/node_modules/comisai",
          "comis",
        ],
      },
    ]);
    expect(JSON.parse(output.join("\n"))).toMatchObject({ ok: true });
  });

  it("probes both hosts and returns a content-safe evidence parity attestation", async () => {
    const output: string[] = [];
    const labels: string[] = [];
    const deps = makeDeps(output);

    const exitCode = await runProductionReplayCli(
      ["evidence-parity"],
      {
        ...deps,
        executor: {
          run: async (invocation) => {
            labels.push(invocation.label);
            return ok({
              stdout: invocation.label.startsWith("runtime-attest-")
                ? runtimeFacts(
                    "c".repeat(64),
                    invocation.label === "runtime-attest-target",
                  )
                : evidenceFacts(),
              exitCode: 0,
            });
          },
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(labels).toEqual([
      "runtime-attest-source",
      "runtime-attest-target",
      "production-evidence-inventory-source",
      "production-evidence-inventory-target",
    ]);
    expect(JSON.parse(output.join("\n"))).toEqual({
      ok: true,
      report: {
        exact: true,
        itemCount: PRODUCTION_EVIDENCE_IDS.length,
        gapCount: PRODUCTION_EVIDENCE_IDS.length,
      },
    });
  });

  it("runtime-attest rejects malformed remote output without echoing its content", async () => {
    const output: string[] = [];
    const deps = makeDeps(output);

    const exitCode = await runProductionReplayCli(["runtime-attest"], {
      ...deps,
      executor: {
        run: async (invocation) =>
          ok({
            stdout:
              invocation.label === "runtime-attest-source"
                ? "unexpected payload=secret-body\n"
                : runtimeFacts("c".repeat(64), true),
            exitCode: 0,
          }),
      },
    });

    expect(exitCode).toBe(1);
    expect(JSON.parse(output.join("\n"))).toEqual({
      ok: false,
      error: {
        kind: "runtime_facts",
        stage: "runtime-attest-source",
        field: "envelope",
        message: "Runtime artifact facts failed validation during runtime-attest-source",
      },
    });
    expect(output.join("\n")).not.toContain("secret-body");
  });

  it("runtime-attest reports remote probe failure without forwarding executor details", async () => {
    const output: string[] = [];
    const deps = makeDeps(output);

    const exitCode = await runProductionReplayCli(["runtime-attest"], {
      ...deps,
      executor: {
        run: async (invocation) =>
          invocation.label === "runtime-attest-source"
            ? err({ kind: "remote", message: "stderr contained sensitive-package-content" })
            : ok({ stdout: runtimeFacts("c".repeat(64), true), exitCode: 0 }),
      },
    });

    expect(exitCode).toBe(1);
    expect(JSON.parse(output.join("\n"))).toEqual({
      ok: false,
      error: {
        kind: "remote_failure",
        stage: "runtime-attest-source",
        message: "Runtime artifact probe failed during runtime-attest-source",
      },
    });
    expect(output.join("\n")).not.toContain("sensitive-package-content");
  });

});

describe("production replay process signal lifecycle", () => {
  it("waits for runtime reconciliation and disposes exactly once after SIGTERM", async () => {
    const output: string[] = [];
    const deps = makeDeps(output);
    const signals = makeSignalPort();
    const dispose = vi.fn(() => ok(undefined));
    let finishSeal: ((result: ReturnType<typeof ok<ProductionRuntimeVaultReport>>) => void) | undefined;
    const seal = vi.fn(
      () => new Promise<ReturnType<typeof ok<ProductionRuntimeVaultReport>>>((resolveSeal) => {
        finishSeal = resolveSeal;
      }),
    );

    const running = runProductionReplayProcess(
      [
        "seal-runtime",
        "--run-id",
        "run_signal_reconciliation",
        "--attempt-id",
        RUNTIME_ATTEMPT_ID,
      ],
      {
        ...deps,
        runtimeVault: () => ok(makeRuntimeController({ seal, dispose })),
      },
      signals,
    );
    await vi.waitFor(() => expect(seal).toHaveBeenCalledOnce());

    signals.emit("SIGTERM");

    expect(dispose).not.toHaveBeenCalled();
    expect(signals.listenerCount()).toBe(3);
    finishSeal?.(ok(sealedRuntimeReport()));
    await expect(running).resolves.toBe(143);
    expect(dispose).toHaveBeenCalledOnce();
    expect(signals.listenerCount()).toBe(0);
    expect(JSON.parse(output.join("\n"))).toMatchObject({
      ok: true,
      command: "seal-runtime",
      runId: "run_signal_reconciliation",
      attemptId: RUNTIME_ATTEMPT_ID,
    });
  });

  it.each([
    ["SIGHUP", 129],
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)("returns the conventional exit code after %s without leaking listeners", async (signal, expected) => {
    const output: string[] = [];
    const deps = makeDeps(output);
    const signals = makeSignalPort();
    let releaseRead: ((result: ReturnType<typeof ok<string>>) => void) | undefined;
    const running = runProductionReplayProcess(
      ["profile"],
      {
        ...deps,
        readText: () => new Promise((resolveRead) => {
          releaseRead = resolveRead;
        }),
      },
      signals,
    );

    signals.emit(signal);
    releaseRead?.(ok(PROFILE));

    await expect(running).resolves.toBe(expected);
    expect(signals.listenerCount()).toBe(0);
  });

  it("removes signal listeners when command dependencies reject unexpectedly", async () => {
    const output: string[] = [];
    const deps = makeDeps(output);
    const signals = makeSignalPort();

    await expect(runProductionReplayProcess(
      ["profile"],
      {
        ...deps,
        readText: async () => Promise.reject(new Error("dependency failed")),
      },
      signals,
    )).rejects.toThrow("dependency failed");
    expect(signals.listenerCount()).toBe(0);
  });
});

function parseRuntimeReportFacts(targetQuarantine = false): Record<string, unknown> {
  return {
    digestSha256: "c".repeat(64),
    entryCount: 120,
    bytes: 409600,
    packageRoot: "/home/comis/.npm-global/lib/node_modules/comisai",
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
    tzdataSha256: "d".repeat(64),
    launcherKind: "systemd",
    applicationLauncherSha256: "e".repeat(64),
    confinementKind: targetQuarantine ? "target_quarantine" : "source",
    confinementSha256: targetQuarantine ? TARGET_REPLAY_QUARANTINE_SHA256 : "none",
    browserStatus: "available",
    browserSha256: "f".repeat(64),
    mediaStatus: "available",
    mediaSha256: "1".repeat(64),
    nativeToolsStatus: "available",
    nativeToolsSha256: "2".repeat(64),
  };
}
