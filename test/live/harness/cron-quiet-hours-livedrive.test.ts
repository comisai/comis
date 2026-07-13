// SPDX-License-Identifier: Apache-2.0
/**
 * IB-20 live-drive: quiet hours suppresses a cron's user-facing channel delivery
 * on a REAL running daemon (not a unit mock). Boots a local rig (daemon +
 * emulator + gateway + keyless model), enables quiet hours over an all-day
 * window, fires a `system_event` cron (no model turn needed) with a delivery
 * target, and asserts the emulator receives NO outbound — the job ran, the
 * off-hours ping was withheld. Then it re-boots WITHOUT quiet hours and fires
 * again to confirm the same cron DOES deliver (the gate is the only difference).
 *
 * This is the end-to-end ground-truth proof the box drive would give, run
 * locally so it does not depend on production-box SSO access.
 *
 * Run: pnpm vitest run -c test/live/vitest.config.ts \
 *        test/live/harness/cron-quiet-hours-livedrive.test.ts   (needs COMIS_LIVE=1)
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import WebSocket from "ws";
import { buildRig } from "./rig.js";
import { startTestDaemon } from "../../support/daemon-harness.js";

const isLive = !!process.env["COMIS_LIVE"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Minimal WS JSON-RPC caller against the rig gateway (Bearer on the handshake). */
function makeWsCall(wsUrl: string, token: string) {
  return (method: string, params: unknown): Promise<any> =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${token}` } });
      const id = Math.floor(Math.abs(Math.sin(method.length + JSON.stringify(params).length)) * 1e9) + 1;
      const timer = setTimeout(() => { ws.close(); reject(new Error(`RPC ${method} timed out`)); }, 20_000);
      ws.on("open", () => ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params })));
      ws.on("message", (data) => {
        let msg: any;
        try { msg = JSON.parse(String(data)); } catch { return; }
        if (msg.id !== id) return;
        clearTimeout(timer);
        ws.close();
        if (msg.error) reject(new Error(`RPC ${method} error: ${JSON.stringify(msg.error)}`));
        else resolve(msg.result);
      });
      ws.on("error", (e) => { clearTimeout(timer); reject(e); });
    });
}

const ALL_DAY_QUIET = `
scheduler:
  quietHours:
    enabled: true
    start: "00:00"
    end: "23:59"
    timezone: "UTC"
    criticalBypass: false
`;

describe.skipIf(!isLive)("IB-20 live-drive: quiet hours gates a cron's channel delivery on a real daemon", () => {
  it("the SAME system_event cron delivers with quiet hours OFF but is suppressed with quiet hours ON", async () => {
    // A verbatim provider/model id (the local Ollama tag) — the system_event
    // path needs no model turn, but this keeps boot clean regardless.
    const rig = await buildRig({ channel: "telegram", model: "qwen3.6:27b" });
    const chatId = rig.chat.chatId;
    const wsUrl = rig.gatewayUrl.replace(/^http/, "ws") + "/ws";
    const call = makeWsCall(wsUrl, rig.authToken);
    const target = { channelType: "telegram", channelId: String(chatId), userId: "111", tenantId: "test" };
    const addParams = (name: string, ping: string) => ({
      name,
      agentId: "default",
      schedule_kind: "every",
      schedule_every_ms: 86_400_000,
      payload_kind: "system_event",
      payload_text: ping,
      deliveryTarget: target,
    });
    const addFire = async (name: string, ping: string) => {
      try { await call("cron.remove", { jobName: name }); } catch { /* not present — ok */ }
      await call("cron.add", addParams(name, ping));
      const fired = await call("cron.run", { jobName: name, agentId: "default" });
      expect(fired.triggered).toBe(true);
    };
    const seen = (ping: string) => rig.emulator.outbound({ chatId }).filter((o) => o.text?.includes(ping));

    try {
      // --- Leg 1: quiet hours OFF (default) → fire → the ping DELIVERS (baseline) ---
      const PING_DELIVER = "QH-CRON-DELIVER-IB20";
      await addFire("ib20-qh-deliver", PING_DELIVER);
      let delivered: ReturnType<typeof seen> = [];
      for (let i = 0; i < 10 && delivered.length === 0; i++) { await sleep(1500); delivered = seen(PING_DELIVER); }
      expect(delivered.length).toBeGreaterThan(0); // no quiet hours → the cron pings the channel

      // --- Reboot with quiet hours ON (all-day window covering now) ---
      const baseCfg = readFileSync(rig.configPath, "utf8");
      writeFileSync(rig.configPath, baseCfg + ALL_DAY_QUIET, "utf8");
      await rig.daemonHandle.cleanup();
      await sleep(3000); // let the gateway port release before the re-boot polls it
      rig.rebindDaemonHandle(await startTestDaemon({ configPath: rig.configPath, gatewayPort: rig.gatewayPort }));

      // --- Leg 2: quiet hours ON → fire → the ping is SUPPRESSED (job ran, withheld) ---
      const PING_SUPPRESS = "QH-CRON-SUPPRESS-IB20";
      await addFire("ib20-qh-suppress", PING_SUPPRESS);
      await sleep(6000); // give any (wrongly-)delivered ping ample time to land
      expect(seen(PING_SUPPRESS).length).toBe(0); // suppressed off-hours
    } finally {
      await rig.cleanup();
    }
  }, 180_000);
});
