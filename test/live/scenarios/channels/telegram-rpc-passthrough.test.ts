// SPDX-License-Identifier: Apache-2.0
/**
 * AUTO-01 — the `tg rpc` auth'd passthrough to a known gateway JSON-RPC method
 * + the honest-error exits.
 *
 * The gateway exposes a SINGLE generic JSON-RPC dispatch (`handlers[method]`,
 * 120+ methods). This scenario proves a known no-LLM method round-trips auth'd
 * by the handle token, plus the two honest-error contracts.
 *
 * ── TRANSPORT (this scenario was the FIRST live /rpc round-trip) ──
 *
 * The generic JSON-RPC dispatch is served ONLY over WEBSOCKET (`/ws?token=…`),
 * NOT over `POST /rpc`. Probed against a booted rig at HEAD: `POST /rpc`,
 * `/api/rpc`, `/jsonrpc` ALL return a plain HTTP 404 `{"error":"Not Found"}` —
 * the gateway's only HTTP routes are `/health`, the static SPA, and a CURATED
 * `/api/*` REST set (`/api/agents`, `/api/channels`, `/api/chat`, …); there is
 * NO generic `/rpc` HTTP endpoint and no config toggle for one (hono-server.js
 * mounts the dispatch via `createWsHandler`, ws-handler.js does "JSON-RPC message
 * dispatch (single and batch)"). Over WS the SAME methods round-trip cleanly:
 * `obs.system.health` -> a bounded SystemHealthReport result; an unknown method ->
 * a proper `{"error":{"code":-32601,"message":"Method not found"}}`. This is
 * exactly how the production `comis` CLI talks to the gateway
 * (`packages/cli/src/client/rpc-client.ts` is a WS JSON-RPC client; the
 * `cli-uses-typed-rpc` architecture invariant).
 *
 * RESOLVED (the AUTO-01 transport fix): `rpcRequest`
 * (test/support/daemon-harness.ts) NOW routes over WS via `ws-helpers.ts`
 * (`openAuthenticatedWebSocket` + `sendJsonRpc`), and the CLI's `tg rpc`
 * (test/live/bin/chan.ts) wraps it — so `tg rpc <method>` reaches ANY gateway
 * dispatch method over the transport the gateway actually serves, mirroring
 * `rpc-client.ts`. The keystone discovered the defect (no prior test
 * caught it: the one integration caller, eventbus-daemon-e2e, asserts only an
 * inline `status < 500` — a 404 passes; chan.test.ts injects a fake `rpc`; the
 * three live `rpcRequest` callers are COMIS_LIVE-gated, so the broken `/rpc` leg
 * never ran in CI). THIS scenario now asserts AUTO-01 over WS via the REAL
 * `rpcRequest`/`tg rpc` (not just `sendJsonRpc` directly) so the keystone is
 * proven over the production transport, end to end. The `POST /rpc` 404 is still
 * PINNED below as documentation of WHY WS is the transport — but `rpcRequest`
 * itself now round-trips, never throws on the 404. (`channels.health` is also
 * NOT a registered dispatch method at HEAD — it appears only as a property
 * access, not a quoted key; the confirmed no-LLM methods are `obs.system.health`
 * / `obs.explain`, registered via the computed-key form
 * `[ObsSystemHealthContract.method]`, and the core `config.get`.)
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

  it("a malformed json arg yields bad_json BEFORE any passthrough (the rpc fn is never called)", async () => {
    let rpcCalled = false;
    const ctx: VerbContext = {
      handle: fakeHandle,
      rpc: async () => {
        rpcCalled = true;
        return {};
      },
    };
    // `tg rpc obs.system.health {not-json}` -> the json is validated first.
    await expect(runVerb("rpc", ["obs.system.health", "{not valid json"], ctx)).rejects.toMatchObject({
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

  it("obs.system.health round-trips to a bounded report (proves the auth'd passthrough + admin scope, over WS)", async () => {
    const r = rig;
    expect(r, "rig booted").toBeDefined();
    if (r === undefined) return;

    // The admin-scoped handle token (ws scope) authenticates the WS connection;
    // obs.system.health requires admin trust (the gateway injects _trustLevel from
    // the token scope) and needs NO model -> a deterministic CI round-trip.
    const ws = await openAuthenticatedWebSocket(r.gatewayUrl, r.authToken);
    try {
      const resp = (await sendJsonRpc(ws, "obs.system.health", { since: 1 }, 1, {
        timeoutMs: 20_000,
      })) as JsonRpcResponse;
      // A well-formed JSON-RPC result (a bounded SystemHealthReport: counts + hints).
      expect(resp.error, `obs.system.health errored: ${JSON.stringify(resp.error)}`).toBeUndefined();
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

  it("the shared `rpcRequest` helper ROUND-TRIPS over WS (the AUTO-01 transport, not a /rpc 404)", async () => {
    const r = rig;
    expect(r, "rig booted").toBeDefined();
    if (r === undefined) return;

    // The shared helper is the seam BOTH the CLI (`tg rpc`) and the COMIS_LIVE
    // billing/health callers use. It connects to `/ws?token=` and
    // dispatches the SAME way the production `comis` CLI does — so a known no-LLM
    // method returns its UNWRAPPED result (the `json.result`, not the envelope),
    // never the old `RPC error undefined: undefined` thrown off the 404 body.
    const report = (await rpcRequest(
      r.gatewayUrl,
      "obs.system.health",
      { since: 1 },
      r.authToken,
    )) as { schemaVersion?: number };
    expect(report).toBeTypeOf("object");
    expect(report).not.toBeNull();
    expect(report.schemaVersion).toBe(1);

    // And an unknown method still surfaces the honest JSON-RPC error as a THROW
    // (`RPC error -32601: …`) — the contract `invokeRpc` maps to rpc_error.
    await expect(
      rpcRequest(r.gatewayUrl, "definitely.not.a.method", {}, r.authToken),
    ).rejects.toThrow(/RPC error -32601/);
  });

  it("`tg rpc <known method>` reaches the gateway over WS via the REAL (default) rpc seam, authed by the handle token", async () => {
    const r = rig;
    expect(r, "rig booted").toBeDefined();
    if (r === undefined) return;

    // The CLI path with NO injected `rpc` fake — runVerb falls through to the
    // default `rpcRequest`, which now routes over WS. This is the genuine
    // `tg rpc obs.system.health` an agent/operator runs against a live rig: it must
    // return a real bounded SystemHealthReport, never a 404 throw. The handle the
    // CLI reads carries the admin-scoped gateway token (the `ws`/`admin` scope).
    const handle: ChanliveHandle = {
      channel: "telegram",
      controlEndpoint: r.gatewayUrl, // unused on the rpc path
      rigControlEndpoint: r.gatewayUrl,
      gatewayUrl: r.gatewayUrl,
      gatewayToken: r.authToken,
      chatId: 424242,
      dataDir: "/tmp/none",
      memoryDbPath: "/tmp/none/memory.db",
    };
    const result = (await runVerb("rpc", ["obs.system.health", '{"since":1}'], {
      handle,
    } satisfies VerbContext)) as { schemaVersion?: number };
    expect(result).toBeTypeOf("object");
    expect(result.schemaVersion).toBe(1);
  });

  it("`tg rpc <unknown method>` over the REAL seam exits honestly as rpc_error carrying the -32601 code (no false success)", async () => {
    const r = rig;
    expect(r, "rig booted").toBeDefined();
    if (r === undefined) return;

    const handle: ChanliveHandle = {
      channel: "telegram",
      controlEndpoint: r.gatewayUrl,
      rigControlEndpoint: r.gatewayUrl,
      gatewayUrl: r.gatewayUrl,
      gatewayToken: r.authToken,
      chatId: 424242,
      dataDir: "/tmp/none",
      memoryDbPath: "/tmp/none/memory.db",
    };
    // The default seam connects over WS, the gateway answers -32601, invokeRpc
    // maps the `RPC error -32601` throw to a reason-coded VerbFailure(rpc_error).
    const err = await runVerb("rpc", ["definitely.not.a.method"], { handle }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(VerbFailure);
    expect((err as VerbFailure).kind).toBe("rpc_error");
    expect((err as VerbFailure).body["code"]).toBe(-32601);
  });

  it("`POST /rpc` is STILL 404 at HEAD — pinned as documentation of WHY the transport is WS (the dispatch is ws-only)", async () => {
    const r = rig;
    expect(r, "rig booted").toBeDefined();
    if (r === undefined) return;

    // This pin is RETAINED as the transport-discovery record: the generic
    // dispatch has no HTTP `/rpc` route (it is mounted via createWsHandler on
    // `/ws` only), which is WHY `rpcRequest`/`tg rpc` must — and now do — speak
    // WS. The fix is detectable BOTH ways: this 404 still holds, AND the
    // `rpcRequest` round-trip above proves the helper no longer touches it.
    const raw = await fetch(`${r.gatewayUrl}/rpc`, {
      method: "POST",
      headers: { Authorization: `Bearer ${r.authToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "obs.system.health", params: { since: 1 } }),
    });
    expect(raw.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// A dead handle is an honest non-zero exit — no daemon, no network.
// ---------------------------------------------------------------------------

describe("AUTO-01 — `tg rpc` with NO resolved handle is an honest dead_handle, never a silent spawn", () => {
  it("rpc with no resolved handle throws VerbFailure(dead_handle) BEFORE any transport (it needs the gateway token)", async () => {
    // An empty ctx (handle omitted) is the unresolved-handle case under
    // exactOptionalPropertyTypes — runVerb's `ctx.handle === undefined` guard fires.
    const err = await runVerb("rpc", ["obs.system.health"], {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VerbFailure);
    expect((err as VerbFailure).kind).toBe("dead_handle");
    // The honest hint points at `tg up` — never a silent spawn / fabricated success.
    expect(JSON.stringify((err as VerbFailure).body)).toMatch(/tg up/);
  });
});
