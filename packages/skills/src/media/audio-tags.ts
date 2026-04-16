/**
 * Audio metadata extraction using music-metadata.
 *
 * Lazily loads music-metadata via dynamic import to avoid startup cost
 * when audio extraction is not needed.
 *
 * @module
 */

import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";

/**
 * Structured audio metadata extracted from an audio buffer.
 * All fields are optional since metadata tags may be absent.
 */
export interface AudioMetadata {
  readonly title?: string;
  readonly artist?: string;
  readonly album?: string;
  readonly year?: number;
  readonly genre?: string;
  readonly durationMs?: number;
  readonly bitrate?: number;
  readonly sampleRate?: number;
  readonly channels?: number;
  readonly format?: string;
  readonly lossless?: boolean;
}

/**
 * Extract audio metadata (ID3 tags, Vorbis comments, etc.) from a buffer.
 *
 * Uses music-metadata's parseBuffer to read tags from MP3, OGG, FLAC,
 * WAV, and other audio formats. The library is lazily loaded on first call.
 *
 * @param buffer - Raw audio file bytes
 * @param mimeType - Optional MIME type hint (e.g. "audio/mpeg", "audio/ogg")
 * @returns Result with AudioMetadata on success, Error on failure
 */
export async function extractAudioMetadata(
  buffer: Buffer,
  mimeType?: string,
): Promise<Result<AudioMetadata, Error>> {
  try {
    const { parseBuffer } = await import("music-metadata");
    const parsed = await parseBuffer(buffer, { mimeType });

    const metadata: AudioMetadata = {
      title: parsed.common.title,
      artist: parsed.common.artist,
      album: parsed.common.album,
      year: parsed.common.year,
      genre: parsed.common.genre?.[0],
      durationMs:
        parsed.format.duration !== undefined
          ? Math.round(parsed.format.duration * 1000)
          : undefined,
      bitrate: parsed.format.bitrate,
      sampleRate: parsed.format.sampleRate,
      channels: parsed.format.numberOfChannels,
      format: parsed.format.container,
      lossless: parsed.format.lossless,
    };

    return ok(metadata);
  } catch (e: unknown) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}
