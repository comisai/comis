// SPDX-License-Identifier: Apache-2.0
/**
 * Both obs oracles must assemble their IncidentReport through the CLI's
 * store-backed offline adapter, not the daemon reader — the daemon reader alone
 * drops every audit-backed verdict when the daemon is down, which is exactly
 * the state these oracles exist to diagnose.
 *
 * Each case RUNS the script against a fixture code root whose
 * `packages/cli/dist/util/offline-obs.js` records the call it receives, so the
 * assertions are the adapter's observed arguments and the script's emitted
 * report — never the script's source text.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXPLAIN = resolve(HERE, "explain.mjs");
const AUDIT = resolve(HERE, "conversation-audit.mjs");

const created: string[] = [];

afterEach(() => {
  while (created.length > 0) rmSync(created.pop()!, { recursive: true, force: true });
});

interface Rig {
  readonly codeRoot: string;
  readonly dataDir: string;
  readonly callLog: string;
}

/**
 * Build a fixture code root in the SOURCE layout `_rig.mjs` recognizes
 * (`<root>/packages/<pkg>/dist/...`) plus an isolated data dir.
 */
function makeRig(adapterModule: (callLog: string) => string): Rig {
  const root = mkdtempSync(resolve(tmpdir(), "comis-offline-explain-"));
  created.push(root);
  const codeRoot = resolve(root, "code");
  const dataDir = resolve(root, "data");
  const callLog = resolve(root, "adapter-call.json");
  mkdirSync(resolve(codeRoot, "packages/cli/dist/util"), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    resolve(codeRoot, "packages/cli/dist/util/offline-obs.js"),
    adapterModule(callLog),
  );
  return { codeRoot, dataDir, callLog };
}

const RECORDING_ADAPTER = (callLog: string): string => `
import { writeFileSync } from "node:fs";
export async function assembleIncidentReportOffline(dataDir, params) {
  writeFileSync(${JSON.stringify(callLog)}, JSON.stringify({ dataDir, params }));
  return {
    coverage: { trajectory: { records: 7 } },
    outcome: "degraded",
    cost: { costUsd: 0.25 },
    likelyRootCause: "tool_provider_configuration_missing",
    failures: [],
    learning: { hint: "fixture" },
  };
}
`;

const ADAPTER_WITHOUT_EXPORT = (): string => "export const unrelated = 1;\n";

interface RecordedCall {
  readonly dataDir: string;
  readonly params: Record<string, unknown>;
}

function recordedCall(rig: Rig): RecordedCall {
  return JSON.parse(readFileSync(rig.callLog, "utf8")) as RecordedCall;
}

function emittedReport(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>;
}

function runScript(script: string, rig: Rig, args: readonly string[]) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      COMIS_SRC: rig.codeRoot,
      COMIS_DATA_DIR: rig.dataDir,
      RIG_ENV: resolve(rig.codeRoot, "absent-rig.env"),
      NODE_ENV: "production",
    },
  });
}

describe("offline live observability wiring", () => {
  it("explain.mjs assembles through the CLI offline adapter and prints the report", () => {
    const rig = makeRig(RECORDING_ADAPTER);

    const result = runScript(EXPLAIN, rig, ["tenant-a:user-b:chat-c", "full"]);

    expect(result.status).toBe(0);
    const recorded = recordedCall(rig);
    expect(recorded.dataDir).toBe(rig.dataDir);
    expect(recorded.params).toEqual({ sessionKey: "tenant-a:user-b:chat-c", depth: "full" });
    expect(emittedReport(result.stdout)).toMatchObject({
      coverageRecords: 7,
      outcome: "degraded",
      costUsd: 0.25,
      likelyRootCause: "tool_provider_configuration_missing",
    });
  });

  it("explain.mjs fails honestly when the deployed offline adapter is unavailable", () => {
    const rig = makeRig(ADAPTER_WITHOUT_EXPORT);

    const result = runScript(EXPLAIN, rig, ["tenant-a:user-b:chat-c"]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("deployed CLI offline observability adapter is unavailable");
  });

  it("conversation-audit.mjs assembles through the CLI offline adapter", () => {
    const rig = makeRig(RECORDING_ADAPTER);
    const driver = resolve(rig.codeRoot, "drive-audit.mjs");
    writeFileSync(
      driver,
      `import { incidentReportFor } from ${JSON.stringify(AUDIT)};\n`
      + "const report = await incidentReportFor(\"trace-abc\");\n"
      + "console.log(JSON.stringify(report));\n",
    );

    const result = runScript(driver, rig, []);

    expect(result.status).toBe(0);
    const recorded = recordedCall(rig);
    expect(recorded.dataDir).toBe(rig.dataDir);
    expect(recorded.params).toEqual({ traceId: "trace-abc", depth: "full" });
    expect(emittedReport(result.stdout)).toMatchObject({ outcome: "degraded" });
  });

  it("conversation-audit.mjs fails honestly when the deployed offline adapter is unavailable", () => {
    const rig = makeRig(ADAPTER_WITHOUT_EXPORT);
    const driver = resolve(rig.codeRoot, "drive-audit.mjs");
    writeFileSync(
      driver,
      `import { incidentReportFor } from ${JSON.stringify(AUDIT)};\n`
      + "await incidentReportFor(\"trace-abc\");\n",
    );

    const result = runScript(driver, rig, []);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("deployed CLI offline observability adapter is unavailable");
  });
});
