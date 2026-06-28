// seed.mjs — read-WRITE seeder for ~/.comis/memory.db (db.mjs is read-only). The companion to db.mjs.
// Born from reflect-obs-20260627: the reuse→promote (LIVE-03) and eviction/INV-4 (LIVE-05) oracles
// REQUIRE seeding — a grounded `mental_models` skill at a chosen proof_count, and `memory_usefulness`
// failure_count rows — and the runbook endorses it but shipped no helper, so they were hand-written on
// the box every run. This makes them one deterministic line. Uses the daemon's better-sqlite3 (a
// SECOND connection; WAL allows it alongside the live daemon).
//
// Run AS comis so $HOME → /home/comis and the comis-owned db opens read-write:
//   sudo -u comis env HOME=/home/comis node /root/seed.mjs <cmd> …
//
//   seed.mjs skill <name> [proofCount=2] [kind=skill]   # a grounded read-only Mental Model doc (candidate,
//                                                          trust=learned, mutating=0) — SURFACES + is reusable.
//                                                          Default proof=2 so ONE successful reuse promotes it
//                                                          (promoteAtProofCount=3). Body is a generic-but-real SAR
//                                                          playbook; pass --body=<file> to override (NOT a script — advisory text, INV-3).
//   seed.mjs failure <memId> <failureCount> [content]   # a `memories` row (if absent) + a `memory_usefulness`
//                                                          row with failure_count=N, for the eviction/INV-4 gate.
//                                                          [content] sets the memory body + lets you also set
//                                                          proof_count/pinned via --proof=N / --pinned.
//
// Flags: --proof=<n> (memories.proof_count, eviction-exemption axis), --pinned (memories.pinned=1),
//        --tenant=<t> (default "default"), --agent=<a> (default "default").
// Echoes the written row. NEVER seeds a `scripts` column (none exists — advisory docs only, INV-3).
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
// COMIS_SRC overrides the better-sqlite3 resolution root (VPS default /root/comis-src; set to a local
// checkout for a LOCAL daemon run). COMIS_DB_PATH / COMIS_DATA_DIR target a non-default data dir; VPS
// default stays ~/.comis/memory.db. (package-delivery-20260628 — seed.mjs was missed in the first pass.)
const require = createRequire((process.env.COMIS_SRC || "/root/comis-src") + "/packages/daemon/package.json");
const Database = require("better-sqlite3");
const dbpath = process.env.COMIS_DB_PATH
  || (process.env.COMIS_DATA_DIR ? process.env.COMIS_DATA_DIR + "/memory.db" : (process.env.HOME || "/home/comis") + "/.comis/memory.db");

const argv = process.argv.slice(2);
const cmd = argv[0];
const pos = argv.filter((a) => !a.startsWith("--"));
const flag = (name) => { const f = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`)); if (f === undefined) return undefined; const eq = f.indexOf("="); return eq === -1 ? true : f.slice(eq + 1); };
const tenant = flag("tenant") || "default";
const agent = flag("agent") || "default";
const now = Date.now();

const DEFAULT_SKILL_BODY = `# Search-and-Rescue Drone Search Order (seeded playbook)

When a hiker is reported missing, fly the drone in THIS order:
1. **Creek junctions / water crossings** — lost hikers drift downhill and follow water; check FIRST.
2. **Trail forks** — the last clear decision point a disoriented hiker remembers.
3. **Water-pooled hollows** — shelter-seeking, especially in rain.
4. **Open ridgelines** — LAST; reaching them takes deliberate effort, low probability.
Clear each tier fully before advancing. Most finds happen at the first creek junction.`;

try {
  const db = new Database(dbpath, { fileMustExist: true }); // read-WRITE (no readonly flag)
  if (cmd === "skill") {
    const name = pos[1];
    if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error("usage: skill <kebab-name> [proofCount] [kind]");
    const proof = Number.parseInt(pos[2] ?? "2", 10);
    const kind = pos[3] ?? "skill";
    const bodyFile = flag("body");
    const body = bodyFile ? readFileSync(bodyFile, "utf8") : DEFAULT_SKILL_BODY;
    db.prepare(
      `INSERT OR REPLACE INTO mental_models
       (id, tenant_id, agent_id, kind, topic_key, name, description, body, trust_level, state, proof_count, confidence, strength, mutating, pinned, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(`seed-${name}`, tenant, agent, kind, name, name, `Seeded ${kind} doc for the reuse→promote oracle.`, body, "learned", "candidate", proof, 0.7, 1.0, 0, 0, now, now);
    console.log("SEEDED skill:", JSON.stringify(db.prepare(`SELECT name,kind,state,trust_level,proof_count,mutating FROM mental_models WHERE id=?`).get(`seed-${name}`)));
  } else if (cmd === "failure") {
    const memId = pos[1];
    const failureCount = Number.parseInt(pos[2] ?? "0", 10);
    if (!memId || !Number.isFinite(failureCount)) throw new Error("usage: failure <memId> <failureCount> [content] [--proof=N] [--pinned]");
    const content = pos[3] ?? `seeded memory ${memId} for the eviction oracle`;
    const proof = Number.parseInt(flag("proof") ?? "1", 10);
    const pinned = flag("pinned") ? 1 : 0;
    // memories row (if absent) — needs the NOT NULL columns (source_who etc.); INSERT OR REPLACE to re-seed.
    db.prepare(
      `INSERT OR REPLACE INTO memories
       (id, tenant_id, agent_id, user_id, content, trust_level, memory_type, source_who, source_session_key, proof_count, pinned, confidence, strength, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(memId, tenant, agent, "678314278", content, "learned", "semantic", "user", `${tenant}:678314278:678314278:peer:678314278`, proof, pinned, 0.7, 1.0, now, now);
    db.prepare(
      `INSERT OR REPLACE INTO memory_usefulness (tenant_id, agent_id, memory_id, intent, used_count, ignored_count, failure_count) VALUES (?,?,?,?,?,?,?)`,
    ).run(tenant, agent, memId, "", 0, 0, failureCount);
    console.log("SEEDED failure:", JSON.stringify({ memory: db.prepare(`SELECT id,proof_count,pinned,evicted_at FROM memories WHERE id=?`).get(memId), failure_count: failureCount }));
  } else {
    throw new Error("usage: seed.mjs skill <name> [proof] [kind] | failure <memId> <count> [content] [--proof=N] [--pinned]");
  }
  db.close();
} catch (err) {
  console.log("ERROR:" + (err?.message || String(err)));
  process.exit(1);
}
