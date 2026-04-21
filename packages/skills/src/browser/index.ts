// SPDX-License-Identifier: Apache-2.0
/**
 * Browser service public API.
 *
 * @module
 */

export { createBrowserService } from "./browser-service.js";
export type {
  BrowserService,
  BrowserStatus,
  NavigateResult,
  TabInfo,
  ConsoleEntry,
  SnapshotParams,
  ScreenshotParams,
  ActParams,
} from "./browser-service.js";
export type { BrowserConfig } from "./config.js";
export { resolveBrowserConfig } from "./config.js";
export type { ActionResult, BrowserAction } from "./playwright-actions.js";
export type { SnapshotResult, SnapshotOptions, RoleRefMap } from "./playwright-snapshots.js";
export type { ScreenshotResult, PdfResult, ScreenshotOptions } from "./screenshots.js";
export { createProfileManager } from "./profiles-service.js";
export type { ProfileManager, ProfileInfo, ProfileManagerDeps } from "./profiles-service.js";
export {
  validateProfileName,
  allocateCdpPort,
  getProfileColor,
  PROFILE_COLORS,
  PROFILE_NAME_PATTERN,
} from "./profiles.js";
export { decorateProfile } from "./profile-decoration.js";
export { waitForDownload, listDownloads } from "./downloads.js";
export type { DownloadResult, DownloadWaitOptions } from "./downloads.js";
export { smartWait } from "./smart-waits.js";
export type { WaitOptions } from "./smart-waits.js";
export { resizeViewport, setDevice } from "./viewport.js";
export type { DevicePreset } from "./viewport.js";
export { normalizeScreenshot } from "./screenshot-normalizer.js";
export type { NormalizeOptions, NormalizedScreenshot } from "./screenshot-normalizer.js";
