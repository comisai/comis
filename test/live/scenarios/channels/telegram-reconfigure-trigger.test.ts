// SPDX-License-Identifier: Apache-2.0
/**
 * AUTO-04 — `tg reconfigure` (rewrite the throwaway config + restart — the
 * model sweep) + `tg trigger cron/heartbeat/wake` (fire the real
 * time-based RPCs NOW over WS, no real-time wait), proven end-to-end.
 *
 * These are the autonomy enablers the ACCEPT-01 loop needs: a
 * clean-slate-with-a-pinned-model (reconfigure) and firing the time-based UCs
 * immediately (trigger), so an unattended agent never waits on a wall clock or
 * hand-rewrites a config. The building blocks all exist at HEAD — this scenario
 * wires + proves them:
 *   • trigger → the gateway RPCs the daemon registers: `cron.run`
 *     (cron-handlers.ts), `heartbeat.trigger` (heartbeat-handlers.ts),
 *     `scheduler.wake` (cron-handlers.ts) — driven over the SAME WS `rpcRequest`
 *     the production `comis` CLI uses, NEVER `POST
 *     /rpc` (404 at HEAD — the dispatch is ws-only).
 *   • reconfigure → `RigController.reconfigure(overrides)` rewrites the isolated
 *     YAML via `buildConfigYaml` then `restart()` (the cleanup-before-reboot
 *     ordering, same gateway port).
 *
 * ── THE CI vs COMIS_LIVE SPLIT ──
 *
 *   • Stage-B (ALWAYS runs, in-process, NO COMIS_LIVE, NO real model): the
 *     deterministic proofs that need no daemon — (1) the reconfigure rewrite
 *     STRUCTURE: `buildConfigYaml(apiRoot, port, <new>)` produces a YAML that
 *     names the NEW model (the model sweep) while keeping the exact telegram
 *     schema keys + the ≥32-char literal gateway token; (2) the `tg trigger`
 *     RPC WIRING: each sub-target maps to the right registered method
 *     (`cron.run`/`heartbeat.trigger`/`scheduler.wake`) over an injected rpc
 *     seam; (3) the honest-error legs (a missing/unknown sub-target → bad_json;
 *     an RPC error → rpc_error) — the `telegram-rpc-passthrough.test.ts`
 *     contracts; (4) the SEC-02 never-published re-verify + the zero-product-
 *     change git-porcelain guard.
 *
 *   • Stage-C (describe.skipIf(!isLive), COMIS_LIVE) boots a REAL isolated rig
 *     and drives the REAL WS `rpcRequest`: `scheduler.wake {}` → `{ woke: true }`;
 *     `cron.run { mode: "due" }` → `{ triggered: true }` (force needs a registered
 *     job — "due" runs missed jobs with none, the no-job-needed non-error result);
 *     `tg trigger wake` over the DEFAULT seam round-trips. The reconfigure leg:
 *     `controller.reconfigure({ "agents.default.model": <new> })` rewrites the
 *     on-disk config (it now names the new model) and the daemon re-boots on the
 *     SAME gateway port (the rewrite+restart STRUCTURE). NO-FALSE-SUCCESS:
 *     an honest `rpc_error` (e.g. `tg trigger cron <unregistered>` → "Job not
 *     found") proves the handler is REACHED and fails honestly — never a faked
 *     success.
 *
 * Run:
 *   CI (Stage-B only, offline, deterministic):
 *     pnpm vitest run -c test/live/vitest.config.ts test/live/scenarios/channels/telegram-reconfigure-trigger.test.ts
 *   Stage-C (the live trigger RPCs + the reconfigure rewrite+restart, operator):
 *     COMIS_LIVE=1 pnpm vitest run -c test/live/vitest.config.ts test/live/scenarios/channels/telegram-reconfigure-trigger.test.ts
 *
 * (NB: a BARE `pnpm vitest run test/live/...` resolves the ROOT config, whose
 *  projects exclude test/live -> 0 files, exit 0 = false green. ALWAYS pass
 *  `-c test/live/vitest.config.ts`.)
 *
 * TEST-HARNESS — lives under `test/`, never the packages source-tree; ZERO
 * production code change.
 *
 * @module
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative, sep } from "node:path";
import { buildConfigYaml } from "../../harness/rig.js";
import { runVerb, VerbFailure, type VerbContext } from "../../bin/chan.js";
import { rpcRequest } from "../../../support/daemon-harness.js";
import type { ChanliveHandle } from "../../harness/chanlive-handle.js";
import type { BuiltRig } from "../../harness/rig.js";

const isLive = !!process.env["COMIS_LIVE"];

/** A handle whose endpoints are never reached on the offline (no-daemon) legs. */
function fakeHandle(over: Partial<ChanliveHandle> = {}): ChanliveHandle {
  return {
    channel: "telegram",
    controlEndpoint: "http://127.0.0.1:1",
    rigControlEndpoint: "http://127.0.0.1:1",
    gatewayUrl: "http://127.0.0.1:1",
    gatewayToken: "test-token-0000000000000000000000000000",
    chatId: 424242,
    dataDir: "/tmp/none",
    memoryDbPath: "/tmp/none/memory.db",
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Stage-B — the reconfigure rewrite STRUCTURE (the model sweep), no daemon
// ---------------------------------------------------------------------------

describe("AUTO-04 Stage-B — reconfigure rewrites the throwaway config to name a NEW model (the model sweep)", () => {
  it("buildConfigYaml(apiRoot, port, <new>) produces a config that NAMES the new model + keeps the telegram seam + the ≥32-char literal token", () => {
    const apiRoot = "http://127.0.0.1:54321";
    const gatewayPort = 4766;
    const newModel = "qwen3.6:14b";
    // This is EXACTLY the rewrite reconfigure({"agents.default.model": <new>})
    // performs (rig.ts wires configYamlFor to call buildConfigYaml with the new
    // model) — assert the produced YAML names the NEW model (the model sweep).
    const yaml = buildConfigYaml(apiRoot, gatewayPort, newModel);

    // The reconfigured config names the new model (agents.default.model + the
    // provider model id + models.defaultModel all carry it) — the sweep landed.
    expect(yaml).toContain(newModel);
    expect(yaml).toMatch(/model:\s*"qwen3\.6:14b"/);
    // It keeps the exact telegram schema keys (the redirect seam) + the gateway
    // port — reconfigure mutates ONLY the model, never the rig's wiring.
    expect(yaml).toContain("apiRoot:");
    expect(yaml).toContain(apiRoot);
    expect(yaml).toContain(`port: ${gatewayPort}`);
    // The ≥32-char LITERAL gateway token (env-refs don't resolve for the test
    // gateway — schema-gateway.ts z.string().min(32)). Assert a >=32-char secret.
    const secretMatch = /secret:\s*"([^"]+)"/.exec(yaml);
    expect(secretMatch, "gateway secret present").not.toBeNull();
    expect((secretMatch?.[1] ?? "").length).toBeGreaterThanOrEqual(32);
  });

  it("a reconfigure to a DIFFERENT model no longer names the prior model (the sweep actually replaced it)", () => {
    const oldYaml = buildConfigYaml("http://127.0.0.1:1", 1, "qwen3.6:35b");
    const newYaml = buildConfigYaml("http://127.0.0.1:1", 1, "llama3.2:3b");
    expect(oldYaml).toContain("qwen3.6:35b");
    // The rewritten config names the NEW model and not the OLD one — proving a
    // reconfigure swap is a real replacement, not an append (no-false-success).
    expect(newYaml).toContain("llama3.2:3b");
    expect(newYaml).not.toContain("qwen3.6:35b");
  });
});

// ---------------------------------------------------------------------------
// Stage-B — tg trigger maps each sub-target to the registered RPC over the WS
// seam (cron.run / heartbeat.trigger / scheduler.wake), no daemon.
// ---------------------------------------------------------------------------

describe("AUTO-04 Stage-B — `tg trigger` fires the real time-based RPCs over the WS seam (no real-time wait)", () => {
  it("`tg trigger cron <id>` invokes cron.run { jobName } VERBATIM over the rpc seam", async () => {
    const rpc = vi.fn().mockResolvedValue({ triggered: true, mode: "force", jobName: "nvda-scan" });
    const result = await runVerb("trigger", ["cron", "nvda-scan"], { handle: fakeHandle(), rpc });
    expect(rpc).toHaveBeenCalledWith(
      "http://127.0.0.1:1",
      "cron.run",
      { jobName: "nvda-scan" },
      "test-token-0000000000000000000000000000",
    );
    expect(result).toMatchObject({ triggered: true });
  });

  it("`tg trigger heartbeat` invokes heartbeat.trigger over the rpc seam", async () => {
    const rpc = vi.fn().mockResolvedValue({ agentId: "default", triggered: true });
    await runVerb("trigger", ["heartbeat"], { handle: fakeHandle(), rpc });
    expect(rpc).toHaveBeenCalledWith("http://127.0.0.1:1", "heartbeat.trigger", {}, expect.any(String));
  });

  it("`tg trigger wake` invokes scheduler.wake {} over the rpc seam", async () => {
    const rpc = vi.fn().mockResolvedValue({ woke: true, source: "agent" });
    await runVerb("trigger", ["wake"], { handle: fakeHandle(), rpc });
    expect(rpc).toHaveBeenCalledWith("http://127.0.0.1:1", "scheduler.wake", {}, expect.any(String));
  });
});

// ---------------------------------------------------------------------------
// Stage-B — the honest-error contracts — no daemon.
// (Reuses the telegram-rpc-passthrough.test.ts rpc_error/bad_json contracts.)
// ---------------------------------------------------------------------------

describe("AUTO-04 Stage-B — the honest-error legs (bad_json + rpc_error), no daemon", () => {
  it("`tg trigger` with no sub-target is an honest bad_json (non-zero), the rpc fn NEVER reached", async () => {
    let rpcCalled = false;
    const ctx: VerbContext = {
      handle: fakeHandle(),
      rpc: async () => {
        rpcCalled = true;
        return {};
      },
    };
    await expect(runVerb("trigger", [], ctx)).rejects.toMatchObject({ kind: "bad_json" });
    expect(rpcCalled).toBe(false);
  });

  it("`tg trigger cron` with no job id is an honest bad_json (force-mode resolves by name)", async () => {
    const rpc = vi.fn();
    await expect(runVerb("trigger", ["cron"], { handle: fakeHandle(), rpc })).rejects.toMatchObject({
      kind: "bad_json",
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("a trigger RPC error (e.g. an unknown/unregistered job) maps to a reason-coded rpc_error carrying the code", async () => {
    // rpcRequest throws "RPC error <code>: <message>" on a JSON-RPC error; the
    // trigger verb (via invokeRpc) maps it to a VerbFailure(rpc_error) — the
    // telegram-rpc-passthrough honest-error contract, never a fake success.
    const rpc = vi.fn().mockRejectedValue(new Error("RPC error -32602: Job not found: nope"));
    const err = await runVerb("trigger", ["cron", "nope"], { handle: fakeHandle(), rpc }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(VerbFailure);
    expect((err as VerbFailure).kind).toBe("rpc_error");
    expect((err as VerbFailure).body["code"]).toBe(-32602);
  });

  it("`tg trigger wake` with NO resolved handle is an honest dead_handle (needs the gateway token), never a silent spawn", async () => {
    const err = await runVerb("trigger", ["wake"], {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VerbFailure);
    expect((err as VerbFailure).kind).toBe("dead_handle");
  });
});

// ---------------------------------------------------------------------------
// Stage-B — SEC-02 re-verify + zero production code change
// ---------------------------------------------------------------------------

describe("AUTO-04 Stage-B — the never-published guard re-verifies + the phase diff is test/-only (zero production code change)", () => {
  it("the SEC-02 never-published invariant holds: no chan/tg comis subcommand + no package.json under test/live", () => {
    // Re-verify the two SEC-02 dimensions a NEW scenario file could plausibly
    // regress, asserted DIRECTLY (no nested-vitest subprocess): the published CLI
    // registers no chan/tg subcommand, and no package.json lives under test/live/**.
    const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf-8" }).trim();

    // Dimension 3 — the published comis CLI registers no `chan`/`tg` subcommand
    // (trigger/reconfigure are `chan`/`tg` dev entries, NOT comis subcommands).
    const cliSource = readFileSync(resolve(repoRoot, "packages/cli/src/cli.ts"), "utf8");
    for (const name of ["chan", "tg"] as const) {
      expect(
        new RegExp(String.raw`\.command\(\s*["'\`]${name}\b`).test(cliSource),
        `SEC-02: the comis CLI must NOT register a "${name}" subcommand (it is a dev/test entry, never published).`,
      ).toBe(false);
    }

    // Dimension 1 — no package.json under test/live/** (a workspace member there
    // would make a fake channel server publishable).
    const liveRoot = resolve(repoRoot, "test/live");
    const offendingPkgJson: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        if (entry === "node_modules") continue;
        const abs = join(dir, entry);
        if (statSync(abs).isDirectory()) walk(abs);
        else if (entry === "package.json") offendingPkgJson.push(relative(repoRoot, abs).split(sep).join("/"));
      }
    };
    walk(liveRoot);
    expect(
      offendingPkgJson,
      `SEC-02: no package.json may live under test/live/** — found: ${offendingPkgJson.join(", ")}`,
    ).toEqual([]);
  });

  it("git status --porcelain shows NO packages source change (the milestone premise)", () => {
    // AUTO-04 drives the already-wired gateway RPCs (cron.run/heartbeat.trigger/
    // scheduler.wake) + the rig-control reconfigure (test infra) with NO product
    // edit. If this fails, a product file was touched — STOP.
    const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf-8" }).trim();
    const porcelain = execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf-8" });
    const offending = porcelain
      .split("\n")
      .map((line) => line.slice(3).trim())
      .filter((p) => p.length > 0)
      .flatMap((p) => (p.includes(" -> ") ? p.split(" -> ") : [p]))
      .filter((p) => /(^|\/)packages\/[^/]+\/src\//.test(p));
    expect(offending, `production source changed: ${offending.join(", ")}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Stage-C — the live trigger RPCs over WS + the reconfigure rewrite+restart
// (COMIS_LIVE; boots a real isolated rig).
// ---------------------------------------------------------------------------

describe.skipIf(!isLive)("AUTO-04 Stage-C — the live trigger RPCs + the reconfigure rewrite+restart (COMIS_LIVE)", () => {
  let built: BuiltRig | undefined;

  beforeAll(async () => {
    const { buildRig } = await import("../../harness/rig.js");
    // $0/offline keyless boot — the trigger RPCs (wake / cron.run due / heartbeat)
    // need NO model; the reconfigure leg only re-boots, it does not author a reply.
    built = await buildRig({ channel: "telegram", model: "keyless" });
  }, 180_000);

  afterAll(async () => {
    if (built) await built.cleanup();
    built = undefined;
  });

  it("scheduler.wake fires NOW over the REAL WS rpcRequest → { woke: true } (no real-time wait)", async () => {
    const r = built;
    expect(r, "rig booted").toBeDefined();
    if (r === undefined) return;
    // scheduler.wake needs no job/agent/model — the cleanest immediate-fire proof.
    const woke = (await rpcRequest(r.gatewayUrl, "scheduler.wake", {}, r.authToken)) as {
      woke?: boolean;
    };
    expect(woke.woke).toBe(true);
  });

  it("cron.run { mode: 'due' } fires NOW over WS → { triggered: true } (runs missed jobs, no registered job needed)", async () => {
    const r = built;
    expect(r, "rig booted").toBeDefined();
    if (r === undefined) return;
    // Force mode resolves a job BY NAME ("Job not found" with none); "due" runs all
    // missed jobs and needs no jobName — the no-job-needed non-error result.
    const ran = (await rpcRequest(r.gatewayUrl, "cron.run", { mode: "due" }, r.authToken)) as {
      triggered?: boolean;
    };
    expect(ran.triggered).toBe(true);
  });

  it("`tg trigger wake` over the DEFAULT (real) WS seam round-trips to { woke: true }", async () => {
    const r = built;
    expect(r, "rig booted").toBeDefined();
    if (r === undefined) return;
    // The genuine CLI path with NO injected rpc — runVerb falls through to the
    // default rpcRequest, which routes over WS. This is exactly the
    // `tg trigger wake` an agent runs against a live rig.
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
    const result = (await runVerb("trigger", ["wake"], { handle } satisfies VerbContext)) as {
      woke?: boolean;
    };
    expect(result.woke).toBe(true);
  });

  it("`tg trigger cron <unregistered>` over the REAL seam is an honest rpc_error (the handler is REACHED, fails honestly — no false success)", async () => {
    const r = built;
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
    // A keyless rig registers no cron jobs → force-mode cron.run honestly errors
    // ("Job not found"). The verb surfaces it as rpc_error — proof the RPC was
    // dispatched and failed honestly (NEVER a faked success on a missing job).
    const err = await runVerb("trigger", ["cron", "definitely-not-a-job"], { handle }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(VerbFailure);
    expect((err as VerbFailure).kind).toBe("rpc_error");
  });

  it("reconfigure rewrites the on-disk config to name a NEW model AND re-boots on the SAME gateway port (the rewrite+restart structure)", async () => {
    const r = built;
    expect(r, "rig booted").toBeDefined();
    if (r === undefined) return;

    const { createRigController } = await import("../../harness/rig-control.js");
    const controller = createRigController({
      emulator: r.emulator,
      daemonHandle: r.daemonHandle,
      dataDir: r.dataDir,
      configPath: r.configPath,
      gatewayPort: r.gatewayPort,
      gatewayUrl: r.gatewayUrl,
      chat: r.chat,
      memoryDbPath: r.memoryDbPath,
      onDaemonHandle: r.rebindDaemonHandle,
      // The same override→YAML mapping startStandaloneRig wires (close over
      // buildConfigYaml + the rig's apiRoot + gatewayPort).
      configYamlFor: (overrides) =>
        buildConfigYaml(
          r.controlEndpoint,
          r.gatewayPort,
          overrides["agents.default.model"] ?? "keyless",
        ),
    });

    const gatewayUrl = controller.gatewayUrl;
    // First /health is green (boot already awaited it).
    expect((await fetch(`${gatewayUrl}/health`)).ok).toBe(true);

    // The model sweep: rewrite the config to a new model, then re-boot.
    const newModel = "qwen3.6:14b";
    await controller.reconfigure({ "agents.default.model": newModel });

    // The on-disk config now NAMES the new model (the rewrite landed).
    const rewritten = readFileSync(r.configPath, "utf-8");
    expect(rewritten).toContain(newModel);
    // And the daemon re-booted on the SAME gateway port (a second /health passes,
    // no double-start deadlock — the reconfigure inherited restart()'s ordering).
    expect(controller.gatewayUrl).toBe(gatewayUrl);
    expect((await fetch(`${gatewayUrl}/health`)).ok).toBe(true);
    // The emulator instance is preserved across the reconfigure re-boot.
    expect(controller.emulator).toBe(r.emulator);
  });
});
