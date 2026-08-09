#!/usr/bin/env node
// Tap Approve (or Deny) on the emulator's pending approval prompt.
//
// Every approval-gated row is otherwise undrivable: with `approvals.enabled`, a gated action
// posts an inline-keyboard prompt and BLOCKS until someone taps it or the timeout denies it. A
// drive that just waits therefore always records a timeout-denial, never the approved path. The
// payload has to be captured from the outbound stream while the prompt is active.
//
// A successful drive also proves that the spent controls are retired promptly. Reporting success
// after the callback POST alone misses the dangerous interval where the user can tap a second
// visible button whose capability has already been disposed.
//
//   Usage:  node approve-pending.mjs <chatId> [approve|deny] [timeoutMs=120000]
//                 [fromUserId=chatId] [maxRetirementMs=500]
//
// Exits 0 only after tapping exactly one prompt and seeing its controls retire. Exit 3 means no
// prompt appeared; exit 4 means the prompt stayed actionable past the retirement budget.
import { readFileSync } from "node:fs";
import { rig } from "./_rig.mjs";
import {
  approvalButtons,
  classifyApprovalRetirement,
} from "./approval-retirement-oracle.mjs";

const chatId = process.argv[2];
const verb = (process.argv[3] ?? "approve").toLowerCase();
const timeoutMs = Number(process.argv[4] ?? 120_000);
const fromUserId = Number(process.argv[5] ?? chatId);
const maxRetirementMs = Number(process.argv[6] ?? 500);

if (
  !chatId
  || !["approve", "deny"].includes(verb)
  || !Number.isFinite(timeoutMs)
  || timeoutMs <= 0
  || !Number.isFinite(fromUserId)
  || !Number.isFinite(maxRetirementMs)
  || maxRetirementMs <= 0
) {
  process.stderr.write(
    "usage: approve-pending.mjs <chatId> [approve|deny] [timeoutMs] [fromUserId] [maxRetirementMs]\n",
  );
  process.exit(2);
}

const wiring = JSON.parse(readFileSync(rig.emuWiringPath, "utf8"));
const base = `http://127.0.0.1:${wiring.port}`;

const startedAt = Date.now();
// Start from the CURRENT tail: an already-resolved prompt from an earlier turn must not be
// re-tapped (its token is disposed, so the tap would silently do nothing and we would report
// success for a request that never existed).
const baseline = await (async () => {
  const response = await fetch(`${base}/control/chats/${chatId}/outbound?afterMessageId=0`);
  const body = await response.json();
  const messages = Array.isArray(body) ? body : (body.messages ?? []);
  return {
    eventCount: messages.length,
    messageId: messages.reduce((max, m) => Math.max(max, Number(m.messageId) || 0), 0),
  };
})();

process.stderr.write(`watching chat ${chatId} for an approval prompt (sendMessage OR editMessageText) after event=${baseline.eventCount}, messageId=${baseline.messageId}\n`);

// A background-task approval does NOT arrive as a fresh sendMessage: the prompt is folded into an
// `editMessageText` of the EXISTING progress message (`🔧 run bash / 🔧 importing skill / approval
// required: …`), buttons attached. Watching only ids ABOVE the watermark therefore misses it and
// reports "no approval prompt appeared" while a real request sits pending until it times out.
// So: rescan the WHOLE tail each poll and advance by outbound EVENT count. Message ids cannot be
// the cursor because an edit reuses the existing progress message id.
const tapped = new Set();
for (;;) {
  if (Date.now() - startedAt > timeoutMs) {
    process.stderr.write("no approval prompt appeared inside the window\n");
    process.exit(3);
  }
  const response = await fetch(
    `${base}/control/chats/${chatId}/outbound?afterMessageId=0&waitMs=5000`,
  );
  const body = await response.json();
  const messages = Array.isArray(body) ? body : (body.messages ?? []);
  const newEvents = messages.length < baseline.eventCount
    ? messages
    : messages.slice(baseline.eventCount);
  for (const message of newEvents) {
    const text = String(message.text ?? "");
    if (!/approval required/i.test(text)) continue;
    const key = `${message.messageId}:${verb}`;
    if (tapped.has(key)) continue;
    tapped.add(key);
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
    await tap.text();
    if (!tap.ok) {
      process.stderr.write(`callback delivery failed with HTTP ${tap.status}\n`);
      process.exit(5);
    }

    const tappedAtEventCount = messages.length;
    const tappedAt = Date.now();
    for (;;) {
      const retirementResponse = await fetch(
        `${base}/control/chats/${chatId}/outbound?afterMessageId=0&waitMs=100`,
      );
      const retirementBody = await retirementResponse.json();
      const currentMessages = Array.isArray(retirementBody)
        ? retirementBody
        : (retirementBody.messages ?? []);
      const retirement = classifyApprovalRetirement({
        messages: currentMessages,
        messageId: message.messageId,
        afterEventCount: tappedAtEventCount,
        elapsedMs: Date.now() - tappedAt,
        maxRetirementMs,
      });
      if (retirement.state === "pending") continue;
      if (retirement.state === "retired") {
        // Print the action and latency, never the callback token or endpoint response.
        process.stdout.write(
          `${verb.toUpperCase()} tapped and controls retired on messageId=${message.messageId} `
          + `withinMs=${Date.now() - tappedAt}\n`,
        );
        process.exit(0);
      }
      process.stderr.write(
        `approval controls were not retired within ${maxRetirementMs}ms `
        + `(messageId=${message.messageId}, state=${retirement.state})\n`,
      );
      process.exit(4);
    }
  }
}
