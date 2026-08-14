import { appendFileSync, readFileSync } from "node:fs";

const [chatArg, userArg, textPath, evidencePath, timeoutArg] = process.argv.slice(2);
const chat = Number(chatArg);
const user = Number(userArg);
const timeoutMs = Number(timeoutArg ?? 180000);
const { apiRoot } = JSON.parse(readFileSync(
  "/home/comisdevcrew/e0-full-live-20260814-b/emulator.json",
  "utf8",
));
const before = await fetch(
  `${apiRoot}/control/chats/${chat}/outbound?afterMessageId=0&waitMs=1`,
).then((response) => response.json());
const beforeRows = Array.isArray(before) ? before : (before.outbound ?? []);
let cursor = beforeRows.reduce(
  (maximum, row) => Math.max(maximum, Number(row.messageId ?? 0)),
  0,
);
const body = JSON.stringify({
  fromUserId: user,
  fromFirstName: "Admin",
  text: readFileSync(textPath, "utf8"),
});
const injected = await fetch(`${apiRoot}/control/chats/${chat}/messages`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body,
});
if (!injected.ok) throw new Error(`inject failed ${injected.status}`);

const deadline = Date.now() + timeoutMs;
while (Date.now() < deadline) {
  const waitMs = Math.min(30000, deadline - Date.now());
  const response = await fetch(
    `${apiRoot}/control/chats/${chat}/outbound?afterMessageId=${cursor}&waitMs=${waitMs}`,
  );
  if (!response.ok) throw new Error(`outbound failed ${response.status}`);
  const responseBody = await response.json();
  const rows = Array.isArray(responseBody) ? responseBody : (responseBody.outbound ?? []);
  for (const row of rows) {
    appendFileSync(evidencePath, `${JSON.stringify(row)}\n`);
    cursor = Math.max(cursor, Number(row.messageId ?? 0));
    const text = typeof row.text === "string" ? row.text : "";
    const activity = text.includes("(running ") || text.startsWith("🔧 ");
    if (row.method === "sendMessage" && text.length > 0 && !activity) {
      console.log(JSON.stringify({
        messageId: row.messageId,
        textBytes: Buffer.byteLength(text),
        cursor,
      }));
      process.exit(0);
    }
  }
}

console.error(JSON.stringify({ error: "no_final_reply", cursor }));
process.exit(2);
