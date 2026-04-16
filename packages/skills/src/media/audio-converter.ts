/**
 * Audio conversion via ffmpeg -- OGG/Opus encoding, waveform extraction,
 * duration probing, and codec verification.
 *
 * All path construction uses safePath() from @comis/core/security --
 * NEVER path.join(). All methods return Result<T, Error> and never throw.
 *
 * @module
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import * as crypto from "node:crypto";
import type { Result } from "@comis/shared";
import { ok, err, fromPromise } from "@comis/shared";
import { safePath } from "@comis/core";

const execFileAsync = promisify(execFile);

/** Encoding timeout in milliseconds (30 seconds). */
const ENCODE_TIMEOUT_MS = 30_000;

/** Probe timeout in milliseconds (10 seconds). */
const PROBE_TIMEOUT_MS = 10_000;

/** Max buffer for ffmpeg stderr/stdout (10 MB). */
const MAX_BUFFER = 10 * 1024 * 1024;

/** Maximum stderr chars included in error logs. */
const STDERR_SNIPPET_LENGTH = 500;

/** Result of an audio conversion operation. */
export interface ConversionResult {
  readonly outputPath: string;
  readonly durationMs: number;
  readonly codec: string;
}

/** Result of a waveform extraction operation. */
export interface WaveformResult {
  readonly waveformBase64: string;
  readonly sampleCount: number;
}

/** Dependencies for the audio converter factory. */
export interface AudioConverterDeps {
  readonly logger: {
    debug(obj: Record<string, unknown>, msg: string): void;
    error(obj: Record<string, unknown>, msg: string): void;
  };
}

/** Audio converter interface wrapping ffmpeg operations. */
export interface AudioConverter {
  toOggOpus(inputPath: string, outputPath: string): Promise<Result<ConversionResult, Error>>;
  extractWaveform(inputPath: string, tempDir: string): Promise<Result<WaveformResult, Error>>;
  getDuration(inputPath: string): Promise<Result<number, Error>>;
  verifyOpusCodec(filePath: string): Promise<Result<boolean, Error>>;
}

/**
 * Extract the filename portion from a path (last segment after /).
 * Never logs full paths which may contain user info.
 */
function filenameOf(filePath: string): string {
  const parts = filePath.split("/");
  return parts[parts.length - 1] || "unknown";
}

/**
 * Extract file extension from a path.
 */
function extensionOf(filePath: string): string {
  const parts = filePath.split(".");
  return parts.length > 1 ? (parts[parts.length - 1] || "unknown") : "unknown";
}

/**
 * Get duration of an audio file via ffprobe.
 * Internal helper shared by toOggOpus and the public getDuration method.
 */
async function probeDuration(filePath: string): Promise<number> {
  const { stdout } = await execFileAsync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", filePath],
    { timeout: PROBE_TIMEOUT_MS },
  );
  const seconds = parseFloat(stdout.trim());
  return Math.round(seconds * 1000);
}

/**
 * Create an AudioConverter that wraps ffmpeg for encoding and probing.
 */
export function createAudioConverter(deps: AudioConverterDeps): AudioConverter {
  const { logger } = deps;

  return {
    async toOggOpus(
      inputPath: string,
      outputPath: string,
    ): Promise<Result<ConversionResult, Error>> {
      const startMs = Date.now();
      const inputFormat = extensionOf(inputPath);

      try {
        await execFileAsync(
          "ffmpeg",
          ["-y", "-i", inputPath, "-c:a", "libopus", "-b:a", "64k", "-threads", "1", outputPath],
          { timeout: ENCODE_TIMEOUT_MS, maxBuffer: MAX_BUFFER },
        );

        const elapsedMs = Date.now() - startMs;

        // Log ffmpeg process lifecycle
        logger.debug(
          { binary: "ffmpeg", args: ["-c:a", "libopus"], exitCode: 0, elapsedMs },
          "ffmpeg process completed",
        );

        // Get duration of the output file
        let durationMs = 0;
        try {
          durationMs = await probeDuration(outputPath);
        } catch {
          // Duration probe failure is non-fatal for conversion
        }

        // Log conversion details
        logger.debug(
          {
            inputFile: filenameOf(inputPath),
            inputFormat,
            outputFormat: "ogg/opus",
            durationMs,
            elapsedMs,
          },
          "Audio conversion complete",
        );

        return ok({ outputPath, durationMs, codec: "opus" });
      } catch (e: unknown) {
        const error = e instanceof Error ? e : new Error(String(e));
        const elapsedMs = Date.now() - startMs;

        // Extract stderr from the error if available
        const stderr = (e as { stderr?: string }).stderr ?? "";

        // Log ffmpeg failure
        logger.error(
          {
            binary: "ffmpeg",
            err: error.message,
            stderr: stderr.slice(0, STDERR_SNIPPET_LENGTH),
            hint: "ffmpeg failed to convert audio — check that the input file is a valid audio format and that libopus is available",
            errorKind: "dependency" as const,
            elapsedMs,
          },
          "ffmpeg process failed",
        );

        return err(error);
      }
    },

    async extractWaveform(
      inputPath: string,
      tempDir: string,
    ): Promise<Result<WaveformResult, Error>> {
      const tempPcm = safePath(tempDir, `waveform-${crypto.randomUUID()}.raw`);

      try {
        await execFileAsync(
          "ffmpeg",
          ["-y", "-i", inputPath, "-f", "s16le", "-acodec", "pcm_s16le", "-ac", "1", "-ar", "8000", tempPcm],
          { timeout: ENCODE_TIMEOUT_MS },
        );

        const pcmBuffer = await fs.readFile(tempPcm);
        const samples = new Int16Array(
          pcmBuffer.buffer,
          pcmBuffer.byteOffset,
          Math.floor(pcmBuffer.byteLength / 2),
        );

        const targetSamples = 256;
        const waveform = new Uint8Array(targetSamples);

        if (samples.length >= targetSamples) {
          const step = Math.floor(samples.length / targetSamples);
          for (let i = 0; i < targetSamples; i++) {
            let sum = 0;
            for (let j = 0; j < step; j++) {
              sum += Math.abs(samples[i * step + j]!);
            }
            const avg = sum / step;
            // Normalize to 0-255
            waveform[i] = Math.min(255, Math.round((avg / 32768) * 255));
          }
        } else {
          // Fewer than 256 samples -- copy what we have, rest stays zero
          for (let i = 0; i < samples.length; i++) {
            waveform[i] = Math.min(255, Math.round((Math.abs(samples[i]!) / 32768) * 255));
          }
        }

        const waveformBase64 = Buffer.from(waveform).toString("base64");

        logger.debug(
          { inputFile: filenameOf(inputPath), sampleCount: targetSamples },
          "Waveform extraction complete",
        );

        return ok({ waveformBase64, sampleCount: targetSamples });
      } catch (e: unknown) {
        const error = e instanceof Error ? e : new Error(String(e));
        return err(error);
      } finally {
        try { await fs.unlink(tempPcm); } catch { /* temp file cleanup best-effort */ }
      }
    },

    async getDuration(inputPath: string): Promise<Result<number, Error>> {
      return fromPromise(probeDuration(inputPath));
    },

    async verifyOpusCodec(filePath: string): Promise<Result<boolean, Error>> {
      try {
        const { stdout } = await execFileAsync(
          "ffprobe",
          ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name", "-of", "csv=p=0", filePath],
          { timeout: PROBE_TIMEOUT_MS },
        );
        return ok(stdout.trim() === "opus");
      } catch (e: unknown) {
        const error = e instanceof Error ? e : new Error(String(e));
        return err(error);
      }
    },
  };
}
