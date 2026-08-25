// SPDX-License-Identifier: Apache-2.0
/**
 * The shared surface the dead-letter queue's lifecycle stages operate on.
 *
 * The queue is one long-lived closure over a record set, a config, and a
 * handful of persistence primitives. Its stages — governed drain, delivery
 * attempts, decision reservations, producer promotion — each need most of that
 * surface, and several call into each other, so naming it once is what lets
 * them live in separate modules at all.
 *
 * Stages take this whole object rather than a hand-picked subset because the
 * call graph between them is genuinely dense: narrowing per stage would mean
 * re-deriving a bespoke interface every time one stage starts calling another,
 * and the compiler would not catch a stage that silently stopped needing one.
 *
 * @module
 */
import type {
  AnnouncementDeadLetterAttachmentSnapshot,
  AnnouncementDeadLetterAttachmentSource,
  AnnouncementDeadLetterEntryInput,
  AnnouncementParentDecisionReservation,
  AnnouncementProducerRecoveryOutcome,
  AnnouncementProducerReservation,
  OutwardSendLedgerPort,
  QuarantinedInvalidAnnouncementRecord,
} from "@comis/core";
import type { Result } from "@comis/shared";
import type { GovernedAnnouncementAttachment } from "./announcement-outward-operation.js";
import type { createParentDecisionReservationStore } from "./announcement-dead-letter-file.js";
import type {
  ChannelType,
  DeadLetterEntry,
  AnnouncementProducerHandoffRecord,
  ParentDecisionReservationRecord,
  ProducerReservationRecord,
  StoredDeadLetterEntry,
} from "./announcement-dead-letter-file.js";
import type { InvalidDeadLetterRecord } from "./announcement-dead-letter-invalid.js";
import type {
  AnnouncementTerminalDecision,
  createAnnouncementTerminalDecisionStore,
} from "./announcement-dead-letter-terminal-decision.js";
import type { GovernedDeadLetterIdentity } from "./announcement-dead-letter-identity.js";
import type {
  AnnouncementDeadLetterQueueOptions,
  AnnouncementLogger,
  PreparedRecoveryAttachment,
  RecoveryDeliveryOptions,
} from "./announcement-dead-letter-types.js";

/** Outcome of draining one governed entry against the outward ledger. */
export type GovernedDrainOutcome =
  | "receipt_already_committed"
  | "receipt_committed_now"
  | "retained";

/**
 * The queue's in-memory record set.
 *
 * One object rather than six bindings because persistence is all-or-nothing:
 * every record kind is rewritten to the same JSONL file in a single atomic
 * replace, so they are read and swapped together. Grouping them lets the
 * lifecycle stages that own each kind take the whole set explicitly instead of
 * closing over it.
 */
export interface DeadLetterRecordStore {
  entries: DeadLetterEntry[];
  decisionReservations: ParentDecisionReservationRecord[];
  producerReservations: ProducerReservationRecord[];
  producerHandoffs: AnnouncementProducerHandoffRecord[];
  invalidRecords: InvalidDeadLetterRecord[];
  terminalInvalidRecords: QuarantinedInvalidAnnouncementRecord[];
}

export type AnnouncementTextChunkOwner = AnnouncementParentDecisionReservation;

/** Marks a chunk whose platform send started but whose result is not yet known. */
export const CHUNK_IN_FLIGHT_PREFIX = "outward_operation_in_flight:";
/** Marks a chunk left undecided, which recovery must adjudicate before reuse. */
export const CHUNK_UNRESOLVED_PREFIX = "outward_operation_unresolved:";

/** Steps of the outward-ledger handshake an entry can be reported at. */
export type LedgerTransition =
  | "prepare" | "allocate" | "lookup" | "begin"
  | "mark_unknown" | "commit" | "mark_failed" | "park";

/** Where the entry ended up after that step. */
export type LedgerOutcome =
  | "prepared" | "blocked" | "in_flight" | "committed" | "failed" | "parked";

export interface DeadLetterQueueContext {
  // --- state + config -------------------------------------------------------
  store: DeadLetterRecordStore;
  maxRetries: number;
  retryIntervalMs: number;
  maxAgeMs: number;
  maxEntries: number;
  parentDecisionGraceMs: number;
  filePath: string;
  logger?: AnnouncementLogger;
  outwardLedger?: OutwardSendLedgerPort;
  activeProducerKeys: Set<string>;
  emittedAdmissionKeys: Set<string>;
  opts: AnnouncementDeadLetterQueueOptions;
  eventBus: AnnouncementDeadLetterQueueOptions["eventBus"];
  governedSendToChannel: AnnouncementDeadLetterQueueOptions["governedSendToChannel"];
  receiptAwareSendToChannel: AnnouncementDeadLetterQueueOptions["receiptAwareSendToChannel"];
  prepareAttachment: AnnouncementDeadLetterQueueOptions["prepareAttachment"];
  cleanupAttachment: AnnouncementDeadLetterQueueOptions["cleanupAttachment"];
  reconcileAttachments: AnnouncementDeadLetterQueueOptions["reconcileAttachments"];
  retirementProducerState: AnnouncementDeadLetterQueueOptions["retirementProducerState"];
  fileOperations: AnnouncementDeadLetterQueueOptions["fileOperations"];
  terminalDecisionStore: ReturnType<typeof createAnnouncementTerminalDecisionStore>;

  // --- persistence + scheduling primitives ----------------------------------
  serialize: <T>(operation: () => Promise<T>) => Promise<T>;
  serializeStateChange: <T>(operation: () => Promise<T>) => Promise<T>;
  signalCapacityChange: () => void;
  waitForCapacity: (version: number, signal?: AbortSignal) => Promise<boolean>;
  admitWithBackpressure: <T>(
    operation: () => Promise<Result<T, Error>>,
    signal?: AbortSignal,
    retainOnCancellation?: () => Promise<Result<T, Error>>,
  ) => Promise<Result<T, Error>>;
  loadFromDisk: () => Promise<Result<void, Error>>;
  persist: (
    nextEntries: readonly DeadLetterEntry[],
    nextReservations?: readonly ParentDecisionReservationRecord[],
    nextInvalidRecords?: readonly InvalidDeadLetterRecord[],
    nextProducerHandoffs?: readonly AnnouncementProducerHandoffRecord[],
    nextProducerReservations?: readonly ProducerReservationRecord[],
    consumedProducerKeys?: readonly string[],
  ) => Promise<Result<void, Error>>;
  canPersistCounts: (nextEntryCount: number, nextReservationCount: number) => boolean;
  canPersistProducerOwnership: (
    nextProducerOwnershipCount: number,
    consumedProducerKeys?: ReadonlySet<string>,
  ) => boolean;
  snapshotRecords: () => StoredDeadLetterEntry[];
  producerCapacityCount: () => number;
  quarantineCapacityCount: () => number;
  collectTerminalRetirementsDurably: () => Promise<Result<number, Error>>;
  refreshTerminalInvalidRecords: () => Promise<Result<void, Error>>;

  // --- attachments ----------------------------------------------------------
  isSourceAttachment: (
    attachment: AnnouncementDeadLetterEntryInput["attachment"],
  ) => attachment is AnnouncementDeadLetterAttachmentSource;
  preparedSnapshot: (
    attachment: PreparedRecoveryAttachment,
  ) => AnnouncementDeadLetterAttachmentSnapshot;
  cleanupUnreferencedSnapshots: (
    candidates: readonly {
      attachment: AnnouncementDeadLetterAttachmentSnapshot;
      cleanup?: () => Promise<Result<void, Error>>;
    }[],
  ) => Promise<void>;

  // --- observability --------------------------------------------------------
  emitAdmission: (entry: DeadLetterEntry) => void;
  emitDelivered: (entry: DeadLetterEntry, attemptCount: number) => void;
  emitLedgerTransition: (
    identity: Pick<GovernedDeadLetterIdentity, "rootRunId" | "stepIndex" | "runId" | "sessionKey">,
    transition: LedgerTransition,
    outcome: LedgerOutcome,
    details?: { platformMessageId?: string },
  ) => void;
  logLedgerFailure: (
    entry: DeadLetterEntry,
    transition: string,
    errorKind: "dependency" | "precondition" | "validation",
    hint: string,
    message: string,
  ) => void;
  retainBlockedEntry: (entry: DeadLetterEntry, reason: string) => void;

  // --- terminal decisions ---------------------------------------------------
  lookupTerminalDecision: (
    owner: AnnouncementDeadLetterEntryInput | AnnouncementParentDecisionReservation,
  ) => Promise<Result<AnnouncementTerminalDecision | undefined, Error>>;
  recordTerminalDecision: (
    owner: AnnouncementDeadLetterEntryInput | AnnouncementParentDecisionReservation,
    outcome: AnnouncementTerminalDecision,
  ) => Promise<Result<void, Error>>;
  terminalizeOwner: (
    owner: AnnouncementDeadLetterEntryInput | AnnouncementParentDecisionReservation,
    outcome: AnnouncementTerminalDecision,
    retainedEntries: readonly DeadLetterEntry[],
    retainedReservations: readonly AnnouncementParentDecisionReservation[],
  ) => Promise<Result<void, Error>>;
  retainsCompletionKey: (
    completionKey: string,
    retainedEntries: readonly DeadLetterEntry[],
    retainedReservations: readonly AnnouncementParentDecisionReservation[],
  ) => boolean;
  resolveDecisionDurably: (
    idempotencyKey: string,
    outcome: "receipt_committed" | "no_reply",
  ) => Promise<Result<boolean, Error>>;

  // --- text chunks ----------------------------------------------------------
  textChunkOwners: (
    owner: AnnouncementDeadLetterEntryInput | AnnouncementParentDecisionReservation,
  ) => AnnouncementTextChunkOwner[];
  unresolvedChunkOperationId: (entry: DeadLetterEntry) => string | undefined;
  settleTextChunkRelease: (
    entry: DeadLetterEntry,
    outcome: "delivered" | "discarded",
  ) => Promise<Result<"release" | "retain", Error>>;
  recordDrainingEntryTextChunks: (
    entry: DeadLetterEntry,
    chunks: readonly string[],
  ) => Promise<Result<void, Error>>;

  // --- drain ----------------------------------------------------------------
  recoveryOptions: (entry: DeadLetterEntry) => RecoveryDeliveryOptions | undefined;
  retryEntryFromReservation: (
    reservation: ParentDecisionReservationRecord,
    options?: { readonly lastError?: string; readonly stepIndex?: number },
  ) => DeadLetterEntry;
  parkGovernedEntry: (
    ledger: OutwardSendLedgerPort,
    entry: DeadLetterEntry,
    identity: Pick<GovernedDeadLetterIdentity, "rootRunId" | "stepIndex" | "runId" | "sessionKey">,
  ) => Promise<void>;
  drainPreparedGovernedEntry: (
    ledger: OutwardSendLedgerPort,
    entry: DeadLetterEntry,
    preparedAttachment?: GovernedAnnouncementAttachment,
  ) => Promise<GovernedDrainOutcome>;
  drainGovernedEntry: (
    ledger: OutwardSendLedgerPort,
    entry: DeadLetterEntry,
  ) => Promise<GovernedDrainOutcome>;
  drainLedgerlessTextChunks: (
    entry: DeadLetterEntry,
    workingEntries: readonly DeadLetterEntry[],
    deliveredIds: ReadonlySet<string>,
  ) => Promise<"delivered" | "retained" | "discarded" | "no_reply">;
  adjudicateReservations: (ledger?: OutwardSendLedgerPort) => Promise<void>;
  drainSerialized: (
    sendToChannel: (
      type: ChannelType,
      id: string,
      text: string,
      options?: RecoveryDeliveryOptions,
    ) => Promise<boolean>,
    onDelivered?: (idempotencyKey: string) => void,
  ) => Promise<void>;

  // --- producers ------------------------------------------------------------
  publicProducerReservation: (record: ProducerReservationRecord) => AnnouncementProducerReservation;
  producerRecoveryAnnouncement: (
    record: ProducerReservationRecord,
  ) => AnnouncementProducerReservation;
  consumeProducerSlots: (producerKeys: Iterable<string>) => void;
  consumeProducerReservationsDurably: (
    producerKeys: readonly string[],
  ) => Promise<Result<void, Error>>;
  promoteProducerReservations: () => Promise<void>;
  recordProducerOutcomeDurably: (
    producerKey: string,
    outcome: AnnouncementProducerRecoveryOutcome,
  ) => Promise<Result<void, Error>>;
  releaseProducerDurably: (producerKey: string) => Promise<Result<void, Error>>;
  removeProducerReservationDurably: (producerKey: string) => Promise<Result<void, Error>>;
  promoteProducerHandoffs: () => Promise<void>;
  decisionStore: ReturnType<typeof createParentDecisionReservationStore>;
  prepareReservedAttachment: <T extends {
    idempotencyKey: string;
    attachment?: AnnouncementDeadLetterEntryInput["attachment"];
  }>(
    entry: T,
    reusable?: readonly AnnouncementParentDecisionReservation[],
  ) => Promise<Result<{ entry: T; cleanup?: () => Promise<Result<void, Error>> }, Error>>;
}
