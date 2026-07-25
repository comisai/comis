// SPDX-License-Identifier: Apache-2.0
/**
 * WhatsApp voice sender: sends OGG/Opus voice notes via Baileys with ptt:true.
 *
 * Uses the ptt (push-to-talk) flag and audio/ogg; codecs=opus mimetype to
 * trigger native WhatsApp voice bubble rendering on recipient devices.
 *
 * The ptt:true flag triggers native voice bubble display on recipient devices.
 * durationSecs is included in both started/complete log entries for observability.
 *
 * @module
 */

import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import {
  createAttachmentSendReceipt,
  type AttachmentSendReceipt,
} from "@comis/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Structural subset of WASocket from Baileys (avoids direct import). */
interface WASocketLike {
  sendMessage(
    jid: string,
    content: Record<string, unknown>,
  ): Promise<{ key?: { id?: string | null } } | undefined>;
}

/** Minimal logger interface for voice sender. */
interface VoiceSenderLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface WhatsAppVoiceSenderDeps {
  readonly sock: WASocketLike;
  readonly logger: VoiceSenderLogger;
}

export interface WhatsAppVoiceSender {
  sendVoice(
    jid: string,
    filePath: string,
    durationSecs?: number,
  ): Promise<Result<AttachmentSendReceipt, Error>>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a WhatsApp voice sender that uses ptt:true for native voice bubbles.
 */
export function createWhatsAppVoiceSender(deps: WhatsAppVoiceSenderDeps): WhatsAppVoiceSender {
  const { sock, logger } = deps;

  return {
    async sendVoice(
      jid: string,
      filePath: string,
      durationSecs?: number,
    ): Promise<Result<AttachmentSendReceipt, Error>> {
      const duration = durationSecs ?? 0;

      logger.info(
        { channelType: "whatsapp", chatId: jid, durationSecs: duration },
        "Voice send started",
      );

      try {
        const sent = await sock.sendMessage(jid, {
          audio: { url: filePath },
          ptt: true,
          mimetype: "audio/ogg; codecs=opus",
        });

        const receipt = createAttachmentSendReceipt(sent?.key?.id);
        if (receipt.kind === "delivered_untracked") {
          logger.warn(
            {
              channelType: "whatsapp",
              chatId: jid,
              hint: "WhatsApp accepted the voice send without key.id. Do not retry; wait for platform reconciliation",
              errorKind: "platform" as const,
            },
            "Voice sent without platform tracking",
          );
        }

        logger.info(
          {
            channelType: "whatsapp",
            chatId: jid,
            durationSecs: duration,
            tracking: receipt.kind,
            ...(receipt.kind === "tracked" ? { messageId: receipt.messageId } : {}),
          },
          "Voice send complete",
        );

        return ok(receipt);
      } catch (error) {
        const sendErr = error instanceof Error ? error : new Error(String(error));

        logger.warn(
          {
            channelType: "whatsapp",
            chatId: jid,
            err: sendErr,
            hint: "Check WhatsApp connection and file accessibility",
            errorKind: "platform" as const,
          },
          "Voice send failed",
        );

        return err(new Error(`Failed to send voice: ${sendErr.message}`));
      }
    },
  };
}
