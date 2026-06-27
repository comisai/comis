#!/usr/bin/env node
// Generic CLI for any self-driving simulator workload — for seeding, debugging, and
// the ground-truth self-test. (The AGENT uses the MCP server, not this CLI; each CLI
// invocation is a fresh process, so multi-step episode state does NOT persist across
// separate calls — use --selftest, which runs a full sequence in ONE process.)
//
//   node sim/bin/cli.mjs <workload> --list                 # list the tools (functions)
//   node sim/bin/cli.mjs <workload> --selftest             # golden path → success, naive → failure
//   node sim/bin/cli.mjs <workload> <tool> --key val ...    # call one function, print JSON
//   node sim/bin/cli.mjs --workloads                        # list all workloads

import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadWorkload, SIM_ROOT } from "../shared/registry.mjs";
import { coerce } from "../shared/world.mjs";

const argv = process.argv.slice(2);

function listWorkloads() {
  return readdirSync(SIM_ROOT)
    .filter((d) => statSync(join(SIM_ROOT, d)).isDirectory() && !["shared", "bin"].includes(d))
    .filter((d) => existsSync(join(SIM_ROOT, d, "tools.json")))
    .sort();
}

if (argv[0] === "--workloads" || argv[0] === undefined) {
  process.stdout.write(listWorkloads().join("\n") + "\n");
  process.exit(0);
}

const workload = argv[0];
const cmd = argv[1];

function parseFlags(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq >= 0) {
      out[a.slice(2, eq)] = coerce(a.slice(eq + 1));
    } else {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out[a.slice(2)] = coerce(next);
        i++;
      } else {
        out[a.slice(2)] = true;
      }
    }
  }
  return out;
}

const print = (o) => process.stdout.write(JSON.stringify(o, null, 2) + "\n");

const wl = await loadWorkload(workload);

if (cmd === "--list" || cmd === "-l" || cmd === undefined) {
  print({
    server: wl.server,
    title: wl.title,
    variant: wl.ctx.variant,
    seed: wl.ctx.seed,
    tools: wl.toolMeta.map((t) => ({
      name: t.name,
      kind: t.kind || "act",
      terminal: !!t.terminal,
      description: t.description,
    })),
  });
  process.exit(0);
}

if (cmd === "--selftest") {
  if (!wl.selftest) {
    print({ workload, selftest: "MISSING", pass: false });
    process.exit(1);
  }
  const res = wl.selftest();
  print({ workload, ...res });
  process.exit(res && res.pass ? 0 : 1);
}

// Otherwise: call one tool with --flags.
const args = parseFlags(argv.slice(2));
try {
  print(wl.call(cmd, args));
} catch (err) {
  print({ error: err && err.message ? err.message : String(err) });
  process.exit(1);
}
