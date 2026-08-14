#!/usr/bin/env node
// Assemble a content-free verdict for one emulator-backed Telegram conversation.
//
// Usage: node conversation-audit.mjs <chatId> [contract.json] [--thread <threadId>]
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

export function wireRecordsForThread(records, threadId) {
  if (threadId === undefined) return records;
  const numericThreadId = Number(threadId);
  const rootedMessageIds = new Set(
    records
      .filter((record) => Number(record?.messageThreadId) === numericThreadId)
      .map((record) => Number(record?.messageId))
      .filter(Number.isFinite),
  );
  return records.filter((record) =>
    Number(record?.messageThreadId) === numericThreadId
    || (
      record?.messageThreadId === undefined
      && rootedMessageIds.has(Number(record?.messageId))
    ));
}

// A keyless turn can die before any session transcript is written. Absence must reach the
// oracle as an empty lens — it scores the HARD `session_evidence_empty` violation — instead
// of aborting the whole audit, which would drop every lens that IS readable.
function readOptionalSessionEvidence(file) {
  try {
    return readJsonlEvidence(file);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
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
  threadId,
  contract = {},
  loadWireRecords,
  loadIncidentReport,
}) {
  const artifacts = resolveChatSessionArtifacts(dataDir, String(chatId), threadId);
  if (artifacts === undefined) {
    throw new Error(`no current Telegram session artifacts were found for chat ${chatId}`);
  }
  const sessionId = sessionIdFor(artifacts.sessionFile);
  const [allWireRecords, incidentReport] = await Promise.all([
    loadWireRecords(),
    loadIncidentReport(sessionId),
  ]);
  const wireRecords = wireRecordsForThread(allWireRecords, threadId);
  const report = auditConversationEvidence({
    trajectoryRecords: readJsonlEvidence(artifacts.trajectoryFile),
    sessionRecords: readOptionalSessionEvidence(artifacts.sessionFile),
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

export async function incidentReportFor(sessionId) {
  // Strict dev parsing can reject the very report this command is intended to diagnose.
  // Production assembly still validates its durable inputs and returns honest coverage.
  if (process.env.NODE_ENV === undefined) process.env.NODE_ENV = "production";
  const cliOfflineDist = await import(comisDist("cli", "dist/util/offline-obs.js"));
  const exports = { ...cliOfflineDist.default, ...cliOfflineDist };
  if (typeof exports.assembleIncidentReportOffline !== "function") {
    throw new Error("deployed CLI offline observability adapter is unavailable");
  }
  return exports.assembleIncidentReportOffline(
    rig.dataDir,
    paramsForExplainRef(sessionId, "full"),
  );
}

const invokedPath = process.argv[1] === undefined
  ? undefined
  : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  const chatId = process.argv[2];
  const args = process.argv.slice(3);
  const threadFlagIndex = args.indexOf("--thread");
  const threadId = threadFlagIndex === -1 ? undefined : args[threadFlagIndex + 1];
  const contractArgs = threadFlagIndex === -1
    ? args
    : args.filter((_, index) =>
      index !== threadFlagIndex && index !== threadFlagIndex + 1);
  const contractFile = contractArgs[0];
  const numericThreadId = threadId === undefined ? undefined : Number(threadId);
  if (
    chatId === undefined
    || contractArgs.length > 1
    || (threadFlagIndex !== -1 && threadId === undefined)
    || (
      numericThreadId !== undefined
      && (!Number.isSafeInteger(numericThreadId) || numericThreadId < 1)
    )
  ) {
    process.stderr.write("usage: conversation-audit.mjs <chatId> [contract.json] [--thread <threadId>]\n");
    process.exitCode = 2;
  } else {
    auditChatConversation({
      dataDir: rig.dataDir,
      chatId,
      ...(threadId === undefined ? {} : { threadId }),
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
