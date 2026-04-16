/**
 * In-process browser control service.
 *
 * Provides a facade over Playwright, Chrome detection, CDP helpers,
 * snapshots, screenshots, and UI actions. Replaces Comis's HTTP
 * server pattern with direct in-process function calls.
 *
 * The BrowserService interface is what the platform browser tool
 * delegates to via rpcCall.
 *
 * @module
 */

import type { BrowserConfig } from "./config.js";
import { resolveBrowserConfig } from "./config.js";
import {
  launchChrome,
  stopChrome,
  type RunningChrome,
} from "./chrome-detection.js";
import {
  getCdpTargets,
  getCdpVersion,
  filterPageTargets,
  type CdpTarget,
} from "./cdp.js";
import {
  createSession,
  closeSession,
  getPage,
  createNewPage,
  getTargetId,
  isConnected,
  ensurePageState,
  type BrowserConsoleMessage,
} from "./playwright-session.js";
import {
  executeAction,
  type BrowserAction,
  type ActionResult,
} from "./playwright-actions.js";
import {
  takeSnapshot,
  type SnapshotOptions,
  type SnapshotResult,
} from "./playwright-snapshots.js";
import {
  takeScreenshot,
  generatePdf,
  type ScreenshotOptions,
  type ScreenshotResult,
  type PdfResult,
} from "./screenshots.js";

// ── Types ────────────────────────────────────────────────────────────

/** Browser service status. */
export type BrowserStatus = {
  running: boolean;
  chromeVersion?: string;
  cdpPort: number;
  activeTabs: number;
  connected: boolean;
};

/** Navigate result. */
export type NavigateResult = {
  url: string;
  title: string;
  targetId: string | null;
};

/** Tab information. */
export type TabInfo = {
  targetId: string;
  title: string;
  url: string;
  type: string;
};

/** Console entry from a page. */
export type ConsoleEntry = BrowserConsoleMessage;

/** Snapshot parameters. */
export type SnapshotParams = SnapshotOptions & {
  targetId?: string;
};

/** Screenshot parameters. */
export type ScreenshotParams = ScreenshotOptions & {
  targetId?: string;
};

/** Act (action) parameters. */
export type ActParams = BrowserAction;

/**
 * In-process browser control service interface.
 *
 * All methods return data objects -- they do not throw. Errors are
 * captured and returned as descriptive error fields.
 */
export interface BrowserService {
  /** Get service status. */
  status(): Promise<BrowserStatus>;
  /** Start browser (find Chrome, launch, connect Playwright). */
  start(): Promise<void>;
  /** Stop browser (disconnect Playwright, kill Chrome). */
  stop(): Promise<void>;
  /** Navigate to a URL. */
  navigate(params: { url: string; targetId?: string }): Promise<NavigateResult>;
  /** Take an accessibility snapshot. */
  snapshot(params: SnapshotParams): Promise<SnapshotResult>;
  /** Take a screenshot. */
  screenshot(params: ScreenshotParams): Promise<ScreenshotResult>;
  /** Generate a PDF. */
  pdf(params: { targetId?: string }): Promise<PdfResult>;
  /** Execute a UI action (click, type, press, hover, drag, select, fill, close). */
  act(params: ActParams): Promise<ActionResult>;
  /** List open tabs. */
  tabs(): Promise<TabInfo[]>;
  /** Open a new tab. */
  openTab(params: { url: string }): Promise<TabInfo>;
  /** Focus a tab. */
  focusTab(params: { targetId: string }): Promise<void>;
  /** Close a tab. */
  closeTab(params: { targetId?: string }): Promise<void>;
  /** Get console messages from a page. */
  console(params: { level?: string; targetId?: string }): Promise<ConsoleEntry[]>;
}

// ── Constants ────────────────────────────────────────────────────────

/**
 * Allowed URL protocols for browser navigation.
 * Blocks file://, javascript:, data:, etc. at the service layer.
 * about: is allowed because about:blank is used as the default new-tab URL.
 */
const ALLOWED_NAV_PROTOCOLS = new Set(["http:", "https:", "about:"]);

// ── Implementation ───────────────────────────────────────────────────

/**
 * Create an in-process browser control service.
 *
 * @param partialConfig - Partial browser config (defaults applied)
 * @returns BrowserService instance
 */
export function createBrowserService(
  partialConfig?: Partial<BrowserConfig>,
  spawnEnv?: Record<string, string>,  // filtered env for Chrome subprocess
): BrowserService {
  const config = resolveBrowserConfig(partialConfig);
  let running: RunningChrome | null = null;
  let lastTargetId: string | null = null;

  function cdpUrl(): string {
    return `http://127.0.0.1:${config.cdpPort}`;
  }

  const service: BrowserService = {
    async status(): Promise<BrowserStatus> {
      try {
        const version = await getCdpVersion(cdpUrl(), 1500);
        const targets = version
          ? await getCdpTargets(cdpUrl(), 1500).catch(() => [])
          : [];
        const pageTabs = filterPageTargets(targets);
        return {
          running: running !== null,
          chromeVersion: version?.Browser,
          cdpPort: config.cdpPort!,
          activeTabs: pageTabs.length,
          connected: isConnected(),
        };
      } catch {
        return {
          running: running !== null,
          cdpPort: config.cdpPort!,
          activeTabs: 0,
          connected: isConnected(),
        };
      }
    },

    async start(): Promise<void> {
      if (running) return; // Already started

      // Launch Chrome
      const chrome = await launchChrome(config, spawnEnv);
      running = chrome;

      // Connect Playwright via CDP
      await createSession(cdpUrl());
    },

    async stop(): Promise<void> {
      // Disconnect Playwright
      await closeSession();

      // Stop Chrome process
      if (running) {
        await stopChrome(running);
        running = null;
      }
    },

    async navigate(params): Promise<NavigateResult> {
      const url = String(params.url ?? "").trim();
      if (!url) throw new Error("url is required");

      // Defense-in-depth: validate URL protocol before page.goto().
      // The browser-tool layer already validates via validateUrl(), but this
      // guards against direct BrowserService.navigate() calls bypassing the tool.
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new Error("Invalid URL");
      }
      if (!ALLOWED_NAV_PROTOCOLS.has(parsed.protocol)) {
        throw new Error(`Blocked protocol: ${parsed.protocol} -- only http/https allowed`);
      }

      const page = await getPage(cdpUrl(), params.targetId);
      ensurePageState(page);

      await page.goto(url, {
        timeout: Math.max(1000, Math.min(120_000, config.timeoutMs ?? 20_000)),
      });

      const targetId = await getTargetId(page).catch(() => null);
      if (targetId) lastTargetId = targetId;

      return {
        url: page.url(),
        title: await page.title().catch(() => ""),
        targetId,
      };
    },

    async snapshot(params): Promise<SnapshotResult> {
      const page = await getPage(cdpUrl(), params.targetId);
      return takeSnapshot(page, {
        interactive: params.interactive,
        maxDepth: params.maxDepth,
        compact: params.compact,
        selector: params.selector,
        maxChars: params.maxChars ?? config.snapshotMaxChars,
      });
    },

    async screenshot(params): Promise<ScreenshotResult> {
      const page = await getPage(cdpUrl(), params.targetId);
      return takeScreenshot(page, {
        fullPage: params.fullPage,
        ref: params.ref,
        element: params.element,
        type: params.type,
        quality: params.quality ?? config.screenshotQuality,
      });
    },

    async pdf(params): Promise<PdfResult> {
      const page = await getPage(cdpUrl(), params.targetId);
      return generatePdf(page);
    },

    async act(params): Promise<ActionResult> {
      const page = await getPage(cdpUrl(), params.targetId);
      return executeAction(page, params);
    },

    async tabs(): Promise<TabInfo[]> {
      try {
        const targets = await getCdpTargets(cdpUrl());
        return filterPageTargets(targets).map((t: CdpTarget) => ({
          targetId: t.id,
          title: t.title,
          url: t.url,
          type: t.type,
        }));
      } catch {
        return [];
      }
    },

    async openTab(params): Promise<TabInfo> {
      const url = String(params.url ?? "").trim() || "about:blank";
      const { page, targetId } = await createNewPage(cdpUrl(), url);
      if (targetId) lastTargetId = targetId;
      return {
        targetId: targetId ?? "",
        title: await page.title().catch(() => ""),
        url: page.url(),
        type: "page",
      };
    },

    async focusTab(params): Promise<void> {
      const page = await getPage(cdpUrl(), params.targetId);
      await page.bringToFront();
      lastTargetId = params.targetId;
    },

    async closeTab(params): Promise<void> {
      const targetId = params.targetId ?? lastTargetId;
      if (!targetId) throw new Error("No tab to close (no targetId)");
      const page = await getPage(cdpUrl(), targetId);
      await page.close();
    },

    async console(params): Promise<ConsoleEntry[]> {
      const page = await getPage(cdpUrl(), params.targetId);
      const state = ensurePageState(page);
      const entries = state.console;
      if (!params.level) return [...entries];
      return entries.filter((e) => e.type === params.level);
    },
  };

  return service;
}
