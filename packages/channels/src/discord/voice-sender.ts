/**
 * Discord voice sender: implements the 3-step upload protocol for native
 * voice bubbles (flag 8192).
 *
 * Protocol:
 * 1. POST /channels/{id}/attachments -- request upload URL from Discord
 * 2. PUT upload_url -- upload file buffer to CDN
 * 3. POST /channels/{id}/messages -- create message with flag 8192 + attachment
 *
 * CRITICAL: Voice messages must NOT include a `content` field -- Discord
 * rejects voice messages that contain text content.
 *
 * Emits INFO bookend logs for voice send started/complete.
 *
 * @module
 */

import * as fs from "node:fs/promises";
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal logger interface for voice sender. */
interface VoiceSenderLogger {
  debug(obj: Record<string, unknown>, msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface DiscordVoiceSenderDeps {
  readonly botToken: string;
  readonly logger: VoiceSenderLogger;
}

export interface DiscordVoiceSender {
  sendVoice(
    channelId: string,
    filePath: string,
    durationSecs: number,
    waveformBase64: string,
  ): Promise<Result<string, Error>>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DISCORD_API_BASE = "https://discord.com/api/v10";
const VOICE_MESSAGE_FLAG = 8192;

/**
 * Allowed Discord CDN domains for voice file uploads (H-2 SSRF mitigation).
 * Discord uses these domains for attachment upload URLs. Any URL not matching
 * these domains is rejected to prevent data exfiltration via compromised responses.
 */
const ALLOWED_UPLOAD_DOMAINS: ReadonlySet<string> = new Set([
  "discord-attachments-uploads-prd.storage.googleapis.com",
  "cdn.discordapp.com",
  "media.discordapp.net",
]);

/**
 * Validate that an upload URL points to a known Discord CDN domain.
 * Returns true only if the URL uses HTTPS and the hostname is in the allowlist.
 *
 * Exported for testing.
 */
export function isAllowedUploadUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && ALLOWED_UPLOAD_DOMAINS.has(parsed.hostname);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a Discord voice sender implementing the 3-step upload protocol.
 *
 * Step 1: Request an upload URL from Discord's attachment API
 * Step 2: PUT the audio file to the CDN upload URL
 * Step 3: POST the message with flag 8192 and attachment metadata
 */
export function createDiscordVoiceSender(deps: DiscordVoiceSenderDeps): DiscordVoiceSender {
  const { botToken, logger } = deps;

  return {
    async sendVoice(
      channelId: string,
      filePath: string,
      durationSecs: number,
      waveformBase64: string,
    ): Promise<Result<string, Error>> {
      // Read file buffer
      let fileBuffer: Buffer;
      try {
        fileBuffer = await fs.readFile(filePath);
      } catch (readErr) {
        const readError = readErr instanceof Error ? readErr : new Error(String(readErr));
        return err(new Error(`Failed to read voice file: ${readError.message}`));
      }

      logger.info(
        { channelType: "discord", chatId: channelId, durationSecs },
        "Voice send started",
      );

      // Step 1: Request upload URL
      let uploadUrl: string;
      let uploadFilename: string;
      try {
        const step1Res = await fetch(`${DISCORD_API_BASE}/channels/${channelId}/attachments`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bot ${botToken}`,
          },
          body: JSON.stringify({
            files: [{ filename: "voice-message.ogg", file_size: fileBuffer.length, id: "0" }],
          }),
        });

        if (!step1Res.ok) {
          const errorText = await step1Res.text();
          return err(new Error(`Step 1 failed (${step1Res.status}): ${errorText}`));
        }

        const step1Data = (await step1Res.json()) as {
          attachments?: Array<{ upload_url?: string; upload_filename?: string }>;
        };

        uploadUrl = step1Data.attachments?.[0]?.upload_url ?? "";
        uploadFilename = step1Data.attachments?.[0]?.upload_filename ?? "";

        if (!uploadUrl || !uploadFilename) {
          return err(new Error("Step 1 failed: missing upload_url or upload_filename in response"));
        }

        logger.debug(
          { step: 1, uploadUrl: "[redacted]" },
          "Upload URL obtained",
        );
      } catch (step1Err) {
        const step1Error = step1Err instanceof Error ? step1Err : new Error(String(step1Err));
        return err(new Error(`Step 1 request failed: ${step1Error.message}`));
      }

      // H-2: Validate upload URL domain before sending any file data
      if (!isAllowedUploadUrl(uploadUrl)) {
        let uploadDomain = "unknown";
        try { uploadDomain = new URL(uploadUrl).hostname; } catch { /* malformed URL */ }
        logger.warn(
          { channelType: "discord", uploadDomain, hint: "Discord returned an upload URL with an unexpected domain; rejecting to prevent SSRF", errorKind: "platform" as const },
          "Upload URL domain validation failed",
        );
        return err(new Error("Upload URL domain validation failed: unexpected domain"));
      }

      // Step 2: PUT file to CDN
      try {
        const step2Res = await fetch(uploadUrl, {
          method: "PUT",
          headers: {
            "Content-Type": "audio/ogg",
          },
          body: new Uint8Array(fileBuffer),
        });

        if (!step2Res.ok) {
          const hint = step2Res.status === 403 || step2Res.status === 404
            ? " (upload URL may have expired)"
            : "";
          return err(new Error(`Step 2 CDN upload failed (${step2Res.status})${hint}`));
        }

        logger.debug(
          { step: 2, fileSize: fileBuffer.length },
          "File uploaded to CDN",
        );
      } catch (step2Err) {
        const step2Error = step2Err instanceof Error ? step2Err : new Error(String(step2Err));
        return err(new Error(`Step 2 CDN upload request failed: ${step2Error.message}`));
      }

      // Step 3: POST message with flag 8192
      // CRITICAL: Do NOT include `content` field -- Discord rejects voice messages with text content.
      try {
        const step3Res = await fetch(`${DISCORD_API_BASE}/channels/${channelId}/messages`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bot ${botToken}`,
          },
          body: JSON.stringify({
            flags: VOICE_MESSAGE_FLAG,
            attachments: [{
              id: "0",
              filename: "voice-message.ogg",
              uploaded_filename: uploadFilename,
              duration_secs: durationSecs,
              waveform: waveformBase64,
            }],
          }),
        });

        if (!step3Res.ok) {
          const errorText = await step3Res.text();
          return err(new Error(`Step 3 message post failed (${step3Res.status}): ${errorText}`));
        }

        const step3Data = (await step3Res.json()) as { id?: string };
        const messageId = step3Data.id ?? "";

        logger.debug(
          { step: 3, flags: VOICE_MESSAGE_FLAG },
          "Voice message posted",
        );

        logger.info(
          { channelType: "discord", messageId, chatId: channelId, durationSecs },
          "Voice send complete",
        );

        return ok(messageId);
      } catch (step3Err) {
        const step3Error = step3Err instanceof Error ? step3Err : new Error(String(step3Err));
        return err(new Error(`Step 3 message post request failed: ${step3Error.message}`));
      }
    },
  };
}
