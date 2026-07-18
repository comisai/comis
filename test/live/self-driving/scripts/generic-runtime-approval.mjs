#!/usr/bin/env node
// Tap the latest Telegram approval control without printing labels or callback data.
// The output is limited to attribution, hashes, and transport outcome.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { ensureRpcEnv, importCli, rig } from "./_rig.mjs";

const choice = process.argv[2] ?? "approve";
if (choice !== "approve" && choice !== "deny") {
  process.stderr.write("usage: generic-runtime-approval.mjs approve|deny\n");
  process.exit(2);
}

const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const buttonsFor = (item) => {
  const raw = item.replyMarkup;
  const markup = typeof raw === "string" ? (() => {
    try { return JSON.parse(raw); } catch { return undefined; }
  })() : raw;
  return markup?.inline_keyboard?.flat?.() ?? [];
};
const wiring = JSON.parse(readFileSync(rig.emuWiringPath, "utf8"));
const outboundResponse = await fetch(
  `${wiring.apiRoot}/control/chats/${encodeURIComponent(rig.chatId)}/outbound?afterMessageId=0&waitMs=0`,
);
if (!outboundResponse.ok) {
  process.stderr.write(`outbound lookup failed with status ${outboundResponse.status}\n`);
  process.exit(1);
}
const outbounds = await outboundResponse.json();
const candidate = [...outbounds].reverse().find((item) => {
  const buttons = buttonsFor(item);
  return buttons.some((button) =>
    typeof button.callback_data === "string"
    && button.callback_data.startsWith(`v1.${choice}.`),
  );
});
if (candidate === undefined) {
  ensureRpcEnv();
  const { withClient } = await importCli("client/rpc-client.js");
  const pending = await withClient((client) => client.call("admin.approval.pending", {}));
  const owned = (pending.requests ?? []).filter((request) =>
    request.callbackOwner?.channelType === "telegram"
    && request.callbackOwner?.channelKey === String(rig.chatId),
  );
  if (owned.length !== 1 || typeof owned[0]?.shortId !== "string") {
    process.stderr.write(`expected one owned pending approval, found ${owned.length}\n`);
    process.exit(1);
  }
  const shortId = owned[0].shortId;
  const fallbackResponse = await fetch(
    `${wiring.apiRoot}/control/chats/${encodeURIComponent(rig.chatId)}/messages`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fromUserId: Number(rig.chatId), text: `/${choice} ${shortId}` }),
    },
  );
  const fallbackBody = fallbackResponse.ok ? await fallbackResponse.json() : {};
  process.stdout.write(`${JSON.stringify({
    choice,
    mode: "command",
    shortIdHash: sha256(shortId),
    inboundMessageId: fallbackBody.messageId,
    status: fallbackResponse.status,
    ok: fallbackResponse.ok,
  })}\n`);
  if (!fallbackResponse.ok) process.exit(1);
  process.exit(0);
}
const buttons = buttonsFor(candidate);
const button = buttons.find((item) => item.callback_data?.startsWith(`v1.${choice}.`));
const callbackData = button?.callback_data;
if (typeof callbackData !== "string") {
  process.stderr.write(`no ${choice} callback payload found\n`);
  process.exit(1);
}

const tapResponse = await fetch(
  `${wiring.apiRoot}/control/chats/${encodeURIComponent(rig.chatId)}/callbacks`,
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      fromUserId: Number(rig.chatId),
      botMessageId: candidate.messageId,
      data: callbackData,
    }),
  },
);
process.stdout.write(`${JSON.stringify({
  choice,
  mode: "callback",
  botMessageId: candidate.messageId,
  callbackHash: sha256(callbackData),
  status: tapResponse.status,
  ok: tapResponse.ok,
})}\n`);
if (!tapResponse.ok) process.exit(1);
