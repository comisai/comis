/**
 * BROWSER: Browser Automation Integration Tests
 *
 * Validates all 13 browser.* RPC methods through the running daemon's internal rpcCall:
 *   BROWSER-01: browser.start / browser.status
 *   BROWSER-02: browser.navigate
 *   BROWSER-03: browser.snapshot
 *   BROWSER-04: browser.screenshot
 *   BROWSER-05: browser.tabs / browser.open / browser.focus / browser.close
 *   BROWSER-06: browser.act
 *   BROWSER-07: browser.console
 *   BROWSER-08: browser.pdf
 *   BROWSER-09: browser.stop
 *
 * Tests run sequentially -- order matters (start -> use -> stop).
 * Chrome must be installed; suite is skipped if not found.
 *
 * Uses the daemon rpcCall pattern from Phase 33-02 (internal dispatch, not gateway WebSocket).
 *
 * All test pages are served via a local HTTP server (data: URLs are blocked by
 * the SSRF protocol guard; about:blank is too simple for content assertions).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import {
  startTestDaemon,
  type TestDaemonHandle,
} from "../support/daemon-harness.js";

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const BROWSER_CONFIG_PATH = resolve(
  __dirname,
  "../config/config.test-browser.yaml",
);

// ---------------------------------------------------------------------------
// Chrome detection (inline to avoid import issues with unexported function)
// ---------------------------------------------------------------------------

function chromeIsAvailable(): boolean {
  const platform = process.platform;
  if (platform === "darwin") {
    const candidates = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
    return candidates.some((p) => existsSync(p));
  }
  if (platform === "linux") {
    const candidates = [
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/snap/bin/chromium",
    ];
    return candidates.some((p) => existsSync(p));
  }
  return false;
}

const HAS_CHROME = chromeIsAvailable();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Type alias for the daemon's internal rpcCall function. */
type RpcCall = (
  method: string,
  params: Record<string, unknown>,
) => Promise<unknown>;

// ---------------------------------------------------------------------------
// Test page content (served via local HTTP server instead of data: URLs,
// which are blocked by the SSRF protocol guard)
// ---------------------------------------------------------------------------

const TEST_PAGES: Record<string, string> = {
  "/hello": "<html><head><title>Test Page</title></head><body><h1>Hello Browser</h1></body></html>",
  "/input": "<html><body><input type='text' id='test' autofocus></body></html>",
  "/console": "<html><body><script>console.log('test-log-message-12345')</script></body></html>",
  "/pdf": "<html><head><title>PDF Test</title></head><body><h1>PDF Content</h1><p>Test paragraph</p></body></html>",
};

function startTestHttpServer(): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const page = TEST_PAGES[req.url ?? "/"];
      if (page) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(page);
      } else {
        res.writeHead(404);
        res.end("Not Found");
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") return reject(new Error("Failed to bind"));
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_CHROME)(
  "BROWSER: Browser Automation Integration Tests",
  () => {
    let handle: TestDaemonHandle;
    let rpcCall: RpcCall;
    let navigatedTargetId: string | undefined;
    let newTabTargetId: string | undefined;
    let tabCountBefore: number;
    let testServer: Server;
    let testBaseUrl: string;

    beforeAll(async () => {
      // Start local HTTP server to serve test pages (data: URLs blocked by SSRF guard)
      const srv = await startTestHttpServer();
      testServer = srv.server;
      testBaseUrl = srv.baseUrl;

      handle = await startTestDaemon({ configPath: BROWSER_CONFIG_PATH });
      rpcCall = (handle.daemon as any).rpcCall as RpcCall;
    }, 120_000);

    afterAll(async () => {
      if (handle) {
        // Stop browser first (may already be stopped by the stop test)
        try {
          await rpcCall("browser.stop", {});
        } catch {
          // Ignore -- browser may already be stopped
        }

        // Clean up daemon
        try {
          await handle.cleanup();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!msg.includes("Daemon exit with code")) {
            throw err;
          }
        }
      }

      // Close the test HTTP server
      if (testServer) {
        testServer.close();
      }
    }, 60_000);

    // -----------------------------------------------------------------------
    // BROWSER-01: browser.start + browser.status
    // -----------------------------------------------------------------------

    it(
      "browser.start launches headless Chrome",
      async () => {
        const result = (await rpcCall("browser.start", {})) as Record<
          string,
          unknown
        >;
        expect(result.started).toBe(true);
      },
      60_000,
    );

    it(
      "browser.status reports running and connected after start",
      async () => {
        const status = (await rpcCall("browser.status", {})) as Record<
          string,
          unknown
        >;
        expect(status.running).toBe(true);
        expect(status.connected).toBe(true);
        expect(typeof status.cdpPort).toBe("number");
      },
      60_000,
    );

    // -----------------------------------------------------------------------
    // BROWSER-02: browser.navigate
    // -----------------------------------------------------------------------

    it(
      "browser.navigate loads a URL and returns url/title/targetId",
      async () => {
        const result = (await rpcCall("browser.navigate", {
          targetUrl: `${testBaseUrl}/hello`,
        })) as Record<string, unknown>;

        expect(result.url).toBeDefined();
        expect(String(result.url)).toContain("/hello");
        expect(typeof result.title).toBe("string");
        expect(typeof result.targetId).toBe("string");

        navigatedTargetId = result.targetId as string;
      },
      60_000,
    );

    // -----------------------------------------------------------------------
    // BROWSER-03: browser.snapshot
    // -----------------------------------------------------------------------

    it(
      "browser.snapshot returns an accessibility tree with content",
      async () => {
        const result = (await rpcCall("browser.snapshot", {})) as Record<
          string,
          unknown
        >;

        expect(result.snapshot).toBeDefined();
        expect(typeof result.snapshot).toBe("string");
        expect((result.snapshot as string).length).toBeGreaterThan(0);
        // The data URL page contains "Hello Browser" heading
        expect(result.snapshot as string).toContain("Hello Browser");
      },
      60_000,
    );

    // -----------------------------------------------------------------------
    // BROWSER-04: browser.screenshot
    // -----------------------------------------------------------------------

    it(
      "browser.screenshot captures a page image as base64 with mimeType",
      async () => {
        const result = (await rpcCall("browser.screenshot", {})) as Record<
          string,
          unknown
        >;

        expect(result.base64).toBeDefined();
        expect(typeof result.base64).toBe("string");
        expect((result.base64 as string).length).toBeGreaterThan(0);
        expect(result.mimeType).toBe("image/png");

        // Verify base64 is valid (only contains base64 chars)
        const b64 = result.base64 as string;
        expect(b64).toMatch(/^[A-Za-z0-9+/=]+$/);
      },
      60_000,
    );

    // -----------------------------------------------------------------------
    // BROWSER-05: browser.tabs / browser.open / browser.focus / browser.close
    // -----------------------------------------------------------------------

    it(
      "browser.tabs lists open tabs",
      async () => {
        const result = (await rpcCall("browser.tabs", {})) as Record<
          string,
          unknown
        >;

        expect(result.tabs).toBeDefined();
        expect(Array.isArray(result.tabs)).toBe(true);

        const tabs = result.tabs as Array<Record<string, unknown>>;
        expect(tabs.length).toBeGreaterThanOrEqual(1);

        // Each tab should have targetId, title, url, type
        for (const tab of tabs) {
          expect(typeof tab.targetId).toBe("string");
          expect(typeof tab.title).toBe("string");
          expect(typeof tab.url).toBe("string");
          expect(typeof tab.type).toBe("string");
        }

        tabCountBefore = tabs.length;
      },
      60_000,
    );

    it(
      "browser.open opens a new tab",
      async () => {
        const result = (await rpcCall("browser.open", {
          targetUrl: "about:blank",
        })) as Record<string, unknown>;

        expect(result.targetId).toBeDefined();
        expect(typeof result.targetId).toBe("string");
        expect(result.url).toBeDefined();
        expect(result.type).toBe("page");

        newTabTargetId = result.targetId as string;
      },
      60_000,
    );

    it(
      "browser.focus switches to a tab by targetId",
      async () => {
        expect(newTabTargetId).toBeDefined();

        const result = (await rpcCall("browser.focus", {
          targetId: newTabTargetId!,
        })) as Record<string, unknown>;

        expect(result.focused).toBe(true);
        expect(result.targetId).toBe(newTabTargetId);
      },
      60_000,
    );

    it(
      "browser.close closes a tab and reduces tab count",
      async () => {
        expect(newTabTargetId).toBeDefined();

        const result = (await rpcCall("browser.close", {
          targetId: newTabTargetId!,
        })) as Record<string, unknown>;

        expect(result.closed).toBe(true);

        // Verify tab count decreased
        const tabsResult = (await rpcCall("browser.tabs", {})) as Record<
          string,
          unknown
        >;
        const tabs = tabsResult.tabs as Array<Record<string, unknown>>;
        expect(tabs.length).toBe(tabCountBefore);
      },
      60_000,
    );

    // -----------------------------------------------------------------------
    // BROWSER-06: browser.act (press action - no ref needed)
    // -----------------------------------------------------------------------

    it(
      "browser.act performs a keyboard press interaction",
      async () => {
        // Navigate to an input page for a realistic test target
        await rpcCall("browser.navigate", {
          targetUrl: `${testBaseUrl}/input`,
        });

        // Small delay for page to render and autofocus
        await new Promise((r) => setTimeout(r, 1000));

        // Use press action (does not require element ref)
        const result = (await rpcCall("browser.act", {
          request: { kind: "press", key: "Tab" },
        })) as Record<string, unknown>;

        expect(result.ok).toBe(true);
        expect(result.action).toBe("press");
      },
      60_000,
    );

    // -----------------------------------------------------------------------
    // BROWSER-07: browser.console
    // -----------------------------------------------------------------------

    it(
      "browser.console returns console log entries from the page",
      async () => {
        // Navigate to a page that logs to console
        await rpcCall("browser.navigate", {
          targetUrl: `${testBaseUrl}/console`,
        });

        // Wait for script execution
        await new Promise((r) => setTimeout(r, 2000));

        const result = (await rpcCall("browser.console", {})) as Record<
          string,
          unknown
        >;

        expect(result.messages).toBeDefined();
        expect(Array.isArray(result.messages)).toBe(true);

        const messages = result.messages as Array<Record<string, unknown>>;
        // At least one message should contain our test string
        const hasTestMessage = messages.some((m) =>
          String(m.text ?? "").includes("test-log-message-12345"),
        );
        expect(hasTestMessage).toBe(true);
      },
      60_000,
    );

    // -----------------------------------------------------------------------
    // BROWSER-08: browser.pdf
    // -----------------------------------------------------------------------

    it(
      "browser.pdf generates a PDF document as base64 with mimeType",
      async () => {
        // Navigate to a page with content for PDF generation
        await rpcCall("browser.navigate", {
          targetUrl: `${testBaseUrl}/pdf`,
        });

        const result = (await rpcCall("browser.pdf", {})) as Record<
          string,
          unknown
        >;

        expect(result.base64).toBeDefined();
        expect(typeof result.base64).toBe("string");
        expect((result.base64 as string).length).toBeGreaterThan(0);
        expect(result.mimeType).toBe("application/pdf");

        // Verify PDF magic bytes: decode first few bytes and check for %PDF
        const decoded = Buffer.from(
          (result.base64 as string).slice(0, 20),
          "base64",
        ).toString("ascii");
        expect(decoded).toContain("%PDF");
      },
      60_000,
    );

    // -----------------------------------------------------------------------
    // BROWSER-09: browser.stop
    // -----------------------------------------------------------------------

    it(
      "browser.stop shuts down Chrome cleanly",
      async () => {
        const result = (await rpcCall("browser.stop", {})) as Record<
          string,
          unknown
        >;

        expect(result.stopped).toBe(true);
      },
      60_000,
    );

    it(
      "browser.status reports not running after stop",
      async () => {
        const status = (await rpcCall("browser.status", {})) as Record<
          string,
          unknown
        >;

        expect(status.running).toBe(false);
        expect(status.connected).toBe(false);
      },
      60_000,
    );
  },
);
