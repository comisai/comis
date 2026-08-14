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
 * Writes owner-only wiring to `EMU_JSON` (default `/tmp/comis-emu.json`) and
 * prints a credential-free `EMU_UP {json}` summary.
 * Group chats (negative ids) are pre-created on request via EMU_GROUPS env
 * (a JSON array of { chatId, members:[{id,firstName,username?}], botId,
 * botUsername, supergroup?, forum? }).
 *
 * TEST-HARNESS — lives under the test tree; consumes only the @comis-free
 * emulator subtree (node: built-ins at runtime; grammy is type-only / erased).
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createTgEmulator } from "../emulators/telegram/tg-emulator.js";
import { registerControlApi } from "../harness/control-api.js";
import {
  nextStandaloneMessageIdBase,
  assertValidGroupSpec,
  toCreateGroupChatOptions,
  type StandaloneGroupSpec,
} from "./vps-emu-group-options.js";

const BOT_TOKEN = process.env["EMU_BOT_TOKEN"] ?? "1234567:emulator-fake-token";
const WIRING_PATH = process.env["EMU_JSON"] ?? "/tmp/comis-emu.json";
const priorState = existsSync(WIRING_PATH)
  ? (() => {
      try {
        return JSON.parse(readFileSync(WIRING_PATH, "utf8")) as { messageIdBase?: unknown };
      } catch {
        return {};
      }
    })()
  : undefined;
const messageIdBase = nextStandaloneMessageIdBase(priorState);

const emu = createTgEmulator({ botToken: BOT_TOKEN, initialMessageId: messageIdBase });
registerControlApi(emu.backend, emu);

// Optionally pre-create group chats for the group/reaction scenarios.
const groups: Array<{ chatId: number; ref: unknown }> = [];
const rawGroups = process.env["EMU_GROUPS"];
if (rawGroups) {
  try {
    const specs = JSON.parse(rawGroups) as StandaloneGroupSpec[];
    if (!Array.isArray(specs)) throw new TypeError("EMU_GROUPS must be a JSON array");
    specs.forEach((s, i) => assertValidGroupSpec(s, i));
    for (const s of specs) {
      const ref = emu.createGroupChat(toCreateGroupChatOptions(s));
      groups.push({ chatId: (ref as { chatId: number }).chatId, ref });
    }
  } catch (e) {
    // EXIT, never continue. Previously this only warned and the emulator came up with no (or a
    // wrongly-identified) group, so the launch banner looked healthy while every mention-gated
    // group arc was silently undrivable — the worst outcome for a test instrument.
    console.error(`EMU_GROUPS invalid — refusing to start: ${(e as Error).message}`);
    process.exit(1);
  }
}

const { apiRoot, port } = await emu.start();

const info = {
  apiRoot,
  port,
  botToken: BOT_TOKEN,
  pid: process.pid,
  messageIdBase,
  groups: groups.map((g) => g.chatId),
};
writeFileSync(WIRING_PATH, JSON.stringify(info, null, 2), { mode: 0o600 });
chmodSync(WIRING_PATH, 0o600);
console.log("EMU_UP " + JSON.stringify({ ...info, botToken: "[REDACTED]" }));

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
