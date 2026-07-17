// SPDX-License-Identifier: Apache-2.0
import { ok, type Result } from "@comis/shared";
import {
  createAttachmentSendReceipt,
  systemNowMs,
  runWithContext,
  getMessageTraceId,
} from "@comis/core";
import { randomUUID } from "node:crypto";
import type {
  ChannelPort,
  ChannelStatus,
  MessageHandler,
  SendMessageOptions,
  FetchMessagesOptions,
  FetchedMessage,
  AttachmentPayload,
  AttachmentSendReceipt,
  NormalizedMessage,
} from "@comis/core";

/**
 * Options for creating an EchoChannelAdapter instance.
 */
export interface EchoAdapterOptions {
  /** Channel identifier (default: "echo-test") */
  channelId?: string;
  /** Channel type label (default: "echo") */
  channelType?: string;
}

/**
 * Stored message record from sendMessage() calls.
 */
interface StoredMessage {
  channelId: string;
  text: string;
  options?: SendMessageOptions;
  timestamp: number;
}

/**
 * EchoChannelAdapter: In-memory ChannelPort implementation for testing.
 *
 * Records all sent messages, reactions, edits, and deletions in memory
 * so that tests can inspect them for assertions. Provides helper methods
 * to inject simulated incoming messages and retrieve sent data.
 *
 * This adapter has no external dependencies and requires no network.
 */
export class EchoChannelAdapter implements ChannelPort {
  readonly channelId: string;
  readonly channelType: string;

  private sentMessages = new Map<string, StoredMessage>();
  private messageHandlers: MessageHandler[] = [];
  private reactions = new Map<string, { emoji: string; channelId: string }>();
  private editedMessages = new Map<string, string>();
  private deletedMessages = new Set<string>();
  private running = false;
  private messageCounter = 0;
  private startedAt: number | undefined;

  constructor(options?: EchoAdapterOptions) {
    this.channelId = options?.channelId ?? "echo-test";
    this.channelType = options?.channelType ?? "echo";
  }

  // -----------------------------------------------------------------------
  // ChannelPort lifecycle
  // -----------------------------------------------------------------------

  async start(): Promise<Result<void, Error>> {
    this.running = true;
    this.startedAt = systemNowMs();
    return ok(undefined);
  }

  async stop(): Promise<Result<void, Error>> {
    this.running = false;
    return ok(undefined);
  }

  // -----------------------------------------------------------------------
  // ChannelPort messaging
  // -----------------------------------------------------------------------

  async sendMessage(
    channelId: string,
    text: string,
    options?: SendMessageOptions,
  ): Promise<Result<string, Error>> {
    const messageId = `echo-msg-${this.messageCounter++}`;
    this.sentMessages.set(messageId, {
      channelId,
      text,
      options,
      timestamp: systemNowMs(),
    });
    return ok(messageId);
  }

  async editMessage(
    _channelId: string,
    messageId: string,
    text: string,
  ): Promise<Result<void, Error>> {
    this.editedMessages.set(messageId, text);
    return ok(undefined);
  }

  async reactToMessage(
    channelId: string,
    messageId: string,
    emoji: string,
  ): Promise<Result<void, Error>> {
    this.reactions.set(messageId, { emoji, channelId });
    return ok(undefined);
  }

  async removeReaction(
    _channelId: string,
    messageId: string,
    _emoji: string,
  ): Promise<Result<void, Error>> {
    this.reactions.delete(messageId);
    return ok(undefined);
  }

  async deleteMessage(
    _channelId: string,
    messageId: string,
  ): Promise<Result<void, Error>> {
    this.deletedMessages.add(messageId);
    return ok(undefined);
  }

  async fetchMessages(
    channelId: string,
    options?: FetchMessagesOptions,
  ): Promise<Result<FetchedMessage[], Error>> {
    const limit = options?.limit ?? 20;
    const before = options?.before;

    const entries: FetchedMessage[] = [];
    for (const [id, stored] of this.sentMessages) {
      if (stored.channelId !== channelId) continue;
      if (before !== undefined && id >= before) continue;
      entries.push({
        id,
        senderId: "echo-bot",
        text: stored.text,
        timestamp: stored.timestamp,
      });
    }

    return ok(entries.slice(0, limit));
  }

  async sendAttachment(
    channelId: string,
    attachment: AttachmentPayload,
    options?: SendMessageOptions,
  ): Promise<Result<AttachmentSendReceipt, Error>> {
    const caption = attachment.caption ?? "";
    const label = `[${attachment.type}:${attachment.fileName ?? attachment.url}]`;
    const text = caption ? `${label} ${caption}` : label;
    const result = await this.sendMessage(channelId, text, options);
    if (!result.ok) return result;
    return ok(createAttachmentSendReceipt(result.value));
  }

  async platformAction(
    action: string,
    params: Record<string, unknown>,
  ): Promise<Result<unknown, Error>> {
    return ok({ action, params, echoed: true });
  }

  getStatus(): ChannelStatus {
    return {
      connected: this.running,
      channelId: this.channelId,
      channelType: this.channelType,
      uptime: this.running && this.startedAt ? systemNowMs() - this.startedAt : undefined,
      connectionMode: "socket",
    };
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler);
  }

  // -----------------------------------------------------------------------
  // Test helper methods
  // -----------------------------------------------------------------------

  /**
   * Simulate an incoming message by invoking all registered handlers.
   * This is the testing equivalent of receiving a message from a platform.
   *
   * Defense-in-depth wrap. Echo's primary consumers are e2e + chaos tests.
   * The wrap exercises the runWithContext path so test harnesses can inject
   * + observe traceId propagation in test mode. Pre-stamped traceIds (set by
   * callers for assertion) are reused via getMessageTraceId; a fresh UUID is
   * minted only when absent.
   */
  async injectMessage(msg: NormalizedMessage): Promise<void> {
    // Reuse pre-stamped traceId (chaos/e2e tests may inject a known value)
    // or mint a fresh one as defense-in-depth fallback.
    const traceId = getMessageTraceId(msg) ?? randomUUID();
    if (typeof msg.metadata.traceId !== "string") {
      msg.metadata.traceId = traceId;
    }
    await runWithContext(
      { traceId, startedAt: systemNowMs(), channelType: "echo", tenantId: "default", trustLevel: "user" },
      async () => {
        for (const handler of this.messageHandlers) {
          await handler(msg);
        }
      },
    );
  }

  /**
   * Retrieve all messages sent via sendMessage() for test assertions.
   */
  getSentMessages(): Array<{
    id: string;
    channelId: string;
    text: string;
    timestamp: number;
  }> {
    const result: Array<{
      id: string;
      channelId: string;
      text: string;
      timestamp: number;
    }> = [];
    for (const [id, stored] of this.sentMessages) {
      result.push({
        id,
        channelId: stored.channelId,
        text: stored.text,
        timestamp: stored.timestamp,
      });
    }
    return result;
  }

  /**
   * Retrieve the reactions map for test assertions.
   */
  getReactions(): Map<string, { emoji: string; channelId: string }> {
    return this.reactions;
  }

  /**
   * Retrieve the edited messages map for test assertions.
   */
  getEditedMessages(): Map<string, string> {
    return this.editedMessages;
  }

  /**
   * Retrieve the deleted message IDs for test assertions.
   */
  getDeletedMessages(): Set<string> {
    return this.deletedMessages;
  }

  /**
   * Check whether the adapter is currently running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Clear all internal state: messages, reactions, edits, deletions, counter.
   */
  reset(): void {
    this.sentMessages.clear();
    this.messageHandlers = [];
    this.reactions.clear();
    this.editedMessages.clear();
    this.deletedMessages.clear();
    this.messageCounter = 0;
    this.running = false;
  }
}
