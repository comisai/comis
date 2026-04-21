// SPDX-License-Identifier: Apache-2.0
/**
 * Smart wait conditions for browser automation.
 *
 * Dispatches to Playwright's native waitFor methods for multiple
 * condition types: static delay, text visible/gone, CSS selector,
 * URL pattern, load state, and JS function evaluation.
 *
 * Provides AI-driven actions with smart wait conditions.
 *
 * @module
 */

import type { Page } from "playwright-core";
import { ok, err, type Result } from "@comis/shared";

// ── Types ────────────────────────────────────────────────────────────

/** Options for smartWait -- each field is an independent wait condition. */
export interface WaitOptions {
  /** Static delay in milliseconds (sleep). */
  readonly timeMs?: number;
  /** Wait for text to become visible on the page. */
  readonly text?: string;
  /** Wait for text to disappear from the page. */
  readonly textGone?: string;
  /** Wait for a CSS selector to be visible. */
  readonly selector?: string;
  /** Wait for the URL to contain this string. */
  readonly url?: string;
  /** Wait for a specific load state. */
  readonly loadState?: "load" | "domcontentloaded" | "networkidle";
  /** Wait for a JS expression to evaluate to a truthy value. */
  readonly fn?: string;
  /** Overall timeout per condition in milliseconds (default 20000, clamped 1000-60000). */
  readonly timeoutMs?: number;
}

// ── Implementation ───────────────────────────────────────────────────

/**
 * Execute one or more wait conditions sequentially on a Playwright Page.
 *
 * Each condition dispatches to the corresponding Playwright native
 * waitFor method. If any condition fails (e.g., timeout), returns an
 * err with a descriptive message identifying which condition failed.
 *
 * @param page - Playwright Page instance
 * @param opts - Wait conditions to process
 * @returns ok(undefined) when all conditions pass, err on failure
 */
export async function smartWait(
  page: Page,
  opts: WaitOptions,
): Promise<Result<void, Error>> {
  const timeoutMs = Math.max(1000, Math.min(60_000, opts.timeoutMs ?? 20_000));

  try {
    // 1. Static delay
    if (opts.timeMs !== undefined) {
      const clampedMs = Math.min(30_000, Math.max(0, opts.timeMs));
      await page.waitForTimeout(clampedMs);
    }

    // 2. Wait for text visible
    if (opts.text !== undefined) {
      await page
        .locator(`text=${opts.text}`)
        .first()
        .waitFor({ state: "visible", timeout: timeoutMs });
    }

    // 3. Wait for text gone
    if (opts.textGone !== undefined) {
      await page
        .locator(`text=${opts.textGone}`)
        .first()
        .waitFor({ state: "hidden", timeout: timeoutMs });
    }

    // 4. Wait for CSS selector visible
    if (opts.selector !== undefined) {
      await page
        .locator(opts.selector)
        .first()
        .waitFor({ state: "visible", timeout: timeoutMs });
    }

    // 5. Wait for URL pattern
    if (opts.url !== undefined) {
      await page.waitForURL(`**/*${opts.url}*`, { timeout: timeoutMs });
    }

    // 6. Wait for load state
    if (opts.loadState !== undefined) {
      await page.waitForLoadState(opts.loadState, { timeout: timeoutMs });
    }

    // 7. Wait for JS function
    if (opts.fn !== undefined) {
      await page.waitForFunction(opts.fn, undefined, { timeout: timeoutMs });
    }

    return ok(undefined);
  } catch (error) {
    const msg =
      error instanceof Error ? error.message : String(error);

    // Identify which condition likely failed from the error message
    return err(new Error(`smartWait failed: ${msg}`));
  }
}
