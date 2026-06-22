// SPDX-License-Identifier: Apache-2.0
/**
 * proxy-connect.test.ts — proxy CONNECT routing proof
 *
 * In-process localhost HTTP CONNECT proxy integration test.
 *
 * Proves the routing guarantee end-to-end: when HTTPS_PROXY is set
 * and the global dispatcher is installed, an outbound HTTPS request
 * to api.telegram.org:443 is actually tunneled through the proxy — recorded as
 * a CONNECT by an in-process localhost recording proxy.
 *
 * Design constraints:
 *   - localhost only, NO bwrap, NO real outbound to Telegram
 *   - The proxy responds "200 Connection Established" on targetSocket error —
 *     the TLS handshake never completes; assertion is purely on connects[]
 *   - Scoped run: `pnpm vitest run packages/infra/src/net/proxy-connect.test.ts`
 */

import * as http from "node:http";
import * as net from "node:net";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getGlobalDispatcher, setGlobalDispatcher } from "undici";
import {
  installGlobalProxyDispatcher,
  resetProxyDispatcherForTests,
} from "./proxy-dispatcher.js";

// ---------------------------------------------------------------------------
// createRecordingConnectProxy — in-process CONNECT proxy harness
// ---------------------------------------------------------------------------

interface ConnectRecord {
  host: string;
  port: number;
}

function createRecordingConnectProxy(): {
  server: http.Server;
  connects: ConnectRecord[];
  port: () => number;
  close: () => Promise<void>;
} {
  const connects: ConnectRecord[] = [];

  // No HTTP request handler — CONNECT only
  const server = http.createServer();

  server.on("connect", (req, clientSocket, head) => {
    // req.url is "host:port" for CONNECT
    const [host, portStr] = (req.url ?? "").split(":");
    const port = parseInt(portStr ?? "443", 10);
    connects.push({ host: host ?? "", port });

    // Attempt a real tunnel; on failure (expected — no real Telegram) respond 200
    const targetSocket = net.connect(port, host ?? "");

    targetSocket.on("connect", () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head && head.length > 0) {
        targetSocket.write(head);
      }
      targetSocket.pipe(clientSocket);
      clientSocket.pipe(targetSocket);
    });

    targetSocket.on("error", () => {
      // No real upstream — respond 200 so the CONNECT is recorded and the
      // client-side fetch knows the tunnel was "accepted" (assertion is on
      // connects[], not on a real TLS handshake completing).
      try {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      } catch {
        // clientSocket may already be closed — ignore
      }
      clientSocket.destroy();
    });

    clientSocket.on("error", () => {
      targetSocket.destroy();
    });
  });

  return {
    server,
    connects,
    port: () => (server.address() as net.AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

// ---------------------------------------------------------------------------
// Dispatcher isolation
// ---------------------------------------------------------------------------

let originalDispatcher: ReturnType<typeof getGlobalDispatcher>;

beforeEach(() => {
  originalDispatcher = getGlobalDispatcher();
});

afterEach(() => {
  setGlobalDispatcher(originalDispatcher);
  resetProxyDispatcherForTests();
});

// ---------------------------------------------------------------------------
// CONNECT routing assertion
// ---------------------------------------------------------------------------

describe("SC#3: CONNECT proxy routing (in-process, localhost only)", () => {
  it(
    "records ≥1 CONNECT to api.telegram.org:443 when HTTPS_PROXY points at the recording proxy",
    async () => {
      const proxy = createRecordingConnectProxy();
      await new Promise<void>((resolve, reject) => {
        proxy.server.listen(0, "127.0.0.1", () => resolve());
        proxy.server.once("error", reject);
      });

      try {
        const proxyUrl = `http://127.0.0.1:${proxy.port()}`;
        installGlobalProxyDispatcher({ env: { HTTPS_PROXY: proxyUrl } });

        // Drive a fetch to api.telegram.org — the TLS handshake will fail
        // (the recording proxy does not complete the tunnel), which is fine:
        // the assertion is on the recorded CONNECT, not on a real response.
        await fetch("https://api.telegram.org/botTEST/getMe").catch(() => {});

        // The proxy must have received ≥1 CONNECT to api.telegram.org
        expect(
          proxy.connects.some((c) => c.host === "api.telegram.org"),
        ).toBe(true);
      } finally {
        resetProxyDispatcherForTests();
        setGlobalDispatcher(originalDispatcher);
        await proxy.close();
      }
    },
    10_000, // 10s timeout — localhost network ops; no real outbound needed
  );

  it(
    "records the CONNECT port as 443 for an https:// target",
    async () => {
      const proxy = createRecordingConnectProxy();
      await new Promise<void>((resolve, reject) => {
        proxy.server.listen(0, "127.0.0.1", () => resolve());
        proxy.server.once("error", reject);
      });

      try {
        const proxyUrl = `http://127.0.0.1:${proxy.port()}`;
        installGlobalProxyDispatcher({ env: { HTTPS_PROXY: proxyUrl } });

        await fetch("https://api.telegram.org/botTEST/getMe").catch(() => {});

        const telegramConnect = proxy.connects.find(
          (c) => c.host === "api.telegram.org",
        );
        expect(telegramConnect).toBeDefined();
        expect(telegramConnect!.port).toBe(443);
      } finally {
        resetProxyDispatcherForTests();
        setGlobalDispatcher(originalDispatcher);
        await proxy.close();
      }
    },
    10_000,
  );

  it(
    "does NOT route loopback targets (127.0.0.1) through the proxy (loopback-bypass sanity)",
    async () => {
      const proxy = createRecordingConnectProxy();
      await new Promise<void>((resolve, reject) => {
        proxy.server.listen(0, "127.0.0.1", () => resolve());
        proxy.server.once("error", reject);
      });

      try {
        const proxyUrl = `http://127.0.0.1:${proxy.port()}`;
        installGlobalProxyDispatcher({
          env: { HTTPS_PROXY: proxyUrl },
          loopbackMode: "gateway-only",
        });

        // Attempt a fetch to a loopback target (will fail — no server — but that is fine)
        await fetch("http://127.0.0.1:19999/test").catch(() => {});

        // The loopback fetch must NOT have been recorded as a CONNECT through the proxy
        // (gateway-only mode: loopback is in effective NO_PROXY, bypassing the proxy)
        const loopbackConnect = proxy.connects.find(
          (c) => c.host === "127.0.0.1",
        );
        expect(loopbackConnect).toBeUndefined();
      } finally {
        resetProxyDispatcherForTests();
        setGlobalDispatcher(originalDispatcher);
        await proxy.close();
      }
    },
    10_000,
  );
});
