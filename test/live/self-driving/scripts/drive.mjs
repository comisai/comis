#!/usr/bin/env node
// Emulator driver v2 — inject a DM and wait for the agent's TURN TO END, capturing the last
// SUBSTANTIVE wire reply. v2 fixes the v1 friction: v1 quiesced on the
// first non-🔧 message, but on a reasoning model that is almost always the agent's PLANNING CHECKLIST
// (`[ ] do X`) or a "running it now / GraphId Z" announcement — while the real work (research, build,
// DAG, sub-agents) finishes ASYNC past the drive's exit. v2:
//   1) treats checklists / "(step N of M)" / 🔧✓🤖❌ / "(running" / "reading ~" as PROGRESS (not the answer);
//   2) keys completion off the TRAJECTORY turn-end (a `session.summary` / `execution.aborted` appended
//      after inject) — the authoritative "this turn is done" signal — not wire-silence. Falls back to
//      answer-aware wire quiescence when the trajectory can't be resolved (graceful, byte-identical to v1).
//
// Usage:  node drive.mjs <chatId> "<text>" [quiesceMs=8000] [maxMs=240000] [DATA=/home/comis/.comis]
//         printf '<one-line text>\n' | node drive.mjs <chatId> -
//         node drive.mjs <chatId> @/path/to/message.txt
//   - DATA: data dir (for the trajectory turn-end watch). env DATA also honored. Empty → wire-only mode.
//   - INJECT_OPTS: optional JSON object carrying Telegram mention/reply/thread metadata, for example
//     `{"mention":true,"replyTo":42,"thread":7}`. The control route validates the closed shape.
//   - Use `-` or `@/absolute/file` for credential-bearing prompts so values never enter argv/process listings.
//   - NOTE the DAG caveat: a `pipeline`/`graph.execute` turn ENDS at the agent's "running it now" answer,
//     then the GRAPH runs separately — poll `graph.status`/the daemon log for the final node, not this.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { rig } from './_rig.mjs';
import {
  driveTextFilePath,
  findAssistantReplyAfterInbound,
  outboundVisibleText,
  selectMainTrajectoryPath,
  telegramInboundGuid,
  telegramInjectAddressingError,
  wireContainsAssistantReply,
} from './drive-session-oracle.mjs';
const [, , chatIdArg, textArg, quiesceMsArg, maxMsArg, dataArg] = process.argv;

const readStdinLine = async () => {
  const lines = createInterface({ input: process.stdin, terminal: false });
  const next = await lines[Symbol.asyncIterator]().next();
  lines.close();
  return next.done ? '' : next.value;
};

const textFilePath = driveTextFilePath(textArg);
const text = textArg === '-'
  ? await readStdinLine()
  : textFilePath !== undefined
    ? readFileSync(textFilePath, 'utf8')
    : textArg;
if (!text) {
  console.error('drive.mjs: message text is required; pass text, `-` for one stdin line, or `@/absolute/file`');
  process.exit(2);
}
const chatId = chatIdArg || rig.chatId;
const quiesceMs = Number(quiesceMsArg || 8000);
const maxMs = Number(maxMsArg || 240000);
// Guard the #1 mis-invocation: passing DATA in the maxMs slot
// (arg order is chatId,text,quiesceMs,maxMs,DATA) makes maxMs=NaN → `while (… < NaN)` is false →
// the loop NEVER runs → an instant, SILENT false "0s [TIMEOUT] — NO SUBSTANTIVE ANSWER" on a reply
// that actually landed. Fail LOUD instead of fabricating a no-reply.
if (Number.isNaN(quiesceMs) || Number.isNaN(maxMs)) {
  console.error(`drive.mjs: non-numeric quiesceMs/maxMs (quiesceMs="${quiesceMsArg}", maxMs="${maxMsArg}"). ` +
    `Usage: drive.mjs <chatId> "<text>" [quiesceMs=8000] [maxMs=240000] [DATA=/home/comis/.comis]`);
  process.exit(2);
}
const DATA = dataArg || rig.dataDir;
let injectOpts;
if (process.env.INJECT_OPTS) {
  try {
    injectOpts = JSON.parse(process.env.INJECT_OPTS);
  } catch {
    console.error("drive.mjs: INJECT_OPTS must be a valid JSON object");
    process.exit(2);
  }
  if (injectOpts === null || typeof injectOpts !== "object" || Array.isArray(injectOpts)) {
    console.error("drive.mjs: INJECT_OPTS must be a JSON object");
    process.exit(2);
  }
}
// FROMUSER (env) — drive a chat as a DIFFERENT sender than the chatId. The session/trajectory stays
// keyed by chatId, but the inbound message author is FROMUSER. Lets one trusted sender drive N distinct
// chat-SESSIONS (reflection anti-domination cardinality is distinct (sessionId, sender) — so two chats
// from the SAME trusted sender = card 2, with SHARED memory + trusted origin + no cross-sender recall
// pollution / no per-sender priming). Default: fromUserId == chatId.
const fromUser = process.env.FROMUSER ? Number(process.env.FROMUSER) : Number(chatId);
const sharedConversation = Number(chatId) < 0;
const emu = JSON.parse(readFileSync(rig.emuWiringPath, 'utf8'));
const base = emu.apiRoot;
const tenantId = process.env.TENANT_ID || 'default';
const agentId = process.env.AGENT_ID || 'default';

// A parallel drive must watch only its own canonical-principal trajectory. Selecting the globally
// newest file lets one conversation stop on another conversation's session.summary and fabricates
// an early completion. Resolve the same assertion key as channel ingress, then fail loudly if the
// emulator identity cannot be established.
const botResponse = await fetch(`${base}/bot${emu.botToken}/getMe`);
const botBody = await botResponse.json();
if (!botResponse.ok || botBody?.ok !== true || !botBody?.result?.id) {
  console.error('drive.mjs: emulator getMe did not return a bot id');
  process.exit(2);
}
const addressingError = telegramInjectAddressingError(
  text,
  injectOpts,
  botBody.result.username,
);
if (addressingError !== undefined) {
  console.error(`drive.mjs: ${addressingError}`);
  process.exit(2);
}
const assertionFields = [tenantId, agentId, 'telegram', `telegram-${botBody.result.id}`, String(fromUser)];
const assertionKey = assertionFields.map((field) => `${Buffer.byteLength(field, 'utf8')}:${field}`).join('');
const expectedPrincipalId = `platform_${createHash('sha256').update(assertionKey, 'utf8').digest('base64url')}`;
const expectedTrajectorySuffix = `${expectedPrincipalId}~peer~${expectedPrincipalId}.jsonl.trajectory.jsonl`;

// Resilient long-poll: a loaded machine or a long slow-model turn (a cold local 35b can run >200s)
// can transiently ETIMEDOUT a fetch — a crash here aborts the WHOLE drive mid-turn.
// Retry a few times, then return [] so the poll loop keeps going (the
// trajectory turn-end / answer-quiesce is the real stop signal, not any single poll).
const getOutbound = async (after, waitMs) => {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(`${base}/control/chats/${chatId}/outbound?afterMessageId=${after}&waitMs=${waitMs}`);
      return await r.json();
    } catch (e) {
      if (attempt >= 4) { process.stderr.write(`getOutbound transient-fail x5 (${e?.message || e}) — returning [] to continue\n`); return []; }
      await new Promise((res) => setTimeout(res, 1000));
    }
  }
};
const inject = async (t) =>
  (await fetch(`${base}/control/chats/${chatId}/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fromUserId: fromUser, text: t, opts: injectOpts }),
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
    const dir = `${DATA}/workspace/sessions`;
    const files = [];
    const visit = (current) => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const path = `${current}/${entry.name}`;
        if (entry.isDirectory()) visit(path);
        else if (entry.name.endsWith('.jsonl.trajectory.jsonl')) files.push(path);
      }
    };
    visit(dir);
    return selectMainTrajectoryPath(
      files.map((path) => ({ path, mtimeMs: statSync(path).mtimeMs })),
      dir,
      tenantId,
      "telegram",
      expectedTrajectorySuffix,
    );
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

// `let` (not const): on a FRESH session the trajectory file does not exist until the turn
// STARTS — which is AFTER inject() below — so this one-shot pre-inject resolve returns null and
// the drive would stay in wire-only mode for the WHOLE first turn, silently abandoning the
// AUTHORITATIVE turn-end signal in favour of wire-quiescence (premature-quiesce risk on a slow
// model that pauses > quiesceMs between tool calls with no wire output). The loop re-resolves
// lazily once the file appears. (On a clean slate the first delivery logs
// `trajectory=NONE (wire-only)`.)
let trajPath = resolveTraj();
let trajBase = trajPath ? trajLineCount(trajPath) : 0;

const initial = await getOutbound(0, 1);
let after = initial.reduce((m, o) => Math.max(m, o.messageId || 0), 0);
const inj = await inject(text);
const normalizedInboundId = telegramInboundGuid(
  Number(botBody.result.id),
  Number(chatId),
  Number(inj.messageId),
);
process.stderr.write(`injected inboundId=${inj.messageId}, polling after ${after}; trajectory=${trajPath ? 'watched' : 'NONE (wire-only)'}\n`);

const seen = [];
let sawAnswer = false, turnEnded = false, lastNew = Date.now();
let correlatedAnswer = null;
let correlatedSessionPath = null;
const start = Date.now();

const sessionFiles = () => {
  const files = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = `${current}/${entry.name}`;
      if (entry.isDirectory()) visit(path);
      else if (
        entry.name.endsWith('.jsonl') &&
        !entry.name.endsWith('.trajectory.jsonl') &&
        !entry.name.endsWith('_session-metadata.jsonl')
      ) files.push(path);
    }
  };
  visit(`${DATA}/workspace/sessions`);
  return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
};

const resolveCorrelatedAnswer = () => {
  if (!sharedConversation || !DATA) return null;
  try {
    const candidates = correlatedSessionPath ? [correlatedSessionPath] : sessionFiles();
    for (const path of candidates) {
      const source = readFileSync(path, 'utf8');
      if (!source.includes(normalizedInboundId)) continue;
      correlatedSessionPath = path;
      return findAssistantReplyAfterInbound(source, normalizedInboundId);
    }
  } catch {
    /* Session persistence can race the poll; retry on the next iteration. */
  }
  return null;
};

while (Date.now() - start < maxMs) {
  // long-poll pre-answer (ride out reasoning gaps); snappy once the answer is in.
  const waitMs = sawAnswer ? quiesceMs : 20000;
  const batch = await getOutbound(after, waitMs);
  if (batch.length) {
    for (const o of batch) {
      seen.push(o); after = Math.max(after, o.messageId || after);
      const visibleText = outboundVisibleText(o);
      if (visibleText && !isProgress(visibleText)) sawAnswer = true;
    }
    lastNew = Date.now();
  }
  if (sharedConversation) {
    correlatedAnswer = resolveCorrelatedAnswer();
    if (correlatedAnswer && wireContainsAssistantReply(seen, correlatedAnswer)) break;
    continue;
  }
  // Lazily pick up the trajectory once the turn creates it (fresh-session first turn — see the
  // `let trajPath` note). base=0 is correct here: we only land here when the pre-inject resolve
  // found nothing, i.e. a brand-new session with no prior turn's session.summary to false-match.
  if (!trajPath) {
    const late = resolveTraj();
    if (late) { trajPath = late; trajBase = 0; process.stderr.write(`trajectory resolved late: ${late.split('/').pop()} — switching to authoritative turn-end watch\n`); }
  }
  // Authoritative stop: the agent TURN ended in the trajectory (work done, incl. empty-final / abort).
  if (trajPath && turnEndedSince(trajPath, trajBase)) { turnEnded = true; }
  if (turnEnded) {
    // drain any just-delivered final message, then stop
    const tail = await getOutbound(after, 2500);
    for (const o of tail) {
      seen.push(o);
      after = Math.max(after, o.messageId || after);
      const visibleText = outboundVisibleText(o);
      if (visibleText && !isProgress(visibleText)) sawAnswer = true;
    }
    break;
  }
  if (sawAnswer && Date.now() - lastNew >= quiesceMs) break;
}
// A 0-outbound "timeout" is often NOT a wedge: an unauthorized sender (FROMUSER
// not in the agent's allowFrom list) is rejected at the auth layer BEFORE any
// agent turn, so there is correctly no reply. Distinguish that from a real hang
// by checking the daemon log for the block naming THIS sender — else the driver
// reports a misleading "[TIMEOUT] — NO SUBSTANTIVE ANSWER" on a correct security
// block, which otherwise looks like a missing substantive answer.
const detectAllowFromBlock = () => {
  if (seen.length > 0 || sawAnswer || turnEnded || !DATA) return null;
  try {
    const logDir = `${DATA}/logs`;
    const logs = readdirSync(logDir)
      .filter((f) => f.startsWith('daemon') && f.endsWith('.log'))
      .map((f) => `${logDir}/${f}`)
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    for (const lf of logs.slice(0, 3)) {
      const tail = readFileSync(lf, 'utf8').split('\n').slice(-400);
      for (let i = tail.length - 1; i >= 0; i--) {
        const line = tail[i];
        if (line.includes('Sender blocked by allowFrom filter') && line.includes(`"senderId":"${fromUser}"`)) {
          return `BLOCKED (allowFrom) — sender ${fromUser} not authorized; rejected at the auth layer, no agent turn (this is a correct security block, NOT a wedge)`;
        }
      }
    }
  } catch { /* no log access — fall through to the timeout reason */ }
  return null;
};
const allowFromBlock = detectAllowFromBlock();
const correlatedWireAnswer = correlatedAnswer
  ? wireContainsAssistantReply(seen, correlatedAnswer)
  : false;
const hasSubstantiveAnswer = sharedConversation ? correlatedWireAnswer : sawAnswer;
const reason = correlatedWireAnswer
  ? 'correlated-session-answer'
  : turnEnded
    ? 'turn-ended(trajectory)'
    : sawAnswer && !sharedConversation
      ? 'answer+quiesce'
      : allowFromBlock
        ? 'BLOCKED(allowFrom)'
        : 'TIMEOUT';
console.log(`=== ALL OUTBOUND (${seen.length}) in ${Math.round((Date.now() - start) / 1000)}s [${reason}]${hasSubstantiveAnswer ? '' : ' — NO SUBSTANTIVE ANSWER'} ===`);
for (const o of seen) console.log(`[${o.method} ${o.messageId}] ${JSON.stringify(outboundVisibleText(o).slice(0, 600))}`);
console.log('=== SUBSTANTIVE ANSWER ===');
let any = false;
if (correlatedWireAnswer) {
  console.log(correlatedAnswer);
  any = true;
} else if (!sharedConversation) {
  for (const o of seen) {
    const visibleText = outboundVisibleText(o);
    if (visibleText && !isProgress(visibleText)) {
      console.log(visibleText);
      any = true;
    }
  }
}
if (!any) console.log(`[NO SUBSTANTIVE ANSWER — ${allowFromBlock ? allowFromBlock : turnEnded ? 'turn ended with no chat delivery (empty-final/abort?) — read the trajectory' : 'timed out'}]`);
