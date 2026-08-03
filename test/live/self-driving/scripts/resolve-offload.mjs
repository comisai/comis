#!/usr/bin/env node
// Resolve `tool.result_offloaded` pointers to real files on disk.
//
// Why this exists: the emitted `diskPathRel` is relative to the session directory that WROTE it
// (`relative(sessionDir, diskPath)` → `tool-results/<toolCallId>.json`), but the record carries
// only `workspaceDir` + `sessionId`, never the owning session dir. A sub-agent offload bridged into
// a parent trajectory is therefore unresolvable by construction — measured 0/118 against the data
// root or `workspaceDir`. Verifying "this claim traces to a real fetch" needs the body, and any
// body large enough to matter is offloaded, so grounding audits stall on that gap.
//
// This walks the workspace once, indexes every `tool-results/*.json` by BASENAME, and joins the
// trajectory's pointers against that index. It reports resolution counts and file sizes; it prints
// CONTENT only with --show (bounded), because offloaded tool results may carry fetched page bodies.
//
//   Usage:  node resolve-offload.mjs [--data <dir>] [--traj <file>] [--show <toolCallId>] [--bytes N]
//
// Exit 0 always (a reporting tool); the counts are the signal.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, basename } from "node:path";

const argv = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const index = argv.indexOf(flag);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
};
const dataDir = argOf("--data", process.env.COMIS_DATA_DIR ?? process.env.DATA ?? "");
const showId = argOf("--show", undefined);
const showBytes = Number(argOf("--bytes", 600));
if (!dataDir) {
  process.stderr.write("resolve-offload: pass --data <dir> or set COMIS_DATA_DIR\n");
  process.exit(2);
}

/** Newest trajectory unless one is named — the biggest file is the MAIN session, not a child. */
function newestTrajectory() {
  const dir = join(dataDir, "trajectories");
  if (!existsSync(dir)) return undefined;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".trajectory.jsonl"))
    .map((f) => join(dir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return files[0];
}
const trajectory = argOf("--traj", newestTrajectory());
if (!trajectory || !existsSync(trajectory)) {
  process.stderr.write(`resolve-offload: no trajectory found (tried ${trajectory})\n`);
  process.exit(2);
}

// --- index every offload file in the workspace by basename ------------------
const index = new Map();
function walk(dir, depth = 0) {
  if (depth > 8) return;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, depth + 1);
    else if (basename(dir) === "tool-results") index.set(entry.name, full);
  }
}
walk(join(dataDir, "workspace"));

// --- join the trajectory's pointers against the index ----------------------
let total = 0;
let resolved = 0;
const missing = [];
const found = [];
for (const line of readFileSync(trajectory, "utf8").split("\n")) {
  if (!line.includes("tool.result_offloaded")) continue;
  let record;
  try { record = JSON.parse(line); } catch { continue; }
  const data = record.data ?? record;
  const rel = String(data.diskPathRel ?? "");
  if (rel === "") continue;
  total += 1;
  const hit = index.get(basename(rel));
  if (hit === undefined) missing.push({ toolName: data.toolName, rel });
  else {
    resolved += 1;
    found.push({ toolName: data.toolName, path: hit, bytes: statSync(hit).size, id: data.toolCallId });
  }
}

process.stdout.write(`trajectory: ${basename(trajectory)}\n`);
process.stdout.write(`offload files indexed under the workspace: ${index.size}\n`);
process.stdout.write(`pointers in trajectory: ${total}\n`);
process.stdout.write(`resolved by basename join: ${resolved}\n`);
process.stdout.write(`unresolvable (file absent): ${missing.length}\n`);
for (const item of found.slice(0, 10)) {
  process.stdout.write(`  OK   ${item.toolName} ${item.bytes}B ${item.path.replace(dataDir, "<data>")}\n`);
}
const byTool = new Map();
for (const item of missing) byTool.set(item.toolName, (byTool.get(item.toolName) ?? 0) + 1);
for (const [tool, count] of [...byTool].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
  process.stdout.write(`  MISS ${tool} x${count}\n`);
}

if (showId !== undefined) {
  const hit = found.find((f) => String(f.id).includes(showId)) ?? found.find((f) => f.path.includes(showId));
  if (hit === undefined) process.stdout.write(`\n--show ${showId}: not resolvable\n`);
  else {
    // Bounded, and only on explicit request: an offloaded result can be a fetched page body.
    process.stdout.write(`\n--show ${showId} (${hit.bytes}B, first ${showBytes} chars):\n`);
    process.stdout.write(readFileSync(hit.path, "utf8").slice(0, showBytes) + "\n");
  }
}
