// SPDX-License-Identifier: Apache-2.0
/**
 * `extractSessionMessages` — the offline inbound-message extraction behind
 * `comis messages`.
 *
 * Reads the raw session `.jsonl` message logs from every agent workspace tree
 * under the data dir and returns the inbound channel messages users typed.
 * Trajectory files are consulted only for content-free, authoritative channel
 * classification of otherwise-headerless records. Current sessions carry a structured, non-context SDK
 * custom entry containing every physical inbound represented by a turn.
 * Envelope parsing remains the on-disk fallback for records without a marker, using the
 * grammar `[<channelType>] <senderId> (<time>):\n<text>` that `wrapInEnvelope`
 * writes inside each user-role record.
 *
 * This content-bearing reader is local-only, soft-fails with honest coverage,
 * and bounds files, bytes, logical records, individual records, and results.
 * It must not be exposed through RPC/MCP without a governance review.
 *
 * @module
 */

import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { formatSessionKey, redactOutputText } from "@comis/core";
import { tryCatch } from "@comis/shared";
import {
  INBOUND_MESSAGE_LEDGER_SUFFIX,
  inboundMessageLedgerPathToSessionKey,
  pathToSessionKey,
} from "@comis/agent";
import {
  listSafeSessionDirectories,
  listSafeSessionFiles,
  listSessionWorkspaceTrees,
} from "./session-message-file-tree.js";
import {
  MAX_SESSION_MESSAGE_FILE_SCAN_BYTES,
  MAX_SESSION_MESSAGE_TOTAL_SCAN_BYTES,
  readLatestLogicalRecords,
  type BoundedLogicalRecord,
} from "./session-message-log-reader.js";
import {
  createProvenanceAssembler,
  decodeProvenanceRecord,
} from "./session-message-provenance.js";
import {
  parseSessionEnvelope,
} from "./session-message-envelope.js";
import {
  classifySessionChannelFromTrajectory,
  inferSessionChannel,
  type SessionMessageChannelClassification,
} from "./session-message-channel-evidence.js";
import {
  acceptProvenanceOccurrence,
  classifySessionMessageOrigin,
  compareRankedMessages,
  isInternalSessionChannel,
  resolveMessageLimit,
  retainLatestMessage,
  retainPendingEvidence,
  trustedSessionSender,
  type PendingUnparsedEvidence,
  type RankedExtractedChannelMessage,
  type SeenProvenanceIdentity,
} from "./session-message-acceptance.js";
import type {
  SessionMessagesCompleteness,
  SessionMessagesCoverage,
  SessionMessagesFilter,
  SessionMessagesIncompleteReason,
  SessionMessagesResult,
  SessionMessagesSourceOptions,
} from "./session-message-report.js";
export type {
  ExtractedChannelMessage,
  SessionMessagesCompleteness,
  SessionMessagesCoverage,
  SessionMessagesFilter,
  SessionMessagesIncompleteReason,
  SessionMessagesResult,
  SessionMessagesSourceOptions,
  UnparsedSessionMessageEvidence,
  UnparsedSessionMessageReason,
} from "./session-message-report.js";

/** Runaway backstop on the tree walk: at most this many session files are read. */
const MAX_SESSION_FILES = 5_000;

/** Hard ceiling on extracted messages; direct callers above it are rejected. */
const MAX_MESSAGES = 10_000;

/** Bounded backfill runway when a retained physical identity later conflicts. */
const MAX_CONFLICT_CANDIDATES = MAX_MESSAGES * 2;

/** Maximum redacted characters retained from one unparsed record. */
const MAX_UNPARSED_PREVIEW_CHARS = 256;

/** A raw session-log user record's envelope text, or undefined for other records. */
function userRecordText(record: Record<string, unknown>): string | undefined {
  if (record["type"] !== "message") return undefined;
  const message = record["message"];
  if (message === null || typeof message !== "object") return undefined;
  const m = message as Record<string, unknown>;
  if (m["role"] !== "user") return undefined;
  const content = m["content"];
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  return content
    .filter(
      (b): b is { type: "text"; text: string } =>
        b !== null &&
        typeof b === "object" &&
        (b as { type?: unknown }).type === "text" &&
        typeof (b as { text?: unknown }).text === "string",
    )
    .map((b) => b.text)
    .join("");
}

/** Whether a user-role record is durable synthetic compaction context. */
function isCompactionSummaryRecord(record: Record<string, unknown>): boolean {
  const message = record["message"];
  if (message === null || typeof message !== "object") return false;
  const m = message as Record<string, unknown>;
  return m["role"] === "user" && m["compactionSummary"] === true;
}

/** Parse one bounded line as a JSON object record. */
function decodeJsonObject(line: string): Record<string, unknown> | undefined {
  const decoded = tryCatch(() => JSON.parse(line) as unknown);
  if (
    !decoded.ok ||
    decoded.value === null ||
    typeof decoded.value !== "object" ||
    Array.isArray(decoded.value)
  ) return undefined;
  return decoded.value as Record<string, unknown>;
}

/** Index of the oldest ordinary record retained after the predecessor runway. */
function firstOrdinaryRecordIndex(records: BoundedLogicalRecord[]): number {
  const index = records.findIndex((record) => !record.contextOnly);
  return index < 0 ? records.length : index;
}

/**
 * Select the provenance-only suffix of the record-cap predecessor runway.
 * Main transcripts use only the contiguous provenance suffix; ledger sidecars
 * have no SDK records and use the full runway so an occurrence may cross the
 * retained boundary.
 */
function provenanceProcessingStart(
  records: BoundedLogicalRecord[],
  ordinaryStart: number,
  expectedChannelId: string,
  isLedger: boolean,
): number {
  if (ordinaryStart === 0 || ordinaryStart >= records.length) return ordinaryStart;
  if (isLedger) return 0;
  let start = ordinaryStart;
  while (start > 0) {
    const predecessor = records[start - 1];
    if (predecessor?.kind !== "line" || !predecessor.contextOnly) break;
    const record = decodeJsonObject(predecessor.line);
    if (record === undefined) break;
    if (decodeProvenanceRecord(record, expectedChannelId).kind === "other") break;
    start--;
  }
  return start;
}

/** Whether context-only provenance directly precedes the retained SDK user prompt. */
function boundaryContextTargetsUser(
  records: BoundedLogicalRecord[],
  ordinaryStart: number,
): boolean {
  const first = records[ordinaryStart];
  if (first?.kind !== "line") return false;
  const record = decodeJsonObject(first.line);
  return record !== undefined &&
    userRecordText(record) !== undefined &&
    !isCompactionSummaryRecord(record);
}

/** A trusted SDK boundary after which ordinary-message fallback parsing is unambiguous. */
function isSafeFallbackBoundary(record: Record<string, unknown>): boolean {
  if (record["type"] === "session") return true;
  if (record["type"] !== "message") return false;
  const message = record["message"];
  return message !== null &&
    typeof message === "object" &&
    (message as Record<string, unknown>)["role"] === "assistant";
}

/** Whether an input path exists as a non-symlink directory. */
function isRealDirectory(path: string): boolean {
  const result = tryCatch(() => fs.lstatSync(path));
  return result.ok && result.value.isDirectory() && !result.value.isSymbolicLink();
}

/**
 * Extract inbound channel messages from every session log under the data dir.
 *
 * Pure offline read — never throws; every degradation is a `coverage` counter.
 * Messages are returned in chronological (ascending) order; when `limit` cuts
 * the result the LATEST N are kept and `coverage.truncated` is set.
 */
export function extractSessionMessages(
  dataDir: string,
  filter: SessionMessagesFilter,
  sources: SessionMessagesSourceOptions = {},
): SessionMessagesResult {
  const limit = resolveMessageLimit(filter, MAX_MESSAGES);
  const coverage: SessionMessagesCoverage = {
    requestedLimit: limit.requested,
    effectiveLimit: limit.effective,
    limitRejected: limit.rejected,
    dataDirExists: isRealDirectory(dataDir),
    workspaceTreesSeen: 0,
    sessionRootsSeen: 0,
    filesScanned: 0,
    fileCapReached: false,
    filesUnreadable: 0,
    sessionDirectoriesUnreadable: 0,
    corruptRecords: 0,
    oversizedRecords: 0,
    userRecordsSeen: 0,
    structuredProvenanceRecordsSeen: 0,
    invalidProvenanceRecords: 0,
    duplicateProvenanceMessagesExcluded: 0,
    mirrorDifferencesReconciled: 0,
    provenanceConflicts: 0,
    expectedSidecars: 0,
    missingSidecars: 0,
    conflictCandidateCapReached: false,
    conflictBackfillIncomplete: false,
    compactionSummaryRecordsExcluded: 0,
    unparsedUserRecords: 0,
    unparsedEvidence: [],
    unparsedEvidenceCapped: 0,
    ambiguousEnvelopeRecords: 0,
    recordCappedFiles: 0,
    bytesScanned: 0,
    byteCappedFiles: 0,
    totalByteCapReached: false,
    internalExcluded: 0,
    secretRedactions: 0,
    truncated: false,
    matchedBeforeLimit: 0,
    messagesReturned: 0,
    physicalMessagesMatched: 0,
    sourceTruncated: false,
  };
  const messageLimit = limit.effective;
  // Keep a fixed, globally bounded backfill runway. Tying this to `limit`
  // meant a late run of more than N conflicts could empty a 2N heap even
  // though older valid messages were scanned. The hard 20k ceiling preserves
  // the memory bound while covering the full 10k public result plus one
  // maximum-size conflicted occurrence.
  const candidateLimit = MAX_CONFLICT_CANDIDATES;
  const matches: RankedExtractedChannelMessage[] = [];
  let sourceOrder = 0;
  const seenProvenanceIdentities = new Map<string, SeenProvenanceIdentity>();
  const conflictedProvenanceIdentities = new Set<string>();
  const pendingEvidence: PendingUnparsedEvidence[] = [];
  const inferredChannels = new Map<string, Set<string>>();
  const countUnreadableDirectory = (): void => {
    coverage.sessionDirectoriesUnreadable++;
  };

  if (limit.rejected) {
    return finish(
      matches,
      coverage,
      messageLimit,
      conflictedProvenanceIdentities.size,
      pendingEvidence,
      inferredChannels,
      filter,
      dataDir,
      sources,
    );
  }

  const workspaceTrees = listSessionWorkspaceTrees(dataDir, countUnreadableDirectory);
  coverage.workspaceTreesSeen = workspaceTrees.length;
  for (const tree of workspaceTrees) {
    if (filter.agent !== undefined && filter.agent !== tree.agentId) continue;
    const sessionsBase = tree.sessionsBase;
    if (!isRealDirectory(sessionsBase)) continue;
    coverage.sessionRootsSeen++;
    for (const tenant of listSafeSessionDirectories(
      sessionsBase,
      countUnreadableDirectory,
    )) {
      for (const channel of listSafeSessionDirectories(
        tenant.path,
        countUnreadableDirectory,
      )) {
        const sessionFiles = listSafeSessionFiles(
          channel.path,
          countUnreadableDirectory,
          () => { coverage.filesUnreadable++; },
        );
        const sessionFilePaths = new Set(sessionFiles.map((file) => file.path));
        for (const file of sessionFiles) {
          const { name, path: filePath } = file;
          if (!name.endsWith(".jsonl") || name.endsWith(".trajectory.jsonl")) continue;
          const ledgerKey = inboundMessageLedgerPathToSessionKey(filePath, sessionsBase);
          const isLedger = ledgerKey !== undefined;
          const transcriptFile = isLedger
            ? `${filePath.slice(0, -INBOUND_MESSAGE_LEDGER_SUFFIX.length)}.jsonl`
            : filePath;
          const key = ledgerKey ?? pathToSessionKey(filePath, sessionsBase);
          if (key === undefined) continue; // Not a session-log filename shape.
          if (filter.chat !== undefined && filter.chat !== key.channelId) continue;
          if (coverage.filesScanned >= MAX_SESSION_FILES) {
            coverage.fileCapReached = true;
            coverage.sourceTruncated = true;
            return finish(
              matches,
              coverage,
              messageLimit,
              conflictedProvenanceIdentities.size,
              pendingEvidence,
              inferredChannels,
              filter,
              dataDir,
              sources,
            );
          }
          if (coverage.bytesScanned >= MAX_SESSION_MESSAGE_TOTAL_SCAN_BYTES) {
            coverage.totalByteCapReached = true;
            coverage.sourceTruncated = true;
            return finish(
              matches,
              coverage,
              messageLimit,
              conflictedProvenanceIdentities.size,
              pendingEvidence,
              inferredChannels,
              filter,
              dataDir,
              sources,
            );
          }
          coverage.filesScanned++;

          const scanBudget = Math.min(
            MAX_SESSION_MESSAGE_FILE_SCAN_BYTES,
            MAX_SESSION_MESSAGE_TOTAL_SCAN_BYTES - coverage.bytesScanned,
          );
          const scanned = readLatestLogicalRecords(filePath, scanBudget);
          if (!scanned.ok) {
            coverage.filesUnreadable++;
            continue;
          }
          coverage.bytesScanned += scanned.value.bytesScanned;
          if (scanned.value.capped) {
            coverage.recordCappedFiles++;
            coverage.sourceTruncated = true;
          }
          if (scanned.value.byteCapped) {
            coverage.byteCappedFiles++;
            coverage.sourceTruncated = true;
            if (scanBudget < MAX_SESSION_MESSAGE_FILE_SCAN_BYTES) {
              coverage.totalByteCapReached = true;
            }
          }
          const formattedKey = formatSessionKey(key);
          let trajectoryChannel: SessionMessageChannelClassification | undefined;
          const getTrajectoryChannel = (): SessionMessageChannelClassification => {
            trajectoryChannel ??= classifySessionChannelFromTrajectory(
              transcriptFile,
              formattedKey,
              key.channelId,
              {
                dataDir,
                ...(sources.trajectoryDir === undefined
                  ? {}
                  : { trajectoryDir: sources.trajectoryDir }),
              },
            );
            return trajectoryChannel;
          };
          let structuredCoverageActive = false;
          const ordinaryStart = firstOrdinaryRecordIndex(scanned.value.records);
          const processingStart = provenanceProcessingStart(
            scanned.value.records,
            ordinaryStart,
            key.channelId,
            isLedger,
          );
          const contextCompletionAllowed = boundaryContextTargetsUser(
            scanned.value.records,
            ordinaryStart,
          );
          const assembler = createProvenanceAssembler();
          let fallbackBoundaryUncertain = scanned.value.prefixUncertain;
          const applyAssembly = (
            update: ReturnType<typeof assembler.consume>,
          ): void => {
            structuredCoverageActive ||= update.structured;
            coverage.structuredProvenanceRecordsSeen += update.validRecords;
            coverage.invalidProvenanceRecords += update.invalidOccurrences;
            for (const occurrence of update.completed) {
              if (
                !occurrence.containsOrdinaryRecord &&
                (isLedger || !contextCompletionAllowed)
              ) continue;
              sourceOrder = acceptProvenanceOccurrence({
                occurrence,
                source: isLedger ? "ledger" : "transcript",
                sessionFile: transcriptFile,
                seenIdentities: seenProvenanceIdentities,
                conflictedIdentities: conflictedProvenanceIdentities,
                inferredChannels,
                pendingEvidence,
                sessionChannelId: key.channelId,
                formattedKey,
                agentId: tree.agentId,
                filter,
                matches,
                candidateLimit,
                coverage,
                sourceOrder,
              });
            }
          };

          for (let recordIndex = processingStart;
            recordIndex < scanned.value.records.length;
            recordIndex += 1) {
            const boundedRecord = scanned.value.records[recordIndex]!;
            if (boundedRecord.kind === "oversized") {
              applyAssembly(assembler.consume({ kind: "other" }, boundedRecord.contextOnly));
              if (!boundedRecord.contextOnly) {
                coverage.oversizedRecords++;
                coverage.sourceTruncated = true;
                fallbackBoundaryUncertain = true;
              }
              continue;
            }
            const record = decodeJsonObject(boundedRecord.line);
            if (record === undefined) {
              applyAssembly(assembler.consume({ kind: "other" }, boundedRecord.contextOnly));
              if (!boundedRecord.contextOnly) {
                coverage.corruptRecords++;
                fallbackBoundaryUncertain = true;
              }
              continue;
            }
            const provenance = decodeProvenanceRecord(record, key.channelId);
            if (provenance.kind === "invalid") {
              retainPendingEvidence(pendingEvidence, {
                reason: "invalid_provenance",
                countedAsUnparsed: false,
                sessionFile: transcriptFile,
                sessionKey: formattedKey,
                sessionChannelId: key.channelId,
                agentId: tree.agentId,
                timestamp: typeof record["timestamp"] === "string" ? record["timestamp"] : null,
                rawText: boundedRecord.line,
              }, coverage);
            }
            applyAssembly(assembler.consume(provenance, boundedRecord.contextOnly));
            if (provenance.kind !== "other") {
              fallbackBoundaryUncertain = false;
              continue;
            }

            const text = userRecordText(record);
            if (text === undefined || boundedRecord.contextOnly || isLedger) {
              if (!boundedRecord.contextOnly && isSafeFallbackBoundary(record)) {
                fallbackBoundaryUncertain = false;
              }
              continue;
            }
            coverage.userRecordsSeen++;
            if (isCompactionSummaryRecord(record)) {
              coverage.compactionSummaryRecordsExcluded++;
              continue;
            }

            // Once a valid structured marker appears, every later accepted
            // channel turn in this append-only file has its own marker. The SDK
            // user record is the model-facing synthetic prompt for that marker,
            // not another physical channel message.
            if (structuredCoverageActive) continue;

            const recordTimestamp = typeof record["timestamp"] === "string"
              ? record["timestamp"]
              : null;

            if (fallbackBoundaryUncertain) {
              retainPendingEvidence(pendingEvidence, {
                reason: "boundary_uncertain",
                countedAsUnparsed: true,
                sessionFile: transcriptFile,
                sessionKey: formattedKey,
                sessionChannelId: key.channelId,
                agentId: tree.agentId,
                timestamp: recordTimestamp,
                rawText: text,
              }, coverage);
              continue;
            }

            const timestamp = recordTimestamp ?? "";
            const epochMs = Date.parse(timestamp);
            const parsedEnvelope = parseSessionEnvelope(text);
            if (parsedEnvelope.envelope === undefined) {
              if (parsedEnvelope.ambiguous) coverage.ambiguousEnvelopeRecords++;
              const candidate = parsedEnvelope.candidate;
              const sessionSenderId = trustedSessionSender(key);
              const candidateSenderId = candidate?.senderId ?? sessionSenderId;
              const channel = getTrajectoryChannel();
              const channelType = channel.channelType;
              if (
                parsedEnvelope.unparsedReason === "unmatched" &&
                !parsedEnvelope.ambiguous &&
                candidate !== undefined &&
                sessionSenderId !== undefined &&
                candidateSenderId === sessionSenderId &&
                channel.classification === "authoritative" &&
                channelType !== undefined &&
                !Number.isNaN(epochMs)
              ) {
                if (filter.sinceMs !== undefined && epochMs < filter.sinceMs) continue;
                if (filter.untilMs !== undefined && epochMs >= filter.untilMs) continue;
                if (filter.channel !== undefined && filter.channel !== channelType) continue;
                if (filter.sender !== undefined && filter.sender !== candidateSenderId) continue;
                const origin = classifySessionMessageOrigin(
                  key.channelId,
                  channelType,
                  candidateSenderId,
                );
                if (origin === "internal" && filter.includeInternal !== true) {
                  coverage.internalExcluded++;
                  continue;
                }
                coverage.matchedBeforeLimit++;
                retainLatestMessage(matches, {
                  messageId: null,
                  timestamp,
                  epochMs,
                  channelType,
                  senderId: candidateSenderId,
                  envelopeTime: candidate.envelopeTime ?? timestamp,
                  text: candidate.text,
                  redactions: 0,
                  agentId: tree.agentId,
                  chatId: key.channelId,
                  sessionKey: formattedKey,
                  origin,
                  sourceOrder: sourceOrder++,
                }, candidateLimit, coverage);
                continue;
              }
              retainPendingEvidence(pendingEvidence, {
                reason: Number.isNaN(epochMs)
                  ? "invalid_timestamp"
                  : parsedEnvelope.unparsedReason ?? "unmatched",
                countedAsUnparsed: true,
                sessionFile: transcriptFile,
                sessionKey: formattedKey,
                sessionChannelId: key.channelId,
                agentId: tree.agentId,
                timestamp: recordTimestamp,
                rawText: parsedEnvelope.candidate?.text ?? text,
              }, coverage);
              continue;
            }
            const env = parsedEnvelope.envelope;
            const channels = inferredChannels.get(transcriptFile) ?? new Set<string>();
            channels.add(env.channelType);
            inferredChannels.set(transcriptFile, channels);
            if (Number.isNaN(epochMs)) {
              retainPendingEvidence(pendingEvidence, {
                reason: "invalid_timestamp",
                countedAsUnparsed: true,
                sessionFile: transcriptFile,
                sessionKey: formattedKey,
                sessionChannelId: key.channelId,
                agentId: tree.agentId,
                timestamp: recordTimestamp,
                rawText: text,
              }, coverage);
              continue;
            }
            if (parsedEnvelope.ambiguous) {
              coverage.ambiguousEnvelopeRecords++;
              retainPendingEvidence(pendingEvidence, {
                reason: "boundary_uncertain",
                countedAsUnparsed: false,
                sessionFile: transcriptFile,
                sessionKey: formattedKey,
                sessionChannelId: key.channelId,
                agentId: tree.agentId,
                timestamp,
                rawText: text,
              }, coverage);
            }
            if (filter.sinceMs !== undefined && epochMs < filter.sinceMs) continue;
            if (filter.untilMs !== undefined && epochMs >= filter.untilMs) continue;

            if (filter.channel !== undefined && filter.channel !== env.channelType) continue;
            if (filter.sender !== undefined && filter.sender !== env.senderId) continue;
            const origin = classifySessionMessageOrigin(
              key.channelId,
              env.channelType,
              env.senderId,
            );
            if (origin === "internal" && filter.includeInternal !== true) {
              coverage.internalExcluded++;
              continue;
            }
            coverage.matchedBeforeLimit++;
            retainLatestMessage(matches, {
              messageId: null,
              timestamp,
              epochMs,
              channelType: env.channelType,
              senderId: env.senderId,
              envelopeTime: env.envelopeTime,
              text: env.text,
              redactions: 0,
              agentId: tree.agentId,
              chatId: key.channelId,
              sessionKey: formattedKey,
              origin,
              sourceOrder: sourceOrder++,
            }, candidateLimit, coverage);
          }
          applyAssembly(assembler.finish());
          if (!isLedger && structuredCoverageActive) {
            coverage.expectedSidecars++;
            const ledgerPath = `${filePath.slice(0, -".jsonl".length)}${INBOUND_MESSAGE_LEDGER_SUFFIX}`;
            if (!sessionFilePaths.has(ledgerPath)) coverage.missingSidecars++;
          }
        }
      }
    }
  }
  return finish(
    matches,
    coverage,
    messageLimit,
    conflictedProvenanceIdentities.size,
    pendingEvidence,
    inferredChannels,
    filter,
    dataDir,
    sources,
  );
}

/** Resolve and redact bounded evidence only after all session records were seen. */
function finalizeUnparsedEvidence(
  pending: PendingUnparsedEvidence[],
  inferredChannels: Map<string, Set<string>>,
  filter: SessionMessagesFilter,
  coverage: SessionMessagesCoverage,
  dataDir: string,
  sources: SessionMessagesSourceOptions,
): void {
  const channelCache = new Map<string, SessionMessageChannelClassification>();
  for (const evidence of pending) {
    const epochMs = evidence.timestamp === null ? Number.NaN : Date.parse(evidence.timestamp);
    if (!Number.isNaN(epochMs)) {
      if (filter.sinceMs !== undefined && epochMs < filter.sinceMs) continue;
      if (filter.untilMs !== undefined && epochMs >= filter.untilMs) continue;
    }
    let channel = channelCache.get(evidence.sessionFile);
    if (channel === undefined) {
      const authoritative = classifySessionChannelFromTrajectory(
        evidence.sessionFile,
        evidence.sessionKey,
        evidence.sessionChannelId,
        {
          dataDir,
          ...(sources.trajectoryDir === undefined
            ? {}
            : { trajectoryDir: sources.trajectoryDir }),
        },
      );
      channel = authoritative.classification === "authoritative"
        ? authoritative
        : inferSessionChannel(inferredChannels.get(evidence.sessionFile) ?? new Set<string>());
      channelCache.set(evidence.sessionFile, channel);
    }
    if (
      filter.channel !== undefined && channel.channelType !== undefined &&
      channel.channelType !== filter.channel
    ) continue;
    if (
      filter.includeInternal !== true &&
      isInternalSessionChannel(evidence.sessionChannelId)
    ) continue;

    const redacted = redactOutputText(evidence.rawText);
    coverage.secretRedactions += redacted.redactions;
    coverage.unparsedEvidence.push({
      reason: evidence.reason,
      sessionKey: evidence.sessionKey,
      agentId: evidence.agentId,
      timestamp: evidence.timestamp,
      digest: createHash("sha256").update(evidence.rawText).digest("hex"),
      preview: redacted.text.slice(0, MAX_UNPARSED_PREVIEW_CHARS),
      redactions: redacted.redactions,
      channel,
    });
    if (evidence.countedAsUnparsed) coverage.unparsedUserRecords++;
  }
}

/** Derive one deterministic completeness verdict solely from coverage facts. */
function buildCompleteness(coverage: SessionMessagesCoverage): SessionMessagesCompleteness {
  if (coverage.limitRejected) {
    return { complete: false, reasons: ["limit_rejected"] };
  }
  const reasons: SessionMessagesIncompleteReason[] = [];
  if (!coverage.dataDirExists) reasons.push("data_dir_missing");
  else if (coverage.workspaceTreesSeen === 0) reasons.push("workspace_tree_missing");
  if (coverage.workspaceTreesSeen > 0 && coverage.sessionRootsSeen === 0) {
    reasons.push("session_root_missing");
  }
  if (coverage.filesUnreadable > 0 || coverage.sessionDirectoriesUnreadable > 0) {
    reasons.push("unreadable_sources");
  }
  if (coverage.corruptRecords > 0) reasons.push("corrupt_records");
  if (coverage.oversizedRecords > 0) reasons.push("oversized_records");
  if (coverage.unparsedUserRecords > 0) reasons.push("unparsed_records");
  if (coverage.ambiguousEnvelopeRecords > 0) reasons.push("ambiguous_records");
  if (coverage.invalidProvenanceRecords > 0) reasons.push("invalid_provenance");
  if (coverage.provenanceConflicts > 0) reasons.push("provenance_conflicts");
  if (coverage.missingSidecars > 0) reasons.push("missing_sidecars");
  if (coverage.sourceTruncated) reasons.push("source_truncated");
  if (coverage.truncated) reasons.push("output_truncated");
  if (coverage.unparsedEvidenceCapped > 0) reasons.push("evidence_capped");
  return { complete: reasons.length === 0, reasons };
}

/** Sort the bounded latest-message heap chronologically for public output. */
function finish(
  matches: RankedExtractedChannelMessage[],
  coverage: SessionMessagesCoverage,
  messageLimit: number,
  conflictedIdentityCount: number,
  pendingEvidence: PendingUnparsedEvidence[],
  inferredChannels: Map<string, Set<string>>,
  filter: SessionMessagesFilter,
  dataDir: string,
  sources: SessionMessagesSourceOptions,
): SessionMessagesResult {
  finalizeUnparsedEvidence(
    pendingEvidence,
    inferredChannels,
    filter,
    coverage,
    dataDir,
    sources,
  );
  matches.sort(compareRankedMessages);
  if (
    matches.length < messageLimit &&
    coverage.conflictCandidateCapReached &&
    conflictedIdentityCount > 0
  ) {
    coverage.conflictBackfillIncomplete = true;
    coverage.sourceTruncated = true;
  }
  if (coverage.matchedBeforeLimit > messageLimit) coverage.truncated = true;
  const selected = messageLimit === 0 ? [] : matches.slice(-messageLimit);
  coverage.messagesReturned = selected.length;
  coverage.physicalMessagesMatched =
    coverage.unparsedUserRecords > 0 ||
      coverage.ambiguousEnvelopeRecords > 0 ||
      coverage.provenanceConflicts > 0 ||
      coverage.unparsedEvidenceCapped > 0
      ? null
      : coverage.matchedBeforeLimit;
  return {
    messages: selected.map(({ sourceOrder: _sourceOrder, ...message }) => message),
    coverage,
    completeness: buildCompleteness(coverage),
  };
}
