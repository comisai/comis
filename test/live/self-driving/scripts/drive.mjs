#!/usr/bin/env node
// Emulator driver v2 — inject a DM and wait for the agent's TURN TO END, capturing the last
// SUBSTANTIVE wire reply. v2 fixes the v1 friction (codex-30uc run 2026-06-25): v1 quiesced on the
// first non-🔧 message, but on a reasoning model that is almost always the agent's PLANNING CHECKLIST
// (`[ ] do X`) or a "running it now / GraphId Z" announcement — while the real work (research, build,
// DAG, sub-agents) finishes ASYNC past the drive's exit. v2:
//   1) treats checklists / "(step N of M)" / 🔧✓🤖❌ / "(running" / "reading ~" as PROGRESS (not the answer);
//   2) keys completion off the TRAJECTORY turn-end (a `session.summary` / `execution.aborted` appended
//      after inject) — the authoritative "this turn is done" signal — not wire-silence. Falls back to
//      answer-aware wire quiescence when the trajectory can't be resolved (graceful, byte-identical to v1).
//
// Usage:  node drive.mjs <chatId> "<text>" [quiesceMs=8000] [maxMs=240000] [DATA=/home/comis/.comis]
//   - DATA: data dir (for the trajectory turn-end watch). env DATA also honored. Empty → wire-only mode.
//   - NOTE the DAG caveat: a `pipeline`/`graph.execute` turn ENDS at the agent's "running it now" answer,
//     then the GRAPH runs separately — poll `graph.status`/the daemon log for the final node, not this.
import { readFileSync, readdirSync, statSync } from 'node:fs';
const [, , chatIdArg, text, quiesceMsArg, maxMsArg, dataArg] = process.argv;
const chatId = chatIdArg || '678314278';
const quiesceMs = Number(quiesceMsArg || 8000);
const maxMs = Number(maxMsArg || 240000);
// Guard the #1 mis-invocation (hindsight-reflection-20260626): passing DATA in the maxMs slot
// (arg order is chatId,text,quiesceMs,maxMs,DATA) makes maxMs=NaN → `while (… < NaN)` is false →
// the loop NEVER runs → an instant, SILENT false "0s [TIMEOUT] — NO SUBSTANTIVE ANSWER" on a reply
// that actually landed. Fail LOUD instead of fabricating a no-reply.
if (Number.isNaN(quiesceMs) || Number.isNaN(maxMs)) {
  console.error(`drive.mjs: non-numeric quiesceMs/maxMs (quiesceMs="${quiesceMsArg}", maxMs="${maxMsArg}"). ` +
    `Usage: drive.mjs <chatId> "<text>" [quiesceMs=8000] [maxMs=240000] [DATA=/home/comis/.comis]`);
  process.exit(2);
}
const DATA = dataArg || process.env.DATA || '/home/comis/.comis';
// FROMUSER (env) — drive a chat as a DIFFERENT sender than the chatId. The session/trajectory stays
// keyed by chatId, but the inbound message author is FROMUSER. Lets one trusted sender drive N distinct
// chat-SESSIONS (reflection anti-domination cardinality is distinct (sessionId, sender) — so two chats
// from the SAME trusted sender = card 2, with SHARED memory + trusted origin + no cross-sender recall
// pollution / no per-sender priming). Default: fromUserId == chatId (v2 behavior). (dispatch-learning-20260627)
const fromUser = process.env.FROMUSER ? Number(process.env.FROMUSER) : Number(chatId);
const emu = JSON.parse(readFileSync('/tmp/comis-emu.json', 'utf8'));
const base = emu.apiRoot;

const getOutbound = async (after, waitMs) =>
  (await fetch(`${base}/control/chats/${chatId}/outbound?afterMessageId=${after}&waitMs=${waitMs}`)).json();
const inject = async (t) =>
  (await fetch(`${base}/control/chats/${chatId}/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fromUserId: fromUser, text: t }),
  })).json();

// v2: a message is PROGRESS (not the final answer) if it's a tool/announce/checklist/plan line.
const isProgress = (t) =>
  !t ||
  /^(🔧|✓|🤖|❌|⏳)/.test(t) ||
  /\(running/.test(t) || /reading ~/.test(t) ||
  /^\s*\[[ x~]\]/.test(t) ||                 // markdown checklist:  [ ] / [~] / [x]
  /\(step \d+ of \d+\)/i.test(t) ||          // "(step 1 of 3)"
  /^\s*───\s*$/.test(t);

// --- trajectory turn-end watch (authoritative completion signal) ---
const resolveTraj = () => {
  try {
    const dir = `${DATA}/workspace/sessions/default/${chatId}`;
    const f = readdirSync(dir)
      .filter((n) => n.endsWith('.jsonl.trajectory.jsonl'))
      .map((n) => ({ n, m: statSync(`${dir}/${n}`).mtimeMs }))
      .sort((a, b) => b.m - a.m)[0];
    return f ? `${dir}/${f.n}` : null;
  } catch { return null; }
};
const trajLineCount = (p) => { try { return readFileSync(p, 'utf8').split('\n').length; } catch { return 0; } };
const turnEndedSince = (p, baseLines) => {
  try {
    const lines = readFileSync(p, 'utf8').split('\n').slice(baseLines);
    for (const l of lines) {
      if (l.includes('"type":"session.summary"') || l.includes('"type":"execution.aborted"')) return true;
    }
  } catch {
    /* best-effort: missing or mid-write trajectory file → treat as not ended */
  }
  return false;
};

const trajPath = resolveTraj();
const trajBase = trajPath ? trajLineCount(trajPath) : 0;

const initial = await getOutbound(0, 1);
let after = initial.reduce((m, o) => Math.max(m, o.messageId || 0), 0);
const inj = await inject(text);
process.stderr.write(`injected inboundId=${inj.messageId}, polling after ${after}; trajectory=${trajPath ? 'watched' : 'NONE (wire-only)'}\n`);

const seen = [];
let sawAnswer = false, turnEnded = false, lastNew = Date.now();
const start = Date.now();
while (Date.now() - start < maxMs) {
  // long-poll pre-answer (ride out reasoning gaps); snappy once the answer is in.
  const waitMs = sawAnswer ? quiesceMs : 20000;
  const batch = await getOutbound(after, waitMs);
  if (batch.length) {
    for (const o of batch) {
      seen.push(o); after = Math.max(after, o.messageId || after);
      if (o.method === 'sendMessage' && !isProgress(o.text)) sawAnswer = true;
    }
    lastNew = Date.now();
  }
  // Authoritative stop: the agent TURN ended in the trajectory (work done, incl. empty-final / abort).
  if (trajPath && turnEndedSince(trajPath, trajBase)) { turnEnded = true; }
  if (turnEnded) {
    // drain any just-delivered final message, then stop
    const tail = await getOutbound(after, 2500);
    for (const o of tail) { seen.push(o); after = Math.max(after, o.messageId || after); if (o.method === 'sendMessage' && !isProgress(o.text)) sawAnswer = true; }
    break;
  }
  if (sawAnswer && Date.now() - lastNew >= quiesceMs) break;
}
const reason = turnEnded ? 'turn-ended(trajectory)' : sawAnswer ? 'answer+quiesce' : 'TIMEOUT';
console.log(`=== ALL OUTBOUND (${seen.length}) in ${Math.round((Date.now() - start) / 1000)}s [${reason}]${sawAnswer ? '' : ' — NO SUBSTANTIVE ANSWER'} ===`);
for (const o of seen) console.log(`[${o.method} ${o.messageId}] ${JSON.stringify((o.text || '').slice(0, 600))}`);
console.log('=== SUBSTANTIVE ANSWER ===');
let any = false;
for (const o of seen) if (o.method === 'sendMessage' && !isProgress(o.text)) { console.log(o.text); any = true; }
if (!any) console.log(`[NO SUBSTANTIVE ANSWER — ${turnEnded ? 'turn ended with no chat delivery (empty-final/abort?) — read the trajectory' : 'timed out'}]`);
