// SPDX-License-Identifier: Apache-2.0
/* global process, console, fetch */
//
// ask.mjs — out-of-process driver for the standalone VPS emulator (§6.4).
//
//   node ask.mjs <chatId> <fromUserId> "<text>" [maxMs=140000] [quietMs=9000]
//
// Injects ONE Telegram inbound (DM or group) via the emulator's /control/* surface
// (apiRoot read from /tmp/comis-emu.json, written by vps-emu.ts), then long-polls the
// outbound until QUIESCENT (no new outbound for quietMs) or maxMs elapses, and prints:
//   { injected, outbound, sends, progress, answer }
// where `answer` is the substantive sendMessage text(s) with codex PROGRESS messages
// filtered out — a codex turn emits a progress sendMessage ("🔧 reading ~<skill>… (running)"),
// then the answer sendMessage, then an editMessageText of the progress → "✓ done".
//
// Pairs with test/live/bin/vps-emu.ts. Loopback only; same host as the daemon.
// TEST-HARNESS — Node built-ins only (global fetch on Node 18+); no deps, no build.

import { readFileSync } from "node:fs";

const EMU = JSON.parse(readFileSync("/tmp/comis-emu.json", "utf8")).apiRoot;
const [chatId, fromUserId, text, maxMs = "140000", quietMs = "9000"] = process.argv.slice(2);
if (!chatId || !fromUserId || text === undefined) {
  console.error('usage: node ask.mjs <chatId> <fromUserId> "<text>" [maxMs] [quietMs]');
  process.exit(2);
}

const getJson = async (u) => (await fetch(u)).json();

// Baseline the outbound offset so we only collect THIS turn's replies.
const before = await getJson(`${EMU}/control/chats/${chatId}/outbound?afterMessageId=0&waitMs=0`);
let off = before.reduce((m, o) => Math.max(m, o.messageId || 0), 0);

// Inject the inbound.
const inj = await (
  await fetch(`${EMU}/control/chats/${chatId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fromUserId: Number(fromUserId), text }),
  })
).json();

// Poll outbound until quiescent (codex sends progress, then answer, then edits progress).
const all = [];
let last = Date.now();
const start = Date.now();
while (Date.now() - start < Number(maxMs)) {
  const batch = await getJson(`${EMU}/control/chats/${chatId}/outbound?afterMessageId=${off}&waitMs=5000`);
  if (batch.length) {
    all.push(...batch);
    off = Math.max(off, ...batch.map((o) => o.messageId || 0));
    last = Date.now();
  } else if (all.length && Date.now() - last > Number(quietMs)) {
    break;
  }
}

const isProgress = (t) => !t || /^🔧|^✓|^⏳|^…|\(running|reading ~|^Thinking|^Working/.test(t);
const sends = all.filter((o) => o.method === "sendMessage");
const answer = sends.filter((o) => !isProgress(o.text)).map((o) => o.text);

console.log(
  JSON.stringify({
    injected: inj.messageId,
    outbound: all.length,
    sends: sends.length,
    progress: sends.filter((o) => isProgress(o.text)).length,
    answer,
  }),
);
