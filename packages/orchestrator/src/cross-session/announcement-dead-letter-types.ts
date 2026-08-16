// SPDX-License-Identifier: Apache-2.0

import type {
  AnnouncementDeadLetterAttachment,
  ChannelEndpoint,
  DeliveryAuthority,
  OutwardSendLedgerPort,
  TypedEventBus,
} from "@comis/core";
import type {
  AnnouncementDeliveryOptions,
  AnnouncementPlatformSendOutcome,
  GovernedAnnouncementAttachment,
} from "./announcement-outward-operation.js";
import type {
  ChannelType,
  DeadLetterWriteOperations,
} from "./announcement-dead-letter-file.js";

export type RecoveryDeliveryOptions = AnnouncementDeliveryOptions & {
  authority?: DeliveryAuthority;
  destinationEndpoint?: ChannelEndpoint;
};

export interface PreparedRecoveryAttachment extends GovernedAnnouncementAttachment {
  cleanup(): Promise<import("@comis/shared").Result<void, Error>>;
}

/** Minimal structural logger accepted from the daemon composition root. */
export interface AnnouncementLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

/** Configuration options for the dead-letter queue factory. */
export interface AnnouncementDeadLetterQueueOptions {
  /** JSONL file path (already safePath'd by caller). */
  filePath: string;
  /** Retry attempts before an entry requires an operator decision (default: 5). */
  maxRetries?: number;
  /** Minimum interval between retry attempts in ms (default: 60_000). */
  retryIntervalMs?: number;
  /** Age after which an entry requires an operator decision (default: 3_600_000). */
  maxAgeMs?: number;
  /** Retained-item threshold for operator alerts (default: 100). */
  maxEntries?: number;
  /** Event bus for emitting dead-letter events. */
  eventBus: TypedEventBus;
  /** Optional logger for diagnostics. */
  logger?: AnnouncementLogger;
  /** Durable authority that prevents replay after an ambiguous platform send. */
  outwardLedger?: OutwardSendLedgerPort;
  /** Receipt-aware transport for a governed row with no ledger record. */
  governedSendToChannel?: (
    type: ChannelType,
    id: string,
    text: string,
    options?: RecoveryDeliveryOptions,
    attachment?: GovernedAnnouncementAttachment,
  ) => Promise<import("@comis/shared").Result<AnnouncementPlatformSendOutcome, Error>>;
  /** Rebuild a validated immutable snapshot before attachment recovery. */
  prepareAttachment?: (
    attachment: AnnouncementDeadLetterAttachment,
  ) => Promise<import("@comis/shared").Result<PreparedRecoveryAttachment, Error>>;
  /** Materialize the owning session observer before off-turn recovery events fire. */
  ensureSessionObservation?: (input: {
    agentId: string;
    sessionKey: string;
  }) => import("@comis/shared").Result<void, Error>;
  fileOperations?: DeadLetterWriteOperations;
}
