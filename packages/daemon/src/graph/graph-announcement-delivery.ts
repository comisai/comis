// SPDX-License-Identifier: Apache-2.0
/** Awaited receipt-aware delivery for one terminal graph notification. */

import {
  scrubSecretsFromText,
  type ChannelEndpoint,
  type ConversationLocator,
} from "@comis/core";
import { err, fromPromise, ok, type Result } from "@comis/shared";
import type {
  AnnouncementDeliveryOptions,
  GovernedAnnouncementSendOutcome,
  SendGovernedCompletionAnnouncement,
} from "@comis/orchestrator";

export type GraphAnnouncementSettlement = "committed" | "retained";

interface GraphAnnouncementDeliveryParams {
  graphId: string;
  agentId?: string;
  callerSessionKey?: string;
  callerConversation?: ConversationLocator;
  destinationEndpoint?: ChannelEndpoint;
  channelType?: string;
  channelId?: string;
  text: string;
  options?: AnnouncementDeliveryOptions;
}

interface GraphAnnouncementDeliveryDeps {
  send?: SendGovernedCompletionAnnouncement;
  logger?: {
    warn(fields: Record<string, unknown>, message: string): void;
    error(fields: Record<string, unknown>, message: string): void;
  };
}

export async function deliverGovernedGraphAnnouncement(
  deps: GraphAnnouncementDeliveryDeps,
  params: GraphAnnouncementDeliveryParams,
): Promise<Result<GraphAnnouncementSettlement, Error>> {
  if (
    deps.send === undefined
    || params.agentId === undefined
    || params.callerSessionKey === undefined
    || params.callerConversation === undefined
    || params.destinationEndpoint === undefined
    || params.channelType === undefined
    || params.channelId === undefined
  ) {
    deps.logger?.error({
      graphId: params.graphId,
      step: "graph-completion-announcement",
      errorKind: "precondition" as const,
      hint: "restore the governed announcement boundary and authenticated graph owner before retrying",
    }, "Graph governed announcement prerequisites unavailable");
    return err(new Error("Graph governed announcement prerequisites unavailable"));
  }

  const scrubbed = scrubSecretsFromText(params.text);
  if (scrubbed.redactions > 0) {
    deps.logger?.warn({
      graphId: params.graphId,
      redactions: scrubbed.redactions,
      errorKind: "internal" as const,
      hint: "Inspect the graph output source; secret-like content was redacted before delivery",
    }, "Graph announcement output was redacted");
  }

  const boundary = await fromPromise(deps.send({
    agentId: params.agentId,
    callerSessionKey: params.callerSessionKey,
    callerConversation: params.callerConversation,
    destinationEndpoint: params.destinationEndpoint,
    runId: params.graphId,
    channelType: params.channelType,
    channelId: params.channelId,
    text: scrubbed.text,
    ...(params.options ? { options: params.options } : {}),
  }));
  if (!boundary.ok || !boundary.value.ok) {
    deps.logger?.error({
      graphId: params.graphId,
      step: "graph-completion-announcement",
      errorKind: "dependency" as const,
      hint: "repair the governed outward boundary; graph authority remains resumable",
    }, "Graph governed announcement boundary failed");
    return err(new Error("Graph governed announcement boundary failed"));
  }
  const outcome = boundary.value.value;
  if (outcome.delivered) return ok("committed");

  const retained = hasRetainedOperationEvidence(outcome);
  deps.logger?.error({
    graphId: params.graphId,
    failure: outcome.failure,
    step: "graph-completion-announcement",
    errorKind: "dependency" as const,
    hint: retained
      ? "inspect the retained outward operation and verify the channel before any retry"
      : "repair the governed ledger boundary; graph authority remains resumable",
  }, "Graph announcement was not receipt-committed");
  return retained
    ? ok("retained")
    : err(new Error("Graph announcement has no durable settlement evidence"));
}

function hasRetainedOperationEvidence(
  outcome: Extract<GovernedAnnouncementSendOutcome, { delivered: false }>,
): boolean {
  if (outcome.identity === undefined) return false;
  switch (outcome.failure) {
    case "operation_retained":
    case "uncertainty_transition_blocked":
    case "transport_failed":
    case "transport_rejected":
    case "platform_receipt_missing":
    case "commit_blocked":
      return true;
    case "allocation_blocked":
    case "attachment_preparation_blocked":
    case "operation_validation_blocked":
    case "lookup_blocked":
    case "operation_mismatch":
    case "begin_blocked":
      return false;
    default: {
      const _exhaustive: never = outcome.failure;
      return _exhaustive;
    }
  }
}
