// SPDX-License-Identifier: Apache-2.0
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { safePath } from "@comis/core";
import { createMediaRoutes } from "./media-routes.js";
import { createTokenStore } from "../auth/token-auth.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(`${os.tmpdir()}/comis-media-routes-test-`);
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

/**
 * Helper: write a file and its .meta sidecar to tmpDir.
 */
async function saveTestFile(
  id: string,
  content: Buffer | string,
  contentType: string,
): Promise<void> {
  const filePath = safePath(tmpDir, id);
  const metaPath = safePath(tmpDir, `${id}.meta`);
  const buf = typeof content === "string" ? Buffer.from(content) : content;
  const meta = { contentType, savedAt: Date.now(), size: buf.length };
  await fsp.writeFile(filePath, buf);
  await fsp.writeFile(metaPath, JSON.stringify(meta));
}

describe("createMediaRoutes", () => {
  it("GET /:id returns 200 with correct Content-Type for saved file", async () => {
    const app = createMediaRoutes({ mediaDir: tmpDir });
    const id = "test-image-001";
    const content = Buffer.from("fake-png-data");
    await saveTestFile(id, content, "image/png");

    const res = await app.request(`/${id}`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-length")).toBe(String(content.length));
    expect(res.headers.get("cache-control")).toBe("no-cache");

    const body = await res.arrayBuffer();
    expect(Buffer.from(body).toString()).toBe("fake-png-data");
  });

  it("GET /:id returns 404 for nonexistent file", async () => {
    const app = createMediaRoutes({ mediaDir: tmpDir });

    const res = await app.request("/nonexistent-id-xyz");

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("Not found");
  });

  it("GET /:id returns 400 for path traversal attempts", async () => {
    const app = createMediaRoutes({ mediaDir: tmpDir });

    const res = await app.request("/../../../etc/passwd");

    // Hono may normalize the URL; the handler should reject invalid IDs
    expect([400, 404]).toContain(res.status);
  });

  it("GET /:id with empty ID returns 400 or 404", async () => {
    const app = createMediaRoutes({ mediaDir: tmpDir });

    // Empty ID -- Hono won't match /:id with empty string, so this becomes
    // a root request which doesn't have a handler, returning 404
    const res = await app.request("/");
    expect([400, 404]).toContain(res.status);
  });

  it("GET /:id returns 410 when file is expired", async () => {
    const app = createMediaRoutes({ mediaDir: tmpDir, ttlMs: 0 });
    const id = "expired-file";
    await saveTestFile(id, "old-data", "text/plain");

    const res = await app.request(`/${id}`);

    expect(res.status).toBe(410);
    const json = await res.json();
    expect(json.error).toBe("Media expired");
  });

  it("GET /:id/meta returns JSON metadata", async () => {
    const app = createMediaRoutes({ mediaDir: tmpDir });
    const id = "meta-test-file";
    await saveTestFile(id, "some-content", "application/pdf");

    const res = await app.request(`/${id}/meta`);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.contentType).toBe("application/pdf");
    expect(json.size).toBe(12); // "some-content".length
    expect(json.savedAt).toBeGreaterThan(0);
  });

  it("GET /:id/meta returns 404 for nonexistent file", async () => {
    const app = createMediaRoutes({ mediaDir: tmpDir });

    const res = await app.request("/no-such-file/meta");

    expect(res.status).toBe(404);
  });

  it("GET /:id with special characters in ID returns 400", async () => {
    const app = createMediaRoutes({ mediaDir: tmpDir });

    // Slash in ID
    const res = await app.request("/foo%2Fbar");
    expect([400, 404]).toContain(res.status);
  });
});

// ---------------------------------------------------------------------------
// Bearer token auth
// ---------------------------------------------------------------------------

describe("createMediaRoutes - bearer token auth", () => {
  const TOKEN_SECRET = "test-media-token-padded-to-32ch";
  const tokenStore = createTokenStore([
    { id: "test", secret: TOKEN_SECRET, scopes: ["rpc"] },
  ]);

  it("returns 401 when Authorization header is missing", async () => {
    const app = createMediaRoutes({ mediaDir: tmpDir, tokenStore });
    const id = "auth-test-file";
    await saveTestFile(id, "secret-data", "text/plain");

    const res = await app.request(`/${id}`);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe("Unauthorized");
  });

  it("returns 401 with invalid bearer token", async () => {
    const app = createMediaRoutes({ mediaDir: tmpDir, tokenStore });
    const id = "auth-test-file-2";
    await saveTestFile(id, "secret-data", "text/plain");

    const res = await app.request(`/${id}`, {
      headers: { Authorization: "Bearer wrong-token-value-padded-32ch" },
    });
    expect(res.status).toBe(401);
  });

  it("returns 200 with valid bearer token in Authorization header", async () => {
    const app = createMediaRoutes({ mediaDir: tmpDir, tokenStore });
    const id = "auth-test-file-3";
    await saveTestFile(id, "secret-data", "text/plain");

    const res = await app.request(`/${id}`, {
      headers: { Authorization: `Bearer ${TOKEN_SECRET}` },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toBe("secret-data");
  });

  it("returns 200 with valid token in query parameter", async () => {
    const app = createMediaRoutes({ mediaDir: tmpDir, tokenStore });
    const id = "auth-test-file-4";
    await saveTestFile(id, "query-data", "text/plain");

    const res = await app.request(`/${id}?token=${TOKEN_SECRET}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toBe("query-data");
  });

  it("returns 401 on /meta route without auth", async () => {
    const app = createMediaRoutes({ mediaDir: tmpDir, tokenStore });
    const id = "meta-auth-file";
    await saveTestFile(id, "meta-data", "application/json");

    const res = await app.request(`/${id}/meta`);
    expect(res.status).toBe(401);
  });
});
