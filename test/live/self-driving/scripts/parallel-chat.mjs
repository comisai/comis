#!/usr/bin/env node
// Drive independent web-console conversations concurrently through the authenticated live gateway.
// Input is a JSON array on stdin (or in a file argument):
//   [{"name":"alpha","sessionKey":"parallel-alpha","message":"..."}]
// The result carries per-request timing and response metadata; trajectories remain the authoritative
// proof that model/tool execution overlapped and stayed within the requested conversation.
import { readFileSync } from 'node:fs';
import { ensureRpcEnv, rig } from './_rig.mjs';

ensureRpcEnv();
const token = process.env.COMIS_GATEWAY_TOKEN;
if (!token) {
  console.error('parallel-chat.mjs: gateway token is unavailable');
  process.exit(2);
}

const inputPath = process.argv[2] || '-';
const raw = inputPath === '-' ? readFileSync(0, 'utf8') : readFileSync(inputPath, 'utf8');
let specs;
try {
  specs = JSON.parse(raw);
} catch {
  console.error('parallel-chat.mjs: input must be valid JSON');
  process.exit(2);
}
if (!Array.isArray(specs) || specs.length < 2 || specs.some((spec) =>
  !spec || typeof spec.name !== 'string' || typeof spec.sessionKey !== 'string' || typeof spec.message !== 'string')) {
  console.error('parallel-chat.mjs: expected at least two {name,sessionKey,message} entries');
  process.exit(2);
}

const campaignStartedAtMs = Date.now();
const records = await Promise.all(specs.map(async (spec) => {
  const startedAtMs = Date.now();
  try {
    const response = await fetch(`http://127.0.0.1:${rig.gwPort}/api/chat`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ message: spec.message, agentId: 'default', sessionKey: spec.sessionKey }),
    });
    const body = await response.json();
    return {
      name: spec.name,
      sessionKey: spec.sessionKey,
      startedAtMs,
      endedAtMs: Date.now(),
      status: response.status,
      ok: response.ok,
      body,
    };
  } catch (error) {
    return {
      name: spec.name,
      sessionKey: spec.sessionKey,
      startedAtMs,
      endedAtMs: Date.now(),
      status: 0,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}));

const result = {
  campaignStartedAtMs,
  campaignEndedAtMs: Date.now(),
  records,
};
console.log(JSON.stringify(result));
if (records.some((record) => !record.ok)) process.exit(1);
