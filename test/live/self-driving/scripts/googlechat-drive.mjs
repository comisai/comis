#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// googlechat-drive.mjs — the Google Chat driver for the self-driving rig. HYBRID:
// Google Chat DEFAULTS to a PULL transport (Pub/Sub, like Telegram) but also
// supports an opt-in signed WEBHOOK (like Teams), so this driver does both:
//
//   --mode pubsub  (default): inject the interaction event onto the emulator's
//     fake Pub/Sub subscription (POST {emu}/emu/pubsub-inject) and let the daemon
//     PULL it — no inbound auth header (the daemon authenticates OUTBOUND with its
//     service-account token, which the emulator's opaque token endpoint answers).
//   --mode webhook: obtain a signed Chat-event Bearer from the emulator
//     (POST {emu}/emu/sign-token — the emulator holds the RS256 key, this process
//     does not), then POST the event to the daemon ingress
//     (POST {gateway}/channels/googlechat) with that Bearer.
//
// Either way it then polls the emulator's Chat-REST oracle (GET {emu}/emu/outbound)
// for the agent's reply. Because the daemon was booted with COMIS_GOOGLECHAT_TEST_API
// set, its outbound Chat/Pub-Sub/token egress is redirected to this emulator, so the
// reply — and a card-click response — actually land in the oracle instead of
// escaping to real chat.googleapis.com.
//
// Prereqs (see vps-emu-googlechat.ts): the emulator is up (its info at
// /tmp/comis-googlechat-emu.json), and the daemon was booted with the two
// OFF-BY-DEFAULT seams — COMIS_GOOGLECHAT_TEST_JWKS=<jwksPath> and
// COMIS_GOOGLECHAT_TEST_API=<apiRoot> — plus channels.googlechat enabled with the
// emulator's serviceAccountKey + audience and allowFrom including the --from id.
//
// The agent turn fires ASYNC past the inbound ack (the model run takes seconds+);
// read completion from the oracle poll below AND from the trajectory / daemon log —
// NOT from a chat reply. This script proves the INBOUND contract (webhook: Chat-JWT
// auth + mapping; pubsub: pull + mapping) and the OUTBOUND round-trip (the reply
// landing on the fake Chat REST oracle), driving both a text turn and a Cards v2
// click (--type card).
//
// Runs ON THE VPS (gateway + emulator bind loopback). Uses only Node builtins + global fetch.
//
// Usage:
//   node googlechat-drive.mjs <space> "<text>" [opts]
//     <space>            the space resource name / channelId (e.g. spaces/AAAA)
//     --mode <m>         pubsub | webhook (default pubsub — Google Chat's default transport)
//     --emu <path>       emulator info json (default /tmp/comis-googlechat-emu.json)
//     --gateway <url>    daemon gateway base (default http://127.0.0.1:4766)
//     --from <userId>    sender resource id / allowlist key (default users/selfdrive)
//     --type message|card   inbound event kind (default message)
//     --mentioned        (message) add a USER_MENTION annotation (wasMentioned)
//     --card-message <n> (card) the clicked card message resource name
//     --invoked-function <fn>  (card) the invoked action method (default comis.approval.resolve)
//     --callback <cb>    (card) the signed callback blob lifted from the agent's card
//     --audience <aud>   (webhook) inbound-token audience override (default the project number)
//     --issuer <iss>     (webhook) inbound-token issuer override
//     --wait <ms>        poll timeout for the reply (default 60000)
//     --no-auth          (webhook) omit the Authorization header (tests the 401 missing-bearer path)
//     --bad-token        (webhook) send a garbage Bearer (tests the 401 invalid-token path)
//
// Exit code: 0 on a 2xx inbound ack, else 1. For the --no-auth / --bad-token SEC
// probes (webhook) the pass/fail inverts: 0 means the ingress CORRECTLY rejected
// the forged webhook with an opaque 401, else 1. A rig error (emulator info
// missing) exits 2.

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
    else if (a === "--mentioned") opt.mentioned = true;
    else if (a === "--mode") opt.mode = argv[++i];
    else if (a === "--emu") opt.emu = argv[++i];
    else if (a === "--gateway") opt.gateway = argv[++i];
    else if (a === "--from") opt.from = argv[++i];
    else if (a === "--type") opt.type = argv[++i];
    else if (a === "--card-message") opt.cardMessage = argv[++i];
    else if (a === "--invoked-function") opt.invokedFunction = argv[++i];
    else if (a === "--callback") opt.callback = argv[++i];
    else if (a === "--audience") opt.audience = argv[++i];
    else if (a === "--issuer") opt.issuer = argv[++i];
    else if (a === "--wait") opt.wait = Number(argv[++i]);
    else pos.push(a);
  }
  return { pos, opt };
}

const { pos, opt } = parseArgs(process.argv.slice(2));
if (pos.length < 1) {
  console.error('usage: googlechat-drive.mjs <space> "<text>" [opts]  (see header)');
  process.exit(2);
}

const space = pos[0];
const text = pos[1] ?? "hello from the self-drive rig";
const mode = opt.mode ?? "pubsub";
const emuPath = opt.emu ?? "/tmp/comis-googlechat-emu.json";
const gateway = (opt.gateway ?? process.env.GOOGLECHAT_GATEWAY ?? "http://127.0.0.1:4766").replace(/\/$/, "");
const fromUser = opt.from ?? "users/selfdrive";
const kind = opt.type ?? "message";
const waitMs = opt.wait ?? 60_000;

if (mode !== "pubsub" && mode !== "webhook") {
  console.error(`[local] --mode must be pubsub | webhook (got ${mode})`);
  process.exit(2);
}

if (!existsSync(emuPath)) {
  console.error(`[local] emulator info not found: ${emuPath}`);
  console.error("[local] ⚠ start the emulator first: tsx test/live/bin/vps-emu-googlechat.ts");
  process.exit(2);
}
const emu = JSON.parse(readFileSync(emuPath, "utf8"));
const emuRoot = emu.apiRoot;

// The action-method name the approval card renders on its Cards v2 buttons — the
// only method in the adapter's rendered set. A click naming any other method is
// dropped before it becomes a message. A real live click lifts the SIGNED callback
// from the agent's card; the placeholder below is rejected by the adapter's
// signature check (an honest negative), so pass --callback with the real blob.
const APPROVAL_FUNCTION = "comis.approval.resolve";

let eventIdSeq = Date.now();
const nextName = () => `${space}/messages/${eventIdSeq++}`;

function buildMessageEvent() {
  const name = nextName();
  return {
    type: "MESSAGE",
    eventTime: new Date().toISOString(),
    user: { name: fromUser },
    space: { name: space, spaceType: "SPACE" },
    message: {
      name,
      sender: { name: fromUser },
      text,
      // The platform strips the app mention into argumentText; set it so the
      // mapper's preferred field carries the faithful command text.
      argumentText: text,
      space: { name: space, spaceType: "SPACE" },
      ...(opt.mentioned ? { annotations: [{ type: "USER_MENTION" }] } : {}),
    },
  };
}

function buildCardClickedEvent() {
  const fn = opt.invokedFunction ?? APPROVAL_FUNCTION;
  const cb = opt.callback ?? "signed-cb-blob";
  const messageName = opt.cardMessage ?? nextName();
  return {
    type: "CARD_CLICKED",
    user: { name: fromUser },
    space: { name: space },
    message: { name: messageName },
    // The verified clicker rides ONLY on user.name (never a parameter); the invoked
    // function + opaque callback sit in BOTH the classic action and newer common
    // shapes (the adapter reads either).
    action: {
      actionMethodName: fn,
      parameters: [{ key: "cb", value: cb }],
    },
    common: {
      invokedFunction: fn,
      parameters: { cb },
    },
  };
}

const event = kind === "card" ? buildCardClickedEvent() : buildMessageEvent();

async function signToken() {
  const body = {
    ...(opt.audience !== undefined ? { audience: opt.audience } : {}),
    ...(opt.issuer !== undefined ? { issuer: opt.issuer } : {}),
  };
  const res = await fetch(`${emuRoot}/emu/sign-token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`sign-token failed: ${res.status}`);
  const { token } = await res.json();
  return token;
}

async function outboundCount() {
  const res = await fetch(
    `${emuRoot}/emu/outbound?space=${encodeURIComponent(space)}&afterCount=0`,
  );
  const body = await res.json();
  return body.total ?? 0;
}

async function pollForReply(afterCount) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const res = await fetch(
      `${emuRoot}/emu/outbound?space=${encodeURIComponent(space)}&afterCount=${afterCount}`,
    );
    const body = await res.json();
    if (Array.isArray(body.outbound) && body.outbound.length > 0) return body.outbound;
    await new Promise((r) => setTimeout(r, 500));
  }
  return [];
}

const before = await outboundCount();

// --- Inject the inbound event (per mode) ---
let status;
let ackBody;
let authLabel = "n/a";
if (mode === "webhook") {
  authLabel = opt.noAuth ? "none" : opt.badToken ? "bad" : "signed";
  const headers = { "content-type": "application/json" };
  if (!opt.noAuth) {
    headers.authorization = `Bearer ${opt.badToken ? "not-a-real-jwt" : await signToken()}`;
  }
  const url = `${gateway}/channels/googlechat`;
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(event) });
  status = res.status;
  ackBody = await res.text();
  console.log(`POST ${url}`);
} else {
  // pubsub: enqueue onto the fake subscription for the daemon to pull. The SEC
  // probes are webhook-only (there is no inbound auth header on the pull path).
  if (opt.noAuth || opt.badToken) {
    console.log("[local] note: --no-auth/--bad-token are webhook-mode SEC probes; ignored for --mode pubsub");
  }
  const url = `${emuRoot}/emu/pubsub-inject`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event),
  });
  status = res.status;
  ackBody = await res.text();
  console.log(`POST ${url} (daemon will pull)`);
}

console.log(`  space=${space} mode=${mode} kind=${kind} from=${fromUser} auth=${authLabel}`);
console.log(`STATUS ${status}`);
console.log(`ACK ${ackBody.slice(0, 500)}`);

// SEC probe (webhook only): a forged or missing Bearer MUST be rejected with an
// opaque 401 — the SECURE outcome is the PASS here, the exact inverse of a normal
// turn. Assert it BEFORE the generic 2xx-ack check below, which would otherwise
// flag the correct 401 rejection as a failure AND (worse) treat an insecure 2xx
// accept — a bypassed ingress auth-gate — as success, so the probe could never
// catch the very regression it exists for. In pubsub mode these flags were
// ignored above (there is no inbound auth header on the pull path), so this
// branch is webhook-only.
if (mode === "webhook" && (opt.noAuth || opt.badToken)) {
  const pass = status === 401;
  // An opaque 401 leaks no reason string; the ack body should be empty/short.
  console.log(
    pass
      ? "SEC PASS: ingress rejected the forged webhook with an opaque 401"
      : `SEC FAIL: expected an opaque 401, got ${status} (auth-gate bypassed?)`,
  );
  process.exit(pass ? 0 : 1);
}

if (status < 200 || status >= 300) {
  process.exit(1);
}

// Poll the Chat REST oracle for the agent's reply (fires async past the ack).
const replies = await pollForReply(before);
if (replies.length === 0) {
  console.log(`REPLY none (waited ${waitMs}ms) — check the trajectory / daemon log (async turn may still be running)`);
} else {
  for (const r of replies) {
    console.log(`REPLY op=${r.op ?? r.method} text=${JSON.stringify(r.text ?? "")}${r.hasCards ? " [card]" : ""}${r.threadName ? " [thread]" : ""}`);
  }
}
process.exit(0);
