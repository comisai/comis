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

import { readdirSync, statSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadWorkload, SIM_ROOT } from "../shared/registry.mjs";
import { coerce } from "../shared/world.mjs";

// --state <file>: persist the mutable episode state (cases/trip) across separate CLI
// calls, so an interactive driver can run a multi-step episode without a long-lived
// process. The world itself is deterministic from seed+variant, so only the case
// store is persisted. Mismatched seed/variant is refused (would corrupt the episode).
function restoreState(ctx, path) {
  if (!existsSync(path)) return;
  const s = JSON.parse(readFileSync(path, "utf8"));
  if (s.seed !== ctx.seed || s.variant !== ctx.variant) {
    process.stderr.write(`[sim] WARNING: state seed/variant (${s.seed}/${s.variant}) != current (${ctx.seed}/${ctx.variant}); ignoring stale state\n`);
    return;
  }
  ctx.cases = new Map(s.cases || []);
  // Rehydrate per-case Map fields. JSON round-trips Maps to plain objects, so a
  // reloaded case would have `decisions`/`escalations` as `{}` and the handler's
  // `r.decisions.set(...)` would throw. (In the live MCP transport the case store is
  // a long-lived in-process Map and never hits this path; the --state CLI debug path
  // does.) Convert the object form back to a Map so cross-call --state works.
  for (const [, r] of ctx.cases) {
    if (r && typeof r === "object") {
      if (r.decisions && !(r.decisions instanceof Map)) r.decisions = new Map(Object.entries(r.decisions));
      if (r.escalations && !(r.escalations instanceof Map)) r.escalations = new Map(Object.entries(r.escalations));
      // lab-research campaigns hold a `designs` Map; without this rehydration the
      // handler's `c.designs.get(...)` throws "c.designs.get is not a function" on any
      // campaign reloaded from --state (only the first queue_run in a fresh process,
      // when the campaign is still a live Map, worked).
      if (r.designs && !(r.designs instanceof Map)) r.designs = new Map(Object.entries(r.designs));
      // precision-apiary holds a `sampledHives` Set (which hives have a fresh sample).
      // A Set stringifies to a bare `{}` (its contents are lost on write), so saveState
      // emits it as an array; here we rebuild the Set. Without this, the handler's
      // `r.sampledHives.add(...)` throws "s.sampledHives.add is not a function" on the
      // SECOND inspect_hive/schedule_inspection reloaded from --state (the first call,
      // when the field is still a live Set, worked).
      if (r.sampledHives && !(r.sampledHives instanceof Set)) {
        r.sampledHives = new Set(Array.isArray(r.sampledHives) ? r.sampledHives : Object.keys(r.sampledHives));
      }
    }
  }
  ctx.lastTrip = s.lastTrip ?? null;
  ctx.lastCase = s.lastCase ?? null; // workloads use either lastTrip OR lastCase; persist both
  ctx.caseCounter = s.caseCounter ?? 0;
}
function saveState(ctx, path) {
  // Serialize per-case Map fields to plain objects so they survive JSON (a raw Map
  // stringifies to `{}`, silently dropping every decision). restoreState rehydrates them.
  const cases = [...ctx.cases.entries()].map(([k, r]) => {
    if (r && typeof r === "object") {
      const o = { ...r };
      if (r.decisions instanceof Map) o.decisions = Object.fromEntries(r.decisions);
      if (r.escalations instanceof Map) o.escalations = Object.fromEntries(r.escalations);
      if (r.designs instanceof Map) o.designs = Object.fromEntries(r.designs);
      // A Set stringifies to `{}` (contents lost); emit it as an array so its members
      // survive the write. restoreState rebuilds the Set.
      if (r.sampledHives instanceof Set) o.sampledHives = [...r.sampledHives];
      return [k, o];
    }
    return [k, r];
  });
  writeFileSync(path, JSON.stringify({ seed: ctx.seed, variant: ctx.variant, caseCounter: ctx.caseCounter, lastTrip: ctx.lastTrip, lastCase: ctx.lastCase, cases }));
}

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
      params:
        t.inputSchema && t.inputSchema.properties
          ? Object.entries(t.inputSchema.properties).map(([k, v]) => ({
              name: k,
              type: v.type,
              required: (t.inputSchema.required || []).includes(k),
            }))
          : [],
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
const statePath = args.state;
delete args.state;
if (statePath) restoreState(wl.ctx, statePath);
try {
  const result = wl.call(cmd, args);
  if (statePath) saveState(wl.ctx, statePath);
  print(result);
} catch (err) {
  print({ error: err && err.message ? err.message : String(err) });
  process.exit(1);
}
