// Zero-dependency MCP stdio server loop. MCP stdio transport = newline-delimited
// JSON-RPC 2.0 over stdin/stdout (NOT LSP Content-Length framing). stdout carries
// ONLY protocol messages — all logging goes to stderr.

const PROTOCOL_VERSION = "2024-11-05";

/**
 * @param {object} wl  a loaded workload (from registry.loadWorkload)
 */
export function serveStdio(wl) {
  let buf = "";
  const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
  const ok = (id, result) => send({ jsonrpc: "2.0", id, result });
  const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

  function handle(msg) {
    const { id, method, params } = msg;
    const isRequest = id !== undefined && id !== null;

    switch (method) {
      case "initialize":
        return ok(id, {
          protocolVersion: (params && params.protocolVersion) || PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: wl.server, version: "0.1.0", title: wl.title },
        });
      case "tools/list":
        return ok(id, { tools: wl.listTools() });
      case "tools/call": {
        const name = params && params.name;
        const args = (params && params.arguments) || {};
        try {
          const result = wl.call(name, args);
          return ok(id, {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            isError: false,
          });
        } catch (err) {
          return ok(id, {
            content: [{ type: "text", text: `ERROR: ${err && err.message ? err.message : String(err)}` }],
            isError: true,
          });
        }
      }
      case "ping":
        return ok(id, {});
      default:
        if (method && method.startsWith("notifications/")) return; // notifications: no reply
        if (isRequest) return fail(id, -32601, `method not found: ${method}`);
    }
  }

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        process.stderr.write(`[sim:${wl.name}] bad JSON line dropped\n`);
        continue;
      }
      try {
        handle(msg);
      } catch (err) {
        process.stderr.write(`[sim:${wl.name}] handler crash: ${err && err.stack}\n`);
      }
    }
  });
  process.stdin.on("end", () => process.exit(0));
  process.stderr.write(`[sim:${wl.name}] MCP stdio server ready — ${wl.listTools().length} tools (variant ${wl.ctx.variant}, seed ${wl.ctx.seed})\n`);
}
