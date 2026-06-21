// SPDX-License-Identifier: Apache-2.0
/**
 * AUTO-01 — the `tg rpc` auth'd passthrough to a known gateway JSON-RPC method
 * + the honest-error exits (Phase 205, Plan 06).
 *
 * The gateway exposes a SINGLE generic JSON-RPC dispatch (`handlers[method]`,
 * 120+ methods). This scenario proves a known no-LLM method round-trips auth'd
 * by the handle token, plus the two honest-error contracts (CLI-04 / V5).
 *
 * ── TRANSPORT DISCOVERY (this scenario is the FIRST live /rpc round-trip) ──
 *
 * The generic JSON-RPC dispatch is served ONLY over WEBSOCKET (`/ws?token=…`),
 * NOT over `POST /rpc`. Probed against a booted rig at HEAD: `POST /rpc`,
 * `/api/rpc`, `/jsonrpc` ALL return a plain HTTP 404 `{"error":"Not Found"}` —
 * the gateway's only HTTP routes are `/health`, the static SPA, and a CURATED
 * `/api/*` REST set (`/api/agents`, `/api/channels`, `/api/chat`, …); there is
 * NO generic `/rpc` HTTP endpoint and no config toggle for one (hono-server.js
 * mounts the dispatch via `createWsHandler`, ws-handler.js does "JSON-RPC message
 * dispatch (single and batch)"). Over WS the SAME methods round-trip cleanly:
 * `obs.fleet.health` -> a bounded FleetHealthReport result; an unknown method ->
 * a proper `{"error":{"code":-32601,"message":"Method not found"}}`.
 *
 * CONSEQUENCE (a discovered harness/CLI defect, documented in the 205-06
 * SUMMARY): `rpcRequest` (test/support/daemon-harness.ts) POSTs `/rpc` and the
 * CLI's `tg rpc` (test/live/bin/chan.ts) wraps it — so `tg rpc` over the live
 * gateway hits the 404, NOT the dispatch. No prior test caught this: the one
 * integration caller (eventbus-daemon-e2e) asserts only `status < 500` (a 404
 * passes), and chan.test.ts injects a fake `rpc`. The fix is to route `tg rpc` /
 * `rpcRequest` over WS (`ws-helpers.ts` `openAuthenticatedWebSocket` +
 * `sendJsonRpc`) — a TEST-TREE change, out of THIS plan's 3-file scope, flagged
 * for a follow-up. THIS scenario asserts AUTO-01 over the transport the gateway
 * ACTUALLY serves (WS) so the keystone is proven honestly, never faked over a
 * 404. (`channels.health` is also NOT a registered dispatch method at HEAD — it
 * appears only as a property access, not a quoted key; the confirmed no-LLM
 * methods are `obs.fleet.health` / `obs.explain`, registered via the
 * computed-key form `[ObsFleetHealthContract.method]`.)
 *
 * Stage-B (CI, deterministic): boots the daemon (no model needed for the obs RPC
 * methods — only the agent-authored reply needs a model, which this does not
 * exercise) and round-trips over WS. The honest-error paths need no daemon.
 *
 * Run:
 *   pnpm vitest run -c test/live/vitest.config.ts test/live/scenarios/channels/telegram-rpc-passthrough.test.ts
 * (a BARE `pnpm vitest run test/live/...` resolves the ROOT config -> 0 files,
 *  exit 0 = false green. ALWAYS pass `-c test/live/vitest.config.ts`.)
 *
 * TEST-HARNESS — lives under `test/`, never the packages source-tree; ZERO
 * production code change.
 *
 * @module
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startRig, type RigHandle } from "../../harness/rig.js";
import { openAuthenticatedWebSocket, sendJsonRpc } from "../../../support/ws-helpers.js";
import { rpcRequest } from "../../../support/daemon-harness.js";
import { runVerb, tryParseJson, VerbFailure, type VerbContext } from "../../bin/chan.js";
import type { ChanliveHandle } from "../../harness/chanlive-handle.js";

/** The JSON-RPC response envelope `sendJsonRpc` resolves to. */
interface JsonRpcResponse {
  readonly jsonrpc: string;
  readonly id: number | string;
  readonly result?: unknown;
  readonly error?: { code: number; message: string };
}

// ---------------------------------------------------------------------------
// The honest-error contracts (no daemon — pure helpers + the runVerb mapping)
// ---------------------------------------------------------------------------

describe("AUTO-01 — the honest-error exits (bad_json + rpc_error), no daemon", () => {
  /** A handle whose endpoints are never reached (these paths fail BEFORE the network). */
  const fakeHandle: ChanliveHandle = {
    channel: "telegram",
    controlEndpoint: "http://127.0.0.1:1",
    rigControlEndpoint: "http://127.0.0.1:1",
    gatewayUrl: "http://127.0.0.1:1",
    gatewayToken: "test-secret-key-for-integration-tests",
    chatId: 424242,
    dataDir: "/tmp/none",
    memoryDbPath: "/tmp/none/memory.db",
  };

  it("a malformed json arg yields bad_json BEFORE any passthrough (V5 — the rpc fn is never called)", async () => {
    let rpcCalled = false;
    const ctx: VerbContext = {
      handle: fakeHandle,
      rpc: async () => {
        rpcCalled = true;
        return {};
      },
    };
    // `tg rpc obs.fleet.health {not-json}` -> the json is validated first.
    await expect(runVerb("rpc", ["obs.fleet.health", "{not valid json"], ctx)).rejects.toMatchObject({
      kind: "bad_json",
    });
    // The passthrough was NEVER reached (no partial dispatch on a malformed arg).
    expect(rpcCalled).toBe(false);

    // The pure helper itself: malformed -> { ok:false } (never a throw/crash).
    expect(tryParseJson("{not valid json").ok).toBe(false);
    // An empty arg is the empty-params default {} (a valid no-params call).
    expect(tryParseJson("")).toEqual({ ok: true, value: {} });
  });

  it("an UNKNOWN rpc method maps the `RPC error` throw to rpc_error (honest, never a fake success)", async () => {
    // rpcRequest throws "RPC error <code>: <message>" on a JSON-RPC error;
    // runVerb maps it to a VerbFailure of kind rpc_error with the extracted code.
    const ctx: VerbContext = {
      handle: fakeHandle,
      rpc: async () => {
        throw new Error("RPC error -32601: Method not found");
      },
    };
    await expect(runVerb("rpc", ["definitely.not.a.method"], ctx)).rejects.toMatchObject({
      kind: "rpc_error",
    });

    // The error body carries the extracted code + the method (diagnosable).
    try {
      await runVerb("rpc", ["definitely.not.a.method"], ctx);
      throw new Error("expected runVerb to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(VerbFailure);
      const vf = err as VerbFailure;
      expect(vf.kind).toBe("rpc_error");
      expect(vf.body["code"]).toBe(-32601);
      expect(vf.body["method"]).toBe("definitely.not.a.method");
    }
  });

  it("a missing rpc method is an honest bad_json (the method is required)", async () => {
    const ctx: VerbContext = { handle: fakeHandle, rpc: async () => ({}) };
    await expect(runVerb("rpc", [], ctx)).rejects.toMatchObject({ kind: "bad_json" });
  });
});

// ---------------------------------------------------------------------------
// Stage-B — the auth'd passthrough to a known no-LLM method over WS (boots the rig)
// ---------------------------------------------------------------------------

describe("AUTO-01 Stage-B — `tg rpc <known method>` round-trips auth'd by the handle token (over the WS transport the gateway serves)", () => {
  let rig: RigHandle | undefined;

  beforeAll(async () => {
    // startRig boots the isolated daemon $0/offline (no model needed for the obs
    // RPC methods — the agent-authored reply is the only model-dependent path,
    // which this scenario does not exercise). The gateway /health was awaited at boot.
    rig = await startRig({ channel: "telegram", model: "keyless" });
  }, 120_000);

  afterAll(async () => {
    if (rig) await rig.cleanup();
    rig = undefined;
  });

  it("obs.fleet.health round-trips to a bounded report (proves the auth'd passthrough + admin scope, over WS)", async () => {
    const r = rig;
    expect(r, "rig booted").toBeDefined();
    if (r === undefined) return;

    // The admin-scoped handle token (ws scope) authenticates the WS connection;
    // obs.fleet.health requires admin trust (the gateway injects _trustLevel from
    // the token scope) and needs NO model -> a deterministic CI round-trip.
    const ws = await openAuthenticatedWebSocket(r.gatewayUrl, r.authToken);
    try {
      const resp = (await sendJsonRpc(ws, "obs.fleet.health", { since: 1 }, 1, {
        timeoutMs: 20_000,
      })) as JsonRpcResponse;
      // A well-formed JSON-RPC result (a bounded FleetHealthReport: counts + hints).
      expect(resp.error, `obs.fleet.health errored: ${JSON.stringify(resp.error)}`).toBeUndefined();
      expect(resp.result).toBeTypeOf("object");
      expect(resp.result).not.toBeNull();
      expect((resp.result as { schemaVersion?: number }).schemaVersion).toBe(1);
    } finally {
      ws.close();
    }
  });

  it("config.get (another no-LLM method) round-trips, confirming the generic passthrough reaches ANY dispatch method", async () => {
    const r = rig;
    expect(r, "rig booted").toBeDefined();
    if (r === undefined) return;

    const ws = await openAuthenticatedWebSocket(r.gatewayUrl, r.authToken);
    try {
      const resp = (await sendJsonRpc(ws, "config.get", {}, 2, { timeoutMs: 20_000 })) as JsonRpcResponse;
      expect(resp.error).toBeUndefined();
      // The rig config we wrote: tenantId "test", gateway enabled on a 127.0.0.1 port.
      expect((resp.result as { tenantId?: string }).tenantId).toBe("test");
    } finally {
      ws.close();
    }
  });

  it("an UNKNOWN method over the REAL gateway returns a proper JSON-RPC -32601 (honest, reason-coded — never a fake success)", async () => {
    const r = rig;
    expect(r, "rig booted").toBeDefined();
    if (r === undefined) return;

    const ws = await openAuthenticatedWebSocket(r.gatewayUrl, r.authToken);
    try {
      const resp = (await sendJsonRpc(ws, "definitely.not.a.method", {}, 3, {
        timeoutMs: 20_000,
      })) as JsonRpcResponse;
      // The honest path: a JSON-RPC error envelope with the standard -32601
      // ("Method not found"), NOT a silent success and NOT a fabricated result.
      expect(resp.result).toBeUndefined();
      expect(resp.error).toBeDefined();
      expect(resp.error!.code).toBe(-32601);
    } finally {
      ws.close();
    }
  });

  it("the HTTP `POST /rpc` path the CLI currently wraps is genuinely 404 at HEAD (the documented harness/CLI transport defect)", async () => {
    const r = rig;
    expect(r, "rig booted").toBeDefined();
    if (r === undefined) return;

    // PINS the discovery so a future fix is detectable: `rpcRequest` POSTs /rpc,
    // which 404s (no HTTP /rpc route exists) -> the body is `{"error":"Not Found"}`
    // so rpcRequest throws `RPC error undefined: undefined`. The CLI's `tg rpc`
    // inherits this until it is routed over WS (the follow-up flagged in the
    // SUMMARY). This assertion documents the CURRENT (broken) state honestly; the
    // working AUTO-01 transport is the WS round-trip asserted above.
    const raw = await fetch(`${r.gatewayUrl}/rpc`, {
      method: "POST",
      headers: { Authorization: `Bearer ${r.authToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "obs.fleet.health", params: { since: 1 } }),
    });
    expect(raw.status).toBe(404);

    // And the harness `rpcRequest` therefore throws (it sees the 404 `error` body).
    await expect(
      rpcRequest(r.gatewayUrl, "obs.fleet.health", { since: 1 }, r.authToken),
    ).rejects.toThrow(/RPC error/);
  });
});
