#!/usr/bin/env node
// Seed or clean one content-free interrupted durable run for the live restart probe.
// The seed is written through the shipped DurableRunPort adapter; the daemon's
// normal boot sweep remains the system under test.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { comisDist, requireCodeRoot, rig } from "./_rig.mjs";

const STATE_PATH = "/root/generic-runtime-durable-state.json";
const Database = requireCodeRoot("better-sqlite3");
const { createConversationRef } = await import(
  pathToFileURL(comisDist("core", "dist/index.js")).href
);
const { createSqliteDurableRunStore } = await import(
  pathToFileURL(comisDist("memory", "dist/index.js")).href
);

const command = process.argv[2];

if (command === "seed") {
  const workspacePolicyHash = process.argv[3];
  if (!/^[a-f0-9]{64}$/u.test(workspacePolicyHash ?? "")) {
    process.stderr.write("seed requires a lowercase SHA-256 workspace policy hash\n");
    process.exit(2);
  }

  const id = randomUUID();
  const checkpointId = `generic-runtime-restart-${id}`;
  const rootRunId = `generic-runtime-root-${id}`;
  const scriptRef = `generic-runtime-restart-${id}.js`;
  const principalId = "generic-runtime-live-principal";
  const conversationScope = {
    tenantId: "default",
    agentId: "default",
    partition: {
      kind: "endpoint-conversation-principal",
      endpoint: {
        channelType: "durable-resume",
        channelInstanceId: "generic-runtime-live",
        conversationId: rootRunId,
        conversationKind: "direct",
      },
      principalId,
    },
  };
  const conversationReference = createConversationRef(conversationScope);
  if (!conversationReference.ok) {
    process.stderr.write(`durable conversation reference failed: ${conversationReference.error.message}\n`);
    process.exit(1);
  }
  const nowMs = Date.now();
  const db = new Database(`${rig.dataDir}/memory.db`);
  const store = createSqliteDurableRunStore(db, { nowMs: () => nowMs });
  const record = {
    checkpointId,
    rootRunId,
    tenantId: "default",
    agentId: "default",
    conversationRef: conversationReference.value,
    conversationScope,
    principalId,
    deliveryOrigin: null,
    spawnTree: [],
    caps: ["orch:read"],
    leaseIds: [],
    budgetConsumed: 0,
    rootBudget: { startedAtMs: nowMs, tokensConsumed: 0, usdConsumed: 0 },
    cronOrigin: null,
    trustLevel: "admin",
    status: "running",
    lastHeartbeatAt: nowMs,
    scriptRef,
    checkpointRef: null,
    workspacePolicyHash,
  };
  const seeded = await store.upsertCheckpoint(record);
  if (!seeded.ok) {
    db.close();
    process.stderr.write(`durable seed failed: ${seeded.error.message}\n`);
    process.exit(1);
  }
  writeFileSync(
    `${rig.dataDir}/workspace/${scriptRef}`,
    "process.stdout.write('generic runtime restart probe\\n');\n",
    { encoding: "utf8", mode: 0o644 },
  );
  writeFileSync(STATE_PATH, `${JSON.stringify({ checkpointId, rootRunId, scriptRef })}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  db.close();
  process.stdout.write(`${JSON.stringify({ checkpointId, rootRunId, scriptRef, workspacePolicyHash })}\n`);
  process.exit(0);
}

if (command === "cleanup") {
  if (!existsSync(STATE_PATH)) {
    process.stdout.write(`${JSON.stringify({ cleaned: false, reason: "state_absent" })}\n`);
    process.exit(0);
  }
  const state = JSON.parse(readFileSync(STATE_PATH, "utf8"));
  const db = new Database(`${rig.dataDir}/memory.db`);
  const remove = db.transaction(() => {
    // A restart atomically retires the source and creates a replacement id.
    // Clean the exact test root so both records disappear without touching any
    // unrelated durable run.
    db.prepare("DELETE FROM durable_run_checkpoints WHERE root_run_id = ?").run(state.rootRunId);
    db.prepare("DELETE FROM durable_run_roots WHERE root_run_id = ?").run(state.rootRunId);
  });
  remove.immediate();
  db.close();
  rmSync(`${rig.dataDir}/workspace/${state.scriptRef}`, { force: true });
  rmSync(STATE_PATH, { force: true });
  process.stdout.write(`${JSON.stringify({ cleaned: true, checkpointId: state.checkpointId })}\n`);
  process.exit(0);
}

process.stderr.write("usage: generic-runtime-durable-seed.mjs <seed HASH|cleanup>\n");
process.exit(2);
