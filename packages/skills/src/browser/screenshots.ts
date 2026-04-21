// SPDX-License-Identifier: Apache-2.0
/**
 * Screenshot capture and PDF generation.
 *
 * Takes page screenshots via Playwright with size normalization (resize
 * images exceeding screenshotMaxSide), supports element-scoped capture,
 * and generates PDFs.
 *
 * Ported from Comis browser/screenshot.ts +
 * pw-tools-core.interactions.ts (takeScreenshotViaPlaywright, pdfViaPlaywright),
 * simplified without sharp-based resize (uses Playwright's built-in capture).
 *
 * @module
 */

import type { Page } from "playwright-core";
import { ensurePageState, refLocator } from "./playwright-session.js";

// ── Types ────────────────────────────────────────────────────────────

export type ScreenshotOptions = {
  /** Capture full page (scrolling). */
  fullPage?: boolean;
  /** Element ref from snapshot (e.g., "e12"). */
  ref?: string;
  /** CSS selector for element-scoped screenshot. */
  element?: string;
  /** Image type: "png" or "jpeg". */
  type?: "png" | "jpeg";
  /** JPEG quality (0-100). Only used for jpeg type. */
  quality?: number;
};

export type ScreenshotResult = {
  buffer: Buffer;
  mimeType: string;
  width?: number;
  height?: number;
};

export type PdfResult = {
  buffer: Buffer;
  mimeType: "application/pdf";
};

// ── Public API ───────────────────────────────────────────────────────

/**
 * Take a screenshot of a page, optionally scoped to an element.
 *
 * @param page - Playwright Page instance
 * @param options - Screenshot options (fullPage, ref, element, type, quality)
 * @returns Buffer with screenshot data and MIME type
 */
export async function takeScreenshot(
  page: Page,
  options: ScreenshotOptions = {},
): Promise<ScreenshotResult> {
  ensurePageState(page);

  const type = options.type ?? "png";
  const quality = type === "jpeg" ? (options.quality ?? 80) : undefined;
  const mimeType = type === "jpeg" ? "image/jpeg" : "image/png";

  // Element screenshot by ref
  if (options.ref) {
    if (options.fullPage) {
      throw new Error("fullPage is not supported for element screenshots");
    }
    const locator = refLocator(page, options.ref);
    const buffer = await locator.screenshot({ type, quality });
    return { buffer, mimeType };
  }

  // Element screenshot by CSS selector
  if (options.element) {
    if (options.fullPage) {
      throw new Error("fullPage is not supported for element screenshots");
    }
    const locator = page.locator(options.element).first();
    const buffer = await locator.screenshot({ type, quality });
    return { buffer, mimeType };
  }

  // Full-page or viewport screenshot
  const buffer = await page.screenshot({
    type,
    quality,
    fullPage: Boolean(options.fullPage),
  });

  return { buffer, mimeType };
}

/**
 * Generate a PDF of a page.
 *
 * @param page - Playwright Page instance
 * @returns Buffer with PDF data
 */
export async function generatePdf(page: Page): Promise<PdfResult> {
  ensurePageState(page);
  const buffer = await page.pdf({ printBackground: true });
  return { buffer, mimeType: "application/pdf" };
}
