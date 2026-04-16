import { describe, it, expect } from "vitest";
import { createStaticMiddleware } from "./static-middleware.js";

describe("static-middleware security headers", () => {
  /**
   * The web dashboard must serve security headers on all /app/* responses.
   *
   * We test by sending a request to /app/index.html and checking the
   * response headers. Since serveStatic won't find real files in tests,
   * we verify via the middleware pipeline that secureHeaders is applied.
   */

  it("includes Content-Security-Policy header on /app/* responses", async () => {
    const app = createStaticMiddleware("/nonexistent/dist");

    const res = await app.request("/app/index.html");

    // Even if the file is not found, the security headers middleware
    // should have set headers on the response
    const csp = res.headers.get("content-security-policy");
    expect(csp).toBeTruthy();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("includes X-Frame-Options: DENY header", async () => {
    const app = createStaticMiddleware("/nonexistent/dist");

    const res = await app.request("/app/index.html");

    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  it("includes X-Content-Type-Options: nosniff header", async () => {
    const app = createStaticMiddleware("/nonexistent/dist");

    const res = await app.request("/app/index.html");

    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("includes Referrer-Policy header", async () => {
    const app = createStaticMiddleware("/nonexistent/dist");

    const res = await app.request("/app/index.html");

    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
  });

  it("includes Strict-Transport-Security header when tlsEnabled is true", async () => {
    const app = createStaticMiddleware("/nonexistent/dist", true);

    const res = await app.request("/app/index.html");

    const hsts = res.headers.get("strict-transport-security");
    expect(hsts).toBeTruthy();
    expect(hsts).toContain("max-age=31536000");
    expect(hsts).toContain("includeSubDomains");
  });

  it("does NOT include Strict-Transport-Security header when tlsEnabled is false", async () => {
    const app = createStaticMiddleware("/nonexistent/dist", false);

    const res = await app.request("/app/index.html");

    expect(res.headers.get("strict-transport-security")).toBeNull();
  });

  it("does NOT include Strict-Transport-Security header when tlsEnabled is omitted", async () => {
    const app = createStaticMiddleware("/nonexistent/dist");

    const res = await app.request("/app/index.html");

    expect(res.headers.get("strict-transport-security")).toBeNull();
  });
});
