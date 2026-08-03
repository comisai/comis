#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Read JSON on stdin, print a picked value. Exists because inline `node -e` with
// nested quotes/parens through bash → sudo → su reliably mangles (the documented
// quoting trap): this run hit `SyntaxError: missing ) after argument list` FOUR
// times writing one-off extractors. Use a file, not an inline script.
//
//   jpick.mjs len                        -> array length
//   jpick.mjs last <field>               -> last element's field
//   jpick.mjs lastwhere <k> <v> <field>  -> last element where k===v, print field
//   jpick.mjs path a.b.0.c               -> dotted path
//   jpick.mjs count <k> <v>              -> count of elements where k===v
let s = "";
process.stdin.on("data", (d) => (s += d)).on("end", () => {
  let j;
  try { j = JSON.parse(s.slice(s.indexOf(s.includes("[") && (s.indexOf("[") < (s.indexOf("{") + 1 || 1e9) ) ? "[" : "{"))); }
  catch { try { j = JSON.parse(s); } catch { process.stdout.write(""); return; } }
  const [mode, a, b, c] = process.argv.slice(2);
  const arr = Array.isArray(j) ? j : (j.entries ?? j.records ?? j.servers ?? j.jobs ?? []);
  const out = (v) => process.stdout.write(v === undefined || v === null ? "" : String(v));
  if (mode === "len") return out(arr.length);
  if (mode === "last") return out(arr.length ? arr[arr.length - 1][a] : "");
  if (mode === "count") return out(arr.filter((e) => String(e[a]) === String(b)).length);
  if (mode === "lastwhere") {
    const m = arr.filter((e) => String(e[a]) === String(b));
    return out(m.length ? m[m.length - 1][c] : "");
  }
  if (mode === "path") {
    let cur = j;
    for (const k of String(a).split(".")) { if (cur == null) break; cur = cur[k]; }
    return out(typeof cur === "object" ? JSON.stringify(cur) : cur);
  }
  out("");
});
