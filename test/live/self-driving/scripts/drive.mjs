#!/usr/bin/env node
// Emulator driver v2 — inject a DM and wait for the agent's TURN TO END, capturing the last
// SUBSTANTIVE wire reply. v2 fixes the v1 friction: v1 quiesced on the
// first non-🔧 message, but on a reasoning model that is almost always the agent's PLANNING CHECKLIST
// (`[ ] do X`) or a "running it now / GraphId Z" announcement — while the real work (research, build,
// DAG, sub-agents) finishes ASYNC past the drive's exit. v2:
//   1) treats checklists / "(step N of M)" / 🔧✓🤖❌ / "(running" / "reading ~" as PROGRESS (not the answer);
//   2) keys completion off the TRAJECTORY turn-end (a `session.summary` / `execution.aborted` appended
//      after inject), then drains a bounded post-turn delivery window because channel post-processing
//      can finish later. Falls back to answer-aware wire quiescence when the trajectory can't be resolved.
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
import { readFileSync, readdirSync, statSync, openSync, closeSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { comisDist, rig } from './_rig.mjs';
import {
  directConversationFinished,
  driveTextFilePath,
  findAssistantReplyAfterInbound,
  findTelegramConversationWireAnswer,
  isDriveProgressText,
  normalizedInboundTextError,
  outboundVisibleText,
  reconcileDriveOutbound,
  selectMainTrajectoryPath,
  selectTelegramConversationTrajectoryPath,
  sharedConversationFinished,
  telegramInboundGuid,
  telegramInjectAddressingError,
  trajectoryTurnEnded,
  wireContainsAssistantReply,
  wireQuiescenceFinished,
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
const { MAX_NORMALIZED_MESSAGE_TEXT_CHARS } =
  await import(comisDist("core", "dist/index.js"));
const inboundTextError = normalizedInboundTextError(
  text,
  MAX_NORMALIZED_MESSAGE_TEXT_CHARS,
);
if (inboundTextError !== undefined) {
  console.error(
    `drive.mjs: ${inboundTextError}; split the text or send it as a document with media-drive.mjs`,
  );
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
// Guard the #2 mis-invocation: a sender the daemon will REFUSE at ingress.
// `channels.telegram.allowFrom` is an ingress allowlist, so a message from an unlisted sender is
// dropped before any turn starts. The emulator still accepts the injection and returns an inboundId,
// so the drive LOOKS healthy and then burns the whole `maxMs` before reporting "NO SUBSTANTIVE
// ANSWER" — indistinguishable from a wedged daemon. That cost a full 240s timeout plus a poll-loop
// investigation (ESTABLISHED long-poll, `state:"healthy"`, both correct) before the cause turned out
// to be a caller's `?? <invented-id>` fallback. The daemon itself logs the refusal honestly at INFO
// ("Sender blocked by allowFrom filter", errorKind:"auth", the failing senderId, content-free
// previewLen) — so the product was never at fault and the fix belongs here: fail BEFORE injecting
// rather than wait out a silence we can already predict.
try {
  const configText = readFileSync(`${DATA}/config.yaml`, 'utf8');
  const allowFromBlock = /allowFrom:\s*\n((?:\s*-\s*.*\n)+)/.exec(configText);
  if (allowFromBlock) {
    const allowed = [...allowFromBlock[1].matchAll(/-\s*"?([^"\s]+)"?/g)].map((m) => m[1]);
    // An empty allowFrom means allow-all; only a POPULATED list can refuse.
    if (allowed.length > 0 && !allowed.includes(String(fromUser))) {
      console.error(
        `drive.mjs: sender "${String(fromUser)}" is NOT in ${DATA}/config.yaml ` +
        `channels.telegram.allowFrom (${allowed.join(', ')}). The daemon will drop this inbound at ` +
        `the ingress gate, so this drive would time out after ${String(maxMs)}ms with a FALSE ` +
        `"no answer". Pass an allowed chatId, or set FROMUSER to an allowed sender.`);
      process.exit(2);
    }
  }
} catch {
  // Config unreadable (different layout/permissions) — never block a drive on the guard itself.
}
// --- per-conversation drive lock --------------------------------------------
// A DM reply carries NO correlation field (the wire payload is only
// {chat_id, parse_mode, text}), and `sharedConversation` correlation is enabled only for
// GROUP chats (negative id). So two concurrent drives on the SAME chat both accept the first
// non-progress message and BOTH report it — which manufactured a phantom "cross-turn answer
// bleed" during a live campaign (one driver reported the other's reply verbatim). Since the wire
// cannot disambiguate, serialize DMs and unthreaded chats instead of guessing. Telegram forum
// topics carry a thread id on every correlated outbound, so distinct topics may run concurrently;
// the lock still serializes two drives inside the same topic.
//
// SO: this helper is a SEQUENTIAL instrument, and firing N of them at one chat does NOT test
// concurrency — they serialize, and the row then reports "no interleaving" as a pass on a test that
// never ran concurrently. For a parallel / burst / mid-flight-steer row use `burst-inject.mjs`
// (injects without this lock, records each inbound identity) + `burst-verify.mjs`
// (`concurrency-oracle.mjs`: attributes each reply to its own inbound, refuses to guess when the
// transcript cannot, and PROVES overlap from the trajectory so a serialized run cannot pass).
const lockIdentity = Number(chatId) < 0 && injectOpts?.thread !== undefined
  ? `${chatId}-thread-${String(injectOpts.thread)}`
  : chatId;
const LOCK_PATH = `/tmp/comis-drive-${String(lockIdentity).replace(/[^0-9A-Za-z-]/g, '')}.lock`;
let lockFd;
const releaseLock = () => {
  if (lockFd === undefined) return;
  try { closeSync(lockFd); } catch { /* already closed */ }
  try { unlinkSync(LOCK_PATH); } catch { /* already removed */ }
  lockFd = undefined;
};
const holderAlive = () => {
  try {
    const pid = Number(readFileSync(LOCK_PATH, 'utf8').trim());
    if (!Number.isFinite(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch { return false; }
};
const acquireLock = async (waitMsMax = 900_000) => {
  const started = Date.now();
  let announced = false;
  for (;;) {
    try {
      lockFd = openSync(LOCK_PATH, 'wx');
      writeFileSync(LOCK_PATH, String(process.pid));
      return;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (!holderAlive()) { try { unlinkSync(LOCK_PATH); } catch { /* raced */ } continue; }
      if (Date.now() - started > waitMsMax) {
        throw new Error(
          `another drive has held ${LOCK_PATH} for >${Math.round(waitMsMax / 1000)}s; refusing to run concurrently in one conversation`,
          { cause: error },
        );
      }
      if (!announced) {
        process.stderr.write(`waiting for the drive lock on chat ${chatId} (another drive is in flight)\n`);
        announced = true;
      }
      await new Promise((resolve) => { setTimeout(resolve, 1500); });
    }
  }
};
for (const signal of ['exit', 'SIGINT', 'SIGTERM']) {
  process.on(signal, () => { releaseLock(); if (signal !== 'exit') process.exit(1); });
}
await acquireLock();

const sharedConversation = Number(chatId) < 0;
const emu = JSON.parse(readFileSync(rig.emuWiringPath, 'utf8'));
const base = emu.apiRoot;
const tenantId = process.env.TENANT_ID || 'default';
const agentId = process.env.AGENT_ID || 'default';
// Bounded wait for a final message AFTER turn-end. Costs nothing on a turn that produces an answer
// — `directConversationFinished` returns as soon as `sawAnswer` is set — so this cap only applies to
// answerless turns. 30 s was too tight once the turn-end signal became background-aware: a
// background completion's delivery can trail its terminal record, and observed sub-agent runtimes
// in this campaign ran 67–384 s.
const POST_TURN_DELIVERY_GRACE_MS = 120000;

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
const isProgress = isDriveProgressText;
const isConversationAnswer = (outbound) => {
  const visibleText = outboundVisibleText(outbound);
  if (!visibleText || isProgress(visibleText)) return false;
  return !sharedConversation
    || findTelegramConversationWireAnswer(
      [outbound],
      injectOpts?.thread,
      inj.messageId,
    ) !== null;
};

// --- trajectory turn-end watch (authoritative execution signal) ---
const resolveTraj = () => {
  try {
    const dir = `${DATA}/workspace/sessions`;
    const files = [];
    // Trajectories are resolved through the co-located `<file>.jsonl.trajectory-path.json`
    // POINTER (its `runtimeFile`), never a hand-built path — a runtime that stores them outside
    // the session dir is exactly the bug class the read-order guidance calls out.
    //
    // Why this matters here: on a rig whose `dataDir` relocates trajectories (they land flat in
    // `$DATA/trajectories/` while `workspace/sessions` keeps only the pointers), the legacy
    // `*.jsonl.trajectory.jsonl` walk matches ZERO files. `resolveTraj()` then returned null, the
    // authoritative turn-end watch was silently never armed, and wire-quiescence became the only
    // stop signal — so a drive stopped at the model's "I'm running it now" acknowledgement and
    // reported that promise as the substantive answer. Measured across 15 heavy questions: every
    // real answer landed 30–384 s AFTER the driver had already exited, and the two best answers
    // of the run would have been scored content-free by anyone reading the driver's output alone.
    // The selectors match a candidate by its EXACT session-dir path
    // (`<sessionsRoot>/<tenant>/<channel>/<expectedFilename>`), so a relocated trajectory can
    // never be matched on its real path. Each candidate therefore carries BOTH: `path` is the
    // session-dir identity the selector matches on, and `real` is where the bytes actually live.
    const visit = (current) => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const full = `${current}/${entry.name}`;
        if (entry.isDirectory()) { visit(full); continue; }
        if (entry.name.endsWith('.jsonl.trajectory-path.json')) {
          try {
            const runtimeFile = JSON.parse(readFileSync(full, 'utf8')).runtimeFile;
            if (typeof runtimeFile !== 'string' || runtimeFile === '') continue;
            // The legacy in-session-dir name this pointer stands in for — the selector's key.
            const asIfLocal = full.replace(/\.trajectory-path\.json$/, '.trajectory.jsonl');
            files.push({ path: asIfLocal, real: runtimeFile });
          } catch { /* unreadable/!json pointer — ignore, the legacy branch may still match */ }
        } else if (entry.name.endsWith('.jsonl.trajectory.jsonl')) {
          files.push({ path: full, real: full });
        }
      }
    };
    visit(dir);
    const candidates = [];
    for (const { path, real } of files) {
      let mtimeMs;
      try { mtimeMs = statSync(real).mtimeMs; } catch { continue; } // pointer written before the file
      candidates.push({ path, real, mtimeMs });
    }
    const chosen = sharedConversation
      ? selectTelegramConversationTrajectoryPath(
          candidates,
          dir,
          tenantId,
          Number(botBody.result.id),
          Number(chatId),
          injectOpts?.thread,
        )
      : selectMainTrajectoryPath(
          candidates,
          dir,
          tenantId,
          "telegram",
          expectedTrajectorySuffix,
        );
    // Map the selector's session-dir identity back to the file that holds the bytes.
    return chosen === null
      ? null
      : (candidates.find((c) => c.path === chosen)?.real ?? chosen);
  } catch { return null; }
};
const trajLineCount = (p) => { try { return readFileSync(p, 'utf8').split('\n').length; } catch { return 0; } };
// A PARENT turn that dispatched background work emits its own `session.summary` and finishes with
// `finishReason:"background_pending"` while the sub-agent keeps running — so treating the first
// summary as turn-end stops the drive before the answer exists. Measured across 15 heavy questions:
// the real answer arrived 30–384 s after that first summary, and because the interim
// "I'm running it now, I'll report back" prose is not a progress card, `sawAnswer` was already set
// and the post-turn grace exited immediately. The promise got reported as the answer.
//
// So: when the tail shows `background_pending`, require a LATER terminal record (the background
// completion's own summary/abort) before calling the turn ended.
// Turn-end is decided by `trajectoryTurnEnded` in drive-session-oracle.mjs — a PURE predicate
// with contract tests, so the hand-off cases (background task / sub-agent spawn) are verified
// deterministically rather than only against a live rig that may or may not spawn.
const turnEndedSince = (p, baseLines) => {
  try {
    return trajectoryTurnEnded(readFileSync(p, 'utf8').split('\n').slice(baseLines));
  } catch {
    /* best-effort: missing or mid-write trajectory file → treat as not ended */
    return false;
  }
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
let sawAnswer = false, turnEnded = false, turnEndedAtMs = null, lastNew = Date.now();
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

// A 0-outbound "timeout" is often NOT a wedge: an unauthorized sender (FROMUSER
// not in the agent's allowFrom list) is rejected at the auth layer BEFORE any
// agent turn, so there is correctly no reply. Distinguish that from a real hang
// by checking the daemon log for the block naming THIS sender — else the driver
// reports a misleading "[TIMEOUT] — NO SUBSTANTIVE ANSWER" on a correct security
// block, which otherwise looks like a missing substantive answer.
const detectCorrectSilence = () => {
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
        // The other correct silence: an unmentioned group message under the mention-gated default is
        // persisted as context and never activates the agent. Like the auth block it can NEVER
        // produce a reply, so waiting out maxMs only delays a verdict the log already carries.
        if (line.includes('Group message persisted as context without activating agent')
          && line.includes(`"${chatId}"`)) {
          return `NOT ACTIVATED (group activation policy) — the message was persisted as context and the agent was deliberately not activated (correct under the mention-gated default, NOT a wedge)`;
        }
      }
    }
  } catch { /* no log access — fall through to the timeout reason */ }
  return null;
};
let allowFromBlock = null;

while (Date.now() - start < maxMs) {
  // An ingress-blocked sender can NEVER reply, so waiting out maxMs only delays a verdict the
  // daemon log already carries. Detecting the block early turns every stranger-ingress row from a
  // full-timeout row into a seconds-long one, with the identical honest verdict — the check is the
  // same one the post-loop reporter uses, just consulted while there is still time to save.
  if (seen.length === 0 && !sawAnswer && !turnEnded && Date.now() - start > 2000) {
    const earlyBlock = detectCorrectSilence();
    if (earlyBlock) { allowFromBlock = earlyBlock; break; }
  }
  // long-poll pre-answer (ride out reasoning gaps); snappy once the answer is in.
  const waitMs = sawAnswer ? quiesceMs : 20000;
  const batch = await getOutbound(after, waitMs);
  if (batch.length) {
    for (const o of batch) {
      seen.push(o); after = Math.max(after, o.messageId || after);
      if (isConversationAnswer(o)) sawAnswer = true;
    }
    lastNew = Date.now();
  }
  // Lazily pick up the trajectory once the turn creates it (fresh-session first turn — see the
  // `let trajPath` note). base=0 is correct here: we only land here when the pre-inject resolve
  // found nothing, i.e. a brand-new session with no prior turn's session.summary to false-match.
  if (!trajPath) {
    const late = resolveTraj();
    if (late) { trajPath = late; trajBase = 0; process.stderr.write(`trajectory resolved late: ${late.split('/').pop()} — switching to authoritative turn-end watch\n`); }
  }
  // The agent turn ended, but channel delivery post-processing can still be in
  // flight. Record the first observation and keep polling for a bounded drain.
  if (trajPath && turnEndedSince(trajPath, trajBase)) {
    turnEnded = true;
    turnEndedAtMs ??= Date.now();
  }
  if (sharedConversation) {
    correlatedAnswer = resolveCorrelatedAnswer();
    if (sharedConversationFinished({
      outbound: seen,
      correlatedAnswer,
      sawAnswer,
      turnEnded,
      threadId: injectOpts?.thread,
      inboundMessageId: inj.messageId,
    })) {
      const tail = await getOutbound(after, 2500);
      for (const o of tail) {
        seen.push(o);
        after = Math.max(after, o.messageId || after);
        if (isConversationAnswer(o)) sawAnswer = true;
      }
      break;
    }
    continue;
  }
  if (directConversationFinished({
    sawAnswer,
    turnEnded,
    turnEndedAtMs,
    nowMs: Date.now(),
    deliveryGraceMs: POST_TURN_DELIVERY_GRACE_MS,
    // `lastNew` is stamped whenever a batch arrives, so the grace measures SILENCE rather than an
    // absolute span from turn-end. A background completion's delivery can trail its terminal record
    // — observed ~200s past turn-end against a 120s window — so a stream of progress cards followed
    // by the real answer now holds the window open instead of closing mid-delivery. An outbound that
    // predates turn-end does not extend it.
    lastOutboundAtMs: lastNew,
  })) {
    // Drain any just-delivered final message, then stop. A turn with no answer
    // reaches this branch only after the bounded post-turn delivery grace.
    const tail = await getOutbound(after, 2500);
    for (const o of tail) {
      seen.push(o);
      after = Math.max(after, o.messageId || after);
      if (isConversationAnswer(o)) sawAnswer = true;
    }
    break;
  }
  if (wireQuiescenceFinished({
    trajectoryAvailable: trajPath !== null,
    sawAnswer,
    lastNewMs: lastNew,
    nowMs: Date.now(),
    quiesceMs,
  })) break;
}
// Telegram edits keep the original message id, so the id-cursor long poll
// cannot return an edit once that message id has already advanced the cursor.
// Reconcile against the emulator's append-only full snapshot before judging or
// printing the wire; this captures approval keyboards and later edit states.
const finalSnapshot = await getOutbound(0, 1);
const reconciledOutbound = reconcileDriveOutbound(initial, seen, finalSnapshot);
seen.splice(0, seen.length, ...reconciledOutbound);
sawAnswer = seen.some(isConversationAnswer);

// Reuse the in-loop detection when it already fired; otherwise check once now.
allowFromBlock ??= detectCorrectSilence();
const correlatedWireAnswer = correlatedAnswer
  ? wireContainsAssistantReply(
      seen,
      correlatedAnswer,
      sharedConversation
        ? { threadId: injectOpts?.thread, inboundMessageId: inj.messageId }
        : undefined,
    )
  : false;
const correctedWireAnswer = sharedConversation && turnEnded
  ? findTelegramConversationWireAnswer(
      seen,
      injectOpts?.thread,
      inj.messageId,
    )
  : null;
const hasSubstantiveAnswer = sharedConversation
  ? correlatedWireAnswer || correctedWireAnswer !== null
  : sawAnswer;
const reason = correlatedWireAnswer
  ? 'correlated-session-answer'
  : correctedWireAnswer !== null
    ? 'turn-ended-visible-answer'
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
} else if (correctedWireAnswer !== null) {
  console.log(correctedWireAnswer);
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
