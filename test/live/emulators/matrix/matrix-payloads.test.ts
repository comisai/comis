// SPDX-License-Identifier: Apache-2.0
/**
 * Stage-A shape tests for the Matrix Client-Server wire builders.
 *
 * Pure/structural — no daemon, no network. They pin the JSON shapes the emulator
 * serves so a drift in a builder (a missing `event_id`, a wrong sync envelope) is
 * caught before the round-trip scenario relies on it. The builders return the
 * exact structures `matrix-js-sdk` parses; these assertions are the fixture
 * contract.
 *
 * Run under the LIVE vitest config:
 *   pnpm vitest run -c test/live/vitest.config.ts \
 *     test/live/emulators/matrix/matrix-payloads.test.ts
 *
 * @module
 */

import { describe, expect, it } from "vitest";
import {
  CUSTOM_HTML_FORMAT,
  DIRECT_ACCOUNT_DATA_TYPE,
  ROOM_MESSAGE_TYPE,
  makeDirectAccountDataEvent,
  makeJoinedRoom,
  makeJoinedRoomState,
  makeLoginResponse,
  makeRoomMessageEvent,
  makeSyncResponse,
  makeVersionsResponse,
  makeWhoamiResponse,
} from "./matrix-payloads.js";

describe("matrix-payloads — m.room.message timeline event", () => {
  it("carries sender (full MXID), event_id, origin_server_ts, and an m.text body", () => {
    const evt = makeRoomMessageEvent({
      sender: "@alice:hs.test",
      body: "hello matrix",
      eventId: "$evt-1",
      ts: 1_700_000_000_000,
    });
    expect(evt.type).toBe(ROOM_MESSAGE_TYPE);
    expect(evt.sender).toBe("@alice:hs.test");
    expect(evt.event_id).toBe("$evt-1");
    expect(evt.origin_server_ts).toBe(1_700_000_000_000);
    expect(evt.content.msgtype).toBe("m.text");
    expect(evt.content.body).toBe("hello matrix");
    // No formatted body unless requested.
    expect(evt.content.formatted_body).toBeUndefined();
  });

  it("adds an org.matrix.custom.html formatted_body when supplied", () => {
    const evt = makeRoomMessageEvent({
      sender: "@alice:hs.test",
      body: "bold",
      eventId: "$evt-2",
      ts: 1_700_000_000_001,
      formattedBody: "<strong>bold</strong>",
    });
    expect(evt.content.format).toBe(CUSTOM_HTML_FORMAT);
    expect(evt.content.formatted_body).toBe("<strong>bold</strong>");
  });
});

describe("matrix-payloads — joined-room state + sync envelope", () => {
  it("builds create + join membership state for each member", () => {
    const state = makeJoinedRoomState({
      members: ["@bot:hs.test", "@alice:hs.test"],
      ts: 100,
    });
    expect(state.some((e) => e.type === "m.room.create")).toBe(true);
    const members = state.filter((e) => e.type === "m.room.member");
    expect(members).toHaveLength(2);
    expect(members.every((m) => m.content.membership === "join")).toBe(true);
    // State events carry a state_key.
    expect(members[0]?.state_key).toBe("@bot:hs.test");
  });

  it("assembles a /sync response with a joined room whose timeline carries the event", () => {
    const msg = makeRoomMessageEvent({
      sender: "@alice:hs.test",
      body: "hi",
      eventId: "$evt-3",
      ts: 200,
    });
    const room = makeJoinedRoom({
      timeline: [msg],
      state: makeJoinedRoomState({ members: ["@bot:hs.test", "@alice:hs.test"], ts: 100 }),
      prevBatch: "p1",
    });
    const sync = makeSyncResponse({ nextBatch: "s2", join: { "!room:hs.test": room } });
    expect(sync.next_batch).toBe("s2");
    expect(sync.rooms.join["!room:hs.test"]?.timeline.events[0]?.event_id).toBe("$evt-3");
    expect(sync.rooms.join["!room:hs.test"]?.timeline.limited).toBe(false);
    // A default sync carries empty global account data.
    expect(sync.account_data.events).toHaveLength(0);
  });

  it("carries an m.direct account-data event mapping the other party to the DM room", () => {
    const direct = makeDirectAccountDataEvent({ "@alice:hs.test": ["!dm:hs.test"] });
    expect(direct.type).toBe(DIRECT_ACCOUNT_DATA_TYPE);
    expect(direct.content["@alice:hs.test"]).toEqual(["!dm:hs.test"]);
    const sync = makeSyncResponse({ nextBatch: "s3", accountData: [direct] });
    expect(sync.account_data.events[0]?.type).toBe(DIRECT_ACCOUNT_DATA_TYPE);
  });
});

describe("matrix-payloads — auth + versions responses", () => {
  it("builds a whoami response with a user_id and device_id", () => {
    const who = makeWhoamiResponse({ userId: "@bot:hs.test", deviceId: "DEV9" });
    expect(who.user_id).toBe("@bot:hs.test");
    expect(who.device_id).toBe("DEV9");
  });

  it("builds a login response carrying user_id, device_id, and an access_token", () => {
    const login = makeLoginResponse({ accessToken: "tok-xyz" });
    expect(login.user_id).toBe("@bot:hs.test");
    expect(typeof login.device_id).toBe("string");
    expect(login.access_token).toBe("tok-xyz");
  });

  it("advertises modern spec versions with an unstable_features map", () => {
    const versions = makeVersionsResponse();
    expect(Array.isArray(versions.versions)).toBe(true);
    expect(versions.versions.length).toBeGreaterThan(0);
    expect(versions.unstable_features).toEqual({});
  });
});
