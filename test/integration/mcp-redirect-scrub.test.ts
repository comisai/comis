// SPDX-License-Identifier: Apache-2.0
/**
 * Cross-origin redirect header scrub.
 *
 * Stands up two `node:http` servers on different 127.0.0.1 ports (different
 * hosts in URL.host sense, since URL.host includes the port) and asserts:
 *   - Cross-host redirect strips Authorization, Cookie, Proxy-Authorization
 *     from the second-hop request.
 *   - Same-host redirect (path /a → /b on the same port) preserves
 *     Authorization through the second-hop request.
 *   - Same-host http→https upgrade preserves Authorization (synthesised via
 *     a mocked baseFetch since spinning up a real HTTPS server is overkill).
 *   - Redirect chain exceeding 20 hops throws the bracketed
 *     `[max_redirects_exceeded]` error.
 *
 * Per CLAUDE.md: integration tests import from `dist/`; this file relies on
 * `pnpm build` having run for `@comis/skills` before vitest executes.
 *
 * @module
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createRedirectPolicyFetch } from "@comis/skills";
import { ok } from "@comis/shared";

/**
 * Both test servers bind 127.0.0.1, which the default cross-host SSRF guard
 * (core `validateUrl`) rightly blocks. These tests exercise the header-scrub
 * policy, not the SSRF guard, so inject the same permissive validator the
 * co-located unit tests use (mcp-client-redirect-policy.test.ts).
 */
const allowAllSsrf = async () => ok<unknown>(undefined);

interface CapturedRequest {
  url: string;
  headers: Record<string, string | string[] | undefined>;
}

function startTestHttpServer(
  handler: (
    req: IncomingMessage,
    res: ServerResponse,
    captured: CapturedRequest[],
  ) => void,
  captured: CapturedRequest[],
): Promise<{ server: Server; baseUrl: string; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => handler(req, res, captured));
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        return reject(new Error("Failed to bind test http server"));
      }
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${addr.port}`,
        port: addr.port,
      });
    });
  });
}

function shutdownServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("MCP redirect scrub — cross-host header policy", () => {
  let serverA: { server: Server; baseUrl: string; port: number } | undefined;
  let serverB: { server: Server; baseUrl: string; port: number } | undefined;
  let capturedA: CapturedRequest[];
  let capturedB: CapturedRequest[];

  beforeEach(() => {
    capturedA = [];
    capturedB = [];
    serverA = undefined;
    serverB = undefined;
  });

  afterEach(async () => {
    if (serverA?.server) await shutdownServer(serverA.server);
    if (serverB?.server) await shutdownServer(serverB.server);
  });

  it("cross-host redirect strips Authorization header before second-hop request", async () => {
    serverB = await startTestHttpServer((req, res, captured) => {
      captured.push({
        url: req.url ?? "",
        headers: { ...req.headers } as Record<string, string | string[] | undefined>,
      });
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    }, capturedB);

    serverA = await startTestHttpServer(
      (req, res) => {
        res.writeHead(302, { location: serverB!.baseUrl });
        res.end();
      },
      capturedA,
    );

    const wrappedFetch = createRedirectPolicyFetch({
      maxRedirections: 20,
      validateRedirectTarget: allowAllSsrf,
    });
    await wrappedFetch(serverA.baseUrl, {
      headers: {
        authorization: "Bearer secret-token",
        cookie: "session=abc",
        "proxy-authorization": "Basic xyz",
      },
    });

    expect(capturedB).toHaveLength(1);
    expect(capturedB[0]!.headers.authorization).toBeUndefined();
    expect(capturedB[0]!.headers.cookie).toBeUndefined();
    expect(capturedB[0]!.headers["proxy-authorization"]).toBeUndefined();
  });

  it("default SSRF guard refuses a cross-host redirect to a loopback address", async () => {
    serverB = await startTestHttpServer((req, res, captured) => {
      captured.push({
        url: req.url ?? "",
        headers: { ...req.headers } as Record<string, string | string[] | undefined>,
      });
      res.writeHead(200);
      res.end("ok");
    }, capturedB);

    serverA = await startTestHttpServer(
      (req, res) => {
        res.writeHead(302, { location: serverB!.baseUrl });
        res.end();
      },
      capturedA,
    );

    const wrappedFetch = createRedirectPolicyFetch({ maxRedirections: 20 });
    await expect(wrappedFetch(serverA.baseUrl, {})).rejects.toThrow(
      /\[redirect_blocked_ssrf\]/,
    );
    expect(capturedB).toHaveLength(0);
  });

  it("same-host redirect preserves Authorization header through second-hop request", async () => {
    const captured: CapturedRequest[] = [];
    serverA = await startTestHttpServer((req, res, capturedList) => {
      if (req.url === "/a") {
        res.writeHead(302, { location: "/b" });
        res.end();
      } else {
        capturedList.push({
          url: req.url ?? "",
          headers: { ...req.headers } as Record<string, string | string[] | undefined>,
        });
        res.writeHead(200);
        res.end("ok");
      }
    }, captured);

    const wrappedFetch = createRedirectPolicyFetch({ maxRedirections: 20 });
    await wrappedFetch(`${serverA.baseUrl}/a`, {
      headers: { authorization: "Bearer kept-token" },
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]!.headers.authorization).toBe("Bearer kept-token");
  });

  it("same-host http to https upgrade preserves Authorization header through redirect", async () => {
    // Synthesised via mocked baseFetch; spinning a real HTTPS server is overkill.
    const baseFetch = vi.fn();
    const httpResponse = {
      status: 302,
      headers: new Headers({ location: "https://api.example.com/v2" }),
      ok: false,
    } as unknown as Response;
    const httpsResponse = {
      status: 200,
      headers: new Headers(),
      ok: true,
    } as unknown as Response;
    baseFetch
      .mockResolvedValueOnce(httpResponse)
      .mockResolvedValueOnce(httpsResponse);

    const wrappedFetch = createRedirectPolicyFetch({
      maxRedirections: 20,
      baseFetch: baseFetch as unknown as typeof fetch,
    });
    await wrappedFetch("http://api.example.com/v1", {
      headers: { authorization: "Bearer upgrade-token" },
    });

    const secondCallArgs = baseFetch.mock.calls[1];
    expect(secondCallArgs).toBeDefined();
    const secondInit = secondCallArgs![1] as RequestInit;
    const secondHeaders = new Headers(secondInit.headers as HeadersInit);
    expect(secondHeaders.get("authorization")).toBe("Bearer upgrade-token");
  });

  it("redirect chain exceeding 20 hops throws max_redirects_exceeded bracketed error", async () => {
    const baseFetch = vi.fn().mockImplementation((url: unknown) => {
      const u = new URL(
        typeof url === "string" ? url : (url as URL).toString(),
      );
      const next = new URL(u.toString());
      next.pathname = `${u.pathname}/x`;
      return Promise.resolve({
        status: 302,
        headers: new Headers({ location: next.toString() }),
        ok: false,
      } as unknown as Response);
    });

    const wrappedFetch = createRedirectPolicyFetch({
      maxRedirections: 20,
      baseFetch: baseFetch as unknown as typeof fetch,
    });
    await expect(
      wrappedFetch("http://api.example.com/start", {}),
    ).rejects.toThrow(/\[max_redirects_exceeded\]/);
  });
});
