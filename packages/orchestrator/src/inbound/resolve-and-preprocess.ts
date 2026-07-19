// SPDX-License-Identifier: Apache-2.0
/**
 * Inbound Pipeline Phase 1: Agent Resolution + Media Preprocessing.
 *
 * Resolves agent identity, constructs scoped session key, then runs audio
 * preflight + media preprocessing on the resolved message.
 *
 * @module
 */

import { toSafeErrorLogString, type NormalizedMessage, type ResolvedTurnScope, type SessionKey, type ChannelPort } from "@comis/core";
import { resolveInboundTurnIdentity } from "./inbound-turn-identity.js";
import { emitObservationalEvent } from "../execution/execution-event-emitter.js";
import type { AgentExecutor, InboundMessageProvenancePlan } from "@comis/agent";
import { isBotMentioned, isGroupMessage, compressAttachments } from "@comis/channels";

import type { InboundPipelineDeps } from "./inbound-pipeline.js";

// ---------------------------------------------------------------------------
// Deps narrowing
// ---------------------------------------------------------------------------

/**
 * Minimal deps for the resolve-and-preprocess phase.
 *
 * Covers both sub-phases — agent resolution and media preprocessing — with
 * `logger` shared across both; 8 unique fields total.
 */
export type ResolveAndPreprocessDeps = Pick<
  InboundPipelineDeps,
  // Agent resolution sub-phase:
  | "tenantId"
  | "logger" // shared with preprocess
  | "eventBus"
  | "messageRouter"
  | "sessionManager"
  | "principalResolver"
  | "getDmScope"
  | "createExecutor"
  | "persistInboundMessage"
  // Media preprocessing sub-phase:
  | "audioPreflight"
  | "preprocessMessage"
  | "autoReplyEngineConfig"
>;

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/** Resolved + preprocessed agent context from Phase 1. */
export interface ResolveAndPreprocessReady {
  kind: "ready";
  agentId: string;
  executor: AgentExecutor;
  sessionKey: SessionKey;
  turnScope: ResolvedTurnScope;
  /** Exact occurrence persisted before preprocessing and reused by SDK mirrors. */
  inboundProvenancePlan: InboundMessageProvenancePlan;
  /** Message with content enrichment projected onto authoritative ingress fields. */
  processedMsg: NormalizedMessage;
}

/** Closed phase outcome for preprocessing or unavailable executor wiring. */
export type ResolveAndPreprocessResult =
  | ResolveAndPreprocessReady
  | {
      kind: "no_executor";
      agentId: string;
      sessionKey: SessionKey;
      turnScope: ResolvedTurnScope;
    };

interface VisionImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

type InboundPersistenceErrorKind =
  | "config"
  | "precondition"
  | "resource"
  | "validation";

function inboundPersistenceHint(errorKind: InboundPersistenceErrorKind): string {
  switch (errorKind) {
    case "precondition":
      return "Quarantine the affected inbound provenance sidecar, then inspect and repair its malformed or conflicting batch before retrying delivery.";
    case "validation":
      return "Inspect the rejected channel envelope and correct invalid source fields before retrying delivery.";
    case "config":
      return "Repair the resolved agent's session persistence wiring before retrying channel delivery.";
    case "resource":
      return "Restore session storage ownership, free space, and lock health; channel delivery can then retry.";
    default: {
      const _exhaustive: never = errorKind;
      return _exhaustive;
    }
  }
}

function isVisionImageContents(value: unknown): value is VisionImageContent[] {
  return Array.isArray(value) && value.every((entry) => {
    if (typeof entry !== "object" || entry === null) return false;
    const image = entry as {
      type?: unknown;
      data?: unknown;
      mimeType?: unknown;
    };
    return image.type === "image"
      && typeof image.data === "string"
      && typeof image.mimeType === "string";
  });
}

/**
 * Admit content produced by media processors without letting their returned
 * message become an identity, provenance, routing, or control authority.
 */
function projectContentEnrichment(
  authoritative: NormalizedMessage,
  candidate: NormalizedMessage,
  options: { allowAudioMention: boolean; allowVisionImages: boolean },
): NormalizedMessage {
  const metadata = { ...authoritative.metadata };
  if (options.allowAudioMention && candidate.metadata.isBotMentioned === true) {
    metadata.isBotMentioned = true;
  }
  if (
    options.allowVisionImages
    && isVisionImageContents(candidate.metadata.imageContents)
  ) {
    metadata.imageContents = candidate.metadata.imageContents;
  }

  return {
    ...authoritative,
    text: typeof candidate.text === "string" ? candidate.text : authoritative.text,
    attachments: Array.isArray(candidate.attachments)
      ? candidate.attachments
      : authoritative.attachments,
    metadata,
  };
}

// ---------------------------------------------------------------------------
// Phase function
// ---------------------------------------------------------------------------

/**
 * Resolve the agent + session key, then run audio preflight + media
 * preprocessing on the inbound message.
 *
 * Returns a closed outcome after durable acceptance. A durable-write failure rejects at
 * this phase boundary; `processInboundMessage` immediately translates that
 * rejection with `fromPromise` and propagates it to the channel middleware so
 * the platform cannot acknowledge an unrecorded message.
 */
export async function resolveAndPreprocess(
  deps: ResolveAndPreprocessDeps,
  adapter: ChannelPort,
  msg: NormalizedMessage,
): Promise<ResolveAndPreprocessResult> {
  // ===== Phase 1A: Agent resolution =====

  // 1. Resolve agent FIRST (only needs RoutableMessage, not SessionKey)
  const agentId = deps.messageRouter.resolve({
    channelType: msg.channelType,
    channelId: msg.channelId,
    senderId: msg.senderId,
    guildId: msg.metadata?.guildId as string | undefined,
  });

  // 2. Normalize the authenticated endpoint and platform subject exactly once,
  // then resolve principal and routing policy into the turn authority.
  const effectiveMsg = msg;
  const identity = resolveInboundTurnIdentity({
    tenantId: deps.tenantId,
    agentId,
    adapter,
    message: effectiveMsg,
    principalResolver: deps.principalResolver,
    dmScope: deps.getDmScope(agentId),
  });
  if (!identity.ok) {
    deps.logger.warn(
      {
        step: "identity-resolution",
        agentId,
        channelType: adapter.channelType,
        hint: "Verify the authenticated channel instance, principal mappings, and per-agent direct-message scope configuration.",
        errorKind: identity.error.errorKind,
      },
      "Inbound turn identity resolution failed",
    );
    return Promise.reject(identity.error);
  }
  const sessionKey = identity.value.displaySessionKey;
  const turnScope = identity.value.turnScope;

  // 4. Commit the physical inbound before any fallible executor lookup,
  // media, gate, or queue work. Queue-coalesced messages retain their exact
  // `originalMessages` payload in this single occurrence.
  const persisted = await deps.persistInboundMessage(agentId, msg, sessionKey);
  if (!persisted.ok) {
    deps.logger.error(
      {
        step: "session-provenance",
        agentId,
        channelType: msg.channelType,
        err: toSafeErrorLogString(persisted.error.error),
        hint: inboundPersistenceHint(persisted.error.errorKind),
        errorKind: persisted.error.errorKind,
      },
      "Inbound message provenance persistence failed",
    );
    return Promise.reject(persisted.error.error);
  }

  // Reception is announced only after the content-bearing ledger commit. A
  // subscriber can therefore treat every message:received as durably backed.
  emitObservationalEvent(deps, "message:received", { message: msg, sessionKey });

  // Executor availability is intentionally checked after the durable commit:
  // an admitted message remains recoverable during partial agent startup.
  const executor = deps.createExecutor(agentId);
  if (!executor) {
    deps.logger.warn({ agentId, channelId: msg.channelId, hint: "Ensure agent executor is registered before processing messages", errorKind: "config" as const }, "No executor configured for agent");
    return { kind: "no_executor", agentId, sessionKey, turnScope };
  }

  // Load or create session
  const sessionLoad = deps.sessionManager.loadOrCreate(turnScope.conversation);
  if (!sessionLoad.ok) {
    deps.logger.error(
      {
        step: "session-load",
        agentId,
        channelType: adapter.channelType,
        hint: "Inspect session database integrity and restore storage availability before retrying the inbound message.",
        errorKind: sessionLoad.error.errorKind,
      },
      "Inbound session load failed",
    );
    return Promise.reject(sessionLoad.error);
  }

  // ===== Phase 1B: Audio preflight + media preprocessing =====

  let processedMsg = effectiveMsg;
  const channelType = adapter.channelType;

  // -------------------------------------------------------------------
  // AUDIO PREFLIGHT: Transcribe voice before mention gate
  // -------------------------------------------------------------------
  // Runs BEFORE preprocessMessage so:
  //   1. Preflight transcribes audio and sets att.transcription
  //   2. preprocessMessage sees att.transcription and skips re-transcription
  //   3. Auto-reply gate sees enriched text with transcript for mention detection
  //
  // Only run in group chats with mention-gated activation where:
  // - Message has audio attachments
  // - Bot is NOT already mentioned in text/metadata
  // - audioPreflight callback is available
  if (deps.audioPreflight) {
    const isGroup = isGroupMessage(msg);
    const isMentionGated = deps.autoReplyEngineConfig?.groupActivation === "mention-gated";
    const hasAudio = msg.attachments?.some(
      (a) => a.type === "audio" || a.mimeType?.startsWith("audio/"),
    );
    const alreadyMentioned = isBotMentioned(msg);

    if (isGroup && isMentionGated && hasAudio && !alreadyMentioned) {
      try {
        const preflightResult = await deps.audioPreflight(structuredClone(processedMsg));
        if (preflightResult.transcribed) {
          processedMsg = projectContentEnrichment(
            processedMsg,
            preflightResult.message,
            { allowAudioMention: true, allowVisionImages: false },
          );
          deps.logger.debug({
            step: "audio-preflight",
            channelType,
            chatId: processedMsg.channelId,
          }, "Audio preflight transcription applied");
        }
      } catch (preflightErr) {
        deps.logger.warn(
          { err: preflightErr, channelId: msg.channelId, hint: "Audio preflight failed, voice message may be dropped by mention gate", errorKind: "internal" as const },
          "Audio preflight failed",
        );
      }
    }
  }

  // Preprocess media attachments (voice transcription, image analysis)
  // NOTE: processedMsg already set above (either original msg or preflight-enriched)
  if (deps.preprocessMessage) {
    try {
      const preprocessed = await deps.preprocessMessage(
        structuredClone(processedMsg),
        turnScope,
      );
      processedMsg = projectContentEnrichment(
        processedMsg,
        preprocessed,
        { allowAudioMention: false, allowVisionImages: true },
      );
    } catch (preprocessErr) {
      deps.logger.warn(
        { err: preprocessErr, channelId: msg.channelId, hint: "Media preprocessing failed; proceeding with original message", errorKind: "internal" as const },
        "Media preprocessing failed, using original message",
      );
    }
  }

  // -------------------------------------------------------------------
  // Media compression (runs before auto-reply evaluation)
  // -------------------------------------------------------------------
  if (deps.autoReplyEngineConfig) {
    const beforeAttachments = processedMsg.attachments?.length ?? 0;
    processedMsg = compressAttachments(processedMsg);
    const afterAttachments = processedMsg.attachments?.length ?? 0;
    if (beforeAttachments !== afterAttachments) {
      deps.logger.debug({
        step: "media-compress",
        inputLen: beforeAttachments,
        outputLen: afterAttachments,
      }, "Attachments compressed");
    }
  }

  return {
    kind: "ready",
    agentId,
    executor,
    sessionKey,
    turnScope,
    processedMsg,
    inboundProvenancePlan: persisted.value,
  };
}
