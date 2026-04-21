// SPDX-License-Identifier: Apache-2.0
/**
 * Browser download tracking with arm-id pattern.
 *
 * Tracks Playwright-initiated downloads using the arm-id pattern from
 * Comis for race safety: each waitForDownload call gets a unique
 * arm counter, and stale waiters are detected and rejected.
 *
 * All path operations use safePath() to prevent directory traversal.
 *
 * @module
 */

import * as fs from "node:fs";
import * as crypto from "node:crypto";
import type { Page, Download } from "playwright-core";
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import { safePath } from "@comis/core";

// ── Types ─────────────────────────────────────────────────────────────

/** Result of a successful download. */
export interface DownloadResult {
  /** The URL that triggered the download. */
  url: string;
  /** The filename suggested by the server. */
  suggestedFilename: string;
  /** Absolute path where the file was saved. */
  path: string;
  /** File size in bytes. */
  sizeBytes: number;
}

/** Options for waitForDownload. */
export interface DownloadWaitOptions {
  /** Directory to save downloaded files to. */
  downloadsDir: string;
  /** Maximum time to wait for a download in milliseconds (default: 120000). */
  timeoutMs?: number;
}

// ── Arm-ID counter ────────────────────────────────────────────────────

let downloadArmCounter = 0;

/**
 * Bump the download arm counter and return the new value.
 * Used to detect stale/superseded download waiters.
 */
function bumpDownloadArmId(): number {
  return ++downloadArmCounter;
}

/**
 * Get the current arm counter value (for testing).
 * @internal
 */
export function _getArmCounter(): number {
  return downloadArmCounter;
}

/**
 * Reset the arm counter (for testing).
 * @internal
 */
export function _resetArmCounter(): void {
  downloadArmCounter = 0;
}

// ── Functions ─────────────────────────────────────────────────────────

/**
 * Wait for a download event on a Playwright page and save the file.
 *
 * Uses the arm-id pattern to detect stale waiters: if another
 * waitForDownload call supersedes this one, the stale waiter returns
 * an error instead of saving.
 *
 * @param page - Playwright page to listen for downloads on
 * @param opts - Download directory and optional timeout
 * @returns ok(DownloadResult) on success, err on failure/timeout/superseded
 */
export async function waitForDownload(
  page: Page,
  opts: DownloadWaitOptions,
): Promise<Result<DownloadResult, Error>> {
  const timeout = Math.max(500, Math.min(120_000, opts.timeoutMs ?? 120_000));
  const armId = bumpDownloadArmId();

  try {
    // Wait for the download event
    const download: Download = await page.waitForEvent("download", { timeout });

    // Check if this waiter was superseded
    if (downloadArmCounter !== armId) {
      return err(new Error("Download was superseded"));
    }

    const suggestedFilename = download.suggestedFilename();
    const uuid = crypto.randomUUID();
    const saveFilename = `${uuid}-${suggestedFilename}`;

    // Ensure downloads directory exists
    await fs.promises.mkdir(opts.downloadsDir, { recursive: true });

    // Build safe save path
    const savePath = safePath(opts.downloadsDir, saveFilename);

    // Save the downloaded file
    await download.saveAs(savePath);

    // Get file size
    const stat = await fs.promises.stat(savePath);

    return ok({
      url: download.url(),
      suggestedFilename,
      path: savePath,
      sizeBytes: stat.size,
    });
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    return err(error);
  }
}

/**
 * List previously downloaded files in the downloads directory.
 *
 * Reads directory entries and reconstructs DownloadResult metadata
 * from the UUID-prefixed filenames.
 *
 * @param downloadsDir - Directory containing downloaded files
 * @returns ok(DownloadResult[]) on success, err on read failure
 */
export async function listDownloads(
  downloadsDir: string,
): Promise<Result<DownloadResult[], Error>> {
  try {
    const dirPath = safePath(downloadsDir, ".");
    const entries = await fs.promises.readdir(dirPath);
    const results: DownloadResult[] = [];

    for (const entry of entries) {
      // UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx-filename
      // 36 chars UUID + 1 dash = 37 char prefix
      const uuidLen = 36;
      if (entry.length <= uuidLen + 1) continue;

      const uuidPart = entry.slice(0, uuidLen);
      const separator = entry[uuidLen];
      if (separator !== "-") continue;

      // Validate UUID format loosely
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuidPart)) {
        continue;
      }

      const originalFilename = entry.slice(uuidLen + 1);
      const filePath = safePath(downloadsDir, entry);

      try {
        const stat = await fs.promises.stat(filePath);
        if (stat.isFile()) {
          results.push({
            url: "", // Original URL not stored in filename
            suggestedFilename: originalFilename,
            path: filePath,
            sizeBytes: stat.size,
          });
        }
      } catch {
        // File may have been removed -- skip
      }
    }

    return ok(results);
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}
