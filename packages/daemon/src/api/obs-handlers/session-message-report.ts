// SPDX-License-Identifier: Apache-2.0
/** Public report contract for offline inbound-message extraction. */

import type { SessionEnvelopeUnparsedReason } from "./session-message-envelope.js";
import type { SessionMessageChannelClassification } from "./session-message-channel-evidence.js";

export interface SessionMessagesFilter {
  channel?: string;
  chat?: string;
  sender?: string;
  agent?: string;
  sinceMs?: number;
  untilMs?: number;
  limit?: number;
  includeInternal?: boolean;
}

/** Trusted roots used by content-bearing auxiliary session readers. */
export interface SessionMessagesSourceOptions {
  /** Operator-configured root for trajectory files relocated from the data directory. */
  trajectoryDir?: string;
}

export interface ExtractedChannelMessage {
  messageId: string | null;
  timestamp: string;
  epochMs: number;
  channelType: string;
  senderId: string;
  envelopeTime: string;
  text: string;
  redactions: number;
  agentId: string;
  chatId: string;
  sessionKey: string;
  origin: "user" | "internal";
}

export type UnparsedSessionMessageReason =
  | SessionEnvelopeUnparsedReason
  | "invalid_timestamp"
  | "boundary_uncertain"
  | "duplicate_conflict"
  | "invalid_provenance";

export interface UnparsedSessionMessageEvidence {
  reason: UnparsedSessionMessageReason;
  sessionKey: string;
  agentId: string;
  timestamp: string | null;
  digest: string;
  preview: string;
  redactions: number;
  channel: SessionMessageChannelClassification;
}

export type SessionMessagesIncompleteReason =
  | "data_dir_missing"
  | "workspace_tree_missing"
  | "session_root_missing"
  | "unreadable_sources"
  | "corrupt_records"
  | "oversized_records"
  | "unparsed_records"
  | "ambiguous_records"
  | "invalid_provenance"
  | "provenance_conflicts"
  | "missing_sidecars"
  | "source_truncated"
  | "output_truncated"
  | "limit_rejected"
  | "evidence_capped";

export interface SessionMessagesCompleteness {
  complete: boolean;
  reasons: SessionMessagesIncompleteReason[];
}

export interface SessionMessagesCoverage {
  requestedLimit: number | null;
  effectiveLimit: number;
  limitRejected: boolean;
  dataDirExists: boolean;
  workspaceTreesSeen: number;
  sessionRootsSeen: number;
  filesScanned: number;
  fileCapReached: boolean;
  filesUnreadable: number;
  sessionDirectoriesUnreadable: number;
  corruptRecords: number;
  oversizedRecords: number;
  userRecordsSeen: number;
  structuredProvenanceRecordsSeen: number;
  invalidProvenanceRecords: number;
  duplicateProvenanceMessagesExcluded: number;
  mirrorDifferencesReconciled: number;
  provenanceConflicts: number;
  expectedSidecars: number;
  missingSidecars: number;
  conflictCandidateCapReached: boolean;
  conflictBackfillIncomplete: boolean;
  compactionSummaryRecordsExcluded: number;
  unparsedUserRecords: number;
  unparsedEvidence: UnparsedSessionMessageEvidence[];
  unparsedEvidenceCapped: number;
  ambiguousEnvelopeRecords: number;
  recordCappedFiles: number;
  bytesScanned: number;
  byteCappedFiles: number;
  totalByteCapReached: boolean;
  internalExcluded: number;
  secretRedactions: number;
  truncated: boolean;
  matchedBeforeLimit: number;
  messagesReturned: number;
  physicalMessagesMatched: number | null;
  sourceTruncated: boolean;
}

export interface SessionMessagesResult {
  messages: ExtractedChannelMessage[];
  coverage: SessionMessagesCoverage;
  completeness: SessionMessagesCompleteness;
}
