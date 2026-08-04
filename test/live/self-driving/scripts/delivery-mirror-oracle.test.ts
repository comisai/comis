// SPDX-License-Identifier: Apache-2.0
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { selectLatestTelegramDeliveryMirror } from "./delivery-mirror-oracle.mjs";

describe("live Telegram delivery mirror oracle", () => {
  it("selects the mirror for the requested chat when another chat is newer", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE delivery_mirror (
        tenant_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        conversation_ref TEXT NOT NULL,
        destination_endpoint TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    const insert = db.prepare(
      "INSERT INTO delivery_mirror VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    insert.run(
      "default",
      "default",
      "cv_requested",
      JSON.stringify({
        channelType: "telegram",
        channelInstanceId: "telegram-test",
        conversationId: "678314278",
        conversationKind: "direct",
      }),
      "requested chat reply",
      "pending",
      1,
    );
    insert.run(
      "default",
      "default",
      "cv_newer",
      JSON.stringify({
        channelType: "telegram",
        channelInstanceId: "telegram-test",
        conversationId: "678314279",
        conversationKind: "direct",
      }),
      "newer other-chat reply",
      "pending",
      2,
    );

    expect(selectLatestTelegramDeliveryMirror(db, "678314278")).toMatchObject({
      conversation_ref: "cv_requested",
      text: "requested chat reply",
      created_at: 1,
    });
    db.close();
  });
});
