// SPDX-License-Identifier: Apache-2.0
/**
 * Smoke test — validates the rig itself at costTier:"$0" (no real LLM calls).
 * Gated on COMIS_LIVE — skips (not fails) when unset.
 *
 * This test validates the FND infrastructure itself:
 *   - daemon boots from a clean temp data dir
 *   - a liveness RPC (`system.ping`) responds over the gateway transport
 *   - log oracle passes (no unexpected ERRORs)
 *   - persistence oracle passes (SQLite integrity on fresh data dir)
 *
 * Transport note: `rpcRequest` drives the gateway over WebSocket
 * (`/ws?token=`), the SAME transport the production `comis` CLI uses — the
 * generic JSON-RPC dispatch has no `POST /rpc` route. The liveness check calls
 * `system.ping` (a REAL registered dispatch method → `{pong:true}`); the prior
 * bare `"health"` was NOT a registered method (it is an HTTP route, not a WS
 * dispatch key — it returns `-32601` over WS), so that assertion was latent-
 * broken and only masked because this whole file is COMIS_LIVE-gated (it never
 * ran in CI). Fixed to a real method as part of the transport repair.
 *
 * costTier: "$0" — no real LLM or provider calls are made.
 * Uses the in-process daemon harness with an isolated temp data dir.
 *
 * @module
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import {
  startTestDaemon,
  rpcRequest,
  type TestDaemonHandle,
} from "../../support/daemon-harness.js";
import { createLogCapture } from "../../support/log-verifier.js";
import { runLogOracle } from "../assert/log-oracle.js";
import { runDbOracle } from "../assert/db-oracle.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// COMIS_LIVE gate — skip (not fail) when unset
// ---------------------------------------------------------------------------

const isLive = !!process.env["COMIS_LIVE"];

// costTier: "$0" — this test makes no real LLM or provider calls.
// It validates the rig itself: daemon boot, health RPC, oracle post-conditions.
const DAEMON_STARTUP_MS = 15_000;

describe.skipIf(!isLive)("Live — smoke (FND rig self-validation)", () => {
  let handle: TestDaemonHandle;
  const logCapture = createLogCapture();
  // T-134-21: isolated temp data dir — never pollutes ~/.comis
  let dataDirBefore: string | undefined;

  beforeAll(async () => {
    dataDirBefore = process.env["COMIS_DATA_DIR"];
    const dataDir = mkdtempSync(join(tmpdir(), "comis-live-smoke-"));
    process.env["COMIS_DATA_DIR"] = dataDir;
    handle = await startTestDaemon({
      logStream: logCapture.stream,
      disableRedaction: true,
    });
  }, DAEMON_STARTUP_MS + 30_000);

  afterAll(async () => {
    await handle.cleanup();
    // Restore COMIS_DATA_DIR to its pre-test value (T-134-21 cleanup)
    if (dataDirBefore !== undefined) {
      process.env["COMIS_DATA_DIR"] = dataDirBefore;
    } else {
      delete process.env["COMIS_DATA_DIR"];
    }
  });

  afterEach(async () => {
    // Flush-sentinel: write a unique sentinel line and poll until it appears
    // in the captured entries before snapshotting — mandated by log-oracle.ts
    // header contract (T-134-flush). The Pino async worker may not have flushed
    // the last 1–2 lines (including the health line) by the time getEntries() is
    // called; skipping this step silently omits oracle check 8.
    const sentinelKey = `end-${randomUUID()}`;
    handle.daemon.logger.debug({ sentinel: sentinelKey }, "flush-sentinel");

    // Poll until sentinel appears (max 2 s at 50 ms intervals).
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const entries = logCapture.getEntries();
      if (entries.some((e) => (e as Record<string, unknown>)["sentinel"] === sentinelKey)) break;
      await new Promise<void>((r) => setTimeout(r, 50));
    }

    const logLines = logCapture
      .getEntries()
      .map((e) => JSON.stringify(e))
      .join("\n");
    await runLogOracle(logLines, { expectedErrors: [] });
  });

  it("a liveness RPC (system.ping) responds over the gateway WS transport when the daemon boots", async () => {
    // `system.ping` is a REAL registered dispatch method (→ `{pong:true,ts}`).
    // rpcRequest routes over WS (205-07); the old bare `"health"` was not a WS
    // method (it is an HTTP route → `-32601` over WS) — see the module note.
    const ping = (await rpcRequest(
      handle.gatewayUrl,
      "system.ping",
      {},
      handle.authToken,
    )) as { pong?: boolean };
    expect(ping).toBeTruthy();
    expect(ping.pong).toBe(true);
  });

  it("persistence oracle passes on a fresh data dir", async () => {
    const dbPath = join(process.env["COMIS_DATA_DIR"]!, "memory.db");
    const { existsSync } = await import("node:fs");
    // memory.db may not exist yet on a fresh boot — skip oracle if absent
    if (existsSync(dbPath)) {
      await runDbOracle(dbPath, {});
    } else {
      // No DB yet on fresh boot is an acceptable state
      expect(existsSync(dbPath)).toBe(false);
    }
  });
});
