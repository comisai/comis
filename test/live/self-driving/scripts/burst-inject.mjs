#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// burst-inject.mjs — inject N messages into ONE conversation with NO per-message quiesce,
// so parallel, steering and burst rows can actually be driven. Writes a MANIFEST that
// `burst-verify.mjs` turns into an attributed verdict.
//
// WHY THIS IS A SEPARATE TOOL. `drive.mjs` takes `/tmp/comis-drive-<conversation>.lock` and
// refuses to run two drives in one conversation — correctly: a Telegram DM outbound payload is
// only `{chat_id, parse_mode, text}`, so two concurrent drives both accept the first non-progress
// message and both report it (that manufactured a phantom cross-turn answer bleed once). Running
// five `drive.mjs` at one chat therefore SERIALIZES them, and the row then reports
// "no interleaving" as a pass on a test that never ran concurrently. This injector does not
// wait, does not take the lock, and does not attribute anything — attribution is the verifier's
// job, and it refuses to guess.
//
// Usage:
//   node burst-inject.mjs <chatId> <messagesFile|-> [options]
//     --stagger-ms <n>   delay between sends (default 0 = all at once)
//     --from <userId>    sender for lines that do not carry their own (default FROMUSER/rig)
//     --out <path>       also write the manifest to this path
//     --label <text>     free-form tag recorded in the manifest (the row id, e.g. CC1)
//
// Input: one message per line — either raw text, or a JSON object
//   {"text":"…","fromUserId":"678314278","opts":{"mention":true,"replyTo":42,"thread":7}}
// Use the JSON form to mix senders (a group row) or to attach reply/thread metadata.
//
// Exit: 0 all injects accepted · 2 usage/rig error · 3 one or more injects rejected
//       (the manifest is still written, so the verifier can report on what did land).
import { readFileSync, writeFileSync } from 'node:fs';
import { comisDist, rig } from './_rig.mjs';
import {
  normalizedInboundTextError,
  telegramInboundGuid,
  telegramInjectAddressingError,
} from './drive-session-oracle.mjs';

const argv = process.argv.slice(2);
const positional = [];
const flags = new Map();
for (let index = 0; index < argv.length; index += 1) {
  const token = argv[index];
  if (token.startsWith('--')) {
    flags.set(token.slice(2), argv[index + 1]);
    index += 1;
    continue;
  }
  positional.push(token);
}

const chatId = positional[0] || rig.chatId;
const messagesPath = positional[1];
if (!chatId || !messagesPath) {
  console.error(
    'burst-inject.mjs: usage: burst-inject.mjs <chatId> <messagesFile|-> '
    + '[--stagger-ms n] [--from userId] [--out path] [--label text]',
  );
  process.exit(2);
}
const staggerMs = Number(flags.get('stagger-ms') ?? 0);
if (!Number.isFinite(staggerMs) || staggerMs < 0) {
  console.error(`burst-inject.mjs: --stagger-ms must be a non-negative number (got "${flags.get('stagger-ms')}")`);
  process.exit(2);
}
const defaultFrom = flags.get('from') || process.env.FROMUSER || rig.chatId;
const tenantId = process.env.TENANT_ID || 'default';
const agentId = process.env.AGENT_ID || 'default';

const raw = messagesPath === '-' ? readFileSync(0, 'utf8') : readFileSync(messagesPath, 'utf8');
const specs = [];
for (const line of raw.split('\n')) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  if (trimmed.startsWith('{')) {
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      console.error(`burst-inject.mjs: unparseable JSON message line: ${trimmed.slice(0, 80)}`);
      process.exit(2);
    }
    if (typeof parsed.text !== 'string' || parsed.text === '') {
      console.error('burst-inject.mjs: every JSON message line needs a non-empty "text"');
      process.exit(2);
    }
    specs.push({
      text: parsed.text,
      fromUserId: String(parsed.fromUserId ?? defaultFrom),
      opts: parsed.opts,
    });
    continue;
  }
  specs.push({ text: trimmed, fromUserId: String(defaultFrom), opts: undefined });
}
if (specs.length < 2) {
  console.error('burst-inject.mjs: a burst needs at least two messages; use drive.mjs for one turn');
  process.exit(2);
}

// A raw ENOENT stack here reads as a code defect; it is almost always "the emulator is not wired
// on this rig yet". Name the fix instead of the exception.
let emu;
try {
  emu = JSON.parse(readFileSync(rig.emuWiringPath, 'utf8'));
} catch (error) {
  console.error(
    `burst-inject.mjs: cannot read the emulator wiring at ${rig.emuWiringPath} `
    + `(${error?.message || error}) — wire the emulator first (deploy-emu.sh / wire-emu.mjs) `
    + 'and confirm RIG_MODE/DATA point at the intended rig',
  );
  process.exit(2);
}
const base = emu.apiRoot;
const botResponse = await fetch(`${base}/bot${emu.botToken}/getMe`);
const botBody = await botResponse.json();
if (!botResponse.ok || botBody?.ok !== true || !botBody?.result?.id) {
  console.error('burst-inject.mjs: emulator getMe did not return a bot id');
  process.exit(2);
}
const botAccountId = Number(botBody.result.id);

// Same pre-flight guards drive.mjs applies, applied to EVERY message before anything is sent:
// a burst that half-lands because message 7 was over the normalized limit is unreadable evidence.
const { MAX_NORMALIZED_MESSAGE_TEXT_CHARS } = await import(comisDist('core', 'dist/index.js'));
for (const [index, spec] of specs.entries()) {
  const lengthError = normalizedInboundTextError(spec.text, MAX_NORMALIZED_MESSAGE_TEXT_CHARS);
  if (lengthError !== undefined) {
    console.error(`burst-inject.mjs: message ${index}: ${lengthError}`);
    process.exit(2);
  }
  const addressingError = telegramInjectAddressingError(
    spec.text,
    spec.opts,
    botBody.result.username,
  );
  if (addressingError !== undefined) {
    console.error(`burst-inject.mjs: message ${index}: ${addressingError}`);
    process.exit(2);
  }
}

// The wire high-water mark BEFORE the burst. The verifier polls outbound strictly after this id,
// so a reply to an earlier turn can never be counted as one of this burst's answers.
const priorOutbound = await (
  await fetch(`${base}/control/chats/${chatId}/outbound?afterMessageId=0&waitMs=1`)
).json();
const wireAfterMessageId = Array.isArray(priorOutbound)
  ? priorOutbound.reduce((max, item) => Math.max(max, item?.messageId || 0), 0)
  : 0;

const startedAtMs = Date.now();
const injectOne = async (spec, index) => {
  if (staggerMs > 0 && index > 0) {
    await new Promise((resolve) => { setTimeout(resolve, staggerMs * index); });
  }
  const sentAtMs = Date.now();
  try {
    const response = await fetch(`${base}/control/chats/${chatId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fromUserId: spec.fromUserId, text: spec.text, opts: spec.opts }),
    });
    const body = await response.json();
    const messageId = Number(body?.messageId);
    if (!response.ok || !Number.isFinite(messageId)) {
      return {
        index,
        ok: false,
        sentAtMs,
        ackedAtMs: Date.now(),
        fromUserId: spec.fromUserId,
        error: `inject rejected (status ${response.status})`,
      };
    }
    return {
      index,
      ok: true,
      sentAtMs,
      ackedAtMs: Date.now(),
      fromUserId: spec.fromUserId,
      messageId,
      inboundGuid: telegramInboundGuid(botAccountId, Number(chatId), messageId),
      thread: spec.opts?.thread,
      textChars: spec.text.length,
    };
  } catch (error) {
    return {
      index,
      ok: false,
      sentAtMs,
      ackedAtMs: Date.now(),
      fromUserId: spec.fromUserId,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

const injects = await Promise.all(specs.map((spec, index) => injectOne(spec, index)));
const manifest = {
  label: flags.get('label') ?? null,
  chatId: String(chatId),
  botAccountId,
  tenantId,
  agentId,
  dataDir: rig.dataDir,
  staggerMs,
  wireAfterMessageId,
  startedAtMs,
  endedAtMs: Date.now(),
  injects: injects.sort((left, right) => left.index - right.index),
};
const serialized = JSON.stringify(manifest, null, 1);
const outPath = flags.get('out');
if (outPath) writeFileSync(outPath, `${serialized}\n`);
console.log(serialized);

const rejected = injects.filter((inject) => !inject.ok);
if (rejected.length > 0) {
  process.stderr.write(
    `burst-inject.mjs: ${rejected.length}/${injects.length} injects rejected — `
    + 'the manifest records them so burst-verify.mjs can report the partial burst\n',
  );
  process.exit(3);
}
process.stderr.write(
  `burst-inject.mjs: ${injects.length} injects accepted into chat ${chatId} `
  + `over ${manifest.endedAtMs - startedAtMs}ms (stagger ${staggerMs}ms); `
  + 'verify with: node burst-verify.mjs <manifest>\n',
);
