/**
 * Viewport control for browser automation.
 *
 * Provides viewport resizing with safe bounds clamping and device
 * presets for common screen sizes (mobile through 4K).
 *
 * Supports rich screenshots with viewport control.
 *
 * @module
 */

import type { Page } from "playwright-core";
import { ok, err, type Result } from "@comis/shared";

// ── Types ────────────────────────────────────────────────────────────

/** Named device viewport preset. */
export type DevicePreset = "mobile" | "tablet" | "desktop" | "fullhd" | "4k";

/** Viewport dimensions for each device preset. */
const DEVICE_PRESETS: Record<DevicePreset, { width: number; height: number }> = {
  mobile: { width: 375, height: 812 },
  tablet: { width: 768, height: 1024 },
  desktop: { width: 1280, height: 720 },
  fullhd: { width: 1920, height: 1080 },
  "4k": { width: 3840, height: 2160 },
};

// ── Implementation ───────────────────────────────────────────────────

/**
 * Resize the browser viewport to specific dimensions.
 *
 * Dimensions are clamped to safe bounds:
 * - Width: 1 to 7680 (8K horizontal)
 * - Height: 1 to 4320 (8K vertical)
 *
 * @param page - Playwright Page instance
 * @param width - Desired viewport width in pixels
 * @param height - Desired viewport height in pixels
 * @returns ok(undefined) on success, err on failure
 */
export async function resizeViewport(
  page: Page,
  width: number,
  height: number,
): Promise<Result<void, Error>> {
  try {
    const clampedWidth = Math.max(1, Math.min(7680, Math.round(width)));
    const clampedHeight = Math.max(1, Math.min(4320, Math.round(height)));

    await page.setViewportSize({
      width: clampedWidth,
      height: clampedHeight,
    });

    return ok(undefined);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return err(new Error(`resizeViewport failed: ${msg}`));
  }
}

/**
 * Set the viewport to a named device preset.
 *
 * Available presets:
 * - mobile: 375x812
 * - tablet: 768x1024
 * - desktop: 1280x720
 * - fullhd: 1920x1080
 * - 4k: 3840x2160
 *
 * @param page - Playwright Page instance
 * @param preset - Device preset name
 * @returns ok with dimensions on success, err on failure
 */
export async function setDevice(
  page: Page,
  preset: DevicePreset,
): Promise<Result<{ width: number; height: number }, Error>> {
  const dims = DEVICE_PRESETS[preset];
  if (!dims) {
    return err(new Error(`Unknown device preset: ${String(preset)}`));
  }

  const result = await resizeViewport(page, dims.width, dims.height);
  if (!result.ok) {
    return result;
  }

  return ok({ width: dims.width, height: dims.height });
}
