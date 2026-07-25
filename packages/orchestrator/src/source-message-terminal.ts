// SPDX-License-Identifier: Apache-2.0
import {
  emitObservationalEventSafely,
  type ComisLogger,
  type DeliveryStatus,
  type EventMap,
  type NormalizedMessage,
  type TypedEventBus,
} from "@comis/core";
import { tryCatch } from "@comis/shared";

interface SourceMessageTerminalDeps {
  eventBus: Pick<TypedEventBus, "emitSafely">;
  logger?: Pick<ComisLogger, "warn">;
}

type SourceMessageTerminalReason = EventMap["message:terminal"]["reason"];

interface SourceTerminalIdentity {
  readonly channelType: string;
  readonly channelId: string;
  readonly sourceMessageId: string;
}

interface SourceTerminalCell {
  readonly deps: SourceMessageTerminalDeps;
  readonly identity: SourceTerminalIdentity;
  published: boolean;
  publishing: boolean;
  linked: Set<SourceTerminalCell>;
}

/** Per-ingress authority for publishing each exact source tuple at most once. */
export interface SourceTerminalScope {
  /** Publish all still-open source tuples and return the number newly emitted. */
  publish(
    outcome: DeliveryStatus,
    reason: SourceMessageTerminalReason,
    timestamp: number,
  ): number;
  /** True when every valid tuple owned by this scope has reached a terminal. */
  readonly isPublished: boolean;
}

const cellsByScope = new WeakMap<SourceTerminalScope, readonly SourceTerminalCell[]>();

function publishCell(
  cell: SourceTerminalCell,
  outcome: DeliveryStatus,
  reason: SourceMessageTerminalReason,
  timestamp: number,
): boolean {
  // Claim the terminal before callbacks run. The event is observational, so a
  // broken bus or subscriber cannot reopen or reclassify this source tuple.
  for (const linkedCell of cell.linked) {
    linkedCell.published = true;
    linkedCell.publishing = false;
  }
  emitObservationalEventSafely(cell.deps, "message:terminal", {
    ...cell.identity,
    outcome,
    reason,
    timestamp,
  });
  return true;
}

function createScope(cells: readonly SourceTerminalCell[]): SourceTerminalScope {
  const scope: SourceTerminalScope = {
    publish(outcome, reason, timestamp): number {
      const claimed = cells.filter((cell) => !cell.published && !cell.publishing);
      // Claim the whole scope before the first observer runs. This keeps one
      // observer from reclassifying a later tuple in the same coalesced turn.
      for (const cell of claimed) {
        for (const linkedCell of cell.linked) linkedCell.publishing = true;
      }
      let emitted = 0;
      for (const cell of claimed) {
        if (publishCell(cell, outcome, reason, timestamp)) emitted++;
      }
      return emitted;
    },
    get isPublished(): boolean {
      return cells.length > 0 && cells.every((cell) => cell.published);
    },
  };
  cellsByScope.set(scope, cells);
  return scope;
}

function logInvalidIdentity(
  deps: SourceMessageTerminalDeps,
  expectedChannelType: string,
): void {
  if (!deps.logger) return;
  void tryCatch(() => deps.logger?.warn({
    expectedChannelType,
    rejectedCount: 1,
    errorKind: "validation" as const,
    hint: "Inspect inbound normalization; the source identity must match the receiving channel before lifecycle tracking starts",
  }, "Rejected mismatched source-message terminal identity"));
}

/**
 * Create lifecycle authority from one original adapter message.
 *
 * `originalMessages` is deliberately ignored here. It is durable session
 * provenance for a synthetic prompt, while queue entries carry and merge the
 * authoritative scopes belonging to their actual ingress messages.
 */
export function createSourceTerminalScope(
  deps: SourceMessageTerminalDeps,
  message: NormalizedMessage,
  expectedChannelType: string,
): SourceTerminalScope {
  if (
    message.channelType !== expectedChannelType
    || message.channelId.length === 0
    || message.id.length === 0
  ) {
    logInvalidIdentity(deps, expectedChannelType);
    return createScope([]);
  }
  const cell: SourceTerminalCell = {
    deps,
    identity: {
      channelType: message.channelType,
      channelId: message.channelId,
      sourceMessageId: message.id,
    },
    published: false,
    publishing: false,
    linked: new Set(),
  };
  cell.linked.add(cell);
  return createScope([cell]);
}

function linkDuplicateCells(
  first: SourceTerminalCell,
  second: SourceTerminalCell,
): void {
  if (first.linked === second.linked) return;
  const linked = new Set([...first.linked, ...second.linked]);
  const isPublished = [...linked].some((cell) => cell.published);
  const isPublishing = !isPublished && [...linked].some((cell) => cell.publishing);
  for (const cell of linked) {
    cell.linked = linked;
    if (isPublished) cell.published = true;
    cell.publishing = isPublishing;
  }
}

/** Merge queue-owned ingress scopes while retaining one cell per exact tuple. */
export function mergeSourceTerminalScopes(
  scopes: readonly SourceTerminalScope[],
): SourceTerminalScope {
  const cells = new Map<string, SourceTerminalCell>();
  for (const scope of scopes) {
    for (const cell of cellsByScope.get(scope) ?? []) {
      const key = JSON.stringify([
        cell.identity.channelType,
        cell.identity.channelId,
        cell.identity.sourceMessageId,
      ]);
      const existing = cells.get(key);
      if (existing === undefined) {
        cells.set(key, cell);
      } else {
        linkDuplicateCells(existing, cell);
      }
    }
  }
  return createScope([...cells.values()]);
}
