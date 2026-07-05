#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// msteams-drive.mjs — the Microsoft Teams push driver for the self-driving rig.
//
// Teams is the INVERSE of Telegram. Telegram's drive.mjs POSTs to the emulator's
// /control/* and the daemon PULLS. Teams' inbound is a signed WEBHOOK the daemon
// EXPOSES, and outbound goes to the Connector. So this driver:
//   1. obtains a signed Bot-Framework Bearer from the emulator (POST /emu/sign-token —
//      the emulator holds the RS256 key; this process does not),
//   2. POSTs a Bot Framework Activity to the daemon ingress
//      (POST {gateway}/channels/msteams/api/messages) with that Bearer,
//   3. polls the emulator's Connector oracle (GET /emu/outbound) for the agent reply.
//
// Prereqs (see vps-emu-msteams.ts): the emulator is up (its info at
// /tmp/comis-msteams-emu.json), and the daemon was booted with the two OFF-BY-DEFAULT
// seams — COMIS_MSTEAMS_TEST_JWKS=<jwksPath> and COMIS_MSTEAMS_TEST_CONNECTOR=<apiRoot> —
// plus channels.msteams enabled with the same appId/tenantId + allowMode:open.
//
// The agent turn fires ASYNC past the 202 ack (the model run takes seconds+); read
// completion from the oracle poll below AND from the trajectory / daemon log — NOT
// from a chat reply. This script proves the INBOUND contract (BF-JWT auth + mapping)
// and the OUTBOUND round-trip (the reply landing on the fake Connector).
//
// Runs ON THE VPS (gateway + emulator bind loopback). Uses only Node builtins + global fetch.
//
// Usage:
//   node msteams-drive.mjs <conversationId> "<text>" [opts]
//     --emu <path>       emulator info json (default /tmp/comis-msteams-emu.json)
//     --gateway <url>    daemon gateway base (default http://127.0.0.1:4766)
//     --from <aad>       sender aadObjectId (default aad-selfdrive-user)
//     --type message|reaction   inbound activity kind (default message)
//     --target <id>      (reaction) the bot activity id being reacted to
//     --emoji-type <t>   (reaction) like|heart|laugh|surprised|sad|angry (default like)
//     --wait <ms>        poll timeout for the reply (default 60000)
//     --no-auth          omit the Authorization header (tests the 401 missing-bearer path)
//     --bad-token        send a garbage Bearer (tests the 401 invalid-token path)
//
// Exit code: 0 on a 2xx ack, else 1. A rig error (emulator info missing) exits 2.

import { readFileSync, existsSync } from "node:fs";

function parseArgs(argv) {
  const pos = [];
  const opt = {};
  argv = argv.flatMap((a) =>
    a.startsWith("--") && a.includes("=")
      ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)]
      : [a],
  );
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-auth") opt.noAuth = true;
    else if (a === "--bad-token") opt.badToken = true;
    else if (a === "--emu") opt.emu = argv[++i];
    else if (a === "--gateway") opt.gateway = argv[++i];
    else if (a === "--from") opt.from = argv[++i];
    else if (a === "--type") opt.type = argv[++i];
    else if (a === "--target") opt.target = argv[++i];
    else if (a === "--emoji-type") opt.emojiType = argv[++i];
    else if (a === "--wait") opt.wait = Number(argv[++i]);
    else pos.push(a);
  }
  return { pos, opt };
}

const { pos, opt } = parseArgs(process.argv.slice(2));
if (pos.length < 1) {
  console.error('usage: msteams-drive.mjs <conversationId> "<text>" [opts]  (see header)');
  process.exit(2);
}

const conversationId = pos[0];
const text = pos[1] ?? "hello from the self-drive rig";
const emuPath = opt.emu ?? "/tmp/comis-msteams-emu.json";
const gateway = (opt.gateway ?? process.env.MSTEAMS_GATEWAY ?? "http://127.0.0.1:4766").replace(/\/$/, "");
const fromAad = opt.from ?? "aad-selfdrive-user";
const kind = opt.type ?? "message";
const waitMs = opt.wait ?? 60_000;

if (!existsSync(emuPath)) {
  console.error(`[local] emulator info not found: ${emuPath}`);
  console.error("[local] ⚠ start the emulator first: tsx test/live/bin/vps-emu-msteams.ts");
  process.exit(2);
}
const emu = JSON.parse(readFileSync(emuPath, "utf8"));
const emuRoot = emu.apiRoot;

// The isSafeServiceUrl-admitted public-cloud Connector host — set verbatim so the
// outbound reply passes the (unchanged) host allowlist; the daemon's redirect seam
// then routes the wire bytes to the loopback emulator.
const SERVICE_URL = "https://smba.trafficmanager.net/";
const TENANT_ID = emu.tenantId ?? "00000000-0000-0000-0000-000000000001";
const BOT_ID = "28:emulator-bot";

let activityIdSeq = Date.now();
const nextId = () => `f:${activityIdSeq++}`;

function baseActivity() {
  return {
    id: nextId(),
    conversation: { id: conversationId, conversationType: "personal", tenantId: TENANT_ID },
    from: { id: fromAad, aadObjectId: fromAad, name: "Self-Drive User" },
    recipient: { id: BOT_ID },
    serviceUrl: SERVICE_URL,
    channelData: { tenant: { id: TENANT_ID } },
  };
}

function buildActivity() {
  if (kind === "reaction") {
    return {
      ...baseActivity(),
      type: "messageReaction",
      replyToId: opt.target ?? "bot-activity-1",
      reactionsAdded: [{ type: opt.emojiType ?? "like" }],
    };
  }
  return { ...baseActivity(), type: "message", text };
}

async function signToken() {
  const res = await fetch(`${emuRoot}/emu/sign-token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error(`sign-token failed: ${res.status}`);
  const { token } = await res.json();
  return token;
}

async function outboundCount() {
  const res = await fetch(
    `${emuRoot}/emu/outbound?conversationId=${encodeURIComponent(conversationId)}&afterCount=0`,
  );
  const body = await res.json();
  return body.total ?? 0;
}

async function pollForReply(afterCount) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const res = await fetch(
      `${emuRoot}/emu/outbound?conversationId=${encodeURIComponent(conversationId)}&afterCount=${afterCount}`,
    );
    const body = await res.json();
    if (Array.isArray(body.outbound) && body.outbound.length > 0) return body.outbound;
    await new Promise((r) => setTimeout(r, 500));
  }
  return [];
}

const activity = buildActivity();
const before = await outboundCount();

const headers = { "content-type": "application/json" };
if (!opt.noAuth) {
  headers.authorization = `Bearer ${opt.badToken ? "not-a-real-jwt" : await signToken()}`;
}

const url = `${gateway}/channels/msteams/api/messages`;
const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(activity) });
const ackBody = await res.text();
console.log(`POST ${url}`);
console.log(`  conversationId=${conversationId} kind=${kind} auth=${opt.noAuth ? "none" : opt.badToken ? "bad" : "signed"}`);
console.log(`STATUS ${res.status}`);
console.log(`ACK ${ackBody.slice(0, 500)}`);

if (res.status < 200 || res.status >= 300) {
  // A 401 here is an HONEST negative for the --no-auth / --bad-token SEC probes.
  process.exit(1);
}

// Poll the Connector oracle for the agent's reply (fires async past the ack).
const replies = await pollForReply(before);
if (replies.length === 0) {
  console.log(`REPLY none (waited ${waitMs}ms) — check the trajectory / daemon log (async turn may still be running)`);
} else {
  for (const r of replies) {
    console.log(`REPLY op=${r.op} text=${JSON.stringify(r.text ?? "")}${r.hasCard ? " [card]" : ""}${r.hasImageAttachment ? " [image]" : ""}`);
  }
}
process.exit(0);
