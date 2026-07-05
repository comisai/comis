// SPDX-License-Identifier: Apache-2.0
/**
 * (Linux/VPS) — the REAL jailed deterministic-replay round-trip for
 * `orchestrate.replay` (REPLAY-02). A green run on the VPS (`pnpm validate:full`)
 * proves, against a REAL `bwrap` jail + a REAL durable row + the REAL separate
 * replay socket (never a mock — CLAUDE.md Root-Cause), that:
 *
 *   - the composition-root re-spawn seam ({@link createOrchestrateReplayRespawn})
 *     re-runs a durable run's PINNED `<runId>.<language>` bytes inside the genuine
 *     jail and returns **byte-identical stdout** (a deterministic pinned script
 *     yields the same bytes on every replay);
 *   - INV-1: the re-spawn's `COMIS_ORCH_SOCKET` points at the SEPARATE operator
 *     replay socket ({@link createOrchestrateReplaySocket}) on its OWN 0600 path —
 *     never the production capability endpoint, so a replay can perform no live
 *     side effect. The richer proof (a recorded cap call served back from
 *     `results/replay.jsonl`) is the operator's manual `comis orchestrate replay`
 *     round-trip in the phase checkpoint.
 *
 * It MUST compile on macOS but the whole describe block SKIPS on non-Linux / when
 * bwrap is unavailable (mirrors `orchestrate-jail.linux.test.ts`), so the macOS
 * `pnpm validate` floor reports it skipped, never failed. DEFERRED: not claimed
 * green until it runs under `pnpm validate:full` on the VPS.
 *
 * @module
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ComisLogger } from "@comis/core";
import { createSqliteDurableRunStore, ensureDurableRunTable } from "@comis/memory";
import { createOrchestrateReplayRespawn, detectSandboxProvider } from "@comis/skills/tools";

import {
  createOrchestrateReplaySocket,
  type OrchestrateReplaySocket,
} from "./orchestrate-replay-socket.js";
import { buildReplayChildEnv } from "./setup-orchestrate-replay.js";

/** Linux + real bwrap gate (mirrors orchestrate-jail.linux.test.ts). */
function canJailRun(): boolean {
  if (process.platform !== "linux") return false;
  const provider = detectSandboxProvider(silentLogger);
  return provider !== undefined && provider.available();
}

const silentLogger: ComisLogger = (() => {
  const noop = (): void => {};
  const l = { level: "silent", trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop, audit: noop } as unknown as ComisLogger;
  (l as unknown as { child: () => ComisLogger }).child = () => l;
  return l;
})();

const jailAvailable = canJailRun();

describe.skipIf(!jailAvailable)("orchestrate.replay real jailed byte-identical round-trip (Linux only)", () => {
  let ws: string;
  let db: unknown;
  let socketPath: string;
  let socket: OrchestrateReplaySocket | undefined;
  const ROOT = "orch-replay-vps-1";
  const SCRIPT_REF = "orch-replay-vps-1.ts";
  // A DETERMINISTIC pinned script (no cap call) — its stdout is byte-identical on
  // every replay, which is the REPLAY-02 property the automated tier proves; the
  // recorded-cap-call serving is the operator's manual round-trip.
  const PINNED = "console.log(JSON.stringify({ ok: true, n: 6 * 7 }))";

  beforeEach(async () => {
    ws = mkdtempSync(join(tmpdir(), "comis-replay-vps-"));
    mkdirSync(join(ws, "results"), { recursive: true });
    // The pinned bytes the replay re-spawns (the sole source — no re-supplied script).
    writeFileSync(join(ws, SCRIPT_REF), PINNED);
    // An empty recorded log — the socket loads + binds cleanly with nothing to serve
    // (this deterministic script makes no cap call). A recorded-call round-trip is
    // the operator's manual `comis orchestrate replay` verify.
    writeFileSync(join(ws, "results", "replay.jsonl"), "");
    // eslint-disable-next-line no-restricted-syntax -- Linux/VPS integration gate.
    const Database = (await import("better-sqlite3")).default;
    db = new Database(":memory:");
    ensureDurableRunTable(db);
    // eslint-disable-next-line no-restricted-syntax -- Linux/VPS integration gate.
    const store = createSqliteDurableRunStore(db as never);
    await store.upsertCheckpoint({
      rootRunId: ROOT, spawnTree: [], caps: [], leaseIds: [], budgetConsumed: 0,
      cronOrigin: null, stepIndex: -1, status: "running", lastHeartbeatAt: Date.now(),
      scriptRef: SCRIPT_REF, checkpointRef: null,
    });
    socketPath = join(ws, "replay.sock");
    socket = createOrchestrateReplaySocket({ workspacePath: ws, logger: silentLogger });
    await socket.start(socketPath);
  });

  afterEach(async () => {
    await socket?.close();
    rmSync(ws, { recursive: true, force: true });
  });

  it("re-spawns the pinned bytes in the real jail → byte-identical stdout, against the SEPARATE replay socket (INV-1)", async () => {
    // eslint-disable-next-line no-restricted-syntax -- Linux/VPS integration gate.
    const store = createSqliteDurableRunStore(db as never);
    const sandbox = detectSandboxProvider(silentLogger)!;
    const respawn = createOrchestrateReplayRespawn({
      sandbox,
      durableRuns: store,
      logger: silentLogger,
      baseEnv: { PATH: process.env.PATH },
    });

    const bearer = "ephemeral-replay-bearer";
    // INV-1: the child dials the SEPARATE replay socket, never the prod endpoint.
    const childEnv = buildReplayChildEnv(socketPath, bearer);
    expect(childEnv.COMIS_ORCH_SOCKET).toBe(socketPath);

    const first = await respawn({ rootRunId: ROOT, workspacePath: ws, socketPath, bearer, childEnv });
    const second = await respawn({ rootRunId: ROOT, workspacePath: ws, socketPath, bearer, childEnv });

    // Deterministic pinned bytes ⇒ byte-identical stdout across replays.
    expect(first.stdout.trim()).toBe(JSON.stringify({ ok: true, n: 42 }));
    expect(second.stdout).toBe(first.stdout);
    // The replay socket is a distinct, operator-only path (never a prod cap socket).
    expect(socketPath).toContain("replay.sock");
  });
});
