#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// terminal-drive-observe.mjs — the GROUND-TRUTH oracle for a webhook/cron→claude TERMINAL DRIVE.
//
// Runs ON THE VPS (needs the tmux socket + /proc + the daemon log). It bundles the four hand-rolled
// probes a webhook→claude terminal-drive run otherwise reinvents every few minutes:
//
//   screen     — the LIVE claude tmux pane(s) (capture-pane), so you SEE what the drive is doing
//                (planning / executing / Noodling / a dialog) without guessing from the log.
//   secrets    — the JAIL secret-residency HARD oracle: /proc/<jailed-pid>/environ scanned for
//                SECRETS_MASTER_KEY / COMIS_GATEWAY_TOKEN / GWTOKEN / GATEWAY_TOKEN_* /
//                ANTHROPIC_API_KEY / sk-ant- (COUNTS only, never the values) + the keep-vars survive.
//   lifecycle  — the drive lifecycle from the daemon log: create / promote / awaiting-input /
//                drive_continue / evicted(reason) / reaped / webhook_delivered(success). This is the
//                honest-fail + idle-reap read (the run had to `cat daemon.log daemon.1.log | grep` by hand).
//   progress   — a coding drive's real progress: the project's git log + ROADMAP `[x]` phases +
//                code-file count (the "did it actually build anything" read, not the chat reply).
//
// WHY: the idle-reap behavior was first diagnosed by hand-correlating `terminal session evicted`
// timestamps vs the last activity, hand-scanning /proc for the leak oracle, and hand-grepping git for
// build progress — all reusable for ANY webhook→claude test. This is that kit, once.
//
// Usage (on the VPS):
//   node terminal-drive-observe.mjs [screen|secrets|lifecycle|progress|all] [projectName] [--session <substr>] [--watch <sec>]
//   node terminal-drive-observe.mjs all snake-app
//   node terminal-drive-observe.mjs lifecycle --session snake        # filter the log to one drive
//   node terminal-drive-observe.mjs all snake-app --watch 20         # re-run every 20s (the drive-poll loop)
//
// --watch <sec> is the DRIVE-POLL loop: it re-runs the selected mode(s) every <sec> seconds so you can
// watch an unattended drive PROGRESS (screen advancing, commits landing, lifecycle transitions) without
// hand-re-running — exactly the poll such a run otherwise does by hand via a remote
// /tmp/*-poll.sh. Ctrl-C to stop; each pass is timestamp-headed.
//
// Env: DATA (default /home/comis/.comis), COMIS_USER (default comis). ROOT-HOME-guarded like db.mjs.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const DATA = process.env.DATA || "/home/comis/.comis";
const COMIS_USER = process.env.COMIS_USER || "comis";
const args = process.argv.slice(2);
const mode = (args[0] && !args[0].startsWith("--")) ? args[0] : "all";
const project = (args[1] && !args[1].startsWith("--")) ? args[1] : undefined;
const sessionFilter = (() => { const i = args.indexOf("--session"); return i >= 0 ? args[i + 1] : undefined; })();
const watchSec = (() => { const i = args.indexOf("--watch"); return i >= 0 ? Number(args[i + 1]) : 0; })();

// Run a command as the comis user (so HOME + perms resolve), returning stdout (never throws).
function asComis(cmd) {
  try {
    return execFileSync("sudo", ["-u", COMIS_USER, "bash", "-lc", cmd], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (e) {
    return (e && e.stdout) ? String(e.stdout) : "";
  }
}
function sh(bin, argv) {
  try { return execFileSync(bin, argv, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); }
  catch (e) { return (e && e.stdout) ? String(e.stdout) : ""; }
}

function claudePids() {
  return sh("pgrep", ["-f", "claude/versions"]).split("\n").map((s) => s.trim()).filter((s) => /^\d+$/.test(s));
}
function tmuxSockets() {
  const dir = `${DATA}/terminal-worker`;
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".sock")).map((f) => `${dir}/${f}`);
}
function latestDaemonLogs() {
  // BOTH the live log AND the rotated .1 (the run kept missing records split across rotation).
  return ["daemon.log", "daemon.1.log"].map((f) => `${DATA}/logs/${f}`).filter((p) => existsSync(p));
}

function doScreen() {
  console.log("=== LIVE claude pane(s) ===");
  const socks = tmuxSockets();
  let any = false;
  for (const sock of socks) {
    const ls = asComis(`tmux -S ${sock} ls 2>/dev/null`).trim();
    if (!ls) continue;
    for (const line of ls.split("\n")) {
      const sess = line.split(":")[0];
      if (!sess) continue;
      any = true;
      console.log(`--- ${sess} (socket ${sock.split("/").pop()}) ---`);
      const pane = asComis(`tmux -S ${sock} capture-pane -t ${sess} -p 2>/dev/null`);
      console.log(pane.split("\n").filter((l) => l.trim()).slice(-18).join("\n"));
    }
  }
  if (!any) console.log("  (no live tmux drive session)");
}

function doSecrets() {
  console.log("=== JAIL secret-residency (jailed claude /proc/environ; expect ALL 0) ===");
  const pids = claudePids();
  if (pids.length === 0) { console.log("  (no jailed claude process alive)"); return; }
  const SECRET_RE = /SECRETS_MASTER_KEY=|COMIS_GATEWAY_TOKEN=|^GWTOKEN=|GATEWAY_TOKEN_|ANTHROPIC_API_KEY=|sk-ant-/;
  const KEEP_RE = /^(HOME|PATH)=/;
  for (const pid of pids) {
    let environ;
    try { environ = readFileSync(`/proc/${pid}/environ`, "utf8"); } catch { console.log(`  PID ${pid}: /proc unreadable (gone?)`); continue; }
    const vars = environ.split("\0").filter(Boolean);
    const leaked = vars.filter((v) => SECRET_RE.test(v)).length;
    const keep = vars.filter((v) => KEEP_RE.test(v)).length;
    const verdict = leaked === 0 ? "GREEN (0 daemon secrets)" : `LEAK ×${leaked} — HARD ORACLE FAIL`;
    console.log(`  PID ${pid}: secret-vars=${leaked} [${verdict}], keep-vars(HOME/PATH)=${keep}`);
  }
}

function doLifecycle() {
  console.log(`=== drive lifecycle from the daemon log${sessionFilter ? ` (session~${sessionFilter})` : ""} ===`);
  const logs = latestDaemonLogs();
  if (logs.length === 0) { console.log("  (no daemon log found)"); return; }
  const grepFilter = sessionFilter ? ` | grep ${JSON.stringify(sessionFilter)}` : "";
  const raw = asComis(`cat ${logs.join(" ")} 2>/dev/null${grepFilter}`);
  const markers = [
    ["terminal session created", "created"],
    ["drive promoted to a backgrounded", "promoted"],
    ["drive_continue_dispatched", "continue-dispatched"],
    ["terminal drive finished its current work", "settled(awaiting-input)"],
    ["terminal session evicted", "EVICTED"],
    ["reaped and recorded an honest failure", "REAPED(never-tasked honest-fail)"],
    ["terminal drive re-attached", "re-attached"],
    ["webhook drive stranded", "stranded"],
  ];
  const lines = raw.split("\n");
  let any = false;
  for (const line of lines) {
    for (const [needle, label] of markers) {
      if (line.includes(needle)) {
        any = true;
        const time = (line.match(/"time":"([0-9T:.-]+)/) || [])[1] || "";
        const reason = (line.match(/"(?:reason|capName)":"([a-z_]+)"/) || [])[1] || "";
        const success = (line.match(/"success":(true|false)/) || [])[1];
        console.log(`  ${time}  ${label}${reason ? ` reason=${reason}` : ""}${success !== undefined ? ` success=${success}` : ""}`);
        break;
      }
    }
  }
  if (!any) console.log("  (no drive-lifecycle records — is the drive on this daemon's log? check rotation)");
  // The honest-fail + idle-reap COUNTS (the health-sweep read).
  const evictions = (raw.match(/terminal session evicted/g) || []).length;
  const reaps = (raw.match(/reaped and recorded an honest failure/g) || []).length;
  console.log(`  totals: evictions=${evictions} never-tasked-reaps=${reaps}`);
}

function doProgress() {
  if (!project) { console.log("=== progress: pass a projectName to read git + ROADMAP ==="); return; }
  const P = `${DATA}/workspace/projects/${project}`;
  console.log(`=== coding progress: ${project} ===`);
  if (!asComis(`test -d ${P} && echo yes`).trim()) { console.log("  (no such project)"); return; }
  const commits = asComis(`cd ${P} && git rev-list --count HEAD 2>/dev/null`).trim();
  const log = asComis(`cd ${P} && git log --oneline -6 2>/dev/null`).trim();
  const topPhases = asComis(`grep -cE '\\[x\\] \\*\\*Phase' ${P}/.planning/ROADMAP.md 2>/dev/null`).trim();
  const codeFiles = asComis(`ls ${P}/*.js ${P}/*.html ${P}/*.css ${P}/src/*.js 2>/dev/null | wc -l`).trim();
  console.log(`  commits=${commits}  topLevelPhasesDone=${topPhases}  codeFiles=${codeFiles}`);
  if (log) console.log("  recent commits:\n" + log.split("\n").map((l) => "    " + l).join("\n"));
}

const run = { screen: doScreen, secrets: doSecrets, lifecycle: doLifecycle, progress: doProgress };
function onePass() {
  if (mode === "all") { doScreen(); console.log(); doSecrets(); console.log(); doLifecycle(); console.log(); doProgress(); }
  else if (run[mode]) run[mode]();
  else { console.error(`unknown mode '${mode}' — use screen|secrets|lifecycle|progress|all`); process.exit(2); }
}

if (!(watchSec > 0)) {
  onePass();
} else {
  // DRIVE-POLL loop — re-run every watchSec seconds, each pass timestamp-headed, until Ctrl-C.
  process.on("SIGINT", () => { console.log("\n[watch] stopped."); process.exit(0); });
  // eslint-disable-next-line no-constant-condition
  for (let pass = 1; ; pass++) {
    console.log(`\n──────── watch pass #${pass} @ ${new Date().toISOString()} (every ${watchSec}s, Ctrl-C to stop) ────────`);
    onePass();
    await sleep(watchSec * 1000);
  }
}
