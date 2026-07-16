// SPDX-License-Identifier: Apache-2.0
/**
 * `vps-emu` — STANDALONE Telegram emulator launcher for an EXTERNAL daemon.
 *
 * Unlike the in-process rig (`rig.ts`) or the `chan`/`tg` cold-shell (which both
 * boot their OWN rig-daemon), this launcher starts ONLY the `TgEmulator` + its
 * `/control/*` surface on one loopback port and stays up. It is meant to be
 * wired to an ALREADY-RUNNING daemon (e.g. the VPS production daemon, a test
 * env) by setting that daemon's `channels.telegram.apiRoot` to the printed
 * `apiRoot` and its `botToken` to `FAKE_BOT_TOKEN`.
 *
 * The daemon's REAL grammy Telegram adapter then long-polls this emulator
 * (`getMe`/`deleteWebhook`/`getUpdates`) and sends replies (`sendMessage`) here;
 * the driver injects user turns + reads bot replies over the SAME port's
 * `/control/*` routes:
 *   - POST /control/chats/:id/messages   { fromUserId, text }            → { messageId }
 *   - GET  /control/chats/:id/outbound    ?afterMessageId&waitMs          → RecordedOutbound[]
 *   - POST /control/chats/:id/reactions   { fromUserId, botMessageId, emoji }
 *   - POST /control/chats/:id/reset                                        → { ok: true }
 *
 * Writes the wiring to /tmp/comis-emu.json and prints `EMU_UP {json}`.
 * Group chats (negative ids) are pre-created on request via EMU_GROUPS env
 * (a JSON array of { chatId, members:[{id,firstName,username?}], botId, botUsername }).
 *
 * TEST-HARNESS — lives under the test tree; consumes only the @comis-free
 * emulator subtree (node: built-ins at runtime; grammy is type-only / erased).
 */
import { writeFileSync } from "node:fs";
import { createTgEmulator } from "../emulators/telegram/tg-emulator.js";
import { registerControlApi } from "../harness/control-api.js";

const BOT_TOKEN = process.env["EMU_BOT_TOKEN"] ?? "1234567:emulator-fake-token";

const emu = createTgEmulator({ botToken: BOT_TOKEN });
registerControlApi(emu.backend, emu);

// Optionally pre-create group chats for the group/reaction scenarios.
const groups: Array<{ chatId: number; ref: unknown }> = [];
const rawGroups = process.env["EMU_GROUPS"];
if (rawGroups) {
  try {
    const specs = JSON.parse(rawGroups) as Array<{
      chatId?: number;
      members: Array<{ id: number; firstName: string; username?: string }>;
      botId?: number;
      botUsername?: string;
    }>;
    for (const s of specs) {
      const ref = emu.createGroupChat({
        ...(s.chatId !== undefined ? { chatId: s.chatId } : {}),
        members: s.members,
        ...(s.botId !== undefined
          ? { bot: { id: s.botId, firstName: "bot", username: s.botUsername ?? "comis_bot" } }
          : {}),
      } as Parameters<typeof emu.createGroupChat>[0]);
      groups.push({ chatId: (ref as { chatId: number }).chatId, ref });
    }
  } catch (e) {
    console.error("EMU_GROUPS parse/create failed:", (e as Error).message);
  }
}

const { apiRoot, port } = await emu.start();

const info = {
  apiRoot,
  port,
  botToken: BOT_TOKEN,
  pid: process.pid,
  groups: groups.map((g) => g.chatId),
};
writeFileSync("/tmp/comis-emu.json", JSON.stringify(info, null, 2));
// eslint-disable-next-line no-console
console.log("EMU_UP " + JSON.stringify(info));

const stop = async (): Promise<void> => {
  try {
    await emu.stop();
  } catch {
    /* best-effort */
  }
  process.exit(0);
};
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
// Keep the event loop alive.
setInterval(() => {}, 1 << 30);
