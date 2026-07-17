#!/usr/bin/env node
// logscan.mjs — precise STRUCTURED-FIELD scan of the daemon log (Pino JSON).
//
// Replaces the hand-written `grep <pat> log | node -e "JSON.parse + project {fields}"` one-liners
// you'd otherwise rewrite a dozen times per run. It reads STRUCTURED FIELDS, never raw words, so it
// can't false-positive on a substring buried in an unrelated field — the trap that makes
// `grep "degraded"` match the "Daemon health" report lines and `grep "transient"` match
// "Stripped transient inline-recall from cached prefix" (both bit this run).
//
// Usage:  node logscan.mjs [--log PATH] [--level 50,60] [--kind k1,k2] [--msg SUBSTR]
//                          [--method M] [--module M] [--trace ID] [--since ISO|EPOCH_MS]
//                          [--fields a,b,c] [--last N] [--uniq] [--raw]
//   node logscan.mjs --level 50,60                  # all ERROR/FATAL (default fields)
//   node logscan.mjs --level 50,60 --uniq           # ...grouped by projection + count (triage)
//   node logscan.mjs --msg "not reachable" --fields method,err
//   node logscan.mjs --kind resource --last 10
//   node logscan.mjs --method graph.execute --raw   # full matched lines
//   node logscan.mjs --trace <traceId> --level 40,50,60
//   node logscan.mjs --since 2026-07-17T18:30:00Z --fields time,level,msg
//
// Defaults: --log = ALL of <dataDir>/logs/daemon*.log (the structured Pino logs — the authoritative
// record under the systemd install; the old supervisor capture is gone) · --fields level,module,msg,
// errorKind,hint. `err` projects as err.message. Non-JSON lines are skipped. Run as root or comis.
import { readFileSync, readdirSync } from 'node:fs';
import { rig } from './_rig.mjs';

const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf('--' + name); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def; };
const flag = (name) => argv.includes('--' + name);
const csv = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : []);

const defaultLogs = () => {
  try {
    const dir = `${rig.dataDir}/logs`;
    const names = readdirSync(dir).filter((n) => n.startsWith('daemon') && n.endsWith('.log')).sort();
    return names.map((n) => `${dir}/${n}`);
  } catch { return []; }
};
const logPathOpt = opt('log');
const logPaths = logPathOpt ? [logPathOpt] : defaultLogs();
if (!logPaths.length) { console.error(`logscan: no daemon*.log under ${rig.dataDir}/logs — pass --log PATH`); process.exit(2); }
const levels = new Set(csv(opt('level')).map(Number));
const kinds = new Set(csv(opt('kind')));
const msgSub = opt('msg');
const method = opt('method');
const moduleF = opt('module');
const traceId = opt('trace');
const sinceRaw = opt('since');
const sinceMs = sinceRaw === undefined
  ? undefined
  : /^\d+$/.test(sinceRaw)
    ? Number(sinceRaw)
    : Date.parse(sinceRaw);
if (sinceRaw !== undefined && !Number.isFinite(sinceMs)) {
  console.error(`logscan: invalid --since value "${sinceRaw}" — use ISO-8601 or epoch milliseconds`);
  process.exit(2);
}
const fields = csv(opt('fields', 'level,module,msg,errorKind,hint'));
const last = Number(opt('last', '0'));
const uniq = flag('uniq');
const raw = flag('raw');

const pick = (j, f) => {
  if (f === 'err') return (j.err && (j.err.message || j.err)) ?? undefined;
  return j[f];
};
const matches = (j) => {
  if (levels.size && !levels.has(j.level)) return false;
  if (kinds.size && !kinds.has(j.errorKind)) return false;
  if (moduleF && j.module !== moduleF) return false;
  if (method && j.method !== method) return false;
  if (traceId && j.traceId !== traceId) return false;
  if (sinceMs !== undefined) {
    const recordMs = typeof j.time === 'number' ? j.time : Date.parse(j.time);
    if (!Number.isFinite(recordMs) || recordMs < sinceMs) return false;
  }
  if (msgSub) {
    const hay = `${j.msg || ''} ${(j.err && (j.err.message || '')) || ''} ${j.hint || ''}`;
    if (!hay.includes(msgSub)) return false;
  }
  return true;
};

// Concatenate in name order (daemon.1.log, daemon.2.log, … = the rotation order).
let lines = [];
for (const p of logPaths) {
  try { lines = lines.concat(readFileSync(p, 'utf8').split('\n')); }
  catch (e) { console.error('logscan: cannot read ' + p + ' — ' + (e?.message || e)); process.exit(1); }
}

let hits = [];
for (const line of lines) {
  if (!line.trim()) continue;
  let j; try { j = JSON.parse(line); } catch { continue; }
  if (!matches(j)) continue;
  hits.push(j);
}
if (last > 0) hits = hits.slice(-last);

if (raw) {
  for (const j of hits) console.log(JSON.stringify(j).slice(0, 600));
} else if (uniq) {
  const groups = new Map();
  for (const j of hits) {
    const proj = {}; for (const f of fields) { const v = pick(j, f); if (v !== undefined) proj[f] = typeof v === 'string' ? v.slice(0, 80) : v; }
    const key = JSON.stringify(proj);
    groups.set(key, (groups.get(key) || 0) + 1);
  }
  for (const [k, n] of [...groups.entries()].sort((a, b) => b[1] - a[1])) console.log(n + 'x ' + k);
} else {
  for (const j of hits) {
    const proj = {}; for (const f of fields) { const v = pick(j, f); if (v !== undefined) proj[f] = typeof v === 'string' ? v.slice(0, 120) : v; }
    console.log(JSON.stringify(proj));
  }
}
console.error(`logscan: ${hits.length} match(es) in ${logPaths.join(', ')}`);
