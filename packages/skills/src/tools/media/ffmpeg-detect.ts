// SPDX-License-Identifier: Apache-2.0
/**
 * Detect ffmpeg and ffprobe availability on the system.
 *
 * Uses promisified execFile with a 5-second timeout to check each binary.
 * Never throws -- uses Promise.allSettled to handle missing binaries gracefully.
 *
 * @module
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Detection timeout in milliseconds. */
const DETECT_TIMEOUT_MS = 5_000;

/** Capabilities detected for ffmpeg and ffprobe. */
export interface FfmpegCapabilities {
  /** Whether ffmpeg binary is available on PATH. */
  readonly ffmpegAvailable: boolean;
  /** Whether ffprobe binary is available on PATH. */
  readonly ffprobeAvailable: boolean;
  /** First line of `ffmpeg -version` output, if available. */
  readonly ffmpegVersion?: string;
  /** First line of `ffprobe -version` output, if available. */
  readonly ffprobeVersion?: string;
}

/**
 * Detect ffmpeg and ffprobe availability by running `<binary> -version`.
 *
 * This function NEVER throws. It uses Promise.allSettled to handle
 * both binaries independently, returning availability booleans and
 * version strings when present.
 */
export async function detectFfmpeg(): Promise<FfmpegCapabilities> {
  const [ffmpegResult, ffprobeResult] = await Promise.allSettled([
    execFileAsync("ffmpeg", ["-version"], { timeout: DETECT_TIMEOUT_MS }),
    execFileAsync("ffprobe", ["-version"], { timeout: DETECT_TIMEOUT_MS }),
  ]);

  const ffmpegAvailable = ffmpegResult.status === "fulfilled";
  const ffprobeAvailable = ffprobeResult.status === "fulfilled";

  const ffmpegVersion =
    ffmpegAvailable
      ? ffmpegResult.value.stdout.split("\n")[0] || undefined
      : undefined;

  const ffprobeVersion =
    ffprobeAvailable
      ? ffprobeResult.value.stdout.split("\n")[0] || undefined
      : undefined;

  return {
    ffmpegAvailable,
    ffprobeAvailable,
    ffmpegVersion,
    ffprobeVersion,
  };
}
