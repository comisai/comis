#!/usr/bin/env node
// Generic MCP stdio server for any self-driving simulator workload.
//
//   node sim/bin/mcp-server.mjs <workload>
//   SIM_WORKLOAD=<workload> SIM_SEED=42 SIM_VARIANT=A node sim/bin/mcp-server.mjs
//
// Wire it into a running daemon (no restart) with:
//   node packages/cli/dist/cli.js mcp connect <server> \
//     --transport stdio --command node \
//     --args "<abs-path>/sim/bin/mcp-server.mjs,<workload>"
//
// See sim/README.md for the full copy-to-daemon + drive instructions.

import { loadWorkload } from "../shared/registry.mjs";
import { serveStdio } from "../shared/rpc.mjs";

const workload = process.argv[2] || process.env.SIM_WORKLOAD;
if (!workload) {
  process.stderr.write("usage: node sim/bin/mcp-server.mjs <workload>\n");
  process.exit(2);
}

loadWorkload(workload)
  .then((wl) => serveStdio(wl))
  .catch((err) => {
    process.stderr.write(`failed to load workload "${workload}": ${err && err.stack}\n`);
    process.exit(1);
  });
