// db.mjs — read-only oracle for ~/.comis/memory.db (learning / memory / delivery ground truth).
// Canned sub-commands avoid shell-quoting hell through ssh→su→node (no quotes in the SQL you type).
//   node db.mjs tables                       list tables
//   node db.mjs schema <table>               the CREATE TABLE sql (see CHECKs / columns)
//   node db.mjs cols <table>                 column names (comma-joined)
//   node db.mjs count <table>                row count
//   node db.mjs rows <table> [n]             last n rows (default 8), JSON
//   node db.mjs pick <table> <c1,c2,..> [n]  selected columns, last n rows
//   node db.mjs pickw <t> <c1,..> <col> <val> [n]  filter col=val (val BOUND as a param — no quote-hell)
//   node db.mjs sql <raw...>                 raw read-only SQL (argv joined) — use only when canned won't do
import { createRequire } from 'node:module';
// COMIS_SRC overrides the better-sqlite3 resolution root (VPS default /root/comis-src; set to a local
// checkout for a LOCAL daemon run). COMIS_DB_PATH / COMIS_DATA_DIR target a NON-default data dir (a local
// isolated daemon); VPS default stays ~/.comis/memory.db.
const require = createRequire((process.env.COMIS_SRC || '/root/comis-src') + '/packages/daemon/package.json');
const Database = require('better-sqlite3');
// ROOT-HOME GUARD: the daemon runs as the
// `comis` user, so its data dir is /home/comis/.comis. If this helper is invoked as ROOT (HOME=/root —
// the common `ssh root@vps 'node db.mjs …'` mistake) WITHOUT an explicit override, HOME resolution would
// point at /root/.comis (which throws fileMustExist here, and SILENTLY returns 0 rows in the obs assembler
// — the "explain blind" false-negative that cost a cycle). Resolve to the comis data dir + warn instead.
const resolvedHome =
  typeof process.getuid === 'function' && process.getuid() === 0 ? '/home/comis' : process.env.HOME || '/home/comis';
if (typeof process.getuid === 'function' && process.getuid() === 0 && !process.env.COMIS_DATA_DIR && !process.env.COMIS_DB_PATH) {
  console.error('[db.mjs] running as root → using /home/comis/.comis (the daemon\'s comis-user data dir, NOT /root/.comis); set COMIS_DATA_DIR to override');
}
const dbpath = process.env.COMIS_DB_PATH
  || (process.env.COMIS_DATA_DIR ? process.env.COMIS_DATA_DIR + '/memory.db' : resolvedHome + '/.comis/memory.db');
const [cmd, a, b, c, d, e] = process.argv.slice(2);
const ident = (s) => { if (!/^[A-Za-z0-9_,]+$/.test(s || '')) throw new Error('bad identifier: ' + s); return s; };
try {
  const db = new Database(dbpath, { readonly: true, fileMustExist: true });
  let sql;
  switch (cmd) {
    case 'tables': sql = "select name from sqlite_master where type='table' order by name"; break;
    case 'schema': sql = `select sql from sqlite_master where name='${ident(a)}'`; break;
    case 'cols':   sql = `select group_concat(name) cols from pragma_table_info('${ident(a)}')`; break;
    case 'count':  sql = `select count(*) n from ${ident(a)}`; break;
    case 'rows':   sql = `select * from ${ident(a)} order by rowid desc limit ${parseInt(b) || 8}`; break;
    case 'pick':   sql = `select ${ident(b)} from ${ident(a)} order by rowid desc limit ${parseInt(c) || 8}`; break;
    // pickw <table> <c1,c2,..> <whereCol> <whereVal> [n] — filter by ONE column = value, the value
    // bound as a PARAMETER (?), so a string literal NEVER rides the SQL text. Fixes the ssh→su→node
    // quoted-literal trap that breaks `db.mjs sql "… WHERE x='lit'"`.
    case 'pickw':  sql = `select ${ident(b)} from ${ident(a)} where ${ident(c)} = ? order by rowid desc limit ${parseInt(e) || 8}`; break;
    case 'sql':    sql = process.argv.slice(3).join(' '); break;
    default: throw new Error('usage: tables|schema|cols|count|rows|pick|pickw|sql');
  }
  if (!/^\s*select\b/i.test(sql) && cmd !== 'schema') throw new Error('read-only: SELECT only');
  // pickw binds the where-value as a parameter (d); all other commands take no params.
  console.log(JSON.stringify(db.prepare(sql).all(...(cmd === 'pickw' ? [d] : []))));
} catch (e) {
  console.log('ERR:' + (e?.message || String(e)));
}
