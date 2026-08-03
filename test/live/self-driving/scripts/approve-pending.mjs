#!/usr/bin/env node
// Tap Approve (or Deny) on the emulator's pending approval prompt.
//
// Every approval-gated row is otherwise undrivable: with `approvals.enabled`, a gated action
// posts an inline-keyboard prompt and BLOCKS until someone taps it or the timeout denies it. A
// drive that just waits therefore always records a timeout-denial, never the approved path — and
// the prompt is `deleteMessage`d as soon as the progress notice supersedes it (F-APPROVAL-1), so
// the payload has to be captured from the outbound stream, not read back later.
//
// The callback token stays valid after the prompt message is deleted, which is what makes this
// work: capture `callback_data` when the prompt appears, then POST it whenever we are ready.
//
//   Usage:  node approve-pending.mjs <chatId> [approve|deny] [timeoutMs=120000] [fromUserId=chatId]
//
// Exits 0 having tapped exactly one prompt, 3 if none appeared inside the window (a caller that
// expected a gate can treat that as "the action was NOT gated" — a real, distinguishable result).
import { readFileSync } from "node:fs";

const chatId = process.argv[2];
const verb = (process.argv[3] ?? "approve").toLowerCase();
const timeoutMs = Number(process.argv[4] ?? 120_000);
const fromUserId = Number(process.argv[5] ?? chatId);

if (!chatId || !["approve", "deny"].includes(verb)) {
  process.stderr.write("usage: approve-pending.mjs <chatId> [approve|deny] [timeoutMs] [fromUserId]\n");
  process.exit(2);
}

const wiring = JSON.parse(readFileSync("/tmp/comis-emu.json", "utf8"));
const base = `http://127.0.0.1:${wiring.port}`;

/** Pull the button payload out of whichever casing the emulator recorded. */
function approvalButtons(message) {
  const markup = message?.reply_markup ?? message?.replyMarkup ?? message?.raw?.reply_markup ?? {};
  const rows = markup.inline_keyboard ?? markup.inlineKeyboard ?? [];
  return rows.flat().map((button) => ({
    label: String(button?.text ?? ""),
    data: String(button?.callback_data ?? button?.callbackData ?? ""),
  }));
}

const startedAt = Date.now();
// Start from the CURRENT tail: an already-resolved prompt from an earlier turn must not be
// re-tapped (its token is disposed, so the tap would silently do nothing and we would report
// success for a request that never existed).
let after = await (async () => {
  const response = await fetch(`${base}/control/chats/${chatId}/outbound?afterMessageId=0`);
  const body = await response.json();
  const messages = Array.isArray(body) ? body : (body.messages ?? []);
  return messages.reduce((max, m) => Math.max(max, Number(m.messageId) || 0), 0);
})();

process.stderr.write(`watching chat ${chatId} for an approval prompt after messageId=${after}\n`);

for (;;) {
  if (Date.now() - startedAt > timeoutMs) {
    process.stderr.write("no approval prompt appeared inside the window\n");
    process.exit(3);
  }
  const response = await fetch(
    `${base}/control/chats/${chatId}/outbound?afterMessageId=${after}&waitMs=5000`,
  );
  const body = await response.json();
  const messages = Array.isArray(body) ? body : (body.messages ?? []);
  for (const message of messages) {
    after = Math.max(after, Number(message.messageId) || after);
    const text = String(message.text ?? "");
    if (!/approval required/i.test(text)) continue;
    const buttons = approvalButtons(message);
    const wanted = buttons.find((b) => new RegExp(verb, "i").test(b.label));
    if (!wanted?.data) {
      process.stderr.write(`prompt ${message.messageId} carried no '${verb}' button: ${JSON.stringify(buttons)}\n`);
      continue;
    }
    const tap = await fetch(`${base}/control/chats/${chatId}/callbacks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fromUserId, botMessageId: Number(message.messageId), data: wanted.data }),
    });
    const outcome = await tap.text();
    // Print the ACTION, never the token: the payload is an authorization capability.
    process.stdout.write(
      `${verb.toUpperCase()} tapped on messageId=${message.messageId} :: ${text.split("\n")[0].slice(0, 120)} :: ${outcome}\n`,
    );
    process.exit(0);
  }
}
