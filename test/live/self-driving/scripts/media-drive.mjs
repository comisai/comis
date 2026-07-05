#!/usr/bin/env node
// media-drive.mjs — inject a MEDIA message (photo / voice / audio / document) via the emulator,
// then poll outbound for the agent's substantive reply. The media analog of `drive.mjs`.
//
// Usage:  node media-drive.mjs <chatId> <file-or-base64> <kind> ["<caption>"] [maxMs=180000]
//   <file-or-base64>: AUTO-DETECTED — if it's an existing file PATH, the file is read + base64-encoded;
//                     otherwise it's treated as INLINE base64. (An earlier version only accepted a path,
//                     so passing inline base64 hit `ENAMETOOLONG` on open.)
//   <kind>: photo | voice | audio | document | video  (the emulator media kind)
//
// Examples:
//   node media-drive.mjs 678314278 /tmp/voice.wav voice "transcribe this"
//   node media-drive.mjs 678314278 "$(base64 -w0 /tmp/chart.png)" photo "what's the trend?"
//
// NOTE (rig limitation): on the loopback rig, a media INPUT is fetched by the daemon from the emulator
// apiRoot. That fetch is SSRF-guarded; the emulator host is allowlisted (`trustedFetchOrigins`) so the
// fetch succeeds. Transcription/vision ACCURACY still needs real
// media that survives the daemon's ffmpeg/decode pipeline — a synthetic/silent blob fails-honestly
// ("transcription failed; send as text") which is a coverage-gap, NOT a Comis bug. (`05-CATALOG.md`.)
import { readFileSync, existsSync, statSync } from "node:fs";
import { rig } from "./_rig.mjs";

const [, , chatIdArg, fileOrB64, kindArg, captionArg, maxMsArg] = process.argv;
const chatId = chatIdArg || rig.chatId;
const kind = kindArg || "photo";
const caption = captionArg || "";
const maxMs = Number(maxMsArg || 180000);
if (!fileOrB64) {
  console.error('usage: media-drive.mjs <chatId> <file-or-base64> <kind> ["caption"] [maxMs]');
  process.exit(2);
}

// AUTO-DETECT: an existing regular file → read+encode; else treat the arg as inline base64.
let fileBase64;
if (existsSync(fileOrB64) && statSync(fileOrB64).isFile()) {
  fileBase64 = readFileSync(fileOrB64).toString("base64");
  process.stderr.write(`encoded file ${fileOrB64} (${fileBase64.length} b64 chars)\n`);
} else {
  fileBase64 = fileOrB64;
  process.stderr.write(`treating arg as inline base64 (${fileBase64.length} chars)\n`);
}

const emu = JSON.parse(readFileSync(rig.emuWiringPath, "utf8"));
const base = emu.apiRoot;
const getOutbound = async (after, waitMs) =>
  (await fetch(`${base}/control/chats/${chatId}/outbound?afterMessageId=${after}&waitMs=${waitMs}`)).json();

const initial = await getOutbound(0, 1);
let after = initial.reduce((m, o) => Math.max(m, o.messageId || 0), 0);
const inj = await (
  await fetch(`${base}/control/chats/${chatId}/media`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fromUserId: Number(chatId), kind, fileBase64, meta: caption ? { caption } : undefined }),
  })
).json();
process.stderr.write(`injected media messageId=${inj.messageId} kind=${kind} (caption: ${JSON.stringify(caption).slice(0, 80)})\n`);

const isProgress = (t) => !t || /^(🔧|✓|🤖|❌|⏳)/.test(t) || /\(running/.test(t);
const seen = [];
let sawAnswer = false;
const start = Date.now();
while (Date.now() - start < maxMs) {
  const batch = await getOutbound(after, sawAnswer ? 6000 : 20000);
  if (batch.length) {
    for (const o of batch) {
      seen.push(o);
      after = Math.max(after, o.messageId || after);
      if (o.method === "sendMessage" && !isProgress(o.text)) sawAnswer = true;
    }
  } else if (sawAnswer) break;
}
console.log(`=== OUTBOUND (${seen.length}) in ${Math.round((Date.now() - start) / 1000)}s ===`);
for (const o of seen) console.log(`[${o.method} ${o.messageId}] ${JSON.stringify((o.text || "").slice(0, 500))}`);
if (!sawAnswer) console.log("[NO SUBSTANTIVE ANSWER — read the trajectory / daemon log; media-input may fail-honestly]");
