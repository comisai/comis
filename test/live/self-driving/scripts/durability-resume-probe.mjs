// SPDX-License-Identifier: Apache-2.0
/**
 * Live durable execution-graph restart probe.
 *
 * The probe uses a real Telegram turn to create a three-stage relationship:
 * a completed anchor, a channel-backed approval wait, and a final marker. It
 * restarts only after two independent ground-truth lenses agree:
 *
 * 1. `graph.status` reports the approval node running and an anchor completed;
 * 2. the durable authority row points to a protected checkpoint with the same
 *    frontier.
 *
 * After boot recovery, it approves the waiting node and reconciles terminal
 * metadata, `graph.runDetail`, the offline `comis explain --graph` report, and
 * the emulator wire. A chat reply is never a success oracle.
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildProbeMessage,
  classifyInterruptEvidence,
  selectPipelineApproval,
  selectUnseenGraphId,
  verifyResumeOutcome,
} from "./durability-resume-probe-core.mjs";
import {
  comisDist,
  ensureRpcEnv,
  importCli,
  requireCodeRoot,
  rig,
} from "./_rig.mjs";

ensureRpcEnv();
const { withClient } = await importCli("client/rpc-client.js");
const Database = requireCodeRoot("better-sqlite3");
const here = dirname(fileURLToPath(import.meta.url));

const sleep = (milliseconds) =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));

function requirePositiveInteger(raw, label) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function emulatorApiRoot(explicit) {
  if (explicit) return explicit.replace(/\/+$/, "");
  if (process.env.EMU_API_ROOT) {
    return process.env.EMU_API_ROOT.replace(/\/+$/, "");
  }
  try {
    const parsed = JSON.parse(readFileSync(rig.emuWiringPath, "utf8"));
    if (typeof parsed.apiRoot === "string" && parsed.apiRoot.length > 0) {
      return parsed.apiRoot.replace(/\/+$/, "");
    }
  } catch {
    // The error below names the missing source and the explicit override.
  }
  throw new Error(
    `emulator API root is unavailable; pass it as arg 2 or repair ${rig.emuWiringPath}`,
  );
}

async function rpc(method, params = {}) {
  return withClient((client) => client.call(method, params));
}

async function maybeGraphStatus(graphId) {
  try {
    return await rpc("graph.status", { graphId });
  } catch {
    return undefined;
  }
}

function graphEntries(dataDir) {
  const root = resolve(dataDir, "graph-runs");
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      graphId: entry.name,
      mtimeMs: statSync(resolve(root, entry.name)).mtimeMs,
    }));
}

function readAuthority(db, graphId) {
  return db.prepare(`
    SELECT checkpoint_id AS checkpointId,
           root_run_id AS rootRunId,
           status,
           checkpoint_ref AS checkpointRef,
           delivery_origin AS deliveryOrigin,
           updated_at_ms AS updatedAtMs
      FROM durable_run_checkpoints
     WHERE checkpoint_id = ?
  `).get(graphId);
}

function readProtectedCheckpoint(dataDir, checkpointRef) {
  if (typeof checkpointRef !== "string" || checkpointRef.length === 0) {
    return undefined;
  }
  const graphRoot = resolve(dataDir, "graph-runs");
  const path = resolve(dataDir, checkpointRef);
  if (!path.startsWith(`${graphRoot}${sep}`) || !existsSync(path)) {
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function checkpointCarriesProbe(checkpoint, anchor, marker) {
  if (!Array.isArray(checkpoint?.graph?.nodes)) return false;
  const tasks = checkpoint.graph.nodes
    .map((node) => node?.task)
    .filter((task) => typeof task === "string")
    .join("\n");
  return tasks.includes(anchor)
    && tasks.includes(marker)
    && checkpoint.graph.nodes.some((node) => node?.typeId === "approval-gate");
}

async function injectText(apiRoot, chatId, text) {
  const response = await fetch(
    `${apiRoot}/control/chats/${encodeURIComponent(chatId)}/messages`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        fromUserId: Number(chatId),
        text,
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`Telegram emulator injection failed with HTTP ${response.status}`);
  }
}

async function injectCallback(apiRoot, chatId, approval) {
  const response = await fetch(
    `${apiRoot}/control/chats/${encodeURIComponent(chatId)}/callbacks`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        fromUserId: Number(chatId),
        botMessageId: approval.botMessageId,
        data: approval.callbackData,
      }),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Telegram emulator pipeline approval failed with HTTP ${response.status}`,
    );
  }
}

async function outbound(apiRoot, chatId, afterMessageId = 0) {
  const response = await fetch(
    `${apiRoot}/control/chats/${encodeURIComponent(chatId)}/outbound`
      + `?afterMessageId=${afterMessageId}&waitMs=0`,
  );
  if (!response.ok) {
    throw new Error(`Telegram emulator outbound oracle failed with HTTP ${response.status}`);
  }
  const parsed = await response.json();
  if (!Array.isArray(parsed)) {
    throw new Error("Telegram emulator outbound oracle returned a non-array payload");
  }
  return parsed;
}

function latestMessageId(events) {
  return events.reduce(
    (maximum, event) =>
      Number.isFinite(event?.messageId)
        ? Math.max(maximum, Number(event.messageId))
        : maximum,
    0,
  );
}

function visibleOutboundText(event) {
  for (const candidate of [
    event?.text,
    event?.caption,
    event?.raw?.text,
    event?.raw?.caption,
  ]) {
    if (typeof candidate === "string") return candidate;
  }
  return "";
}

function resumeLogEvidence(dataDir, graphId, notBeforeMs) {
  const logsDir = resolve(dataDir, "logs");
  if (!existsSync(logsDir)) return undefined;
  const files = readdirSync(logsDir)
    .filter((name) => /^daemon.*\.log$/.test(name))
    .sort();
  for (const name of files) {
    const lines = readFileSync(resolve(logsDir, name), "utf8").split("\n");
    for (const line of lines) {
      if (!line.includes("Graph durable resume: re-entering incomplete nodes")) {
        continue;
      }
      try {
        const record = JSON.parse(line);
        const timestampMs = Date.parse(record.time ?? "");
        if (
          record.graphId === graphId
          && Number.isFinite(timestampMs)
          && timestampMs >= notBeforeMs
        ) {
          return {
            graphId: record.graphId,
            rootRunId: record.rootRunId,
            resumedNodeCount: record.resumedNodeCount,
            totalNodeCount: record.totalNodeCount,
            time: record.time,
          };
        }
      } catch {
        // Ignore non-JSON and partially rotated lines; structured matches win.
      }
    }
  }
  return undefined;
}

function runOfflineExplain(dataDir, graphId) {
  const cliEntry = comisDist("cli", "dist/cli.js");
  const result = spawnSync(
    process.execPath,
    [
      cliEntry,
      "explain",
      graphId,
      "--graph",
      "--format",
      "json",
      "--depth",
      "full",
      "--offline",
    ],
    {
      encoding: "utf8",
      timeout: 120_000,
      env: {
        ...process.env,
        COMIS_DATA_DIR: dataDir,
        COMIS_CONFIG_PATHS: resolve(dataDir, "config.yaml"),
      },
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `comis explain --graph failed: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  const firstBrace = result.stdout.indexOf("{");
  if (firstBrace < 0) {
    throw new Error("comis explain --graph returned no JSON report");
  }
  return JSON.parse(result.stdout.slice(firstBrace));
}

function restartDaemon(dataDir) {
  const startedAtMs = Date.now();
  const result = spawnSync("bash", [resolve(here, "restart-daemon.sh")], {
    encoding: "utf8",
    timeout: 180_000,
    env: {
      ...process.env,
      RIG_MODE: rig.mode,
      DATA: dataDir,
      COMIS_DATA_DIR: dataDir,
      COMIS_CONFIG_PATHS: resolve(dataDir, "config.yaml"),
      GW_PORT: String(rig.gwPort),
      COMIS_USER: rig.comisUser,
      COMIS_HOME: rig.comisHome,
      ...(rig.isLocal
        ? {
            REPO: rig.repoRoot,
            PKG: rig.codeRoot,
          }
        : {}),
    },
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(`daemon restart failed with exit ${result.status ?? "unknown"}`);
  }
  return startedAtMs;
}

async function waitForInterruptEvidence({
  dataDir,
  db,
  beforeGraphIds,
  anchor,
  marker,
  waitMs,
  apiRoot,
  chatId,
  afterMessageId,
}) {
  const ignored = new Set(beforeGraphIds);
  let selectedGraphId;
  let pipelineApprovalSent = false;
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (!pipelineApprovalSent) {
      const approval = selectPipelineApproval(
        await outbound(apiRoot, chatId, afterMessageId),
        afterMessageId,
      );
      if (approval !== undefined) {
        await injectCallback(apiRoot, chatId, approval);
        pipelineApprovalSent = true;
        console.log(
          `probe: approved attributed pipeline control message ${approval.botMessageId}`,
        );
      }
    }
    if (selectedGraphId === undefined) {
      selectedGraphId = selectUnseenGraphId(ignored, graphEntries(dataDir));
    }
    if (selectedGraphId !== undefined) {
      const authority = readAuthority(db, selectedGraphId);
      const checkpoint = readProtectedCheckpoint(
        dataDir,
        authority?.checkpointRef,
      );
      if (
        checkpoint !== undefined
        && !checkpointCarriesProbe(checkpoint, anchor, marker)
      ) {
        ignored.add(selectedGraphId);
        selectedGraphId = undefined;
        await sleep(500);
        continue;
      }
      if (
        authority?.status === "running"
        && typeof authority.rootRunId === "string"
        && authority.rootRunId.length > 0
        && typeof authority.deliveryOrigin === "string"
        && authority.deliveryOrigin.length > 0
        && checkpoint !== undefined
      ) {
        const live = await maybeGraphStatus(selectedGraphId);
        const classified = classifyInterruptEvidence(
          selectedGraphId,
          live,
          checkpoint,
        );
        if (classified.ok) {
          return {
            evidence: classified,
            authority: {
              checkpointId: authority.checkpointId,
              rootRunId: authority.rootRunId,
              status: authority.status,
              checkpointRef: authority.checkpointRef,
              updatedAtMs: authority.updatedAtMs,
            },
          };
        }
      }
    }
    await sleep(1_000);
  }
  throw new Error(
    "no probe graph reached a matching live + durable approval-gate frontier before timeout",
  );
}

async function waitForRecoveredFrontier(
  graphId,
  beforeRestart,
  dataDir,
  restartStartedAtMs,
  waitMs,
) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const snapshot = await maybeGraphStatus(graphId);
    const completedPreserved = beforeRestart.completed.every((completed) => {
      const state = snapshot?.nodes?.[completed.nodeId];
      return state?.status === "completed"
        && state.runId === completed.runId
        && state.output === completed.output;
    });
    const waitingRecovered = beforeRestart.runningNodeIds.every(
      (nodeId) => snapshot?.nodes?.[nodeId]?.status === "running",
    );
    const log = resumeLogEvidence(dataDir, graphId, restartStartedAtMs);
    if (
      snapshot?.graphId === graphId
      && snapshot.status === "running"
      && snapshot.isTerminal === false
      && completedPreserved
      && waitingRecovered
      && log !== undefined
    ) {
      return { snapshot, log };
    }
    await sleep(1_000);
  }
  throw new Error(
    "boot did not recover the same graph frontier with preserved completed nodes",
  );
}

async function waitForTerminalGraph(graphId, waitMs) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const snapshot = await maybeGraphStatus(graphId);
    if (snapshot?.graphId === graphId && snapshot.isTerminal === true) {
      return snapshot;
    }
    await sleep(1_000);
  }
  throw new Error("recovered graph did not reach a terminal state before timeout");
}

async function waitForTerminalMetadata(dataDir, graphId, waitMs) {
  const path = resolve(dataDir, "graph-runs", graphId, "_run-metadata.json");
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      await sleep(250);
    }
  }
  throw new Error("terminal graph metadata was not persisted before timeout");
}

async function waitForWireMarker(apiRoot, chatId, afterMessageId, marker, waitMs) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const events = await outbound(apiRoot, chatId, afterMessageId);
    const matching = events.filter((event) =>
      visibleOutboundText(event).includes(marker)
    );
    if (matching.length > 0) return matching.length;
    await sleep(500);
  }
  return 0;
}

async function main() {
  const [chatIdArg, apiRootArg, launchWaitArg] = process.argv.slice(2);
  const chatId = requirePositiveInteger(chatIdArg ?? rig.chatId, "chatId");
  const apiRoot = emulatorApiRoot(apiRootArg);
  const launchWaitSeconds = requirePositiveInteger(
    launchWaitArg ?? "240",
    "launchWaitSeconds",
  );
  const dataDir = rig.dataDir;
  const nonce = `${process.pid}_${Date.now()}`;
  const anchor = `DURABLE_ANCHOR_${nonce}`;
  const marker = `DURABLE_RESUME_${nonce}`;
  const message = buildProbeMessage(anchor, marker);
  const beforeGraphIds = new Set(
    graphEntries(dataDir).map(({ graphId }) => graphId),
  );
  const beforeWire = await outbound(apiRoot, chatId);
  const afterMessageId = latestMessageId(beforeWire);

  console.log(`probe: graph durability through Telegram chat ${chatId}`);
  console.log(`probe: baseline graph directories=${beforeGraphIds.size}`);
  await injectText(apiRoot, chatId, message);
  console.log("probe: natural three-stage restart request injected");

  const dbPath = resolve(dataDir, "memory.db");
  if (!existsSync(dbPath)) {
    throw new Error(`durable authority store is missing: ${dbPath}`);
  }
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  let interrupted;
  try {
    interrupted = await waitForInterruptEvidence({
      dataDir,
      db,
      beforeGraphIds,
      anchor,
      marker,
      waitMs: launchWaitSeconds * 1_000,
      apiRoot,
      chatId,
      afterMessageId,
    });
  } finally {
    db.close();
  }

  console.log(JSON.stringify({
    phase: "interrupt-ready",
    graphId: interrupted.evidence.graphId,
    completedNodeIds: interrupted.evidence.completed.map(({ nodeId }) => nodeId),
    runningNodeIds: interrupted.evidence.runningNodeIds,
    durableStatus: interrupted.authority.status,
    durableRootRunId: interrupted.authority.rootRunId,
  }));

  const restartStartedAtMs = restartDaemon(dataDir);
  const recovered = await waitForRecoveredFrontier(
    interrupted.evidence.graphId,
    interrupted.evidence,
    dataDir,
    restartStartedAtMs,
    120_000,
  );
  console.log(JSON.stringify({
    phase: "recovered",
    graphId: interrupted.evidence.graphId,
    resumedNodeCount: recovered.log.resumedNodeCount,
    totalNodeCount: recovered.log.totalNodeCount,
    resumeLogTime: recovered.log.time,
  }));

  const beforeApprovalWire = await outbound(apiRoot, chatId);
  const approvalAfterMessageId = Math.max(
    latestMessageId(beforeWire),
    latestMessageId(beforeApprovalWire),
  );
  await injectText(apiRoot, chatId, "yes");
  console.log("probe: approval injected after recovered wait became observable");

  await waitForTerminalGraph(interrupted.evidence.graphId, 300_000);
  const metadata = await waitForTerminalMetadata(
    dataDir,
    interrupted.evidence.graphId,
    30_000,
  );
  const runDetail = await rpc("graph.runDetail", {
    graphId: interrupted.evidence.graphId,
  });
  const incident = runOfflineExplain(dataDir, interrupted.evidence.graphId);
  const verified = verifyResumeOutcome({
    graphId: interrupted.evidence.graphId,
    marker,
    beforeRestart: interrupted.evidence,
    metadata,
    runDetail,
    incident,
  });
  if (!verified.ok) throw new Error(verified.reason);

  const wireMarkerCount = await waitForWireMarker(
    apiRoot,
    chatId,
    approvalAfterMessageId,
    marker,
    30_000,
  );
  if (wireMarkerCount !== 1) {
    throw new Error(
      `post-restart marker appeared ${wireMarkerCount} times on the Telegram wire; expected exactly once`,
    );
  }

  console.log(JSON.stringify({
    verdict: "PASS",
    graphId: verified.graphId,
    preservedCompletedNodeIds: verified.preservedCompletedNodeIds,
    markerNodeId: verified.markerNodeId,
    wireMarkerCount,
    terminalStatus: metadata.status,
    explainGraphStatus: incident.graph?.status,
  }));
}

main().catch((error) => {
  console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
