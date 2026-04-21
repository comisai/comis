// SPDX-License-Identifier: Apache-2.0
/**
 * Email Channel Adapter: ChannelPort implementation for IMAP/SMTP.
 *
 * Provides the bridge between email (IMAP inbound, SMTP outbound) and
 * Comis's channel-agnostic ChannelPort interface.
 *
 * - IMAP lifecycle for inbound messages with IDLE cycling
 * - SMTP via nodemailer for outbound messages
 * - RFC 5322 threading (In-Reply-To, References)
 * - Auto-Submitted: auto-generated header on all outbound messages
 * - Sender allowlist filtering and automated sender detection
 * - OAuth2 and password authentication
 *
 * @module
 */

import type {
  AttachmentPayload,
  ChannelPort,
  ChannelStatus,
  FetchedMessage,
  FetchMessagesOptions,
  MessageHandler,
  SendMessageOptions,
} from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import type { Result } from "@comis/shared";
import { ok, err, fromPromise } from "@comis/shared";
import nodemailer from "nodemailer";
import { simpleParser } from "mailparser";

import { createImapLifecycle } from "./imap-lifecycle.js";
import { buildThreadingHeaders } from "./threading.js";
import { isAllowedSender, isAutomatedSender } from "./sender-filter.js";
import { mapEmailToNormalized } from "./message-mapper.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface EmailAdapterDeps {
  address: string;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  secure: boolean;
  auth: {
    user: string;
    pass?: string;
    accessToken?: string;
    type?: "OAuth2";
    clientId?: string;
    clientSecret?: string;
    refreshToken?: string;
  };
  allowFrom: string[];
  allowMode: "allowlist" | "open";
  pollingIntervalMs?: number;
  attachmentDir: string;
  logger: ComisLogger;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an email channel adapter implementing ChannelPort.
 *
 * @param deps - Email adapter configuration and dependencies
 * @returns ChannelPort implementation for email
 */
export function createEmailAdapter(deps: EmailAdapterDeps): ChannelPort {
  const channelId = `email-${deps.address}`;
  const channelType = "email";

  const handlers: MessageHandler[] = [];
  let transport: nodemailer.Transporter | undefined;
  let connected = false;
  let lastActivity = 0;

  // Build SMTP transport auth config
  function buildSmtpAuth(): Record<string, unknown> {
    if (deps.auth.type === "OAuth2" || deps.auth.accessToken) {
      return {
        type: "OAuth2",
        user: deps.auth.user,
        accessToken: deps.auth.accessToken,
        clientId: deps.auth.clientId,
        clientSecret: deps.auth.clientSecret,
        refreshToken: deps.auth.refreshToken,
      };
    }
    return {
      user: deps.auth.user,
      pass: deps.auth.pass,
    };
  }

  // Build IMAP auth config
  const imapAuth = deps.auth.accessToken
    ? { user: deps.auth.user, accessToken: deps.auth.accessToken }
    : { user: deps.auth.user, pass: deps.auth.pass };

  // Create IMAP lifecycle
  const imapLifecycle = createImapLifecycle({
    host: deps.imapHost,
    port: deps.imapPort,
    secure: deps.secure,
    auth: imapAuth,
    pollingIntervalMs: deps.pollingIntervalMs,
    logger: deps.logger,
  });

  // Register IMAP message handler
  imapLifecycle.onNewMessage(async (source: Buffer) => {
    try {
      const parsed = await simpleParser(source);

      // Extract headers as lowercase-keyed record
      const headers: Record<string, string> = {};
      if (parsed.headers) {
        for (const [key, value] of parsed.headers) {
          headers[key.toLowerCase()] = typeof value === "string" ? value : String(value);
        }
      }

      const fromAddress = parsed.from?.value[0]?.address ?? "";

      // Skip automated senders
      if (isAutomatedSender(headers, fromAddress)) {
        deps.logger.debug(
          { channelType, module: "email", fromAddress },
          "Skipping automated sender",
        );
        return;
      }

      // Sender allowlist
      if (!isAllowedSender(fromAddress, deps.allowFrom, deps.allowMode)) {
        deps.logger.debug(
          { channelType, module: "email", fromAddress },
          "Sender not in allowlist, skipping",
        );
        return;
      }

      // Map to NormalizedMessage — adapt mailparser's ParsedMail to our structural type
      // (mailparser uses `html: string | false`, our type uses `string | undefined`)
      const normalized = await mapEmailToNormalized(
        {
          ...parsed,
          html: parsed.html || undefined,
          attachments: parsed.attachments.map((a) => ({
            contentType: a.contentType,
            filename: a.filename,
            content: a.content,
            size: a.size,
          })),
        },
        channelId,
        deps.attachmentDir,
      );

      lastActivity = Date.now();

      // Dispatch to all registered handlers
      for (const handler of handlers) {
        await handler(normalized);
      }
    } catch (e) {
      deps.logger.warn(
        { err: e, channelType, module: "email", hint: "Failed to process inbound email", errorKind: "parse" },
        "Inbound email processing failed",
      );
    }
  });

  // -----------------------------------------------------------------------
  // ChannelPort implementation
  // -----------------------------------------------------------------------

  async function start(): Promise<Result<void, Error>> {
    // Create SMTP transport
    transport = nodemailer.createTransport({
      host: deps.smtpHost,
      port: deps.smtpPort,
      secure: deps.secure,
      auth: buildSmtpAuth(),
    });

    // Start IMAP lifecycle
    const result = await imapLifecycle.start();
    if (result.ok) {
      connected = true;
      deps.logger.info(
        { channelType, module: "email", channelId },
        "Email adapter started",
      );
    }
    return result;
  }

  async function stop(): Promise<Result<void, Error>> {
    connected = false;

    // Stop IMAP
    const imapResult = await imapLifecycle.stop();

    // Close SMTP transport
    if (transport) {
      transport.close();
      transport = undefined;
    }

    deps.logger.info(
      { channelType, module: "email", channelId },
      "Email adapter stopped",
    );

    return imapResult;
  }

  async function sendMessage(
    recipient: string,
    text: string,
    options?: SendMessageOptions,
  ): Promise<Result<string, Error>> {
    if (!transport) {
      return err(new Error("Email adapter not started — call start() first"));
    }

    // Build threading headers if replying
    let inReplyTo: string | undefined;
    let references: string | undefined;

    if (options?.replyTo) {
      const threading = buildThreadingHeaders({
        inReplyTo: options.replyTo,
      });
      inReplyTo = threading.inReplyTo;
      references = threading.references.length > 0
        ? threading.references.join(" ")
        : undefined;
    }

    const mailResult = await fromPromise(
      transport.sendMail({
        from: deps.address,
        to: recipient,
        html: text,
        headers: {
          "Auto-Submitted": "auto-generated",
        },
        ...(inReplyTo ? { inReplyTo } : {}),
        ...(references ? { references } : {}),
      }),
    );

    if (!mailResult.ok) {
      const error = mailResult.error instanceof Error
        ? mailResult.error
        : new Error(String(mailResult.error));
      deps.logger.error(
        { err: error, channelType, module: "email", hint: "Check SMTP credentials and host", errorKind: "network" },
        "Failed to send email",
      );
      return err(error);
    }

    const messageId = (mailResult.value as { messageId?: string }).messageId ?? "";
    lastActivity = Date.now();
    return ok(messageId);
  }

  async function editMessage(
    _channelId: string,
    _messageId: string,
    _text: string,
  ): Promise<Result<void, Error>> {
    return err(new Error("Email does not support editing sent messages"));
  }

  function onMessage(handler: MessageHandler): void {
    handlers.push(handler);
  }

  async function reactToMessage(
    _channelId: string,
    _messageId: string,
    _emoji: string,
  ): Promise<Result<void, Error>> {
    return err(new Error("Email does not support reactions"));
  }

  async function removeReaction(
    _channelId: string,
    _messageId: string,
    _emoji: string,
  ): Promise<Result<void, Error>> {
    return err(new Error("Email does not support reactions"));
  }

  async function deleteMessage(
    _channelId: string,
    _messageId: string,
  ): Promise<Result<void, Error>> {
    return err(new Error("Email does not support deleting sent messages"));
  }

  async function fetchMessages(
    _channelId: string,
    _options?: FetchMessagesOptions,
  ): Promise<Result<FetchedMessage[], Error>> {
    return err(new Error("Email does not support fetching message history"));
  }

  async function sendAttachment(
    recipient: string,
    attachment: AttachmentPayload,
    options?: SendMessageOptions,
  ): Promise<Result<string, Error>> {
    if (!transport) {
      return err(new Error("Email adapter not started — call start() first"));
    }

    // Build threading headers if replying
    let inReplyTo: string | undefined;
    let references: string | undefined;

    if (options?.replyTo) {
      const threading = buildThreadingHeaders({
        inReplyTo: options.replyTo,
      });
      inReplyTo = threading.inReplyTo;
      references = threading.references.length > 0
        ? threading.references.join(" ")
        : undefined;
    }

    const mailResult = await fromPromise(
      transport.sendMail({
        from: deps.address,
        to: recipient,
        text: attachment.caption ?? "",
        headers: {
          "Auto-Submitted": "auto-generated",
        },
        attachments: [
          {
            filename: attachment.fileName ?? "attachment",
            path: attachment.url,
            contentType: attachment.mimeType,
          },
        ],
        ...(inReplyTo ? { inReplyTo } : {}),
        ...(references ? { references } : {}),
      }),
    );

    if (!mailResult.ok) {
      const error = mailResult.error instanceof Error
        ? mailResult.error
        : new Error(String(mailResult.error));
      return err(error);
    }

    const messageId = (mailResult.value as { messageId?: string }).messageId ?? "";
    lastActivity = Date.now();
    return ok(messageId);
  }

  function getStatus(): ChannelStatus {
    return {
      connected,
      channelId,
      channelType,
      lastMessageAt: lastActivity || undefined,
      connectionMode: "polling",
    };
  }

  async function platformAction(
    action: string,
    _params: Record<string, unknown>,
  ): Promise<Result<unknown, Error>> {
    return err(new Error(`Unsupported action: ${action} on email`));
  }

  return Object.freeze({
    channelId,
    channelType,
    start,
    stop,
    sendMessage,
    editMessage,
    onMessage,
    reactToMessage,
    removeReaction,
    deleteMessage,
    fetchMessages,
    sendAttachment,
    getStatus,
    platformAction,
  });
}
