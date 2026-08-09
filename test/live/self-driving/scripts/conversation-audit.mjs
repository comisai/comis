#!/usr/bin/env node
// Assemble a content-free verdict for one emulator-backed Telegram conversation.
//
// Usage: node conversation-audit.mjs <chatId> [contract.json]
//
// The live command resolves the actual nested session layout, reads its session and
// trajectory JSONL, fetches the emulator wire, assembles obs.explain offline, then passes
// only counts and named violations to stdout. Exit 1 means a HARD evidence violation.
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { auditConversationEvidence } from "./conversation-audit-oracle.mjs";
import { comisDist, rig } from "./_rig.mjs";
import { paramsForExplainRef } from "./explain-ref.mjs";
import { resolveChatSessionArtifacts } from "./session-artifact-ref.mjs";

export function readJsonlEvidence(file) {
  const records = [];
  const lines = readFileSync(file, "utf8").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line.length === 0) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      throw new Error(`${basename(file)} contains malformed JSON on line ${index + 1}`);
    }
  }
  return records;
}

function sessionIdFor(sessionFile) {
  const pointerFile = `${sessionFile}.trajectory-path.json`;
  let pointer;
  try {
    pointer = JSON.parse(readFileSync(pointerFile, "utf8"));
  } catch {
    throw new Error("current session trajectory pointer is unreadable");
  }
  if (
    pointer?.traceSchema !== "comis-trajectory-pointer"
    || pointer?.schemaVersion !== 1
    || typeof pointer?.sessionId !== "string"
    || pointer.sessionId.length === 0
  ) {
    throw new Error("current session trajectory pointer has no durable session id");
  }
  return pointer.sessionId;
}

export async function auditChatConversation({
  dataDir,
  chatId,
  contract = {},
  loadWireRecords,
  loadIncidentReport,
}) {
  const artifacts = resolveChatSessionArtifacts(dataDir, String(chatId));
  if (artifacts === undefined) {
    throw new Error(`no current Telegram session artifacts were found for chat ${chatId}`);
  }
  const sessionId = sessionIdFor(artifacts.sessionFile);
  const [wireRecords, incidentReport] = await Promise.all([
    loadWireRecords(),
    loadIncidentReport(sessionId),
  ]);
  const report = auditConversationEvidence({
    trajectoryRecords: readJsonlEvidence(artifacts.trajectoryFile),
    sessionRecords: readJsonlEvidence(artifacts.sessionFile),
    wireRecords,
    incidentReport,
    contract,
  });
  return {
    artifacts: {
      sessionFile: artifacts.sessionFile,
      trajectoryFile: artifacts.trajectoryFile,
      sessionId,
    },
    report,
  };
}

function loadContract(file) {
  if (file === undefined) return {};
  let contract;
  try {
    contract = JSON.parse(readFileSync(resolve(file), "utf8"));
  } catch {
    throw new Error(`conversation audit contract is unreadable: ${file}`);
  }
  if (contract === null || typeof contract !== "object" || Array.isArray(contract)) {
    throw new Error("conversation audit contract must be a JSON object");
  }
  return contract;
}

async function emulatorWireRecords(chatId) {
  let wiring;
  try {
    wiring = JSON.parse(readFileSync(rig.emuWiringPath, "utf8"));
  } catch {
    throw new Error("Telegram emulator wiring is unavailable");
  }
  if (!Number.isInteger(wiring?.port) || wiring.port <= 0) {
    throw new Error("Telegram emulator wiring has no valid port");
  }
  const response = await fetch(
    `http://127.0.0.1:${wiring.port}/control/chats/${chatId}/outbound?afterMessageId=0`,
  );
  if (!response.ok) {
    throw new Error(`Telegram emulator outbound read failed with HTTP ${response.status}`);
  }
  const body = await response.json();
  const records = Array.isArray(body) ? body : body?.messages;
  if (!Array.isArray(records)) {
    throw new Error("Telegram emulator outbound response is not a message array");
  }
  return records;
}

async function incidentReportFor(sessionId) {
  // Strict dev parsing can reject the very report this command is intended to diagnose.
  // Production assembly still validates its durable inputs and returns honest coverage.
  if (process.env.NODE_ENV === undefined) process.env.NODE_ENV = "production";
  const daemonDist = await import(comisDist("daemon", "dist/index.js"));
  const exports = { ...daemonDist.default, ...daemonDist };
  if (
    typeof exports.assembleIncidentReportFromSources !== "function"
    || typeof exports.makeRealReader !== "function"
  ) {
    throw new Error("deployed observability incident-report exports are unavailable");
  }
  return exports.assembleIncidentReportFromSources(
    exports.makeRealReader(rig.dataDir),
    rig.dataDir,
    paramsForExplainRef(sessionId, "full"),
  );
}

const invokedPath = process.argv[1] === undefined
  ? undefined
  : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  const chatId = process.argv[2];
  const contractFile = process.argv[3];
  if (chatId === undefined || process.argv.length > 4) {
    process.stderr.write("usage: conversation-audit.mjs <chatId> [contract.json]\n");
    process.exitCode = 2;
  } else {
    auditChatConversation({
      dataDir: rig.dataDir,
      chatId,
      contract: loadContract(contractFile),
      loadWireRecords: () => emulatorWireRecords(chatId),
      loadIncidentReport: incidentReportFor,
    }).then((output) => {
      process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
      process.exitCode = output.report.verdict === "pass" ? 0 : 1;
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`conversation-audit.mjs: ${message}\n`);
      process.exitCode = 2;
    });
  }
}
