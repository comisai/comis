#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// browser-oracle.mjs — the CHEAP, zero-dep half of the browser "it actually runs" oracle for a
// webhook→claude drive that built a static web app (the Snake game, any HTML5/canvas/JS artifact).
//
// A prior run proved such a game via the chrome-devtools MCP (real render +
// arrow-key interaction) — but nearly logged a FALSE DEFECT twice because the render check is subtle
// (a game that auto-runs into a wall in ~1.25s reads as a "static" canvas if you screenshot too late).
// The lesson: gate the EXPENSIVE, timing-sensitive browser check behind a CHEAP, deterministic one that
// catches the common "blank page" causes FIRST — a syntax error, a broken <script src>, a wrong-case
// asset path, a 404 on a referenced file. Those need no browser and no timing; this script does them.
//
// WHAT IT CHECKS (all zero-dep, Node builtins only):
//   1. compile   — `node --check` every local .js the page references or that lives in the dir
//   2. refs      — every <script src> / <link href> / relative asset RESOLVES to a file on disk
//   3. serve     — boots a static server, fetches "/" + each referenced asset, asserts HTTP 200
//   Then it PRINTS the chrome-devtools MCP recipe (the render/interaction half you run next).
//
// Usage:   node browser-oracle.mjs <projectDir> [--port 8137] [--entry index.html]
//   Exit 0 = the cheap gate is GREEN (proceed to the MCP render check); non-zero = a named blocker.
//   Runs wherever the built files are (locally after a pull, or on the VPS project dir).

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve, extname, relative } from "node:path";
import { execFileSync } from "node:child_process";
import http from "node:http";

const args = process.argv.slice(2);
const dir = resolve(args.find((a) => !a.startsWith("--")) || ".");
// Guard the flag lookups with `>= 0` — a bare `indexOf(flag) + 1` reads args[0] (the DIR) when the
// flag is absent, so `Number(dir)` → NaN → ERR_SOCKET_BAD_PORT (caught live).
const portIdx = args.indexOf("--port");
const port = portIdx >= 0 ? Number(args[portIdx + 1]) : 8137;
const entryIdx = args.indexOf("--entry");
const entry = entryIdx >= 0 ? args[entryIdx + 1] : "index.html";

let fails = 0;
const pass = (t, m) => console.log(`  \x1b[32mPASS\x1b[0m  ${t.padEnd(10)} ${m}`);
const fail = (t, m) => { console.log(`  \x1b[31mFAIL\x1b[0m  ${t.padEnd(10)} ${m}`); fails++; };

if (!existsSync(dir) || !statSync(dir).isDirectory()) {
  console.error(`browser-oracle: not a directory: ${dir}`);
  process.exit(2);
}
const entryPath = join(dir, entry);
if (!existsSync(entryPath)) {
  console.error(`browser-oracle: entry '${entry}' not found in ${dir} (pass --entry <file>)`);
  process.exit(2);
}
console.log(`=== browser-oracle (dir=${dir}, entry=${entry}) ===`);

// Recursively list local files (skip node_modules/.git), cap to keep it a smoke check.
function walk(d, acc = []) {
  for (const name of readdirSync(d)) {
    if (name === "node_modules" || name === ".git") continue;
    const p = join(d, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else acc.push(p);
    if (acc.length > 500) break;
  }
  return acc;
}
const allFiles = walk(dir);

// 1) compile — node --check every local .js (module or classic; --check parses both)
const jsFiles = allFiles.filter((f) => extname(f) === ".js" || extname(f) === ".mjs");
if (jsFiles.length === 0) pass("compile", "no local .js files to check");
for (const f of jsFiles) {
  try { execFileSync(process.execPath, ["--check", f], { stdio: ["ignore", "ignore", "pipe"] }); pass("compile", relative(dir, f)); }
  catch (e) { fail("compile", `${relative(dir, f)} — ${String(e.stderr || e.message).split("\n").find((l) => l.includes("Error")) || "syntax error"}`); }
}

// 2) refs — every referenced local asset resolves on disk (the "blank page from a broken src" catch)
const html = readFileSync(entryPath, "utf8");
const refs = [...html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)]
  .map((m) => m[1])
  .filter((u) => !/^(https?:)?\/\//.test(u) && !u.startsWith("data:") && !u.startsWith("#") && !u.startsWith("mailto:"));
const referencedAssets = [];
for (const ref of refs) {
  const clean = ref.split(/[?#]/)[0].replace(/^\.?\//, "");
  const p = join(dir, clean);
  if (existsSync(p)) { pass("refs", `${ref} → exists`); referencedAssets.push(clean); }
  else fail("refs", `${ref} → MISSING on disk (broken <script/link>? wrong case?)`);
}
if (refs.length === 0) pass("refs", "no local asset references in entry (inline-only page)");

// 3) serve — boot a static server, fetch "/" + each asset, assert 200
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml" };
const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  const rel = urlPath === "/" ? entry : urlPath.replace(/^\//, "");
  const p = join(dir, rel);
  if (!p.startsWith(dir) || !existsSync(p) || statSync(p).isDirectory()) { res.statusCode = 404; res.end("not found"); return; }
  res.setHeader("content-type", MIME[extname(p)] || "application/octet-stream");
  res.end(readFileSync(p));
});

await new Promise((res) => server.listen(port, "127.0.0.1", res));
const base = `http://127.0.0.1:${port}`;
async function probe(path) {
  try {
    const r = await fetch(`${base}${path}`);
    if (r.status === 200) pass("serve", `${path} → 200 (${r.headers.get("content-type")})`);
    else fail("serve", `${path} → ${r.status}`);
  } catch (e) { fail("serve", `${path} → ${e.message}`); }
}
await probe("/");
for (const a of referencedAssets) await probe(`/${a}`);
server.close();

console.log();
console.log(`--- NEXT: the render/interaction oracle (chrome-devtools MCP) — the timing-sensitive half ---`);
console.log(`  1. new_page("${base}/") after re-serving (this script closed its server), OR serve the dir yourself.`);
console.log(`  2. For an AUTO-RUNNING game, inject a trail recorder via navigate_page initScript BEFORE it starts,`);
console.log(`     e.g. hook the draw loop / record positions, so you read MOTION not a single late screenshot`);
console.log(`     (the snake-run false-defect: the game died into a wall in ~1.25s < your reload→screenshot latency).`);
console.log(`  3. evaluate_script to assert GAME STATE (score, snake length, gameOver) — structure, not pixels.`);
console.log(`  4. press_key ArrowUp/Down/Left/Right + re-read state to prove INTERACTION, not just first paint.`);
console.log(`  5. list_console_messages → assert ZERO uncaught errors (a runtime throw a static check can't see).`);
console.log();

if (fails === 0) { console.log(`\x1b[32m✅ browser-oracle cheap gate GREEN — proceed to the MCP render check\x1b[0m`); process.exit(0); }
else { console.log(`\x1b[31m❌ browser-oracle: ${fails} blocker(s) — fix before the browser render check\x1b[0m`); process.exit(1); }
