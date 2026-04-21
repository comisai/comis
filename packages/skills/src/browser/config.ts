// SPDX-License-Identifier: Apache-2.0
/**
 * Browser service configuration.
 *
 * Defines the BrowserConfig interface and a resolver that fills in
 * defaults from constants.ts. Config is accepted as a parameter --
 * no global config system dependency.
 *
 * @module
 */

import {
  DEFAULT_CDP_PORT,
  DEFAULT_BROWSER_PROFILE,
  DEFAULT_VIEWPORT_WIDTH,
  DEFAULT_VIEWPORT_HEIGHT,
  DEFAULT_SCREENSHOT_MAX_SIDE,
  DEFAULT_SCREENSHOT_QUALITY,
  DEFAULT_AI_SNAPSHOT_MAX_CHARS,
  DEFAULT_TIMEOUT_MS,
} from "./constants.js";

/**
 * Configuration for the browser service.
 *
 * All fields are optional; resolveBrowserConfig() fills in defaults.
 */
export interface BrowserConfig {
  /** Whether the browser service is enabled. */
  enabled: boolean;
  /** Override Chrome executable path. */
  chromePath?: string;
  /** CDP debugging port (default 9222). */
  cdpPort?: number;
  /** Default browser profile name. */
  defaultProfile?: string;
  /** Viewport dimensions. */
  viewport?: { width: number; height: number };
  /** Run Chrome headless (default true for server usage). */
  headless?: boolean;
  /** Disable Chrome sandbox (needed in some container envs). */
  noSandbox?: boolean;
  /** Maximum screenshot dimension in px (default 2000). */
  screenshotMaxSide?: number;
  /** JPEG compression quality (default 80). */
  screenshotQuality?: number;
  /** Maximum snapshot text length. */
  snapshotMaxChars?: number;
  /** Default action timeout in ms. */
  timeoutMs?: number;
}

/**
 * Resolve a full BrowserConfig from a partial, filling in defaults.
 */
export function resolveBrowserConfig(
  partial?: Partial<BrowserConfig>,
): BrowserConfig {
  return {
    enabled: partial?.enabled ?? true,
    chromePath: partial?.chromePath,
    cdpPort: validPort(partial?.cdpPort) ?? DEFAULT_CDP_PORT,
    defaultProfile: partial?.defaultProfile ?? DEFAULT_BROWSER_PROFILE,
    viewport: {
      width: positiveInt(partial?.viewport?.width) ?? DEFAULT_VIEWPORT_WIDTH,
      height: positiveInt(partial?.viewport?.height) ?? DEFAULT_VIEWPORT_HEIGHT,
    },
    headless: partial?.headless ?? true,
    noSandbox: partial?.noSandbox ?? false,
    screenshotMaxSide:
      positiveInt(partial?.screenshotMaxSide) ?? DEFAULT_SCREENSHOT_MAX_SIDE,
    screenshotQuality:
      clampInt(partial?.screenshotQuality, 1, 100) ?? DEFAULT_SCREENSHOT_QUALITY,
    snapshotMaxChars:
      positiveInt(partial?.snapshotMaxChars) ?? DEFAULT_AI_SNAPSHOT_MAX_CHARS,
    timeoutMs: positiveInt(partial?.timeoutMs) ?? DEFAULT_TIMEOUT_MS,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

function positiveInt(v: number | undefined): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return undefined;
  return Math.floor(v);
}

function validPort(v: number | undefined): number | undefined {
  const n = positiveInt(v);
  if (n === undefined || n > 65535) return undefined;
  return n;
}

function clampInt(
  v: number | undefined,
  min: number,
  max: number,
): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  return Math.max(min, Math.min(max, Math.floor(v)));
}
