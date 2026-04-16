/**
 * Browser service constants.
 *
 * Default values for browser configuration. These are used by
 * resolveBrowserConfig() when no explicit value is provided.
 *
 * @module
 */

/** Default viewport width in pixels. */
export const DEFAULT_VIEWPORT_WIDTH = 1280;

/** Default viewport height in pixels. */
export const DEFAULT_VIEWPORT_HEIGHT = 720;

/** Maximum side length for normalized screenshots (px). */
export const DEFAULT_SCREENSHOT_MAX_SIDE = 2000;

/** Maximum screenshot file size in bytes (5 MB). */
export const DEFAULT_SCREENSHOT_MAX_BYTES = 5 * 1024 * 1024;

/** JPEG quality for compressed screenshots (0-100). */
export const DEFAULT_SCREENSHOT_QUALITY = 80;

/** Maximum character count for AI accessibility snapshots. */
export const DEFAULT_AI_SNAPSHOT_MAX_CHARS = 30_000;

/** Default action timeout in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Default Chrome DevTools Protocol port. */
export const DEFAULT_CDP_PORT = 9222;

/** Default browser profile name. */
export const DEFAULT_BROWSER_PROFILE = "comis";

/** Maximum console messages retained per page. */
export const MAX_CONSOLE_MESSAGES = 500;

/** Maximum page errors retained per page. */
export const MAX_PAGE_ERRORS = 200;
