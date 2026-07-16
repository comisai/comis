// SPDX-License-Identifier: Apache-2.0
// @allow-throw: browser/playwright SDK boundary wrapper; throws caught by AgentTool wrapper (browser-action-tool) — agent execution boundary catch.
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
import type {
  BrowserContext,
  CDPSession,
  Page,
  Route,
  WebSocketRoute,
} from "playwright-core";
import { validateUrl, validateLocalServerUrl } from "@comis/core";
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
 * Methods resolve with data objects and reject when validation, browser, or
 * Playwright operations fail. The RPC boundary maps those failures to JSON-RPC
 * errors for callers.
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
 * Allowed URL protocols for browser navigation. HTTP(S) destinations receive
 * DNS/IP-range validation; about:blank is the only local browser page callers
 * may navigate to directly.
 */
const ALLOWED_NAV_PROTOCOLS = new Set(["http:", "https:", "about:"]);
const GUARDED_NETWORK_PROTOCOLS = new Set(["http:", "https:"]);
const ALLOWED_INTERNAL_RESOURCE_PROTOCOLS = new Set(["about:", "blob:", "data:"]);

type FetchRequestPausedEvent = {
  requestId: string;
  request: { url: string };
};

const BLOCKED_PAGE_NETWORK_CONSTRUCTORS = [
  "Worker",
  "SharedWorker",
  "WebTransport",
  "WebSocketStream",
  "RTCPeerConnection",
  "webkitRTCPeerConnection",
] as const;

/**
 * Disable browser APIs whose traffic does not pass through Playwright's page
 * routing or the page-target CDP Fetch interceptor. Workers are disabled as a
 * unit because worker-created sockets otherwise bypass both controls.
 */
function createNetworkApiLockdownScript(blockWebSocket: boolean): string {
  const constructorNames = blockWebSocket
    ? [...BLOCKED_PAGE_NETWORK_CONSTRUCTORS, "WebSocket"]
    : [...BLOCKED_PAGE_NETWORK_CONSTRUCTORS];
  return `(() => {
  const constructorNames = ${JSON.stringify(constructorNames)};
  for (const name of constructorNames) {
    const constructor = globalThis[name];
    if (typeof constructor === "function" && constructor.prototype) {
      try {
        Object.defineProperty(constructor.prototype, "constructor", {
          value: undefined,
          writable: false,
          configurable: false
        });
      } catch {}
    }
    try {
      Object.defineProperty(globalThis, name, {
        value: undefined,
        writable: false,
        configurable: false
      });
    } catch {}
  }

  const serviceWorker = globalThis.navigator?.serviceWorker;
  if (serviceWorker) {
    const rejectRegistration = () => Promise.reject(
      new DOMException("Blocked by the browser network policy", "SecurityError")
    );
    for (const target of [serviceWorker, Object.getPrototypeOf(serviceWorker)]) {
      if (!target) continue;
      try {
        Object.defineProperty(target, "register", {
          value: rejectRegistration,
          writable: false,
          configurable: false
        });
      } catch {}
    }
  }

  if (constructorNames.some((name) => typeof globalThis[name] !== "undefined")) {
    throw new DOMException("Browser network policy could not be installed", "SecurityError");
  }
})();`;
}

const FUTURE_DOCUMENT_NETWORK_LOCKDOWN_SCRIPT = createNetworkApiLockdownScript(false);
// Playwright cannot retrofit its WebSocket route into a document that already
// loaded, so that document keeps WebSocket disabled until its next navigation.
const CURRENT_DOCUMENT_NETWORK_LOCKDOWN_SCRIPT = createNetworkApiLockdownScript(true);

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
  const guardedContexts = new WeakMap<BrowserContext, Promise<void>>();
  const guardedPages = new WeakMap<Page, Promise<void>>();
  const activePageGuards = new WeakSet<Page>();

  function cdpUrl(): string {
    return `http://127.0.0.1:${config.cdpPort}`;
  }

  /**
   * SSRF verdict for every guarded browser URL (navigation, subresource
   * routing, CDP fetch, WebSocket). Operator opt-in
   * (`browser.allowLoopbackNavigation`) permits LOOPBACK targets only —
   * validateLocalServerUrl allows loopback and still denies private ranges and
   * cloud-metadata IPs, so the relaxation cannot widen into arbitrary
   * internal-network egress.
   */
  async function checkGuardedUrl(href: string): Promise<Awaited<ReturnType<typeof validateUrl>>> {
    const validation = await validateUrl(href);
    if (validation.ok || !config.allowLoopbackNavigation) return validation;
    const loopback = await validateLocalServerUrl(href);
    return loopback.ok ? loopback : validation;
  }

  async function validateNavigationTarget(rawUrl: string): Promise<string> {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new Error("Invalid URL");
    }
    if (!ALLOWED_NAV_PROTOCOLS.has(parsed.protocol)) {
      throw new Error(
        `Blocked protocol: ${parsed.protocol} -- only http, https, and about:blank are allowed`,
      );
    }
    if (parsed.protocol === "about:") {
      if (parsed.href !== "about:blank") {
        throw new Error("Blocked browser URL -- only about:blank is allowed");
      }
      return parsed.href;
    }

    const validation = await checkGuardedUrl(parsed.href);
    if (!validation.ok) {
      throw new Error(`SSRF blocked: ${validation.error.message}`);
    }
    return validation.value.url.toString();
  }

  async function handleGuardedRequest(route: Route): Promise<void> {
    const requestUrl = route.request().url();
    let parsed: URL;
    try {
      parsed = new URL(requestUrl);
    } catch {
      await route.abort("blockedbyclient");
      return;
    }

    if (!GUARDED_NETWORK_PROTOCOLS.has(parsed.protocol)) {
      if (ALLOWED_INTERNAL_RESOURCE_PROTOCOLS.has(parsed.protocol)) {
        await route.continue();
      } else {
        await route.abort("blockedbyclient");
      }
      return;
    }

    // Playwright does not invoke BrowserContext.route() again for redirect
    // hops. HTTP(S) requests without an active page-level CDP guard are
    // therefore blocked instead of being allowed onto an unguarded target.
    // This also fails closed for popup and service-worker requests whose frame
    // is unavailable at interception time.
    let guardedPage: boolean;
    try {
      guardedPage = activePageGuards.has(route.request().frame().page());
    } catch {
      guardedPage = false;
    }
    if (!guardedPage) {
      await route.abort("blockedbyclient");
      return;
    }

    const validation = await checkGuardedUrl(parsed.href);
    if (!validation.ok) {
      await route.abort("blockedbyclient");
      return;
    }

    await route.continue({ url: validation.value.url.toString() });
  }

  async function failCdpRequest(session: CDPSession, requestId: string): Promise<void> {
    try {
      await session.send("Fetch.failRequest", {
        requestId,
        errorReason: "BlockedByClient",
      });
    } catch {
      // The page or request may have closed while its asynchronous URL check
      // was in flight. There is no live request left to release in that case.
    }
  }

  async function handleCdpRequest(
    session: CDPSession,
    event: FetchRequestPausedEvent,
  ): Promise<void> {
    let parsed: URL;
    try {
      parsed = new URL(event.request.url);
    } catch {
      await failCdpRequest(session, event.requestId);
      return;
    }

    if (!GUARDED_NETWORK_PROTOCOLS.has(parsed.protocol)) {
      await failCdpRequest(session, event.requestId);
      return;
    }

    let validation: Awaited<ReturnType<typeof validateUrl>>;
    try {
      validation = await checkGuardedUrl(parsed.href);
    } catch {
      await failCdpRequest(session, event.requestId);
      return;
    }
    if (!validation.ok) {
      await failCdpRequest(session, event.requestId);
      return;
    }

    try {
      await session.send("Fetch.continueRequest", {
        requestId: event.requestId,
        url: validation.value.url.toString(),
      });
    } catch {
      await failCdpRequest(session, event.requestId);
    }
  }

  async function ensurePageRequestGuard(page: Page): Promise<void> {
    const existing = guardedPages.get(page);
    if (existing) {
      await existing;
      return;
    }

    const installation = (async () => {
      // Context init scripts cover future documents; evaluate the same policy
      // in the current document before any browser action is allowed.
      await page.evaluate(CURRENT_DOCUMENT_NETWORK_LOCKDOWN_SCRIPT);
      const session = await page.context().newCDPSession(page);
      session.on("Fetch.requestPaused", (event) => {
        void handleCdpRequest(session, event as FetchRequestPausedEvent);
      });
      // Existing or externally managed Chrome profiles may already have an
      // active service worker. Make page requests bypass it so the worker
      // cannot issue network traffic outside this page's Fetch guard.
      await session.send("Network.enable");
      await session.send("Network.setBypassServiceWorker", { bypass: true });
      await session.send("Fetch.enable", {
        patterns: [
          { urlPattern: "http://*", requestStage: "Request" },
          { urlPattern: "https://*", requestStage: "Request" },
        ],
      });
      activePageGuards.add(page);
    })();
    guardedPages.set(page, installation);
    await installation;
  }

  async function handleGuardedWebSocket(socket: WebSocketRoute): Promise<void> {
    let parsed: URL;
    try {
      parsed = new URL(socket.url());
    } catch {
      await socket.close({ code: 1008, reason: "Blocked by browser network policy" });
      return;
    }

    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
      await socket.close({ code: 1008, reason: "Blocked by browser network policy" });
      return;
    }

    parsed.protocol = parsed.protocol === "wss:" ? "https:" : "http:";
    const validation = await checkGuardedUrl(parsed.href);
    if (!validation.ok) {
      await socket.close({ code: 1008, reason: "Blocked by browser network policy" });
      return;
    }

    socket.connectToServer();
  }

  async function ensureRequestGuard(page: Page): Promise<void> {
    const context = page.context();
    const existing = guardedContexts.get(context);
    if (existing) {
      await existing;
    } else {
      const installation = Promise.all([
        context.addInitScript({ content: FUTURE_DOCUMENT_NETWORK_LOCKDOWN_SCRIPT }),
        context.route("**/*", handleGuardedRequest),
        context.routeWebSocket("**/*", handleGuardedWebSocket),
      ]).then(() => undefined);
      guardedContexts.set(context, installation);
      await installation;
    }
    await ensurePageRequestGuard(page);
  }

  async function getGuardedPage(targetId?: string): Promise<Page> {
    const page = await getPage(cdpUrl(), targetId);
    ensurePageState(page);
    await ensureRequestGuard(page);
    return page;
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
      try {
        // Connect Playwright via CDP
        await createSession(cdpUrl());
        // Install the page and context guards before browser actions can trigger
        // network traffic. New targets without a page guard fail closed.
        await getGuardedPage();
      } catch (error) {
        running = null;
        await closeSession();
        await stopChrome(chrome);
        throw error;
      }
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

      // Validate direct BrowserService callers as well as the outer platform
      // tool. The persistent network guards independently validate actual
      // HTTP(S) requests, including every redirect hop and subresources.
      const validatedUrl = await validateNavigationTarget(url);
      const page = await getGuardedPage(params.targetId);

      await page.goto(validatedUrl, {
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
      const page = await getGuardedPage(params.targetId);
      return takeSnapshot(page, {
        interactive: params.interactive,
        maxDepth: params.maxDepth,
        compact: params.compact,
        selector: params.selector,
        maxChars: params.maxChars ?? config.snapshotMaxChars,
      });
    },

    async screenshot(params): Promise<ScreenshotResult> {
      const page = await getGuardedPage(params.targetId);
      return takeScreenshot(page, {
        fullPage: params.fullPage,
        ref: params.ref,
        element: params.element,
        type: params.type,
        quality: params.quality ?? config.screenshotQuality,
      });
    },

    async pdf(params): Promise<PdfResult> {
      const page = await getGuardedPage(params.targetId);
      return generatePdf(page);
    },

    async act(params): Promise<ActionResult> {
      const page = await getGuardedPage(params.targetId);
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
      const validatedUrl = await validateNavigationTarget(url);
      // Create the tab without an external navigation so its context can be
      // guarded before the first request or redirect leaves the browser.
      const { page, targetId } = await createNewPage(cdpUrl(), "about:blank");
      await ensureRequestGuard(page);
      if (validatedUrl !== "about:blank") {
        await page.goto(validatedUrl, {
          timeout: Math.max(1000, Math.min(120_000, config.timeoutMs ?? 20_000)),
        });
      }
      if (targetId) lastTargetId = targetId;
      return {
        targetId: targetId ?? "",
        title: await page.title().catch(() => ""),
        url: page.url(),
        type: "page",
      };
    },

    async focusTab(params): Promise<void> {
      const page = await getGuardedPage(params.targetId);
      await page.bringToFront();
      lastTargetId = params.targetId;
    },

    async closeTab(params): Promise<void> {
      const targetId = params.targetId ?? lastTargetId;
      if (!targetId) throw new Error("No tab to close (no targetId)");
      const page = await getGuardedPage(targetId);
      await page.close();
    },

    async console(params): Promise<ConsoleEntry[]> {
      const page = await getGuardedPage(params.targetId);
      const state = ensurePageState(page);
      const entries = state.console;
      if (!params.level) return [...entries];
      return entries.filter((e) => e.type === params.level);
    },
  };

  return service;
}
