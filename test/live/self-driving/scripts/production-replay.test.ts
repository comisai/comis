import { createHash } from "node:crypto";

import { err, ok } from "@comis/shared";
import { describe, expect, it } from "vitest";

import {
  runProductionReplayCli,
  type ProductionReplayCliDeps,
} from "./production-replay.js";
import { TARGET_REPLAY_QUARANTINE_SHA256 } from "./production-bootstrap.js";
import {
  EVIDENCE_FACTS_BEGIN,
  EVIDENCE_FACTS_END,
  PRODUCTION_EVIDENCE_IDS,
} from "./production-evidence.js";
import { RUNTIME_FACTS_BEGIN, RUNTIME_FACTS_END } from "./production-runtime.js";
import {
  MESSAGES_ATTESTATION_BEGIN,
  MESSAGES_ATTESTATION_END,
} from "./production-messages.js";
import { buildReplayQuarantineOverlay } from "./production-quarantine.js";
import {
  deriveProductionSnapshotDataTreeIdentity,
  deriveProductionSnapshotEnvironmentEvidenceIdentity,
  type ProductionSnapshotManifest,
} from "./production-snapshot.js";

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

function snapshotManifest(): string {
  const metadata = { uid: 1001, gid: 1001, mtimeNs: "1752560000123456789" } as const;
  const value: ProductionSnapshotManifest = {
    schemaVersion: 1,
    runId: "state-cli-a1",
    sourceMachineIdSha256: "a".repeat(64),
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
    entries: [
      { path: "data", type: "directory", mode: "0700", size: 0, ...metadata },
      {
        path: "data/memory.db",
        type: "file",
        mode: "0600",
        size: 4096,
        sha256: "c".repeat(64),
        ...metadata,
      },
      { path: "system", type: "directory", mode: "0700", size: 0, uid: 0, gid: 0, mtimeNs: metadata.mtimeNs },
      { path: "system/etc", type: "directory", mode: "0755", size: 0, uid: 0, gid: 0, mtimeNs: metadata.mtimeNs },
      { path: "system/etc/comis", type: "directory", mode: "0755", size: 0, uid: 0, gid: 0, mtimeNs: metadata.mtimeNs },
      {
        path: "system/etc/comis/env",
        type: "file",
        mode: "0640",
        size: 200,
        sha256: "d".repeat(64),
        uid: 0,
        gid: 1001,
        mtimeNs: metadata.mtimeNs,
      },
    ],
    exclusions: [],
  };
  return JSON.stringify({
    ...value,
    dataTreeIdentitySha256: deriveProductionSnapshotDataTreeIdentity(value),
    sourceEnvironmentEvidenceIdentitySha256:
      deriveProductionSnapshotEnvironmentEvidenceIdentity(value),
  });
}

function restoreAttestation(manifestJson: string): string {
  const captured = JSON.parse(manifestJson) as ProductionSnapshotManifest;
  const overlay = buildReplayQuarantineOverlay(["default"]);
  if (!overlay.ok) throw new Error("overlay fixture invalid");
  return `${JSON.stringify({
    schemaVersion: 1,
    state: "committed",
    runId: captured.runId,
    targetMachineIdSha256: "b".repeat(64),
    baselineImmutable: true,
    dataDirSha256: createHash("sha256")
      .update("comis-replay-data-dir-v1\0")
      .update("/home/comis/.comis")
      .digest("hex"),
    snapshotManifestSha256: createHash("sha256").update(manifestJson).digest("hex"),
    restoredDataTreeDigestSha256: captured.dataTreeIdentitySha256,
    sourceEnvironmentEvidenceIdentitySha256:
      captured.sourceEnvironmentEvidenceIdentitySha256,
    effectiveEnvironmentContentSha256: "e".repeat(64),
    replayOverlayContentSha256: createHash("sha256").update(overlay.value).digest("hex"),
    dataEntryCount: captured.entries.filter(
      ({ path }) => path === "data" || path.startsWith("data/"),
    ).length,
    dataBytes: captured.entries.reduce(
      (total, entry) =>
        total +
        (entry.type === "file" && entry.path.startsWith("data/") ? entry.size : 0),
      0,
    ),
  })}\n`;
}

function restoreStatus(
  state: "promoting" | "authorized" | "finalized" | "rolled_back",
  manifestJson = snapshotManifest(),
): string {
  const attestationRaw =
    state === "authorized" || state === "finalized"
      ? restoreAttestation(manifestJson)
      : null;
  return `${JSON.stringify({
    schemaVersion: 1,
    runId: "state-cli-a1",
    targetMachineIdSha256: "b".repeat(64),
    state,
    bytesTransferred: state === "rolled_back" ? null : 500_000,
    restoreAttestationBase64:
      attestationRaw === null ? null : Buffer.from(attestationRaw).toString("base64"),
    restoreAttestationSha256:
      attestationRaw === null
        ? null
        : createHash("sha256").update(attestationRaw).digest("hex"),
  })}\n`;
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
    binaryBridge: {
      transfer: async () =>
        err({ kind: "remote_failure", message: "binary transfer was not expected" }),
    },
    writeOutput: (line) => output.push(line),
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

  it("returns a committed exact source artifact after transactional streaming", async () => {
    const output: string[] = [];
    const labels: string[] = [];
    let targetProbeCount = 0;
    const deps = makeDeps(output);

    const exitCode = await runProductionReplayCli(
      ["clone-runtime", "--run-id", "runtime-cli-a1"],
      {
        ...deps,
        executor: {
          run: async (invocation) => {
            labels.push(invocation.label);
            if (invocation.label === "runtime-attest-source") {
              return ok({ stdout: runtimeFacts("c".repeat(64)), exitCode: 0 });
            }
            if (invocation.label === "runtime-attest-target") {
              targetProbeCount += 1;
              return ok({
                stdout: runtimeFacts(
                  targetProbeCount === 1 ? "d".repeat(64) : "c".repeat(64),
                  true,
                ),
                exitCode: 0,
              });
            }
            return ok({ stdout: "", exitCode: 0 });
          },
        },
        binaryBridge: {
          transfer: async (request) => {
            expect(request.source).toMatchObject({ host: "comis-harel", port: 2222 });
            expect(request.target).toMatchObject({ host: "comis-test2", port: 2202 });
            return ok({ bytesTransferred: 500_000 });
          },
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(labels).toContain("promote-runtime-target");
    expect(labels.at(-1)).toBe("commit-runtime-target");
    expect(JSON.parse(output.join("\n"))).toEqual({
      ok: true,
      report: {
        changed: true,
        bytesTransferred: 500_000,
        digestSha256: "c".repeat(64),
      },
    });
  });

  it("returns a committed full state clone without rendering captured content", async () => {
    const output: string[] = [];
    const labels: string[] = [];
    const deps = makeDeps(output);

    const exitCode = await runProductionReplayCli(
      [
        "clone-state",
        "--run-id",
        "state-cli-a1",
        "--capture-mode",
        "offline",
        "--agent-id",
        "default",
      ],
      {
        ...deps,
        executor: {
          run: async (invocation) => {
            labels.push(invocation.label);
            if (invocation.label === "read-snapshot-manifest-source") {
              return ok({ stdout: snapshotManifest(), exitCode: 0 });
            }
            if (invocation.label === "read-promoted-snapshot-attestation") {
              return ok({ stdout: restoreAttestation(snapshotManifest()), exitCode: 0 });
            }
            return ok({ stdout: "", exitCode: 0 });
          },
        },
        binaryBridge: {
          transfer: async () => ok({ bytesTransferred: 500_000 }),
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(labels).toContain("capture-snapshot-source");
    expect(labels).toContain("verify-and-promote-snapshot-target");
    expect(labels.at(-1)).toBe("finalize-snapshot-target");
    expect(JSON.parse(output.join("\n"))).toMatchObject({
      ok: true,
      report: {
        state: "committed",
        runId: "state-cli-a1",
        captureMode: "offline",
        bytesTransferred: 500_000,
        entries: 6,
        exclusions: 0,
        dataTreeIdentitySha256: deriveProductionSnapshotDataTreeIdentity(
          JSON.parse(snapshotManifest()) as ProductionSnapshotManifest,
        ),
        sourceEnvironmentEvidenceIdentitySha256:
          deriveProductionSnapshotEnvironmentEvidenceIdentity(
            JSON.parse(snapshotManifest()) as ProductionSnapshotManifest,
          ),
        environmentConfiguration: "source_plus_replay_overlay",
        dataFileContentBytes: 4096,
        metadataIdentity: {
          fidelity: "gapped",
          acl: "unavailable",
          xattr: "unavailable",
          capability: "unavailable",
          gapKinds: ["acl", "xattr", "capability"],
        },
      },
    });
    expect(output.join("\n")).not.toContain("memory.db");
    expect(output.join("\n")).not.toContain("COMIS_CONFIG_PATHS");
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

  it("recovers an interrupted state promotion through explicit controller commands", async () => {
    const output: string[] = [];
    const labels: string[] = [];
    let statusReads = 0;
    const deps = makeDeps(output);

    const exitCode = await runProductionReplayCli(
      ["restore-rollback", "--run-id", "state-cli-a1"],
      {
        ...deps,
        executor: {
          run: async (invocation) => {
            labels.push(invocation.label);
            if (invocation.label === "inspect-snapshot-target") {
              statusReads += 1;
              return ok({
                stdout: restoreStatus(statusReads === 1 ? "promoting" : "rolled_back"),
                exitCode: 0,
              });
            }
            return ok({ stdout: "", exitCode: 0 });
          },
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(labels).toEqual([
      "inspect-snapshot-target",
      "rollback-snapshot-target",
      "inspect-snapshot-target",
    ]);
    expect(JSON.parse(output.join("\n"))).toMatchObject({
      ok: true,
      report: { runId: "state-cli-a1", state: "rolled_back" },
    });
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
