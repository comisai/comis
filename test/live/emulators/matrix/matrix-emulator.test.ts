// SPDX-License-Identifier: Apache-2.0
/**
 * Stage-A unit tests for the Matrix loopback homeserver emulator.
 *
 * These drive the emulator's wire surface DIRECTLY with `fetch` (no matrix-js-sdk,
 * no daemon) to prove each route answers and the inject/oracle verbs work: the
 * loopback bind, the `/versions`/`/login`/`/whoami`/filter responses, the
 * initial-vs-incremental `/sync` sequencing, the send oracle, the join log, the
 * `m.direct` account-data for a DM inject, and the catch-all safety net. The
 * end-to-end proof against the REAL adapter lives in the round-trip scenario.
 *
 * Run under the LIVE vitest config:
 *   pnpm vitest run -c test/live/vitest.config.ts \
 *     test/live/emulators/matrix/matrix-emulator.test.ts
 *
 * @module
 */

import { afterEach, describe, expect, it } from "vitest";
import { createMatrixEmulator, type MatrixEmulator } from "./matrix-emulator.js";
import { DIRECT_ACCOUNT_DATA_TYPE, ROOM_MESSAGE_TYPE } from "./matrix-payloads.js";

const V3 = "/_matrix/client/v3";

const running: MatrixEmulator[] = [];
afterEach(async () => {
  while (running.length > 0) await running.pop()!.stop();
});

async function boot(): Promise<{ emu: MatrixEmulator; apiRoot: string }> {
  const emu = createMatrixEmulator();
  const { apiRoot } = await emu.start();
  running.push(emu);
  return { emu, apiRoot };
}

async function getJson(url: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(url);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("matrix-emulator — loopback bind + wire responses", () => {
  it("binds 127.0.0.1 on a kernel-allocated port", async () => {
    const { apiRoot } = await boot();
    expect(apiRoot).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("answers /versions, /account/whoami, and the login flows", async () => {
    const { apiRoot } = await boot();
    const versions = await getJson(`${apiRoot}/_matrix/client/versions`);
    expect(versions.status).toBe(200);
    expect(Array.isArray(versions.json.versions)).toBe(true);

    const whoami = await getJson(`${apiRoot}${V3}/account/whoami`);
    expect(whoami.status).toBe(200);
    expect(typeof whoami.json.user_id).toBe("string");

    const flows = await getJson(`${apiRoot}${V3}/login`);
    expect(flows.status).toBe(200);
    expect(flows.json.flows).toBeDefined();
  });

  it("mints a filter id on POST .../user/{userId}/filter", async () => {
    const { apiRoot } = await boot();
    const res = await fetch(`${apiRoot}${V3}/user/%40bot%3Ahs.test/filter`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ room: { timeline: { limit: 20 } } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { filter_id?: string };
    expect(typeof body.filter_id).toBe("string");
  });
});

describe("matrix-emulator — /sync sequencing (initial vs incremental)", () => {
  it("serves an injected backlog event in the INITIAL sync (no since)", async () => {
    const { emu, apiRoot } = await boot();
    emu.injectBacklog({ roomId: "!room:hs.test", sender: "@alice:hs.test", body: "old" });

    const { json } = await getJson(`${apiRoot}${V3}/sync`);
    const rooms = json.rooms as { join?: Record<string, { timeline: { events: Array<{ content: { body: string } }> } }> };
    const events = rooms.join?.["!room:hs.test"]?.timeline.events ?? [];
    expect(events).toHaveLength(1);
    expect(events[0]?.content.body).toBe("old");
    expect(typeof json.next_batch).toBe("string");
  });

  it("serves an injected live event only on the INCREMENTAL sync (with since)", async () => {
    const { emu, apiRoot } = await boot();
    // First drive the initial sync to obtain a since token.
    const initial = await getJson(`${apiRoot}${V3}/sync`);
    const since = initial.json.next_batch as string;

    emu.injectRoomMessage({ roomId: "!room:hs.test", sender: "@alice:hs.test", body: "live" });

    const incremental = await getJson(`${apiRoot}${V3}/sync?since=${since}&timeout=30000`);
    const rooms = incremental.json.rooms as { join?: Record<string, { timeline: { events: Array<{ type: string; sender: string; content: { body: string }; event_id: string }> } }> };
    const events = rooms.join?.["!room:hs.test"]?.timeline.events ?? [];
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe(ROOM_MESSAGE_TYPE);
    expect(events[0]?.sender).toBe("@alice:hs.test");
    expect(events[0]?.content.body).toBe("live");
    expect(events[0]?.event_id).toMatch(/^\$evt_/);
  });

  it("includes m.direct account-data for a direct inject (the DM classifier)", async () => {
    const { emu, apiRoot } = await boot();
    const initial = await getJson(`${apiRoot}${V3}/sync`);
    const since = initial.json.next_batch as string;
    emu.injectRoomMessage({ roomId: "!dm:hs.test", sender: "@alice:hs.test", body: "dm", direct: true });

    const { json } = await getJson(`${apiRoot}${V3}/sync?since=${since}`);
    const accountData = json.account_data as { events: Array<{ type: string; content: Record<string, string[]> }> };
    const mdirect = accountData.events.find((e) => e.type === DIRECT_ACCOUNT_DATA_TYPE);
    expect(mdirect).toBeDefined();
    expect(mdirect?.content["@alice:hs.test"]).toContain("!dm:hs.test");
  });
});

describe("matrix-emulator — outbound oracle + join log + catch-all", () => {
  it("records an outbound m.room.message send and returns an event_id (the oracle)", async () => {
    const { emu, apiRoot } = await boot();
    const encoded = encodeURIComponent("!room:hs.test");
    const res = await fetch(`${apiRoot}${V3}/rooms/${encoded}/send/m.room.message/txn1`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ msgtype: "m.text", body: "echo: hi", format: "org.matrix.custom.html", formatted_body: "echo: hi" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { event_id?: string };
    expect(body.event_id).toMatch(/^\$out_/);

    const recorded = emu.sentMessages("!room:hs.test");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.body).toBe("echo: hi");
    expect(recorded[0]?.formatted_body).toBe("echo: hi");
    expect(emu.lastSent("!room:hs.test")?.body).toBe("echo: hi");
  });

  it("records an auto-join on POST .../join/{roomId}", async () => {
    const { emu, apiRoot } = await boot();
    const encoded = encodeURIComponent("!invited:hs.test");
    const res = await fetch(`${apiRoot}${V3}/join/${encoded}`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { room_id?: string };
    expect(body.room_id).toBe("!invited:hs.test");
    expect(emu.joinedRooms()).toContain("!invited:hs.test");
  });

  it("answers a client-startup probe with a benign {} and records it as unhandled", async () => {
    const { emu, apiRoot } = await boot();
    const res = await getJson(`${apiRoot}${V3}/pushrules/`);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({});
    expect(emu.unhandledPaths().some((p) => p.endsWith("/pushrules/"))).toBe(true);
  });
});
