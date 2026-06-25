// db.mjs — read-only oracle for ~/.comis/memory.db (learning / memory / delivery ground truth).
// Canned sub-commands avoid shell-quoting hell through ssh→su→node (no quotes in the SQL you type).
//   node db.mjs tables                       list tables
//   node db.mjs schema <table>               the CREATE TABLE sql (see CHECKs / columns)
//   node db.mjs cols <table>                 column names (comma-joined)
//   node db.mjs count <table>                row count
//   node db.mjs rows <table> [n]             last n rows (default 8), JSON
//   node db.mjs pick <table> <c1,c2,..> [n]  selected columns, last n rows
//   node db.mjs sql <raw...>                 raw read-only SQL (argv joined) — use only when canned won't do
import { createRequire } from 'node:module';
const require = createRequire('/root/comis-src/packages/daemon/package.json');
const Database = require('better-sqlite3');
const dbpath = (process.env.HOME || '/home/comis') + '/.comis/memory.db';
const [cmd, a, b, c] = process.argv.slice(2);
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
    case 'sql':    sql = process.argv.slice(3).join(' '); break;
    default: throw new Error('usage: tables|schema|cols|count|rows|pick|sql');
  }
  if (!/^\s*select\b/i.test(sql) && cmd !== 'schema') throw new Error('read-only: SELECT only');
  console.log(JSON.stringify(db.prepare(sql).all()));
} catch (e) {
  console.log('ERR:' + (e?.message || String(e)));
}
