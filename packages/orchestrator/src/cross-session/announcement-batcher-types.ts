// SPDX-License-Identifier: Apache-2.0

import type {
  AnnouncementDeadLetterQueuePort,
  ChannelEndpoint,
  CitationEvidence,
  ConversationLocator,
  SessionKey,
  TypedEventBus,
} from "@comis/core";
import type { AnnouncementTerminalOutcome, DeliveryDedup } from "@comis/agent";
import type { Result } from "@comis/shared";
import type { ChannelType } from "./announcement-dead-letter.js";
import type {
  AnnouncementPlatformSendOutcome,
  CompletionAttachmentRef,
  SendGovernedCompletionAnnouncement,
} from "./announcement-outward-operation.js";

export interface QueuedAnnouncement {
  announcementText: string;
  announceChannelType: ChannelType;
  announceChannelId: string;
  announceThreadId?: string;
  callerAgentId: string;
  callerSessionKey: string;
  /** Canonical parent conversation authority captured at spawn time. */
  callerConversation: ConversationLocator;
  /** Immutable channel endpoint captured from the authenticated caller turn. */
  destinationEndpoint: ChannelEndpoint;
  /** Response locale resolved for the originating user turn. */
  resolvedLanguage?: string;
  citationEvidence?: CitationEvidence;
  /** Runtime-owned terminal truth that a model rewrite cannot weaken. */
  terminalOutcome: AnnouncementTerminalOutcome;
  /** Silent-control responses still deliver attachments without manufactured caption text. */
  suppressText?: boolean;
  runId: string;
  /** Opaque delivery idempotency key; absent for a top-level spawn. */
  idempotencyKey?: string;
  attachments?: CompletionAttachmentRef[];
  /** Root used to allocate the governed fallback's outward-ledger step. */
  reservationRootRunId?: string | undefined;
}

export interface AnnouncementBatcherDeps {
  eventBus: TypedEventBus;
  announceToParent: (
    callerAgentId: string,
    callerSessionKey: SessionKey,
    callerConversation: ConversationLocator,
    text: string,
    channelType: string,
    channelId: string,
    options?: {
      threadId?: string;
      resolvedLanguage?: string;
      citationEvidence?: CitationEvidence;
    },
  ) => Promise<string | undefined>;
  sendToChannel: (
    channelType: string,
    channelId: string,
    text: string,
    options?: { threadId?: string; extra?: Record<string, unknown> },
  ) => Promise<boolean>;
  logger?: {
    debug(obj: Record<string, unknown>, msg: string): void;
    warn(obj: Record<string, unknown>, msg: string): void;
  };
  debounceMs?: number;
  /** Durable decision reservation and failed-delivery quarantine. */
  deadLetterQueue?: Pick<
    AnnouncementDeadLetterQueuePort,
    "enqueue" | "beginDeliveryAttempt" | "settleDeliveryAttempt"
      | "reserveDecision" | "resolveDecision" | "replaceDecisions"
  >;
  /** Durable single-attempt sender for the irreversible final delivery. */
  sendGovernedAnnouncement?: SendGovernedCompletionAnnouncement;
  sendToChannelWithReceipt?: (
    channelType: string,
    channelId: string,
    text: string,
    options?: { threadId?: string; extra?: Record<string, unknown> },
  ) => Promise<Result<AnnouncementPlatformSendOutcome, Error>>;
  /** Shared bounded delivered-key store across every completion-delivery surface. */
  deliveryDedup?: DeliveryDedup;
}

export interface AnnouncementBatcher {
  enqueue(params: QueuedAnnouncement): Promise<Result<"queued" | "retained", Error>>;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
  readonly pending: number;
  hasDelivered(key: string): boolean;
  markDelivered(key: string): void;
  /** True while a completion remains owned by queued, admission, or uncertain state. */
  hasPending?(key: string): boolean;
}
