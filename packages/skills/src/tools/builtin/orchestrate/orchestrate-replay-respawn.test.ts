// SPDX-License-Identifier: Apache-2.0
/**
 * macOS-unit tests for `createOrchestrateReplayRespawn` — the sandbox-backed
 * pinned-byte re-spawn seam that the operator `orchestrate.replay` RPC drives.
 * WITHOUT a real spawn (the real bwrap byte-identical round-trip is the
 * `.linux`/VPS tier), these prove the seam's LOGIC:
 *   - the PINNED bytes are loaded from the durable row + re-spawned VERBATIM (the
 *     caller supplies NO script — T-WS4-03);
 *   - INV-1: `buildArgs` binds the SEPARATE replay socket AND the child env's
 *     `COMIS_ORCH_SOCKET`/`COMIS_CAP_LEASE` point at the replay socket + ephemeral
 *     bearer (never the production endpoint), with the secret-named base env scrubbed;
 *   - honest-degrade throws (a missing pinned row / an unavailable jail) — never a
 *     silent unjailed replay.
 * @module
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

import type { ComisLogger, DurableRunRecord } from "@comis/core";
import { ok, type Result } from "@comis/shared";

import { createOrchestrateReplayRespawn } from "./orchestrate-replay-respawn.js";
import { BwrapProvider } from "../sandbox/bwrap-provider.js";
import type { OrchestrateSpawnFn, OrchestrateSpawnedChild } from "./orchestrate-repair.js";
import type { OrchestrateDurableRuns } from "./orchestrate-durable.js";

function makeLogger(): ComisLogger {
  const noop = (): void => {};
  const logger: ComisLogger = {
    level: "silent",
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    audit: noop,
    child: () => logger,
  };
  return logger;
}

/** A fake spawned child that emits a fixed stdout then closes with `exitCode`. */
function makeFakeChild(stdout: string, exitCode = 0, stderr = ""): OrchestrateSpawnedChild {
  const child = new EventEmitter() as unknown as OrchestrateSpawnedChild & EventEmitter;
  const out = new EventEmitter();
  const errStream = new EventEmitter();
  (child as { stdout: EventEmitter }).stdout = out;
  (child as { stderr: EventEmitter }).stderr = errStream;
  (child as { kill: () => void }).kill = () => {};
  setImmediate(() => {
    if (stdout) out.emit("data", Buffer.from(stdout));
    if (stderr) errStream.emit("data", Buffer.from(stderr));
    child.emit("close", exitCode);
  });
  return child;
}

/** A durable-run store whose getByRootRun returns a row with (or without) a scriptRef. */
function makeDurableRuns(scriptRef: string | undefined): OrchestrateDurableRuns {
  return {
    upsertCheckpoint: async () => ok(undefined),
    getByRootRun: async (): Promise<Result<DurableRunRecord | undefined, Error>> =>
      ok(
        scriptRef === undefined
          ? undefined
          : ({
              rootRunId: "orch-x",
              spawnTree: [],
              caps: [],
              leaseIds: [],
              budgetConsumed: 0,
              cronOrigin: null,
              stepIndex: -1,
              status: "running",
              lastHeartbeatAt: 0,
              scriptRef,
            } as DurableRunRecord),
      ),
  };
}

describe("createOrchestrateReplayRespawn", () => {
  let workspacePath: string;
  let sdkAssetsDir: string;
  const replaySocket = "/run/comis/replay-test.sock";
  const PINNED = "console.log('PINNED')";

  beforeEach(() => {
    workspacePath = mkdtempSync(join(tmpdir(), "comis-replay-ws-"));
    // The PINNED script the durable row points at (loadResumeSpec reads it via real fs).
    writeFileSync(join(workspacePath, "orch-x.ts"), PINNED);
    // The SDK-assets fixture dir (the copy loop needs all four).
    sdkAssetsDir = mkdtempSync(join(tmpdir(), "comis-replay-sdk-"));
    writeFileSync(join(sdkAssetsDir, "comis_tools.d.ts"), "// d.ts\n");
    writeFileSync(join(sdkAssetsDir, "comis_tools.js"), "// js\n");
    writeFileSync(join(sdkAssetsDir, "comis_tools.py"), "# py\n");
    writeFileSync(join(sdkAssetsDir, "orchestrate-sdk-runtime.js"), "// runtime\n");
  });

  afterEach(() => {
    rmSync(workspacePath, { recursive: true, force: true });
    rmSync(sdkAssetsDir, { recursive: true, force: true });
  });

  function makeRespawn(over?: {
    spawnFn?: OrchestrateSpawnFn;
    durableRuns?: OrchestrateDurableRuns;
    resolveJailNodeFn?: () => { mode: "path" } | { mode: "bind"; execPath: string } | { mode: "unavailable"; hint: string };
  }) {
    return createOrchestrateReplayRespawn({
      sandbox: new BwrapProvider(),
      durableRuns: over?.durableRuns ?? makeDurableRuns("orch-x.ts"),
      logger: makeLogger(),
      sdkAssetsDir,
      // A base env carrying a SECRET_KEY (must be scrubbed) — the replay socket/bearer
      // ride the caller's childEnv, merged LAST.
      baseEnv: { PATH: "/usr/bin", SECRET_KEY: "must-not-leak" },
      spawnFn: over?.spawnFn ?? ((): OrchestrateSpawnedChild => makeFakeChild("replayed\n")),
      resolveJailNodeFn: over?.resolveJailNodeFn ?? (() => ({ mode: "bind" as const, execPath: "/usr/bin/node" })),
      // The comis-agent CLI surface off (unavailable) so no COMIS_AGENT_BIN is set.
      resolveJailAgentCliFn: () => ({ mode: "unavailable" as const, hint: "test" }),
      loadSeccompFdFn: () => null,
    });
  }

  it("loads + re-spawns the PINNED bytes verbatim (no re-supplied script) and returns stdout", async () => {
    const respawn = makeRespawn();
    const childEnv = { COMIS_ORCH_SOCKET: replaySocket, COMIS_CAP_LEASE: "ephemeral-bearer" };
    const res = await respawn({
      rootRunId: "orch-x",
      workspacePath,
      socketPath: replaySocket,
      bearer: "ephemeral-bearer",
      childEnv,
    });
    expect(res.stdout).toBe("replayed\n");
    // The PINNED bytes were written to the scriptPath and re-run (never re-supplied).
    expect(readFileSync(join(workspacePath, "orch-x.ts"), "utf8")).toBe(PINNED);
  });

  it("INV-1: binds the SEPARATE replay socket + points COMIS_ORCH_SOCKET/COMIS_CAP_LEASE at it, and scrubs the secret-named base env", async () => {
    let capturedArgs: string[] | undefined;
    let capturedEnv: Record<string, string | undefined> | undefined;
    const spawnFn: OrchestrateSpawnFn = (_bin, args, opts) => {
      capturedArgs = args;
      capturedEnv = opts.env;
      return makeFakeChild("x\n");
    };
    const respawn = makeRespawn({ spawnFn });
    await respawn({
      rootRunId: "orch-x",
      workspacePath,
      socketPath: replaySocket,
      bearer: "ephemeral-bearer",
      childEnv: { COMIS_ORCH_SOCKET: replaySocket, COMIS_CAP_LEASE: "ephemeral-bearer" },
    });
    expect(capturedArgs).toBeDefined();
    // Network-isolated + the SEPARATE replay socket bound (never the prod endpoint).
    expect(capturedArgs).toContain("--unshare-net");
    expect(capturedArgs).toContain(replaySocket);
    // The dial env points at the replay socket + the ephemeral bearer (merged LAST).
    expect(capturedEnv?.COMIS_ORCH_SOCKET).toBe(replaySocket);
    expect(capturedEnv?.COMIS_CAP_LEASE).toBe("ephemeral-bearer");
    // The secret-named base key was scrubbed before the merge.
    expect(capturedEnv?.SECRET_KEY).toBeUndefined();
    // The interpreter command runs the pinned scriptRef by name.
    const cmdIdx = capturedArgs!.indexOf("-c");
    expect(capturedArgs![cmdIdx + 1]).toContain("orch-x.ts");
  });

  it("throws (no re-spawn) when the durable run has no pinned script (T-233-14)", async () => {
    const respawn = makeRespawn({ durableRuns: makeDurableRuns(undefined) });
    await expect(
      respawn({ rootRunId: "missing", workspacePath, socketPath: replaySocket, bearer: "eb", childEnv: {} }),
    ).rejects.toThrow();
  });

  it("honest-degrades (throws) when the jail node is unavailable — never a silent unjailed replay", async () => {
    const respawn = makeRespawn({
      resolveJailNodeFn: () => ({ mode: "unavailable" as const, hint: "no node in jail" }),
    });
    await expect(
      respawn({ rootRunId: "orch-x", workspacePath, socketPath: replaySocket, bearer: "eb", childEnv: {} }),
    ).rejects.toThrow();
  });
});
