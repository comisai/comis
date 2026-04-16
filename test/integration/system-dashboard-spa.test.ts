/**
 * System Dashboard SPA Integration Tests
 *
 * Covers Phase 16 from the comprehensive system test plan:
 *
 *   SPA-01: Root redirect (GET / -> /app/)
 *   SPA-02: Dashboard HTML (GET /app/ serves index.html)
 *   SPA-03: SPA fallback (GET /app/chat/session-123 serves index.html)
 *   SPA-04: Security headers present on /app/* routes
 *
 * Requires the @comis/web package to be built (dist/index.html must exist).
 *
 * @module
 */

import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  startTestDaemon,
  type TestDaemonHandle,
} from "../support/daemon-harness.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_PATH = resolve(__dirname, "../config/config.test-system-dashboard.yaml");

// Check if web dist is available (built via pnpm build)
const WEB_DIST_PATH = resolve(__dirname, "../../packages/web/dist");
const webDistAvailable = existsSync(resolve(WEB_DIST_PATH, "index.html"));

describe.skipIf(!webDistAvailable)(
  "System Dashboard SPA (Phase 16)",
  () => {
    let handle: TestDaemonHandle;
    let gatewayUrl: string;

    beforeAll(async () => {
      handle = await startTestDaemon({ configPath: CONFIG_PATH });
      gatewayUrl = handle.gatewayUrl;
    }, 60_000);

    afterAll(async () => {
      if (handle) {
        try {
          await handle.cleanup();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!msg.includes("Daemon exit with code")) {
            throw err;
          }
        }
      }
    }, 30_000);

    // -----------------------------------------------------------------------
    // SPA-01: Root Redirect
    // -----------------------------------------------------------------------

    it("SPA-01: GET / redirects to /app/", async () => {
      const response = await fetch(`${gatewayUrl}/`, {
        redirect: "manual",
      });

      // Should be a redirect (302)
      expect(response.status).toBe(302);

      const location = response.headers.get("location");
      expect(location).toBe("/app/");
    });

    // -----------------------------------------------------------------------
    // SPA-02: Dashboard HTML
    // -----------------------------------------------------------------------

    it("SPA-02: GET /app/ serves HTML content", async () => {
      const response = await fetch(`${gatewayUrl}/app/`);

      expect(response.status).toBe(200);

      const text = await response.text();
      // Should contain HTML (could be <!DOCTYPE html> or <html>)
      expect(text.toLowerCase()).toContain("<!doctype html");
    });

    it("SPA-02b: GET /app/index.html returns 200", async () => {
      const response = await fetch(`${gatewayUrl}/app/index.html`);
      expect(response.status).toBe(200);
    });

    // -----------------------------------------------------------------------
    // SPA-03: SPA Fallback
    // -----------------------------------------------------------------------

    it("SPA-03: deep SPA route /app/chat/session-123 serves index.html (SPA fallback)", async () => {
      const response = await fetch(`${gatewayUrl}/app/chat/session-123`);

      // SPA fallback should serve index.html with 200
      expect(response.status).toBe(200);

      const text = await response.text();
      expect(text.toLowerCase()).toContain("<!doctype html");
    });

    it("SPA-03b: deep SPA route /app/settings/profile serves index.html", async () => {
      const response = await fetch(`${gatewayUrl}/app/settings/profile`);

      expect(response.status).toBe(200);

      const text = await response.text();
      expect(text.toLowerCase()).toContain("<!doctype html");
    });

    // -----------------------------------------------------------------------
    // SPA-04: Security Headers
    // -----------------------------------------------------------------------

    it("SPA-04: /app/ responses include security headers", async () => {
      const response = await fetch(`${gatewayUrl}/app/`);
      expect(response.status).toBe(200);

      // Content-Security-Policy should be present
      const csp = response.headers.get("content-security-policy");
      expect(csp).toBeDefined();
      expect(csp).toContain("default-src");

      // X-Frame-Options should be DENY
      const xFrameOptions = response.headers.get("x-frame-options");
      expect(xFrameOptions).toBe("DENY");

      // X-Content-Type-Options should be nosniff
      const xContentType = response.headers.get("x-content-type-options");
      expect(xContentType).toBe("nosniff");
    });
  },
);
