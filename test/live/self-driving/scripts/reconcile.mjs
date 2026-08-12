#!/usr/bin/env node
// reconcile.mjs — the numeric-reconciliation GROUND-TRUTH digest for a driven chat (run on the VPS).
//
// WHY THIS EXISTS (the trading-desk campaign's flagship-oracle helper the kit lacked): a naive
// "grep the .trajectory.jsonl for the reply's digits" FAILS — the trajectory `tool.result` record
// carries PROVENANCE ONLY (toolName / toolCallId / success / durationMs), never the result payload.
// The VALUE the agent saw lives in the RAW session `.jsonl` (wrapExternalContent-wrapped tool
// results). This helper reads BOTH: trajectory for provenance (which tool ran, served model, recall)
// and the raw session for the numbers to reconcile the reply against. It also reads the emulator's
// recorded outbound surface so a post-execution correction is not confused with the model draft.
//
// Usage: node reconcile.mjs <chatId> [dataDir=/home/comis/.comis] [threadId]
//   Prints a compact digest; digits are ASCII-safe to grep, Hebrew is \u-escaped (do not grep prose).
//   Exit 0 always (a read-only oracle) — the CALLER decides pass/fail by reconciling the printed sets.
import { readFileSync, existsSync } from "node:fs";
import { rig } from "./_rig.mjs";
import { reconcileAssistantSurfaces } from "./drive-session-oracle.mjs";
import { resolveChatSessionArtifacts } from "./session-artifact-ref.mjs";

const chatId = process.argv[2] || rig.chatId;
const DATA = process.argv[3] || rig.dataDir;
const threadArg = process.argv[4];
const threadId = threadArg === undefined ? undefined : Number(threadArg);
const decimals = (s) => [...new Set((s.match(/-?\d[\d,]*\.\d{1,6}/g) || []).map((x) => x.replace(/,/g, "")))];

// Resolve through structured provenance. Privacy-principal session directories
// do not contain the physical Telegram chat id, so a guessed legacy path is not
// an authority-bearing lookup.
const artifacts = resolveChatSessionArtifacts(DATA, String(chatId), threadId);
const trajFile = artifacts?.trajectoryFile;
const sessFile = artifacts?.sessionFile;
if (!trajFile) {
  console.log(`NO trajectory for Telegram chat ${chatId} under ${DATA}/workspace/sessions`);
  process.exit(0);
}

// --- trajectory: provenance (scoped to the LAST turn — a session file accumulates turns) ---
const tlinesAll = readFileSync(trajFile, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
let lastPrompt = -1;
for (let i = 0; i < tlinesAll.length; i++) if (tlinesAll[i].type === "prompt.submitted") lastPrompt = i;
const tlines = lastPrompt >= 0 ? tlinesAll.slice(lastPrompt) : tlinesAll;
const turns = tlinesAll.filter((r) => r.type === "prompt.submitted").length;
const tools = [], served = new Set(); let recalled = 0;
for (const r of tlines) {
  const d = r.data || {};
  if (r.type === "tool.call") tools.push({ name: d.toolName || d.tool || "?", call: (d.toolCallId || "").slice(0, 12) });
  if (r.type === "tool.result") { const t = tools.find((x) => x.call === (d.toolCallId || "").slice(0, 12)); if (t) { t.ok = d.success; t.ms = d.durationMs; } }
  if (r.type === "model.completed") { if (r.modelId) served.add(r.modelId); if (d.model) served.add(d.model); if (d.servedModel) served.add(d.servedModel); if (d.capabilityClass) served.add("class:" + d.capabilityClass); }
  if (r.type === "memory.recalled") recalled += (d.finalCount ?? d.count ?? d.results?.length ?? 0);
}

// --- raw session: the VALUES the model saw (tool results) + last assistant draft ---
let sessNums = [], lastAssistant = "";
if (sessFile && existsSync(sessFile)) {
  const raw = readFileSync(sessFile, "utf8");
  sessNums = decimals(raw);
  const slines = raw.split("\n").filter(Boolean);
  for (const l of slines) { try { const o = JSON.parse(l); const role = o.role || o.message?.role; if (role === "assistant") { const c = o.content || o.message?.content; const txt = typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => p.text || "").join(" ") : ""; if (txt.trim()) lastAssistant = txt; } } catch { /* skip a malformed session line */ } }
}

// --- emulator: the actual user-visible Telegram reply ---
let outbound = [];
let wireAvailable = false;
try {
  const wiring = JSON.parse(readFileSync(rig.emuWiringPath, "utf8"));
  if (typeof wiring.apiRoot === "string" && wiring.apiRoot.length > 0) {
    const response = await fetch(
      `${wiring.apiRoot}/control/chats/${encodeURIComponent(chatId)}/outbound?afterMessageId=0&waitMs=0`,
    );
    const body = await response.json();
    if (response.ok && Array.isArray(body)) {
      outbound = body;
      wireAvailable = true;
    }
  }
} catch {
  // The digest remains useful offline, but must say the wire surface was unavailable.
}
const assistantSurfaces = reconcileAssistantSurfaces(lastAssistant, outbound, threadId);

// --- book + conservation invariant ---
let book = null, inv = null;
const bookPath = `${DATA}/workspace/trading/portfolio.json`;
if (existsSync(bookPath)) {
  try {
    book = JSON.parse(readFileSync(bookPath, "utf8"));
    // Cost basis per position — schema-robust: prefer an explicit cost_basis, else shares/qty × price.
    // (gpt-5.6-sol books positions as {quantity, average_cost, cost_basis}; the SEED schema names them
    // {shares, entry_price}. A field-name mismatch here silently FALSE-FLAGS the invariant as broken.)
    const posCost = (p) => (typeof p.cost_basis === "number" ? p.cost_basis
      : (p.shares ?? p.quantity ?? 0) * (p.entry_price ?? p.average_cost ?? p.avg_price ?? p.cost ?? 0));
    const cost = Object.values(book.positions || {}).reduce((a, p) => a + posCost(p), 0);
    inv = Math.round(((book.cash || 0) + cost + (book.realized_pnl || 0) - (book.starting_cash || 0)) * 100) / 100;
  } catch (e) { book = { error: e.message }; }
}

console.log(`# reconcile chat=${chatId}  (turn ${turns} of ${turns} — LAST-turn scoped)`);
console.log(`traj=${trajFile.split("/").pop()}`);
console.log(`served=${[...served].join(",") || "?"}  recall.rows=${recalled}`);
console.log(`tools[last-turn]=${tools.map((t) => `${t.name}${t.ok === false ? "✗" : ""}${t.ms != null ? "(" + t.ms + "ms)" : ""}`).join(" ") || "none"}`);
console.log(`session.tool_numbers(${sessNums.length})= ${sessNums.slice(0, 40).join(" ")}`);
if (book) console.log(`book: cash=${book.cash} start=${book.starting_cash} positions=${Object.keys(book.positions || {}).length} trade_log=${(book.trade_log || []).length} realized=${book.realized_pnl ?? 0}  INVARIANT=${inv}${inv === 0 ? " ✓" : " ✗BROKEN"}`);
console.log(`last_assistant_session_draft(${assistantSurfaces.sessionDraft.length}c)= ${assistantSurfaces.sessionDraft.replace(/\s+/g, " ").slice(0, 400)}`);
if (wireAvailable && assistantSurfaces.wireReply !== null) {
  console.log(`last_assistant_wire(${assistantSurfaces.wireReply.length}c)= ${assistantSurfaces.wireReply.replace(/\s+/g, " ").slice(0, 400)}`);
} else {
  console.log("last_assistant_wire(UNAVAILABLE)= emulator outbound did not provide a substantive reply");
}
