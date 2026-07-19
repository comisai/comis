#!/usr/bin/env node
// Tap the latest Telegram approval control without printing labels or callback data.
// The output is limited to attribution, hashes, and transport outcome.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { ensureRpcEnv, importCli, requireCodeRoot, rig } from "./_rig.mjs";

const choice = process.argv[2] ?? "approve";
if (choice !== "approve" && choice !== "deny") {
  process.stderr.write("usage: generic-runtime-approval.mjs approve|deny\n");
  process.exit(2);
}

const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const approvalAuthority = () => {
  const Database = requireCodeRoot("better-sqlite3");
  const db = new Database(`${rig.dataDir}/memory.db`, { readonly: true, fileMustExist: true });
  const row = db.prepare(
    "SELECT tenant_id, agent_id, conversation_ref FROM delivery_mirror "
    + "WHERE channel_type = ? AND channel_id = ? ORDER BY created_at DESC LIMIT 1",
  ).get("telegram", String(rig.chatId));
  db.close();
  if (
    typeof row?.tenant_id !== "string"
    || typeof row?.agent_id !== "string"
    || typeof row?.conversation_ref !== "string"
  ) {
    throw new Error("current Telegram approval authority is unavailable");
  }
  return {
    tenant_id: row.tenant_id,
    agent_id: row.agent_id,
    conversation_ref: row.conversation_ref,
  };
};
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
  const authority = approvalAuthority();
  const pending = await withClient((client) => client.call("admin.approval.pending", authority));
  const owned = (pending.requests ?? []).filter((request) =>
    request.callbackOwner?.channelType === "telegram"
    && request.callbackOwner?.channelKey === String(rig.chatId),
  );
  if (owned.length !== 1 || typeof owned[0]?.shortId !== "string") {
    process.stderr.write(`expected one owned pending approval, found ${owned.length}\n`);
    process.exit(1);
  }
  const requestId = owned[0].requestId;
  const shortId = owned[0].shortId;
  const resolution = await withClient((client) => client.call("admin.approval.resolve", {
    ...authority,
    requestId,
    approved: choice === "approve",
    approvedBy: "live-campaign-operator",
    reason: "generic runtime live campaign decision",
  }));
  process.stdout.write(`${JSON.stringify({
    choice,
    mode: "scoped-rpc",
    requestIdHash: sha256(requestId),
    shortIdHash: sha256(shortId),
    resolved: resolution.approved === (choice === "approve"),
    authority,
  })}\n`);
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
