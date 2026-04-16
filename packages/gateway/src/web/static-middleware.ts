import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";

/**
 * Create static file serving middleware for the web dashboard SPA.
 *
 * Serves pre-built Vite assets from the specified dist directory.
 * Implements SPA fallback: unmatched routes under /app/* are served
 * index.html so client-side routing works.
 *
 * @param webDistPath - Absolute or relative path to @comis/web dist directory
 * @param tlsEnabled - When true, adds Strict-Transport-Security header (HSTS)
 * @returns Hono app to mount on the gateway
 */
export function createStaticMiddleware(webDistPath: string, tlsEnabled?: boolean): Hono {
  const app = new Hono();

  // Security headers for all dashboard responses; HSTS header when TLS is active
  app.use(
    "/app/*",
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"], // Lit components use inline styles
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'", "ws:", "wss:"], // WebSocket connections
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
      xFrameOptions: "DENY",
      xContentTypeOptions: "nosniff",
      referrerPolicy: "strict-origin-when-cross-origin",
      // Only send HSTS when TLS is active; suppress in dev/HTTP mode
      strictTransportSecurity: tlsEnabled
        ? "max-age=31536000; includeSubDomains"   // 1 year
        : false,
    }),
  );

  // Hashed assets (immutable) — cache for 1 year
  app.use(
    "/app/assets/*",
    async (c, next) => {
      await next();
      if (c.res.status === 200) {
        c.res.headers.set("Cache-Control", "public, max-age=31536000, immutable");
      }
    },
  );

  // Serve static assets from the web dist directory
  app.use(
    "/app/*",
    serveStatic({
      root: webDistPath,
      rewriteRequestPath: (path) => path.replace(/^\/app/, ""),
    }),
  );

  // SPA fallback: serve index.html for unmatched /app routes (no-cache so rebuilds take effect)
  app.get("/app/*", async (c, next) => {
    await next();
    if (c.res.status === 200 && c.res.headers.get("content-type")?.includes("html")) {
      c.res.headers.set("Cache-Control", "no-cache");
    }
  });
  app.get("/app/*", serveStatic({ root: webDistPath, path: "index.html" }));

  return app;
}
