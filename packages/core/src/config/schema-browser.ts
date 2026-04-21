// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

/**
 * Browser automation / CDP configuration schema.
 *
 * Controls Chrome/Chromium browser automation settings including
 * viewport, screenshot quality, and CDP connection parameters.
 * Used by the browser built-in tool for headless web interactions.
 *
 * @module
 */
const ViewportSchema = z.strictObject({
    /** Viewport width in pixels (default: 1280) */
    width: z.number().int().positive().default(1280),
    /** Viewport height in pixels (default: 720) */
    height: z.number().int().positive().default(720),
  });

export const BrowserConfigSchema = z.strictObject({
    /** Enable browser automation (default: false) */
    enabled: z.boolean().default(false),
    /** Path to Chrome/Chromium binary (auto-detected if omitted) */
    chromePath: z.string().optional(),
    /** CDP (Chrome DevTools Protocol) debug port (default: 9222) */
    cdpPort: z.number().int().min(1).max(65535).default(9222),
    /** Named browser profile directory (default: "default") */
    defaultProfile: z.string().default("default"),
    /** Default viewport dimensions for headless pages */
    viewport: ViewportSchema.default(() => ViewportSchema.parse({})),
    /** Run browser in headless mode (default: true) */
    headless: z.boolean().default(true),
    /** Disable Chrome sandbox (security-sensitive, default: false) */
    noSandbox: z.boolean().default(false),
    /** Maximum screenshot dimension in pixels (default: 2000) */
    screenshotMaxSide: z.number().int().positive().default(2000),
    /** Screenshot JPEG quality 1-100 (default: 80) */
    screenshotQuality: z.number().int().min(1).max(100).default(80),
    /** Maximum characters for DOM snapshot (default: 120000) */
    snapshotMaxChars: z.number().int().positive().default(120_000),
    /** Page load / navigation timeout in milliseconds (default: 30000) */
    timeoutMs: z.number().int().positive().default(30_000),
    /** Base CDP port for profile allocation (default: 18800) */
    baseCdpPort: z.number().int().min(1).max(65535).default(18800),
    /** Maximum concurrent named profiles (default: 10) */
    maxProfiles: z.number().int().min(1).max(50).default(10),
    /** Override directory for profile data (defaults to system temp) */
    profilesDir: z.string().optional(),
    /** Directory for tracked downloads (defaults to system temp) */
    downloadsDir: z.string().optional(),
    /** Maximum wait time for a download in milliseconds (default: 120000) */
    downloadTimeoutMs: z.number().int().positive().default(120_000),
  });

/** Inferred browser configuration type. */
export type BrowserConfig = z.infer<typeof BrowserConfigSchema>;
