#!/usr/bin/env node
// Deliberately-hanging MCP server for the ED-15 / B6-8 deadline rows.
//
// Why a dedicated server: ED-15 ("an MCP server that HANGS — the call ends at its deadline with an
// honest error and the turn is not wedged") and B6-8 ("the deadline is per-CALL") cannot be driven
// against a well-behaved server, and they must NOT be driven by mis-reading a duration — the tree
// warns that `BackgroundTask.durationMs` spans promote-to-commit and comparing it against
// `integrations.mcp.callToolTimeoutMs` "manufactures a phantom deadline breach" (a correctly-capped
// 120000ms call surfaced as 138841ms and was twice mistaken for an unenforced deadline). So the only
// sound way to test the cap is a server that provably never answers.
//
// `hang_forever` accepts the call and then never sends a response — the request id is simply never
// resolved. Everything else (initialize, tools/list, and a `ping` control) answers normally, so the
// server's own liveness is not in question when the hang is observed: a wedged *process* and an
// unanswered *call* are distinguishable, which is exactly what B6-8's per-CALL claim requires.
//
// stdout is protocol-only. The process receives and reads no credentials.
const PROTOCOL_VERSION = "2024-11-05";

let buffer = "";
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const ok = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

const tools = [
  {
    name: "hang_forever",
    description: "Never returns. Used to verify the per-call MCP deadline fires and the turn survives.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "ping",
    description: "Returns immediately. Proves the server process is still healthy after a hung call.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

function toolResult(text, isError = false) {
  return { content: [{ type: "text", text: JSON.stringify(text) }], isError };
}

function handle(message) {
  const { id, method, params } = message;
  if (method === "initialize") {
    ok(id, {
      protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "hang-probe", version: "1.0.0" },
    });
    return;
  }
  if (method === "tools/list") {
    ok(id, { tools });
    return;
  }
  if (method === "tools/call") {
    const name = params?.name;
    if (name === "hang_forever") {
      // Deliberately no response, ever. Do NOT block the event loop — the process must stay
      // responsive so a follow-up `ping` still answers, which is how B6-8 separates
      // "this CALL exceeded its deadline" from "the SERVER is dead".
      process.stderr.write(`hang-mcp: swallowing tools/call id=${String(id)} (never responding)\n`);
      return;
    }
    if (name === "ping") {
      ok(id, toolResult({ alive: true }));
      return;
    }
    fail(id, -32601, `Unknown tool: ${String(name)}`);
    return;
  }
  if (id !== undefined && id !== null) fail(id, -32601, `Unknown method: ${String(method)}`);
}

process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line === "") continue;
    try {
      handle(JSON.parse(line));
    } catch {
      // Malformed line — ignore; stdout stays protocol-only.
    }
  }
});
process.stdin.on("end", () => process.exit(0));
