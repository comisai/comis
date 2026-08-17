// SPDX-License-Identifier: Apache-2.0
/**
 * The service set the cross-session setup hands back to the composition root.
 *
 * Kept apart from the setup itself so callers that only need to name the
 * result — the wiring barrel, the shutdown path — do not depend on the module
 * that builds it.
 *
 * @module
 */
import type {
  CitationEvidence,
  ConversationLocator,
  DeliverToChannelOptions,
  SessionKey,
} from "@comis/core";
import type {
  createAnnouncementBatcher,
  createAnnouncementDeadLetterQueue,
  createCrossSessionSender,
  SendGovernedCompletionAnnouncement,
  SendRecoverableCompletionAnnouncement,
} from "@comis/orchestrator";
import type { createSubAgentRunner } from "@comis/agent";

/** All services produced by the cross-session messaging setup. */
export interface CrossSessionResult {
  /** Cross-session message sender for agent-to-agent communication. */
  crossSessionSender: ReturnType<typeof createCrossSessionSender>;
  /** Sub-agent task runner for delegated execution. */
  subAgentRunner: ReturnType<typeof createSubAgentRunner>;
  /** Channel message sender for graph completion announcements */
  sendToChannel: (channelType: string, channelId: string, text: string, options?: Omit<DeliverToChannelOptions, "completionMode">) => Promise<boolean>;
  /** Receipt-aware retained-operation boundary for completion announcements. */
  sendGovernedAnnouncement?: SendGovernedCompletionAnnouncement;
  sendRecoverableAnnouncement?: SendRecoverableCompletionAnnouncement;
  /** Parent session announcement for graph results */
  announceToParent: (callerAgentId: string, callerSessionKey: SessionKey, callerConversation: ConversationLocator, text: string, channelType: string, channelId: string, options?: { threadId?: string; resolvedLanguage?: string; citationEvidence?: CitationEvidence }) => Promise<string | undefined>;
  /** Dead-letter queue for failed announcement persistence. */
  deadLetterQueue?: ReturnType<typeof createAnnouncementDeadLetterQueue>;
  /** Announcement batcher for coalescing concurrent graph/sub-agent completions. */
  announcementBatcher: ReturnType<typeof createAnnouncementBatcher>;
  closeAnnouncementAdmission: () => void;
  /**
   * Cleanup for proxy-typing controllers + the TTL sweep timer. Threaded to the
   * composition root and invoked via ShutdownDeps.proxyTypingCleanup — an
   * eventBus.on("system:shutdown", …) subscription silently no-op'd in
   * production, so the caller owns the call instead.
   */
  proxyTypingCleanup: () => void;
}
