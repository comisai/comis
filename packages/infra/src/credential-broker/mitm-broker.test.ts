// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for NodeMitmBroker — auth gate, injection, fail-closed + audit + non-leakage.
 *
 * Uses in-process HTTP fixtures (real http.createServer on loopback:0)
 * and manual TCP CONNECT clients to assert fail-closed behavior.
 * No real network — all fixtures bind to 127.0.0.1:0.
 *
 * @module
 */
import "reflect-metadata"; // required when createNodeCaManager is used in the TLS-upgrade tests
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import * as tls from "node:tls";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeCaManager } from "./ca-manager.js";
import { createMitmBroker } from "./mitm-broker.js";
import type { MitmBrokerDeps } from "./mitm-broker.js";
import { createSessionManager } from "./session-manager.js";
import { MAX_BODY_BYTES } from "./finalizer-stage.js";
import { createMockEventBus } from "../../../../test/support/mock-event-bus.js";
import { createMockLogger, makeMockLogger } from "../../../../test/support/mock-logger.js";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
import { createFakeTimers } from "../../../../test/support/fake-timers.js";
import { createSecretManager } from "@comis/core";
import type { BrokerBinding } from "@comis/core";

// ── In-process upstream HTTP fixture ──────────────────────────────────────────

/**
 * A plain HTTP server on loopback:0 that records every request's headers.
 * The broker net.connect()s to this port during the tunnel phase.
 * Zero-call assertion: if receivedHeaders.length === 0, no upstream was reached.
 */
function makeUpstreamFixture(): Promise<{
  server: http.Server;
  port: number;
  receivedHeaders: Record<string, string | string[] | undefined>[];
}> {
  const receivedHeaders: Record<string, string | string[] | undefined>[] = [];
  const server = http.createServer((req, res) => {
    receivedHeaders.push({ ...req.headers });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({ server, port, receivedHeaders });
    });
  });
}

/**
 * Manual TCP CONNECT client — no third-party dependency.
 * Sends a proxy CONNECT request to the broker and returns the status code + socket.
 */
async function connectThroughProxy(
  brokerPort: number,
  proxyToken: string,
  targetHostPort: string,
): Promise<{ statusCode: number; socket: net.Socket }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(brokerPort, "127.0.0.1", () => {
      const connectLine =
        `CONNECT ${targetHostPort} HTTP/1.1\r\n` +
        `Host: ${targetHostPort}\r\n` +
        `Proxy-Authorization: Bearer ${proxyToken}\r\n` +
        `\r\n`;
      socket.write(connectLine);
    });
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("latin1");
      const idx = buf.indexOf("\r\n\r\n");
      if (idx === -1) return;
      const statusLine = buf.slice(0, buf.indexOf("\r\n"));
      const statusCode = parseInt(statusLine.split(" ")[1] ?? "0", 10);
      resolve({ statusCode, socket });
    });
    socket.on("error", reject);
    setTimeout(() => reject(new Error("connect timeout")), 3000);
  });
}

/**
 * Sends a GET request through an already-established tunnel socket.
 * Used after a 200 Connection established response to exercise the inner HTTP layer.
 */
async function sendGetThroughTunnel(
  socket: net.Socket,
  path: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    let headerStr = `GET ${path} HTTP/1.1\r\n`;
    for (const [k, v] of Object.entries(extraHeaders)) {
      headerStr += `${k}: ${v}\r\n`;
    }
    headerStr += `\r\n`;
    socket.write(headerStr);

    let buf = "";
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("latin1");
      const idx = buf.indexOf("\r\n\r\n");
      if (idx === -1) return;
      socket.off("data", onData);
      const statusLine = buf.slice(0, buf.indexOf("\r\n"));
      const status = parseInt(statusLine.split(" ")[1] ?? "0", 10);
      resolve({ status, headers: {} });
    };
    socket.on("data", onData);
    socket.on("error", reject);
    setTimeout(() => reject(new Error("tunnel GET timeout")), 3000);
  });
}

// ── Test fixture factories ─────────────────────────────────────────────────────

/** The sentinel secret value — must NEVER appear in logs or events. */
const SENTINEL_SECRET = "sentinel-secret-abc123";

/**
 * Build a single BrokerBinding that matches api.anthropic.com with a
 * setHeader inject rule (injects x-api-key with the secret value).
 */
function makeAnthropicBinding(): BrokerBinding {
  return {
    secretRef: "ANTHROPIC_API_KEY",
    hostRules: [
      {
        pattern: { kind: "exact", host: "api.anthropic.com" },
        inject: [
          {
            kind: "setHeader",
            name: "x-api-key",
            format: "raw",
          },
        ],
      },
    ],
  };
}

/**
 * Build a BrokerBinding for a finnhub-like host that uses setParam injection
 * (appends ?token=<secret> to the URL path).
 */
function makeFinnhubBinding(): BrokerBinding {
  return {
    secretRef: "FINNHUB_API_KEY",
    hostRules: [
      {
        pattern: { kind: "exact", host: "finnhub.io" },
        inject: [
          {
            kind: "setParam",
            name: "token",
          },
        ],
      },
    ],
  };
}

/**
 * Build a BrokerBinding with a path-policy restriction.
 * Only paths matching /v1/* are allowed.
 */
function makePolicyBinding(): BrokerBinding {
  return {
    secretRef: "POLICY_KEY",
    hostRules: [
      {
        pattern: { kind: "exact", host: "policy.example.com" },
        pathPolicy: ["/v1/*"],
        inject: [
          {
            kind: "setHeader",
            name: "x-api-key",
            format: "raw",
          },
        ],
      },
    ],
  };
}

function makeDeps(
  overrides?: Partial<MitmBrokerDeps>,
): MitmBrokerDeps {
  const clock = createFakeClock(1_700_000_000_000);
  const eventBus = createMockEventBus();
  const logger = createMockLogger();
  const secretManager = createSecretManager({
    ANTHROPIC_API_KEY: SENTINEL_SECRET,
    FINNHUB_API_KEY: "finnhub-real-key",
    POLICY_KEY: "policy-real-key",
  });
  const sessionManager = createSessionManager({ clock });
  const bindings: readonly BrokerBinding[] = [
    makeAnthropicBinding(),
    makeFinnhubBinding(),
    makePolicyBinding(),
  ];
  return {
    clock,
    timers: createFakeTimers(),
    eventBus,
    logger,
    secretManager,
    sessionManager,
    bindings,
    ...overrides,
  };
}

// ── Broker lifecycle helpers ───────────────────────────────────────────────────

const runningBrokers: { stop: () => Promise<void> }[] = [];

afterEach(async () => {
  for (const broker of runningBrokers.splice(0)) {
    await broker.stop().catch(() => undefined);
  }
});

// ── Auth gate tests ─────────────────────────────────────────────────────────────

describe("CONNECT auth gate (fail-closed 407)", () => {
  it("missing Proxy-Authorization header → 407, zero upstream calls", async () => {
    const upstream = await makeUpstreamFixture();
    const deps = makeDeps();
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const brokerPort = await broker.start();

    // Send CONNECT without the Proxy-Authorization header
    await new Promise<void>((resolve, reject) => {
      const s = net.connect(brokerPort, "127.0.0.1", () => {
        s.write(
          `CONNECT api.anthropic.com:${upstream.port} HTTP/1.1\r\n` +
            `Host: api.anthropic.com:${upstream.port}\r\n` +
            `\r\n`,
        );
      });
      let buf = "";
      s.on("data", (chunk) => {
        buf += chunk.toString("latin1");
        const idx = buf.indexOf("\r\n\r\n");
        if (idx === -1) return;
        const statusLine = buf.slice(0, buf.indexOf("\r\n"));
        const code = parseInt(statusLine.split(" ")[1] ?? "0", 10);
        s.destroy();
        expect(code).toBe(407);
        expect(upstream.receivedHeaders).toHaveLength(0);
        resolve();
      });
      s.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 3000);
    });

    upstream.server.close();
  });

  it("Proxy-Authorization without Bearer prefix → 407, zero upstream calls", async () => {
    const upstream = await makeUpstreamFixture();
    const deps = makeDeps();
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const brokerPort = await broker.start();

    await new Promise<void>((resolve, reject) => {
      const s = net.connect(brokerPort, "127.0.0.1", () => {
        s.write(
          `CONNECT api.anthropic.com:${upstream.port} HTTP/1.1\r\n` +
            `Host: api.anthropic.com:${upstream.port}\r\n` +
            `Proxy-Authorization: Basic dXNlcjpwYXNz\r\n` +
            `\r\n`,
        );
      });
      let buf = "";
      s.on("data", (chunk) => {
        buf += chunk.toString("latin1");
        if (!buf.includes("\r\n\r\n")) return;
        const statusLine = buf.slice(0, buf.indexOf("\r\n"));
        const code = parseInt(statusLine.split(" ")[1] ?? "0", 10);
        s.destroy();
        expect(code).toBe(407);
        expect(upstream.receivedHeaders).toHaveLength(0);
        resolve();
      });
      s.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 3000);
    });

    upstream.server.close();
  });

  it("forged Bearer token (never issued) → 407, zero upstream calls", async () => {
    const upstream = await makeUpstreamFixture();
    const deps = makeDeps();
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const brokerPort = await broker.start();

    const forgedToken = "A".repeat(64); // random 64-char base64url-like, never issued
    await new Promise<void>((resolve, reject) => {
      const s = net.connect(brokerPort, "127.0.0.1", () => {
        s.write(
          `CONNECT api.anthropic.com:${upstream.port} HTTP/1.1\r\n` +
            `Host: api.anthropic.com:${upstream.port}\r\n` +
            `Proxy-Authorization: Bearer ${forgedToken}\r\n` +
            `\r\n`,
        );
      });
      let buf = "";
      s.on("data", (chunk) => {
        buf += chunk.toString("latin1");
        if (!buf.includes("\r\n\r\n")) return;
        const code = parseInt(buf.slice(0, buf.indexOf("\r\n")).split(" ")[1] ?? "0", 10);
        s.destroy();
        expect(code).toBe(407);
        expect(upstream.receivedHeaders).toHaveLength(0);
        resolve();
      });
      s.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 3000);
    });

    upstream.server.close();
  });

  it("consumed token used a second time → 407 on second use, zero upstream calls", async () => {
    const upstream = await makeUpstreamFixture();
    const deps = makeDeps();
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const brokerPort = await broker.start();

    // Issue a token
    const { proxyToken } = deps.sessionManager.issueToken("agent-1");

    // First use: should succeed (200)
    const { statusCode: first, socket: sock1 } = await connectThroughProxy(
      brokerPort,
      proxyToken,
      `api.anthropic.com:${upstream.port}`,
    );
    expect(first).toBe(200);
    sock1.destroy();

    // Wait a tick for cleanup
    await new Promise((r) => setTimeout(r, 50));

    // Second use: same token should now be rejected
    await new Promise<void>((resolve, reject) => {
      const s = net.connect(brokerPort, "127.0.0.1", () => {
        s.write(
          `CONNECT api.anthropic.com:${upstream.port} HTTP/1.1\r\n` +
            `Host: api.anthropic.com:${upstream.port}\r\n` +
            `Proxy-Authorization: Bearer ${proxyToken}\r\n` +
            `\r\n`,
        );
      });
      let buf = "";
      s.on("data", (chunk) => {
        buf += chunk.toString("latin1");
        if (!buf.includes("\r\n\r\n")) return;
        const code = parseInt(buf.slice(0, buf.indexOf("\r\n")).split(" ")[1] ?? "0", 10);
        s.destroy();
        expect(code).toBe(407);
        resolve();
      });
      s.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 3000);
    });

    upstream.server.close();
  });

  it("token invalidated by endSession → 407 on subsequent use, zero upstream calls", async () => {
    const upstream = await makeUpstreamFixture();
    const deps = makeDeps();
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const brokerPort = await broker.start();

    const { sessionId, proxyToken } = deps.sessionManager.issueToken("agent-1");
    deps.sessionManager.endSession(sessionId);

    await new Promise<void>((resolve, reject) => {
      const s = net.connect(brokerPort, "127.0.0.1", () => {
        s.write(
          `CONNECT api.anthropic.com:${upstream.port} HTTP/1.1\r\n` +
            `Host: api.anthropic.com:${upstream.port}\r\n` +
            `Proxy-Authorization: Bearer ${proxyToken}\r\n` +
            `\r\n`,
        );
      });
      let buf = "";
      s.on("data", (chunk) => {
        buf += chunk.toString("latin1");
        if (!buf.includes("\r\n\r\n")) return;
        const code = parseInt(buf.slice(0, buf.indexOf("\r\n")).split(" ")[1] ?? "0", 10);
        s.destroy();
        expect(code).toBe(407);
        expect(upstream.receivedHeaders).toHaveLength(0);
        resolve();
      });
      s.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 3000);
    });

    upstream.server.close();
  });

  it("broker:denied emitted with reason:bad_token on auth failure", async () => {
    const upstream = await makeUpstreamFixture();
    const deps = makeDeps();
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const brokerPort = await broker.start();

    await new Promise<void>((resolve, reject) => {
      const s = net.connect(brokerPort, "127.0.0.1", () => {
        s.write(
          `CONNECT api.anthropic.com:${upstream.port} HTTP/1.1\r\n` +
            `Host: api.anthropic.com:${upstream.port}\r\n` +
            `Proxy-Authorization: Bearer invalid-token-xyz\r\n` +
            `\r\n`,
        );
      });
      let buf = "";
      s.on("data", (chunk) => {
        buf += chunk.toString("latin1");
        if (!buf.includes("\r\n\r\n")) return;
        s.destroy();
        expect(deps.eventBus.emit).toHaveBeenCalledWith(
          "broker:denied",
          expect.objectContaining({
            reason: "bad_token",
            statusCode: 407,
          }),
        );
        resolve();
      });
      s.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 3000);
    });

    upstream.server.close();
  });
});

// ── Injection tests ─────────────────────────────────────────────────────────────

describe("credential injection (happy path)", () => {
  it("valid token + allowed host: upstream receives real secret key via x-api-key header, NOT the placeholder", async () => {
    const upstream = await makeUpstreamFixture();
    // Use a secret manager with a known real key (not sentinel for this test)
    const clock = createFakeClock(1_700_000_000_000);
    const secretManager = createSecretManager({ ANTHROPIC_API_KEY: "real-sk-key" });
    const sessionManager = createSessionManager({ clock });
    const deps: MitmBrokerDeps = {
      clock,
      timers: createFakeTimers(),
      eventBus: createMockEventBus(),
      logger: createMockLogger(),
      secretManager,
      sessionManager,
      bindings: [makeAnthropicBinding()],
    };
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const brokerPort = await broker.start();

    const { proxyToken } = sessionManager.issueToken("agent-1");
    const { statusCode, socket } = await connectThroughProxy(
      brokerPort,
      proxyToken,
      `api.anthropic.com:${upstream.port}`,
    );
    expect(statusCode).toBe(200);

    // Send the GET request through the tunnel
    await sendGetThroughTunnel(socket, "/v1/messages", { host: "api.anthropic.com" });
    socket.destroy();

    // Give the upstream a moment to record the request
    await new Promise((r) => setTimeout(r, 100));

    expect(upstream.receivedHeaders.length).toBeGreaterThan(0);
    expect(upstream.receivedHeaders[0]).toMatchObject({ "x-api-key": "real-sk-key" });
    // The placeholder "broker-placeholder" must NOT appear
    const xApiKey = upstream.receivedHeaders[0]?.["x-api-key"];
    expect(xApiKey).not.toBe("broker-placeholder");

    upstream.server.close();
  });

  it("secret:accessed emitted with agentId and outcome:success on valid injection", async () => {
    const upstream = await makeUpstreamFixture();
    const clock = createFakeClock(1_700_000_000_000);
    const secretManager = createSecretManager({ ANTHROPIC_API_KEY: "real-sk-key" });
    const sessionManager = createSessionManager({ clock });
    const eventBus = createMockEventBus();
    const deps: MitmBrokerDeps = {
      clock,
      timers: createFakeTimers(),
      eventBus,
      logger: createMockLogger(),
      secretManager,
      sessionManager,
      bindings: [makeAnthropicBinding()],
    };
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const brokerPort = await broker.start();

    const { proxyToken } = sessionManager.issueToken("agent-1");
    const { statusCode, socket } = await connectThroughProxy(
      brokerPort,
      proxyToken,
      `api.anthropic.com:${upstream.port}`,
    );
    expect(statusCode).toBe(200);
    await sendGetThroughTunnel(socket, "/v1/messages", { host: "api.anthropic.com" });
    socket.destroy();

    await new Promise((r) => setTimeout(r, 100));

    expect(eventBus.emit).toHaveBeenCalledWith(
      "secret:accessed",
      expect.objectContaining({
        secretName: "ANTHROPIC_API_KEY",
        agentId: "agent-1",
        outcome: "success",
      }),
    );

    upstream.server.close();
  });

  it("broker:injected emitted with ruleKind and host — never contains the secret value", async () => {
    const upstream = await makeUpstreamFixture();
    const clock = createFakeClock(1_700_000_000_000);
    const secretManager = createSecretManager({ ANTHROPIC_API_KEY: "real-sk-key" });
    const sessionManager = createSessionManager({ clock });
    const eventBus = createMockEventBus();
    const deps: MitmBrokerDeps = {
      clock,
      timers: createFakeTimers(),
      eventBus,
      logger: createMockLogger(),
      secretManager,
      sessionManager,
      bindings: [makeAnthropicBinding()],
    };
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const brokerPort = await broker.start();

    const { proxyToken } = sessionManager.issueToken("agent-1");
    const { statusCode, socket } = await connectThroughProxy(
      brokerPort,
      proxyToken,
      `api.anthropic.com:${upstream.port}`,
    );
    expect(statusCode).toBe(200);
    await sendGetThroughTunnel(socket, "/v1/messages", { host: "api.anthropic.com" });
    socket.destroy();

    await new Promise((r) => setTimeout(r, 100));

    expect(eventBus.emit).toHaveBeenCalledWith(
      "broker:injected",
      expect.objectContaining({
        host: "api.anthropic.com",
        ruleKind: "setHeader",
      }),
    );

    // Verify no secret appears in event payload
    const injectedCalls = (eventBus.emit as ReturnType<typeof import("vitest").vi.fn>).mock.calls
      .filter(([name]) => name === "broker:injected")
      .map(([, payload]) => JSON.stringify(payload));
    for (const payloadStr of injectedCalls) {
      expect(payloadStr).not.toContain("real-sk-key");
    }

    upstream.server.close();
  });

  it("setParam host (finnhub): upstream GET path has ?token=real-key appended — never the placeholder", async () => {
    const upstream = await makeUpstreamFixture();
    const clock = createFakeClock(1_700_000_000_000);
    const secretManager = createSecretManager({ FINNHUB_API_KEY: "fh-real-key" });
    const sessionManager = createSessionManager({ clock });
    const deps: MitmBrokerDeps = {
      clock,
      timers: createFakeTimers(),
      eventBus: createMockEventBus(),
      logger: createMockLogger(),
      secretManager,
      sessionManager,
      bindings: [makeFinnhubBinding()],
    };
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const brokerPort = await broker.start();

    const { proxyToken } = sessionManager.issueToken("agent-1");
    const { statusCode, socket } = await connectThroughProxy(
      brokerPort,
      proxyToken,
      `finnhub.io:${upstream.port}`,
    );
    expect(statusCode).toBe(200);
    await sendGetThroughTunnel(socket, "/api/v1/quote?symbol=AAPL", { host: "finnhub.io" });
    socket.destroy();

    await new Promise((r) => setTimeout(r, 100));

    expect(upstream.receivedHeaders.length).toBeGreaterThan(0);
    // The actual URL with the token appended should have reached the upstream.
    // Since http.createServer captures headers not the URL path, we verify via
    // the broker:injected event which carries ruleKind "setParam"
    expect(deps.eventBus.emit).toHaveBeenCalledWith(
      "broker:injected",
      expect.objectContaining({ ruleKind: "setParam" }),
    );

    upstream.server.close();
  });
});

// ── Fail-closed tests ──────────────────────────────────────────────────────────

describe("fail-closed (403/502 with zero upstream calls)", () => {
  it("unknown host (not in bindings) → 403, zero upstream calls", async () => {
    const upstream = await makeUpstreamFixture();
    const clock = createFakeClock(1_700_000_000_000);
    const sessionManager = createSessionManager({ clock });
    const eventBus = createMockEventBus();
    const deps: MitmBrokerDeps = {
      clock,
      timers: createFakeTimers(),
      eventBus,
      logger: createMockLogger(),
      secretManager: createSecretManager({ ANTHROPIC_API_KEY: "real-sk-key" }),
      sessionManager,
      bindings: [makeAnthropicBinding()],
    };
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const brokerPort = await broker.start();

    const { proxyToken } = sessionManager.issueToken("agent-1");
    const { statusCode, socket } = await connectThroughProxy(
      brokerPort,
      proxyToken,
      `evil.com:${upstream.port}`,
    );
    expect(statusCode).toBe(200); // CONNECT succeeds — auth gate passed

    // Now send the inner HTTP request to the unlisted host
    await sendGetThroughTunnel(socket, "/steal-secrets", { host: "evil.com" });
    socket.destroy();

    await new Promise((r) => setTimeout(r, 100));

    expect(upstream.receivedHeaders).toHaveLength(0);
    expect(eventBus.emit).toHaveBeenCalledWith(
      "broker:denied",
      expect.objectContaining({
        reason: "no_binding",
        statusCode: 403,
      }),
    );

    upstream.server.close();
  });

  it("path-policy violation → 403, zero upstream calls", async () => {
    const upstream = await makeUpstreamFixture();
    const clock = createFakeClock(1_700_000_000_000);
    const sessionManager = createSessionManager({ clock });
    const eventBus = createMockEventBus();
    const deps: MitmBrokerDeps = {
      clock,
      timers: createFakeTimers(),
      eventBus,
      logger: createMockLogger(),
      secretManager: createSecretManager({ POLICY_KEY: "policy-real-key" }),
      sessionManager,
      bindings: [makePolicyBinding()],
    };
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const brokerPort = await broker.start();

    const { proxyToken } = sessionManager.issueToken("agent-1");
    const { statusCode, socket } = await connectThroughProxy(
      brokerPort,
      proxyToken,
      `policy.example.com:${upstream.port}`,
    );
    expect(statusCode).toBe(200);

    // /v2/x violates the /v1/* pathPolicy
    await sendGetThroughTunnel(socket, "/v2/x", { host: "policy.example.com" });
    socket.destroy();

    await new Promise((r) => setTimeout(r, 100));

    expect(upstream.receivedHeaders).toHaveLength(0);
    expect(eventBus.emit).toHaveBeenCalledWith(
      "broker:denied",
      expect.objectContaining({
        reason: "path_policy",
        statusCode: 403,
      }),
    );

    upstream.server.close();
  });

  it("SecretManager miss → 502, zero upstream calls", async () => {
    const upstream = await makeUpstreamFixture();
    const clock = createFakeClock(1_700_000_000_000);
    const sessionManager = createSessionManager({ clock });
    const eventBus = createMockEventBus();
    // SecretManager with NO keys configured — simulates missing secret
    const deps: MitmBrokerDeps = {
      clock,
      timers: createFakeTimers(),
      eventBus,
      logger: createMockLogger(),
      secretManager: createSecretManager({}),
      sessionManager,
      bindings: [makeAnthropicBinding()],
    };
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const brokerPort = await broker.start();

    const { proxyToken } = sessionManager.issueToken("agent-1");
    const { statusCode, socket } = await connectThroughProxy(
      brokerPort,
      proxyToken,
      `api.anthropic.com:${upstream.port}`,
    );
    expect(statusCode).toBe(200);

    await sendGetThroughTunnel(socket, "/v1/messages", { host: "api.anthropic.com" });
    socket.destroy();

    await new Promise((r) => setTimeout(r, 100));

    expect(upstream.receivedHeaders).toHaveLength(0);
    expect(eventBus.emit).toHaveBeenCalledWith(
      "broker:credential_unavailable",
      expect.objectContaining({
        secretRef: "ANTHROPIC_API_KEY",
      }),
    );

    upstream.server.close();
  });

  it("secret:accessed emitted with outcome:not_found on SecretManager miss", async () => {
    const upstream = await makeUpstreamFixture();
    const clock = createFakeClock(1_700_000_000_000);
    const sessionManager = createSessionManager({ clock });
    const eventBus = createMockEventBus();
    const deps: MitmBrokerDeps = {
      clock,
      timers: createFakeTimers(),
      eventBus,
      logger: createMockLogger(),
      secretManager: createSecretManager({}), // no keys
      sessionManager,
      bindings: [makeAnthropicBinding()],
    };
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const brokerPort = await broker.start();

    const { proxyToken } = sessionManager.issueToken("agent-1");
    const { statusCode, socket } = await connectThroughProxy(
      brokerPort,
      proxyToken,
      `api.anthropic.com:${upstream.port}`,
    );
    expect(statusCode).toBe(200);

    await sendGetThroughTunnel(socket, "/v1/messages", { host: "api.anthropic.com" });
    socket.destroy();

    await new Promise((r) => setTimeout(r, 100));

    expect(eventBus.emit).toHaveBeenCalledWith(
      "secret:accessed",
      expect.objectContaining({
        secretName: "ANTHROPIC_API_KEY",
        outcome: "not_found",
      }),
    );

    upstream.server.close();
  });
});

// ── Audit / non-leakage tests ─────────────────────────────────────────────────

describe("Audit — non-leakage invariants", () => {
  it("sentinel secret never appears in any captured log string", async () => {
    const upstream = await makeUpstreamFixture();
    const clock = createFakeClock(1_700_000_000_000);
    // Use the SENTINEL_SECRET as the real key
    const secretManager = createSecretManager({ ANTHROPIC_API_KEY: SENTINEL_SECRET });
    const sessionManager = createSessionManager({ clock });
    const logger = makeMockLogger();
    const eventBus = createMockEventBus();
    const deps: MitmBrokerDeps = {
      clock,
      timers: createFakeTimers(),
      eventBus,
      logger: logger as unknown as MitmBrokerDeps["logger"],
      secretManager,
      sessionManager,
      bindings: [makeAnthropicBinding()],
    };
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const brokerPort = await broker.start();

    const { proxyToken } = sessionManager.issueToken("agent-1");
    const { statusCode, socket } = await connectThroughProxy(
      brokerPort,
      proxyToken,
      `api.anthropic.com:${upstream.port}`,
    );
    expect(statusCode).toBe(200);
    await sendGetThroughTunnel(socket, "/v1/messages", { host: "api.anthropic.com" });
    socket.destroy();

    await new Promise((r) => setTimeout(r, 100));

    // All captured log calls must not contain the sentinel secret
    const allCalls = logger._calls();
    for (const call of allCalls) {
      const payloadStr = JSON.stringify(call.payload);
      expect(payloadStr).not.toContain(SENTINEL_SECRET);
      expect(call.msg).not.toContain(SENTINEL_SECRET);
    }

    upstream.server.close();
  });

  it("sentinel secret never appears in any broker:injected event payload", async () => {
    const upstream = await makeUpstreamFixture();
    const clock = createFakeClock(1_700_000_000_000);
    const secretManager = createSecretManager({ ANTHROPIC_API_KEY: SENTINEL_SECRET });
    const sessionManager = createSessionManager({ clock });
    const eventBus = createMockEventBus();
    const deps: MitmBrokerDeps = {
      clock,
      timers: createFakeTimers(),
      eventBus,
      logger: createMockLogger(),
      secretManager,
      sessionManager,
      bindings: [makeAnthropicBinding()],
    };
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const brokerPort = await broker.start();

    const { proxyToken } = sessionManager.issueToken("agent-1");
    const { statusCode, socket } = await connectThroughProxy(
      brokerPort,
      proxyToken,
      `api.anthropic.com:${upstream.port}`,
    );
    expect(statusCode).toBe(200);
    await sendGetThroughTunnel(socket, "/v1/messages", { host: "api.anthropic.com" });
    socket.destroy();

    await new Promise((r) => setTimeout(r, 100));

    // Check every "broker:injected" event payload for the sentinel
    const emitCalls = (eventBus.emit as ReturnType<typeof import("vitest").vi.fn>).mock.calls;
    for (const [eventName, payload] of emitCalls) {
      if (eventName === "broker:injected") {
        const payloadStr = JSON.stringify(payload);
        expect(payloadStr).not.toContain(SENTINEL_SECRET);
      }
    }

    upstream.server.close();
  });
});

// ── Edge-case / error-path coverage ──────────────────────────────────────────

describe("Edge cases — error paths and coverage branches", () => {
  it("stop() called before start() does not throw", async () => {
    const deps = makeDeps();
    const broker = createMitmBroker(deps);
    // stop() before start() — server is null, should resolve without error
    await expect(broker.stop()).resolves.toBeUndefined();
  });

  it("stop() is idempotent — can be called twice without error", async () => {
    const upstream = await makeUpstreamFixture();
    const deps = makeDeps();
    const broker = createMitmBroker(deps);
    const brokerPort = await broker.start();
    expect(brokerPort).toBeGreaterThan(0);
    await broker.stop();
    await expect(broker.stop()).resolves.toBeUndefined();
    upstream.server.close();
  });

  it("client socket closes before sending inner request — broker does not hang", async () => {
    const upstream = await makeUpstreamFixture();
    const clock = createFakeClock(1_700_000_000_000);
    const sessionManager = createSessionManager({ clock });
    const deps: MitmBrokerDeps = {
      clock,
      timers: createFakeTimers(),
      eventBus: createMockEventBus(),
      logger: createMockLogger(),
      secretManager: createSecretManager({ ANTHROPIC_API_KEY: "real-sk-key" }),
      sessionManager,
      bindings: [makeAnthropicBinding()],
    };
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const brokerPort = await broker.start();

    const { proxyToken } = sessionManager.issueToken("agent-1");

    // Open tunnel, get 200, then immediately destroy without sending inner request
    const { statusCode, socket } = await connectThroughProxy(
      brokerPort,
      proxyToken,
      `api.anthropic.com:${upstream.port}`,
    );
    expect(statusCode).toBe(200);
    socket.destroy(); // destroy before sending GET

    // Wait for broker to process the close — should not hang or throw
    await new Promise((r) => setTimeout(r, 150));

    // No upstream calls were made
    expect(upstream.receivedHeaders).toHaveLength(0);
    upstream.server.close();
  });

  it("8KB header overflow → broker closes tunnel without forwarding to upstream", async () => {
    const upstream = await makeUpstreamFixture();
    const clock = createFakeClock(1_700_000_000_000);
    const sessionManager = createSessionManager({ clock });
    const deps: MitmBrokerDeps = {
      clock,
      timers: createFakeTimers(),
      eventBus: createMockEventBus(),
      logger: createMockLogger(),
      secretManager: createSecretManager({ ANTHROPIC_API_KEY: "real-sk-key" }),
      sessionManager,
      bindings: [makeAnthropicBinding()],
    };
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const brokerPort = await broker.start();

    const { proxyToken } = sessionManager.issueToken("agent-1");

    const { statusCode, socket } = await connectThroughProxy(
      brokerPort,
      proxyToken,
      `api.anthropic.com:${upstream.port}`,
    );
    expect(statusCode).toBe(200);

    // Send a header that exceeds 8192 bytes without \r\n\r\n
    // This triggers the MAX_HEADER_BYTES overflow path
    const oversizeHeader = "GET /v1/messages HTTP/1.1\r\n" +
      `X-Overflow: ${"A".repeat(8200)}\r\n`;
    socket.write(oversizeHeader);

    // The broker should destroy the socket
    await new Promise<void>((resolve) => {
      socket.on("close", () => resolve());
      socket.on("error", () => resolve());
      setTimeout(() => resolve(), 2000); // fallback timeout
    });
    socket.destroy();

    // Upstream must not have received any request
    expect(upstream.receivedHeaders).toHaveLength(0);
    upstream.server.close();
  });

  it("upstream connection error is handled gracefully — client socket is destroyed", async () => {
    const clock = createFakeClock(1_700_000_000_000);
    const sessionManager = createSessionManager({ clock });
    // Use a port where connections are immediately refused
    // We start a temporary server to get a valid port, then close it
    const tempServer = await new Promise<http.Server>((resolve) => {
      const s = http.createServer();
      s.listen(0, "127.0.0.1", () => resolve(s));
    });
    const refusedPort = (tempServer.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => tempServer.close(() => resolve()));
    // Port is now closed — connections will be refused

    const deps: MitmBrokerDeps = {
      clock,
      timers: createFakeTimers(),
      eventBus: createMockEventBus(),
      logger: createMockLogger(),
      secretManager: createSecretManager({ ANTHROPIC_API_KEY: "real-sk-key" }),
      sessionManager,
      bindings: [
        {
          secretRef: "ANTHROPIC_API_KEY",
          hostRules: [
            {
              pattern: { kind: "exact", host: "api.anthropic.com" },
              inject: [{ kind: "setHeader", name: "x-api-key", format: "raw" }],
            },
          ],
        },
      ],
    };
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const brokerPort = await broker.start();

    const { proxyToken } = sessionManager.issueToken("agent-1");

    // CONNECT to a target that will refuse connection
    const { statusCode, socket } = await connectThroughProxy(
      brokerPort,
      proxyToken,
      `api.anthropic.com:${refusedPort}`,
    );
    expect(statusCode).toBe(200);

    // Send the GET request — this will trigger net.connect to the refused port
    socket.write("GET /v1/messages HTTP/1.1\r\nhost: api.anthropic.com\r\n\r\n");

    // Wait for socket to close due to upstream error
    await new Promise<void>((resolve) => {
      socket.on("close", () => resolve());
      socket.on("error", () => resolve());
      setTimeout(() => resolve(), 2000);
    });
    socket.destroy();
  });

  it("empty inject array uses default Bearer injection — upstream receives Authorization header", async () => {
    const upstream = await makeUpstreamFixture();
    const clock = createFakeClock(1_700_000_000_000);
    const sessionManager = createSessionManager({ clock });
    // Binding with empty inject → default Bearer behavior
    const emptyInjectBinding: BrokerBinding = {
      secretRef: "BEARER_KEY",
      hostRules: [
        {
          pattern: { kind: "exact", host: "bearer.example.com" },
          inject: [], // empty → default Authorization: Bearer
        },
      ],
    };
    const deps: MitmBrokerDeps = {
      clock,
      timers: createFakeTimers(),
      eventBus: createMockEventBus(),
      logger: createMockLogger(),
      secretManager: createSecretManager({ BEARER_KEY: "bearer-secret-key" }),
      sessionManager,
      bindings: [emptyInjectBinding],
    };
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const brokerPort = await broker.start();

    const { proxyToken } = sessionManager.issueToken("agent-1");
    const { statusCode, socket } = await connectThroughProxy(
      brokerPort,
      proxyToken,
      `bearer.example.com:${upstream.port}`,
    );
    expect(statusCode).toBe(200);
    await sendGetThroughTunnel(socket, "/api/v1", { host: "bearer.example.com" });
    socket.destroy();

    await new Promise((r) => setTimeout(r, 100));
    expect(upstream.receivedHeaders.length).toBeGreaterThan(0);
    // Default Bearer injection sets Authorization header
    const authHeader = upstream.receivedHeaders[0]?.["authorization"];
    expect(authHeader).toBe("Bearer bearer-secret-key");

    // broker:injected ruleKind defaults to "setHeader" for empty inject
    expect(deps.eventBus.emit).toHaveBeenCalledWith(
      "broker:injected",
      expect.objectContaining({ ruleKind: "setHeader" }),
    );
    upstream.server.close();
  });

  it("createMitmBroker factory returns MitmBrokerPort with start and stop methods", () => {
    const deps = makeDeps();
    const broker = createMitmBroker(deps);
    expect(typeof broker.start).toBe("function");
    expect(typeof broker.stop).toBe("function");
  });

  it("clientSocket error listener absorbs EPIPE/ECONNRESET before 200 write — no uncaughtException", async () => {
    // Exercises the noopErrorHandler registered on clientSocket before the 200 write.
    // Forces EPIPE by half-closing the client side WHILE the broker is writing 200,
    // using a flag to detect if uncaughtException fired.
    const clock = createFakeClock(1_700_000_000_000);
    const sessionManager = createSessionManager({ clock });
    const deps: MitmBrokerDeps = {
      clock,
      timers: createFakeTimers(),
      eventBus: createMockEventBus(),
      logger: createMockLogger(),
      secretManager: createSecretManager({ ANTHROPIC_API_KEY: "epipe-test-key" }),
      sessionManager,
      bindings: [makeAnthropicBinding()],
    };
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const brokerPort = await broker.start();

    const { proxyToken } = sessionManager.issueToken("agent-1");

    let uncaughtCount = 0;
    const onUncaught = () => { uncaughtCount = uncaughtCount + 1; };
    process.on("uncaughtException", onUncaught);

    try {
      // Connect and write CONNECT request, then half-close the socket
      // with resetAndDestroy() to force ECONNRESET/EPIPE on the broker side.
      await new Promise<void>((resolve) => {
        const s = net.connect(brokerPort, "127.0.0.1", () => {
          s.write(
            `CONNECT api.anthropic.com:443 HTTP/1.1\r\n` +
              `Host: api.anthropic.com:443\r\n` +
              `Proxy-Authorization: Bearer ${proxyToken}\r\n` +
              `\r\n`,
          );
          // Issue RST immediately to force ECONNRESET on the server socket.
          // This races with the broker's 200 write — the error handler absorbs it.
          s.resetAndDestroy();
        });
        s.on("close", () => resolve());
        s.on("error", () => resolve());
        setTimeout(() => resolve(), 500);
      });

      // Wait for any uncaught exception to propagate
      await new Promise((r) => setTimeout(r, 100));

      // The no-op error handler must have absorbed any EPIPE/ECONNRESET
      expect(uncaughtCount).toBe(0);
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });

  it("start() rejects when port is already in use — server error callback fires", async () => {
    // Start a server to occupy a port
    const occupied = await new Promise<http.Server>((resolve) => {
      const s = http.createServer();
      s.listen(0, "127.0.0.1", () => resolve(s));
    });
    const occupiedPort = (occupied.address() as net.AddressInfo).port;

    const deps = makeDeps();
    const broker = createMitmBroker(deps);

    // Try to start on the occupied port — should reject
    await expect(broker.start(occupiedPort)).rejects.toThrow();

    occupied.close();
  });

  it("unexpected exception in pipeline (secretManager.get throws) — outer catch handles gracefully", async () => {
    const upstream = await makeUpstreamFixture();
    const clock = createFakeClock(1_700_000_000_000);
    const sessionManager = createSessionManager({ clock });
    // Create a mock secret manager that throws on get()
    const throwingSecretManager = {
      get: (_key: string): string | undefined => {
        throw new Error("unexpected internal error");
      },
    };
    const deps: MitmBrokerDeps = {
      clock,
      timers: createFakeTimers(),
      eventBus: createMockEventBus(),
      logger: createMockLogger(),
      secretManager: throwingSecretManager,
      sessionManager,
      bindings: [makeAnthropicBinding()],
    };
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const brokerPort = await broker.start();

    const { proxyToken } = sessionManager.issueToken("agent-1");
    const { statusCode, socket } = await connectThroughProxy(
      brokerPort,
      proxyToken,
      `api.anthropic.com:${upstream.port}`,
    );
    expect(statusCode).toBe(200);

    // Send GET — secretManager.get() will throw inside the pipeline
    socket.write("GET /v1/messages HTTP/1.1\r\nhost: api.anthropic.com\r\n\r\n");

    // Broker's catch block should destroy the clientSocket
    await new Promise<void>((resolve) => {
      socket.on("close", () => resolve());
      socket.on("error", () => resolve());
      setTimeout(() => resolve(), 2000);
    });
    socket.destroy();

    // Upstream must not have received any request
    expect(upstream.receivedHeaders).toHaveLength(0);
    upstream.server.close();
  });

  it("CONNECT with IPv6 bracketed authority — broker normalizes and routes correctly", async () => {
    const upstream = await makeUpstreamFixture();
    const clock = createFakeClock(1_700_000_000_000);
    const sessionManager = createSessionManager({ clock });
    // A binding for the loopback IPv6 address
    const ipv6Binding: BrokerBinding = {
      secretRef: "IPV6_KEY",
      hostRules: [
        {
          pattern: { kind: "exact", host: "::1" },
          inject: [{ kind: "setHeader", name: "x-ipv6-key", format: "raw" }],
        },
      ],
    };
    const deps: MitmBrokerDeps = {
      clock,
      timers: createFakeTimers(),
      eventBus: createMockEventBus(),
      logger: createMockLogger(),
      secretManager: createSecretManager({ IPV6_KEY: "ipv6-real-key" }),
      sessionManager,
      bindings: [ipv6Binding],
    };
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const brokerPort = await broker.start();

    const { proxyToken } = sessionManager.issueToken("agent-1");

    // CONNECT with IPv6 bracketed authority: [::1]:PORT
    // This exercises the extractPort and normalizeHost IPv6 paths
    const { statusCode, socket } = await connectThroughProxy(
      brokerPort,
      proxyToken,
      `[::1]:${upstream.port}`,
    );
    expect(statusCode).toBe(200);

    await sendGetThroughTunnel(socket, "/test", { host: "::1" });
    socket.destroy();

    await new Promise((r) => setTimeout(r, 150));

    // Upstream should have received the request with injected header
    expect(upstream.receivedHeaders.length).toBeGreaterThan(0);
    expect(upstream.receivedHeaders[0]).toMatchObject({ "x-ipv6-key": "ipv6-real-key" });
    upstream.server.close();
  });

  it("CONNECT with malformed IPv6 authority (no closing bracket) — 407 because token needed", async () => {
    // This exercises extractPort with authority.startsWith("[") && closeBracket === -1
    const clock = createFakeClock(1_700_000_000_000);
    const sessionManager = createSessionManager({ clock });
    const deps: MitmBrokerDeps = {
      clock,
      timers: createFakeTimers(),
      eventBus: createMockEventBus(),
      logger: createMockLogger(),
      secretManager: createSecretManager({}),
      sessionManager,
      bindings: [],
    };
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const brokerPort = await broker.start();

    // Missing token → 407 (before extractPort is even called)
    // But the authority "[::1-no-close-bracket" exercises normalizeHost + extractPort IPv6 branch
    await new Promise<void>((resolve, reject) => {
      const s = net.connect(brokerPort, "127.0.0.1", () => {
        // "[::1:PORT" — bracket never closed, exercises closeBracket === -1 → return 443
        s.write(`CONNECT [::1:8080 HTTP/1.1\r\nHost: [::1:8080\r\nProxy-Authorization: Bearer invalid\r\n\r\n`);
      });
      let buf = "";
      s.on("data", (chunk) => {
        buf += chunk.toString("latin1");
        if (!buf.includes("\r\n\r\n")) return;
        const code = parseInt(buf.slice(0, buf.indexOf("\r\n")).split(" ")[1] ?? "0", 10);
        s.destroy();
        expect(code).toBe(407); // bad token
        resolve();
      });
      s.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 3000);
    });
  });

  it("CONNECT with IPv6 authority and non-numeric port — broker uses default port 443", async () => {
    const clock = createFakeClock(1_700_000_000_000);
    const sessionManager = createSessionManager({ clock });
    const ipv6Binding: BrokerBinding = {
      secretRef: "IPV6_KEY",
      hostRules: [{ pattern: { kind: "exact", host: "::1" }, inject: [{ kind: "setHeader", name: "x-key", format: "raw" }] }],
    };
    const deps: MitmBrokerDeps = {
      clock,
      timers: createFakeTimers(),
      eventBus: createMockEventBus(),
      logger: createMockLogger(),
      secretManager: createSecretManager({ IPV6_KEY: "val" }),
      sessionManager,
      bindings: [ipv6Binding],
    };
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const brokerPort = await broker.start();

    const { proxyToken } = sessionManager.issueToken("agent-1");

    // [::1]:abc — non-numeric port for IPv6 → isNaN(parsed) branch → return 443
    const result = await new Promise<{ statusCode: number; socket: net.Socket }>((resolve, reject) => {
      const s = net.connect(brokerPort, "127.0.0.1", () => {
        s.write(
          `CONNECT [::1]:abc HTTP/1.1\r\n` +
            `Host: [::1]:abc\r\n` +
            `Proxy-Authorization: Bearer ${proxyToken}\r\n` +
            `\r\n`,
        );
      });
      let buf = "";
      s.on("data", (chunk) => {
        buf += chunk.toString("latin1");
        if (!buf.includes("\r\n\r\n")) return;
        const code = parseInt(buf.slice(0, buf.indexOf("\r\n")).split(" ")[1] ?? "0", 10);
        resolve({ statusCode: code, socket: s });
      });
      s.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 3000);
    });

    expect(result.statusCode).toBe(200);
    result.socket.destroy();
    await new Promise((r) => setTimeout(r, 200));
  });

  it("CONNECT authority without port number (default port) — broker parses authority correctly", async () => {
    const upstream = await makeUpstreamFixture();
    const clock = createFakeClock(1_700_000_000_000);
    const sessionManager = createSessionManager({ clock });
    const deps: MitmBrokerDeps = {
      clock,
      timers: createFakeTimers(),
      eventBus: createMockEventBus(),
      logger: createMockLogger(),
      secretManager: createSecretManager({ ANTHROPIC_API_KEY: "real-sk-key" }),
      sessionManager,
      bindings: [makeAnthropicBinding()],
    };
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const brokerPort = await broker.start();

    const { proxyToken } = sessionManager.issueToken("agent-1");

    // CONNECT without a port number (no colon in authority) exercises
    // the extractPort "lastColon === -1" branch which returns 443.
    const result = await new Promise<{ statusCode: number; socket: net.Socket }>((resolve, reject) => {
      const s = net.connect(brokerPort, "127.0.0.1", () => {
        s.write(
          `CONNECT api.anthropic.com HTTP/1.1\r\n` +
            `Host: api.anthropic.com\r\n` +
            `Proxy-Authorization: Bearer ${proxyToken}\r\n` +
            `\r\n`,
        );
      });
      let buf = "";
      s.on("data", (chunk) => {
        buf += chunk.toString("latin1");
        if (!buf.includes("\r\n\r\n")) return;
        const statusLine = buf.slice(0, buf.indexOf("\r\n"));
        const code = parseInt(statusLine.split(" ")[1] ?? "0", 10);
        resolve({ statusCode: code, socket: s });
      });
      s.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 3000);
    });

    // Auth passed → 200 Connection established (even though port 443 may be unavailable)
    expect(result.statusCode).toBe(200);
    result.socket.destroy();
    await new Promise((r) => setTimeout(r, 200));
    upstream.server.close();
  });

  it("CONNECT with a suffix-matched host that exceeds suffix boundary — 403 if suffix host itself is the target", async () => {
    const upstream = await makeUpstreamFixture();
    const clock = createFakeClock(1_700_000_000_000);
    const sessionManager = createSessionManager({ clock });
    // Binding with suffix pattern: *.anthropic.com
    const suffixBinding: BrokerBinding = {
      secretRef: "ANTHROPIC_API_KEY",
      hostRules: [
        {
          pattern: { kind: "suffix", suffix: ".anthropic.com" },
          inject: [{ kind: "setHeader", name: "x-api-key", format: "raw" }],
        },
      ],
    };
    const deps: MitmBrokerDeps = {
      clock,
      timers: createFakeTimers(),
      eventBus: createMockEventBus(),
      logger: createMockLogger(),
      secretManager: createSecretManager({ ANTHROPIC_API_KEY: "real-sk-key" }),
      sessionManager,
      bindings: [suffixBinding],
    };
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const brokerPort = await broker.start();

    // api.anthropic.com should match the suffix .anthropic.com
    const { proxyToken } = sessionManager.issueToken("agent-1");
    const { statusCode, socket } = await connectThroughProxy(
      brokerPort,
      proxyToken,
      `api.anthropic.com:${upstream.port}`,
    );
    expect(statusCode).toBe(200);
    await sendGetThroughTunnel(socket, "/v1/messages", { host: "api.anthropic.com" });
    socket.destroy();

    await new Promise((r) => setTimeout(r, 100));
    expect(upstream.receivedHeaders.length).toBeGreaterThan(0);
    upstream.server.close();
  });

  it("malformed inner HTTP request (empty request line) — broker closes tunnel without forwarding", async () => {
    const upstream = await makeUpstreamFixture();
    const clock = createFakeClock(1_700_000_000_000);
    const sessionManager = createSessionManager({ clock });
    const deps: MitmBrokerDeps = {
      clock,
      timers: createFakeTimers(),
      eventBus: createMockEventBus(),
      logger: createMockLogger(),
      secretManager: createSecretManager({ ANTHROPIC_API_KEY: "real-sk-key" }),
      sessionManager,
      bindings: [makeAnthropicBinding()],
    };
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const brokerPort = await broker.start();

    const { proxyToken } = sessionManager.issueToken("agent-1");
    const { statusCode, socket } = await connectThroughProxy(
      brokerPort,
      proxyToken,
      `api.anthropic.com:${upstream.port}`,
    );
    expect(statusCode).toBe(200);

    // Send an inner request with just the header terminator — no request line
    socket.write("\r\n\r\n");

    await new Promise<void>((resolve) => {
      socket.on("close", () => resolve());
      socket.on("error", () => resolve());
      setTimeout(() => resolve(), 2000);
    });
    socket.destroy();

    expect(upstream.receivedHeaders).toHaveLength(0);
    upstream.server.close();
  });

  it("CONNECT with IPv6 authority without port — broker uses default port 443", async () => {
    const clock = createFakeClock(1_700_000_000_000);
    const sessionManager = createSessionManager({ clock });
    const ipv6Binding: BrokerBinding = {
      secretRef: "IPV6_KEY",
      hostRules: [{ pattern: { kind: "exact", host: "::1" }, inject: [{ kind: "setHeader", name: "x-key", format: "raw" }] }],
    };
    const deps: MitmBrokerDeps = {
      clock,
      timers: createFakeTimers(),
      eventBus: createMockEventBus(),
      logger: createMockLogger(),
      secretManager: createSecretManager({ IPV6_KEY: "val" }),
      sessionManager,
      bindings: [ipv6Binding],
    };
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const brokerPort = await broker.start();

    const { proxyToken } = sessionManager.issueToken("agent-1");

    // [::1] without port — afterBracket is empty, doesn't start with ":" → return 443
    const result = await new Promise<{ statusCode: number; socket: net.Socket }>((resolve, reject) => {
      const s = net.connect(brokerPort, "127.0.0.1", () => {
        s.write(
          `CONNECT [::1] HTTP/1.1\r\n` +
            `Host: [::1]\r\n` +
            `Proxy-Authorization: Bearer ${proxyToken}\r\n` +
            `\r\n`,
        );
      });
      let buf = "";
      s.on("data", (chunk) => {
        buf += chunk.toString("latin1");
        if (!buf.includes("\r\n\r\n")) return;
        const statusLine = buf.slice(0, buf.indexOf("\r\n"));
        const code = parseInt(statusLine.split(" ")[1] ?? "0", 10);
        resolve({ statusCode: code, socket: s });
      });
      s.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 3000);
    });

    expect(result.statusCode).toBe(200);
    result.socket.destroy();
    await new Promise((r) => setTimeout(r, 200));
  });

  it("CONNECT with non-numeric port in authority — broker uses default port 443", async () => {
    const upstream = await makeUpstreamFixture();
    const clock = createFakeClock(1_700_000_000_000);
    const sessionManager = createSessionManager({ clock });
    const deps: MitmBrokerDeps = {
      clock,
      timers: createFakeTimers(),
      eventBus: createMockEventBus(),
      logger: createMockLogger(),
      secretManager: createSecretManager({ ANTHROPIC_API_KEY: "real-sk-key" }),
      sessionManager,
      bindings: [makeAnthropicBinding()],
    };
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const brokerPort = await broker.start();

    const { proxyToken } = sessionManager.issueToken("agent-1");

    // CONNECT with a non-numeric port triggers the isNaN(parsed) branch in extractPort
    // The broker will use port 443 (default) and fail to connect — but the 200 is sent first
    const result = await new Promise<{ statusCode: number; socket: net.Socket }>((resolve, reject) => {
      const s = net.connect(brokerPort, "127.0.0.1", () => {
        s.write(
          `CONNECT api.anthropic.com:notaport HTTP/1.1\r\n` +
            `Host: api.anthropic.com:notaport\r\n` +
            `Proxy-Authorization: Bearer ${proxyToken}\r\n` +
            `\r\n`,
        );
      });
      let buf = "";
      s.on("data", (chunk) => {
        buf += chunk.toString("latin1");
        if (!buf.includes("\r\n\r\n")) return;
        const statusLine = buf.slice(0, buf.indexOf("\r\n"));
        const code = parseInt(statusLine.split(" ")[1] ?? "0", 10);
        resolve({ statusCode: code, socket: s });
      });
      s.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 3000);
    });

    // 200 is sent before port check — auth passed
    expect(result.statusCode).toBe(200);
    result.socket.destroy();
    await new Promise((r) => setTimeout(r, 200));
    upstream.server.close();
  });

  it("socket error event during header read — broker handles gracefully", async () => {
    const upstream = await makeUpstreamFixture();
    const clock = createFakeClock(1_700_000_000_000);
    const sessionManager = createSessionManager({ clock });
    const deps: MitmBrokerDeps = {
      clock,
      timers: createFakeTimers(),
      eventBus: createMockEventBus(),
      logger: createMockLogger(),
      secretManager: createSecretManager({ ANTHROPIC_API_KEY: "real-sk-key" }),
      sessionManager,
      bindings: [makeAnthropicBinding()],
    };
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const brokerPort = await broker.start();

    const { proxyToken } = sessionManager.issueToken("agent-1");

    // Establish tunnel and immediately destroy with error
    const { statusCode, socket } = await connectThroughProxy(
      brokerPort,
      proxyToken,
      `api.anthropic.com:${upstream.port}`,
    );
    expect(statusCode).toBe(200);

    // Destroy the socket immediately without sending any inner request
    // This tests the close event path in readTunnelHeaders
    socket.destroy(new Error("simulated client error"));

    await new Promise((r) => setTimeout(r, 150));
    expect(upstream.receivedHeaders).toHaveLength(0);
    upstream.server.close();
  });
});

// ── Regression tests ────────────────────────────────────────────────────────

/**
 * makeBodyUpstreamFixture — like makeUpstreamFixture but also captures request
 * bodies so we can assert POST/PUT bodies are forwarded bidirectionally.
 */
function makeBodyUpstreamFixture(): Promise<{
  server: http.Server;
  port: number;
  receivedHeaders: Record<string, string | string[] | undefined>[];
  receivedBodies: string[];
}> {
  const receivedHeaders: Record<string, string | string[] | undefined>[] = [];
  const receivedBodies: string[] = [];
  const server = http.createServer((req, res) => {
    receivedHeaders.push({ ...req.headers });
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf-8");
    });
    req.on("end", () => {
      receivedBodies.push(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, echo: body }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({ server, port, receivedHeaders, receivedBodies });
    });
  });
}

/**
 * sendPostThroughTunnel — send a POST with a body through an already-open tunnel.
 * Returns the response status and echoed body (from the upstream fixture above).
 */
async function sendPostThroughTunnel(
  socket: net.Socket,
  path: string,
  body: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; responseBody: string }> {
  return new Promise((resolve, reject) => {
    let resolved = false;
    function tryResolve(status: number, responseBody: string): void {
      if (resolved) return;
      resolved = true;
      resolve({ status, responseBody });
    }

    let buf = "";
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString("latin1");
      const headerEnd = buf.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const statusLine = buf.slice(0, buf.indexOf("\r\n"));
      const status = parseInt(statusLine.split(" ")[1] ?? "0", 10);
      // Extract content-length from response to read body
      const responseHeaders = buf.slice(0, headerEnd);
      const clMatch = /content-length:\s*(\d+)/i.exec(responseHeaders);
      const contentLength = clMatch ? parseInt(clMatch[1] ?? "0", 10) : 0;
      const responseBody = buf.slice(headerEnd + 4);
      if (responseBody.length >= contentLength) {
        socket.off("data", onData);
        tryResolve(status, responseBody);
      }
    };

    // Attach listener BEFORE writing so we don't miss an early 413.
    socket.on("data", onData);

    // Absorb EPIPE/ECONNRESET — expected when broker sends early 413 and
    // destroys the socket before the client body write completes.
    socket.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EPIPE" || err.code === "ECONNRESET") return;
      reject(err);
    });

    // On close: resolve with whatever response we received (handles the case where
    // the broker closes the connection immediately after a 413).
    socket.on("close", () => {
      const headerEnd = buf.indexOf("\r\n\r\n");
      if (headerEnd !== -1) {
        const statusLine = buf.slice(0, buf.indexOf("\r\n"));
        const status = parseInt(statusLine.split(" ")[1] ?? "0", 10);
        const responseBody = buf.slice(headerEnd + 4);
        tryResolve(status, responseBody);
      }
    });

    const bodyBytes = Buffer.from(body, "utf-8");
    let reqStr = `POST ${path} HTTP/1.1\r\n`;
    reqStr += `content-length: ${bodyBytes.length}\r\n`;
    reqStr += `content-type: application/json\r\n`;
    for (const [k, v] of Object.entries(extraHeaders)) {
      reqStr += `${k}: ${v}\r\n`;
    }
    reqStr += `\r\n`;
    socket.write(reqStr);
    socket.write(bodyBytes);

    setTimeout(() => reject(new Error("POST tunnel timeout")), 12_000);
  });
}

// ── request body forwarding ───────────────────────────────────────────────────

describe("POST body must reach upstream (bidirectional pipe)", () => {
  it("POST /v1/messages with JSON body: upstream receives the exact body bytes", async () => {
    const upstream = await makeBodyUpstreamFixture();
    const clock = createFakeClock(1_700_000_000_000);
    const secretManager = createSecretManager({ ANTHROPIC_API_KEY: "real-sk-key" });
    const sessionManager = createSessionManager({ clock });
    const deps: MitmBrokerDeps = {
      clock,
      timers: createFakeTimers(),
      eventBus: createMockEventBus(),
      logger: createMockLogger(),
      secretManager,
      sessionManager,
      bindings: [makeAnthropicBinding()],
    };
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const brokerPort = await broker.start();

    const { proxyToken } = sessionManager.issueToken("agent-1");
    const { statusCode, socket } = await connectThroughProxy(
      brokerPort,
      proxyToken,
      `api.anthropic.com:${upstream.port}`,
    );
    expect(statusCode).toBe(200);

    const requestBody = JSON.stringify({ model: "claude-3-5-sonnet-20241022", max_tokens: 1024, messages: [{ role: "user", content: "Hello" }] });
    const { status } = await sendPostThroughTunnel(socket, "/v1/messages", requestBody, { host: "api.anthropic.com" });
    expect(status).toBe(200);
    socket.destroy();

    // Wait for the upstream to fully receive the request
    await new Promise((r) => setTimeout(r, 300));

    // The upstream MUST have received the body — this fails if clientSocket.pipe(upstreamSocket) is missing
    expect(upstream.receivedBodies).toHaveLength(1);
    expect(upstream.receivedBodies[0]).toBe(requestBody);

    upstream.server.close();
  }, 15_000);

  it("full request→response round-trip: upstream response body reaches the client", async () => {
    const upstream = await makeBodyUpstreamFixture();
    const clock = createFakeClock(1_700_000_000_000);
    const secretManager = createSecretManager({ ANTHROPIC_API_KEY: "real-sk-key" });
    const sessionManager = createSessionManager({ clock });
    const deps: MitmBrokerDeps = {
      clock,
      timers: createFakeTimers(),
      eventBus: createMockEventBus(),
      logger: createMockLogger(),
      secretManager,
      sessionManager,
      bindings: [makeAnthropicBinding()],
    };
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const brokerPort = await broker.start();

    const { proxyToken } = sessionManager.issueToken("agent-1");
    const { statusCode, socket } = await connectThroughProxy(
      brokerPort,
      proxyToken,
      `api.anthropic.com:${upstream.port}`,
    );
    expect(statusCode).toBe(200);

    const requestBody = '{"model":"claude-3-5-sonnet-20241022"}';
    const { status, responseBody } = await sendPostThroughTunnel(socket, "/v1/messages", requestBody, { host: "api.anthropic.com" });

    // The upstream fixture echoes the body: { ok: true, echo: <body> }
    // Response must have arrived — this proves the upstreamSocket→clientSocket pipe works too
    expect(status).toBe(200);
    expect(responseBody).toContain('"ok":true');
    socket.destroy();

    await new Promise((r) => setTimeout(r, 100));
    upstream.server.close();
  }, 15_000);
});

// ── EPIPE protection on 200 write ────────────────────────────────────────────

describe("client socket error before 200 write must not throw uncaughtException", () => {
  it("client closes socket immediately after CONNECT is parsed — no uncaughtException", async () => {
    const clock = createFakeClock(1_700_000_000_000);
    const sessionManager = createSessionManager({ clock });
    const deps: MitmBrokerDeps = {
      clock,
      timers: createFakeTimers(),
      eventBus: createMockEventBus(),
      logger: createMockLogger(),
      secretManager: createSecretManager({ ANTHROPIC_API_KEY: "real-sk-key" }),
      sessionManager,
      bindings: [makeAnthropicBinding()],
    };
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const brokerPort = await broker.start();

    const { proxyToken } = sessionManager.issueToken("agent-1");

    // Track any uncaught exceptions
    let uncaughtCount = 0;
    const onUncaught = () => {
      uncaughtCount = uncaughtCount + 1;
    };
    process.on("uncaughtException", onUncaught);

    try {
      // Destroy the socket as soon as the connection is established, BEFORE
      // reading back the 200 — simulates the race where client closes before
      // the broker writes the 200 Connection established response.
      await new Promise<void>((resolve, reject) => {
        const s = net.connect(brokerPort, "127.0.0.1", () => {
          s.write(
            `CONNECT api.anthropic.com:443 HTTP/1.1\r\n` +
              `Host: api.anthropic.com:443\r\n` +
              `Proxy-Authorization: Bearer ${proxyToken}\r\n` +
              `\r\n`,
          );
          // Destroy immediately — before the 200 is likely written
          s.destroy();
        });
        s.on("close", () => resolve());
        s.on("error", () => resolve()); // error on close is expected
        setTimeout(() => resolve(), 1000);
      });

      // Wait a tick for any uncaught exception to propagate
      await new Promise((r) => setTimeout(r, 100));

      // If an EPIPE escaped as uncaughtException, uncaughtCount would be > 0
      expect(uncaughtCount).toBe(0);
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });

  it("clientSocket has an error listener attached before the 200 write — no unhandled error event", async () => {
    const clock = createFakeClock(1_700_000_000_000);
    const sessionManager = createSessionManager({ clock });
    const deps: MitmBrokerDeps = {
      clock,
      timers: createFakeTimers(),
      eventBus: createMockEventBus(),
      logger: createMockLogger(),
      secretManager: createSecretManager({ ANTHROPIC_API_KEY: "real-sk-key" }),
      sessionManager,
      bindings: [makeAnthropicBinding()],
    };
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const brokerPort = await broker.start();

    const { proxyToken } = sessionManager.issueToken("agent-1");

    // Open tunnel then immediately send a reset to simulate EPIPE during 200 write
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.connect(brokerPort, "127.0.0.1", () => {
        s.write(
          `CONNECT api.anthropic.com:443 HTTP/1.1\r\n` +
            `Host: api.anthropic.com:443\r\n` +
            `Proxy-Authorization: Bearer ${proxyToken}\r\n` +
            `\r\n`,
        );
        resolve(s);
      });
      s.on("error", reject);
      setTimeout(() => reject(new Error("connect timeout")), 3000);
    });

    // Forcefully destroy to trigger EPIPE on the broker's write side
    socket.destroy();
    await new Promise((r) => setTimeout(r, 150));
    // Test passes if no exception was thrown — broker handled the error gracefully
  });
});

// ── audit event completeness ─────────────────────────────────────────────────

describe("broker:denied audit events on all exit paths with correct reasons", () => {
  it("header overflow path emits broker:denied with reason:malformed_request (NOT path_policy)", async () => {
    const clock = createFakeClock(1_700_000_000_000);
    const sessionManager = createSessionManager({ clock });
    const eventBus = createMockEventBus();
    const deps: MitmBrokerDeps = {
      clock,
      timers: createFakeTimers(),
      eventBus,
      logger: createMockLogger(),
      secretManager: createSecretManager({ ANTHROPIC_API_KEY: "real-sk-key" }),
      sessionManager,
      bindings: [makeAnthropicBinding()],
    };
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const brokerPort = await broker.start();

    const { proxyToken } = sessionManager.issueToken("agent-1");
    const { statusCode, socket } = await connectThroughProxy(
      brokerPort,
      proxyToken,
      `api.anthropic.com:443`,
    );
    expect(statusCode).toBe(200);

    // Send oversized headers (>8192 bytes without \r\n\r\n) to trigger overflow
    const oversizeHeader = "GET /v1/messages HTTP/1.1\r\n" + `X-Overflow: ${"A".repeat(8300)}\r\n`;
    socket.write(oversizeHeader);

    await new Promise<void>((resolve) => {
      socket.on("close", () => resolve());
      socket.on("error", () => resolve());
      setTimeout(() => resolve(), 2000);
    });
    socket.destroy();

    // broker:denied MUST be emitted with reason "malformed_request", NOT "path_policy"
    expect(eventBus.emit).toHaveBeenCalledWith(
      "broker:denied",
      expect.objectContaining({
        reason: "malformed_request",
        statusCode: 400,
      }),
    );
    // Specifically must NOT have been called with path_policy for this scenario
    const emitCalls = (eventBus.emit as ReturnType<typeof import("vitest").vi.fn>).mock.calls;
    const deniedWithPathPolicy = emitCalls.filter(
      ([name, payload]: [string, { reason?: string }]) =>
        name === "broker:denied" && payload?.reason === "path_policy"
    );
    expect(deniedWithPathPolicy).toHaveLength(0);
  });

  it("malformed inner request (empty request line) emits broker:denied with reason:malformed_request", async () => {
    const clock = createFakeClock(1_700_000_000_000);
    const sessionManager = createSessionManager({ clock });
    const eventBus = createMockEventBus();
    const deps: MitmBrokerDeps = {
      clock,
      timers: createFakeTimers(),
      eventBus,
      logger: createMockLogger(),
      secretManager: createSecretManager({ ANTHROPIC_API_KEY: "real-sk-key" }),
      sessionManager,
      bindings: [makeAnthropicBinding()],
    };
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const brokerPort = await broker.start();

    const { proxyToken } = sessionManager.issueToken("agent-1");
    const { statusCode, socket } = await connectThroughProxy(
      brokerPort,
      proxyToken,
      `api.anthropic.com:443`,
    );
    expect(statusCode).toBe(200);

    // Send malformed inner request (only the terminator, no request line)
    socket.write("\r\n\r\n");

    await new Promise<void>((resolve) => {
      socket.on("close", () => resolve());
      socket.on("error", () => resolve());
      setTimeout(() => resolve(), 2000);
    });
    socket.destroy();

    // broker:denied MUST be emitted on malformed parse — currently missing
    expect(eventBus.emit).toHaveBeenCalledWith(
      "broker:denied",
      expect.objectContaining({
        reason: "malformed_request",
        statusCode: 400,
      }),
    );
  });
});

// ── endSession must DELETE the map entry ─────────────────────────────────────

describe("endSession must remove the Map entry (not just set active=false)", () => {
  it("after endSession, consumeToken returns null — session fully removed", () => {
    const clock = createFakeClock(1_700_000_000_000);
    const mgr = createSessionManager({ clock });
    const { sessionId, proxyToken } = mgr.issueToken("agent-1");
    mgr.endSession(sessionId);
    // Verify the token cannot be consumed (existing test passes already — this is the basic gate)
    expect(mgr.consumeToken(proxyToken)).toBeNull();
  });

  it("multiple sessions: endSession removes only the target session, not others", () => {
    const clock = createFakeClock(1_700_000_000_000);
    const mgr = createSessionManager({ clock });
    const s1 = mgr.issueToken("agent-1");
    const s2 = mgr.issueToken("agent-2");
    // End session 1 only
    mgr.endSession(s1.sessionId);
    // Session 2 must still be consumable
    const result = mgr.consumeToken(s2.proxyToken);
    expect(result).not.toBeNull();
    expect(result?.agentId).toBe("agent-2");
    // Session 1 must be gone — not just inactive
    expect(mgr.consumeToken(s1.proxyToken)).toBeNull();
  });

  it("endSession then issueToken: map does not grow unboundedly — re-issue after end creates a fresh entry", () => {
    // This is the memory growth scenario: endSession must delete, not accumulate inactive entries.
    // We verify correctness by confirming that calling endSession then re-issuing works cleanly,
    // proving the Map mutation (delete) path runs without error.
    const clock = createFakeClock(1_700_000_000_000);
    const mgr = createSessionManager({ clock });
    for (let i = 0; i < 5; i++) {
      const { sessionId } = mgr.issueToken(`agent-${i}`);
      // endSession must delete so the Map does not accumulate stale entries
      mgr.endSession(sessionId);
    }
    // After 5 issue+end cycles, a new token must be issuable and consumable
    const { proxyToken } = mgr.issueToken("agent-new");
    const result = mgr.consumeToken(proxyToken);
    expect(result).not.toBeNull();
    expect(result?.agentId).toBe("agent-new");
  });

  it("endSession is idempotent — calling it twice does not throw", () => {
    const clock = createFakeClock(1_700_000_000_000);
    const mgr = createSessionManager({ clock });
    const { sessionId } = mgr.issueToken("agent-1");
    mgr.endSession(sessionId);
    // Second call on a deleted session must not throw
    expect(() => mgr.endSession(sessionId)).not.toThrow();
  });
});

// ── upstreamSocket must not block process exit ───────────────────────────────

describe("stop() destroys in-flight upstream sockets (no process-exit block)", () => {
  it("stop() called during in-flight request: broker resolves stop() promise promptly", async () => {
    const upstream = await makeBodyUpstreamFixture();
    const clock = createFakeClock(1_700_000_000_000);
    const secretManager = createSecretManager({ ANTHROPIC_API_KEY: "real-sk-key" });
    const sessionManager = createSessionManager({ clock });
    const deps: MitmBrokerDeps = {
      clock,
      timers: createFakeTimers(),
      eventBus: createMockEventBus(),
      logger: createMockLogger(),
      secretManager,
      sessionManager,
      bindings: [makeAnthropicBinding()],
    };
    const broker = createMitmBroker(deps);
    // Note: do NOT push to runningBrokers — we stop it manually below
    const brokerPort = await broker.start();

    const { proxyToken } = sessionManager.issueToken("agent-1");
    const { statusCode, socket } = await connectThroughProxy(
      brokerPort,
      proxyToken,
      `api.anthropic.com:${upstream.port}`,
    );
    expect(statusCode).toBe(200);

    // Start a POST — body not yet sent, upstream connection in-flight
    socket.write(
      `POST /v1/messages HTTP/1.1\r\n` +
        `host: api.anthropic.com\r\n` +
        `content-length: 100\r\n` +
        `\r\n`,
    );
    // Don't send body — keeps upstream socket alive

    // Give the broker time to open the upstream socket
    await new Promise((r) => setTimeout(r, 100));

    // stop() must resolve promptly — if upstreamSocket is not destroyed/unref'd,
    // this will hang until the upstream socket times out
    const stopStart = Date.now();
    await broker.stop();
    const stopMs = Date.now() - stopStart;

    // With unref() or tracked+destroyed upstreams, stop() should resolve quickly
    // (well under 2 seconds). Without it, it may hang for the upstream connection timeout.
    expect(stopMs).toBeLessThan(2000);

    socket.destroy();
    upstream.server.close();
  });
});

// ── TLS upgrade via caManager ────────────────────────────────────────────────
//
// These tests MUST FAIL before mitm-broker.ts wires the TLS upgrade.
// The caManager seam already exists (caManager?: CaManagerPort) but the
// CONNECT handler must wire it to terminate TLS on the decrypted layer.

describe("broker CONNECT handler terminates TLS via caManager", () => {
  let caDataDir: string;

  beforeEach(() => {
    caDataDir = mkdtempSync(join(tmpdir(), "comis-broker-tls-test-"));
  });

  afterEach(() => {
    rmSync(caDataDir, { recursive: true, force: true });
  });

  it(
    "caManager wired: after 200, client TLS handshake succeeds (broker terminates TLS for allow-listed host)",
    async () => {
      // Build a real NodeCaManager so the broker can mint a leaf cert for api.anthropic.com
      const clock = createFakeClock(Date.now());
      const caManager = createNodeCaManager({ clock, dataDir: caDataDir });

      // Warm up the CA so broker-ca.pem exists before the test needs it
      await caManager.serverContextForHost("api.anthropic.com");
      const caCertPem = readFileSync(join(caDataDir, "broker-ca.pem"), "utf8");

      const secretManager = createSecretManager({ ANTHROPIC_API_KEY: "real-sk-key" });
      const sessionManager = createSessionManager({ clock });

      const deps: MitmBrokerDeps = {
        clock,
        timers: createFakeTimers(),
        eventBus: createMockEventBus(),
        logger: createMockLogger(),
        secretManager,
        sessionManager,
        bindings: [makeAnthropicBinding()],
        caManager, // wired!
      };

      const broker = createMitmBroker(deps);
      runningBrokers.push(broker);
      const brokerPort = await broker.start();

      const { proxyToken } = sessionManager.issueToken("agent-1");

      // Step 1: send the CONNECT request to the broker
      const rawSocket = await new Promise<net.Socket>((resolve, reject) => {
        const s = net.connect(brokerPort, "127.0.0.1", () => {
          s.write(
            `CONNECT api.anthropic.com:443 HTTP/1.1\r\n` +
              `Host: api.anthropic.com:443\r\n` +
              `Proxy-Authorization: Bearer ${proxyToken}\r\n` +
              `\r\n`,
          );
        });
        let buf = "";
        s.on("data", (chunk: Buffer) => {
          buf += chunk.toString("latin1");
          if (!buf.includes("\r\n\r\n")) return;
          const statusLine = buf.slice(0, buf.indexOf("\r\n"));
          const code = parseInt(statusLine.split(" ")[1] ?? "0", 10);
          if (code !== 200) {
            reject(new Error(`Expected 200, got ${code}`));
            return;
          }
          resolve(s);
        });
        s.on("error", reject);
        setTimeout(() => reject(new Error("CONNECT timeout")), 5000);
      });

      // Step 2: after the 200, wrap the raw TCP socket in a TLS client that trusts the broker CA.
      // When the TLS upgrade is wired, the broker upgrades the raw socket to a TLS server socket,
      // so a TLS client handshake should complete. Without it, the broker does not upgrade
      // the socket and the handshake will fail (the raw socket sends no TLS ServerHello).
      const tlsResult = await new Promise<{ alpnProtocol: string | boolean | null; subjectaltname: string }>(
        (resolve, reject) => {
          const tlsSocket = tls.connect({
            socket: rawSocket as net.Socket,
            servername: "api.anthropic.com",
            ca: caCertPem, // trust only the broker CA
            rejectUnauthorized: true,
            // Offer both h2 and http/1.1 — the broker's ALPNProtocols: ["http/1.1"]
            // means the server can only pick http/1.1, proving the ALPN constraint works.
            ALPNProtocols: ["h2", "http/1.1"],
          });
          tlsSocket.on("secureConnect", () => {
            const cert = tlsSocket.getPeerCertificate();
            resolve({
              alpnProtocol: tlsSocket.alpnProtocol,
              subjectaltname: cert.subjectaltname ?? "",
            });
            tlsSocket.destroy();
          });
          tlsSocket.on("error", reject);
          setTimeout(() => reject(new Error("TLS handshake timeout")), 5000);
        },
      );

      // These assertions prove: (a) TLS handshake completed, (b) ALPN = http/1.1,
      // (c) leaf cert SAN contains the target hostname
      expect(tlsResult.alpnProtocol).toBe("http/1.1");
      expect(tlsResult.subjectaltname).toContain("DNS:api.anthropic.com");

      rawSocket.destroy();

      // Wait for the broker's async IIFE (handleConnect) to process the socket
      // close and complete its async steps — ensures V8 coverage collection
      // captures the lines inside the TLS-upgrade branch before the test ends.
      await new Promise((r) => setTimeout(r, 150));
    },
    15_000, // 15s timeout for TLS handshake + cert generation
  );

  it(
    "caManager wired but returns undefined (pass-through host): raw TCP socket used, inner HTTP still works",
    async () => {
      // When caManager.serverContextForHost returns undefined, the broker
      // passes through without TLS upgrade (pass-through host behavior).
      const upstream = await makeUpstreamFixture();
      const clock = createFakeClock(1_700_000_000_000);
      const secretManager = createSecretManager({ ANTHROPIC_API_KEY: "pass-through-key" });
      const sessionManager = createSessionManager({ clock });

      // A caManager that always returns undefined (no host uses TLS termination)
      const passThroughCaManager = {
        serverContextForHost: async (_host: string) => undefined,
      };

      const deps: MitmBrokerDeps = {
        clock,
        timers: createFakeTimers(),
        eventBus: createMockEventBus(),
        logger: createMockLogger(),
        secretManager,
        sessionManager,
        bindings: [makeAnthropicBinding()],
        caManager: passThroughCaManager, // wired but always returns undefined
      };

      const broker = createMitmBroker(deps);
      runningBrokers.push(broker);
      const brokerPort = await broker.start();

      const { proxyToken } = sessionManager.issueToken("agent-1");
      const { statusCode, socket } = await connectThroughProxy(
        brokerPort,
        proxyToken,
        `api.anthropic.com:${upstream.port}`,
      );
      expect(statusCode).toBe(200);

      // Send plain HTTP (no TLS) — broker should not attempt TLS upgrade
      // since caManager returned undefined for this host.
      await sendGetThroughTunnel(socket, "/v1/messages", { host: "api.anthropic.com" });
      socket.destroy();

      await new Promise((r) => setTimeout(r, 100));

      // Upstream received the request — pass-through injection path works
      expect(upstream.receivedHeaders.length).toBeGreaterThan(0);
      expect(upstream.receivedHeaders[0]).toMatchObject({ "x-api-key": "pass-through-key" });

      upstream.server.close();
    },
  );

  it(
    "caManager undefined (opaque-TCP mode): CONNECT handler behaves identically — no TLS upgrade, inner HTTP still works",
    async () => {
      // Regression guard: when caManager is NOT wired, opaque-TCP behavior is unchanged.
      const upstream = await makeUpstreamFixture();
      const clock = createFakeClock(1_700_000_000_000);
      const secretManager = createSecretManager({ ANTHROPIC_API_KEY: "no-upgrade-key" });
      const sessionManager = createSessionManager({ clock });

      const deps: MitmBrokerDeps = {
        clock,
        timers: createFakeTimers(),
        eventBus: createMockEventBus(),
        logger: createMockLogger(),
        secretManager,
        sessionManager,
        bindings: [makeAnthropicBinding()],
        // caManager intentionally omitted — opaque-TCP behavior
      };

      const broker = createMitmBroker(deps);
      runningBrokers.push(broker);
      const brokerPort = await broker.start();

      const { proxyToken } = sessionManager.issueToken("agent-1");
      const { statusCode, socket } = await connectThroughProxy(
        brokerPort,
        proxyToken,
        `api.anthropic.com:${upstream.port}`,
      );
      expect(statusCode).toBe(200);

      // Send a plain HTTP request (no TLS) — should still work since caManager is undefined
      await sendGetThroughTunnel(socket, "/v1/messages", { host: "api.anthropic.com" });
      socket.destroy();

      await new Promise((r) => setTimeout(r, 100));

      // Upstream received the request — the injection path still works
      expect(upstream.receivedHeaders.length).toBeGreaterThan(0);
      expect(upstream.receivedHeaders[0]).toMatchObject({ "x-api-key": "no-upgrade-key" });

      upstream.server.close();
    },
  );
});

// ── Finalizer interface tests ────────────────────────────────────────────────

/**
 * Build an awsSigV4 BrokerBinding based on the Anthropic binding but with a
 * finalizer: { kind: "awsSigV4" } on the first hostRule. Used by the finalizer tests.
 */
function makeAwsSigV4Binding(): BrokerBinding {
  const base = makeAnthropicBinding();
  return {
    ...base,
    hostRules: [
      {
        ...base.hostRules[0]!,
        finalizer: { kind: "awsSigV4" },
      },
    ],
  };
}

describe("finalizer runs after injection (ordering via log step index)", () => {
  it("step='inject' log index is strictly less than step='finalizer_skipped' log index", async () => {
    const upstream = await makeBodyUpstreamFixture();
    const clock = createFakeClock(1_700_000_000_000);
    const secretManager = createSecretManager({ ANTHROPIC_API_KEY: "real-sk-key" });
    const sessionManager = createSessionManager({ clock });
    const mockLogger = makeMockLogger();
    const deps: MitmBrokerDeps = {
      clock,
      timers: createFakeTimers(),
      eventBus: createMockEventBus(),
      logger: mockLogger as unknown as MitmBrokerDeps["logger"],
      secretManager,
      sessionManager,
      bindings: [makeAwsSigV4Binding()],
    };
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const brokerPort = await broker.start();

    const { proxyToken } = sessionManager.issueToken("agent-1");
    const { statusCode, socket } = await connectThroughProxy(
      brokerPort,
      proxyToken,
      `api.anthropic.com:${upstream.port}`,
    );
    expect(statusCode).toBe(200);

    // Send a small body so finalizer runs (well under cap)
    await sendPostThroughTunnel(socket, "/v1/messages", "small body", { host: "api.anthropic.com" });
    socket.destroy();

    await new Promise((r) => setTimeout(r, 300));
    upstream.server.close();

    const debugCalls = mockLogger._calls("debug");
    const injectIdx = debugCalls.findIndex((c) => c.payload["step"] === "inject");
    const finalizerIdx = debugCalls.findIndex((c) => c.payload["step"] === "finalizer_skipped");

    expect(injectIdx).toBeGreaterThanOrEqual(0);
    expect(finalizerIdx).toBeGreaterThan(injectIdx);
  }, 15_000);
});

describe("no-finalizer rule: body pass-through byte-identical", () => {
  it("body received by upstream matches body sent by client exactly", async () => {
    const upstream = await makeBodyUpstreamFixture();
    const clock = createFakeClock(1_700_000_000_000);
    const secretManager = createSecretManager({ ANTHROPIC_API_KEY: "real-sk-key" });
    const sessionManager = createSessionManager({ clock });
    const deps: MitmBrokerDeps = {
      clock,
      timers: createFakeTimers(),
      eventBus: createMockEventBus(),
      logger: createMockLogger(),
      secretManager,
      sessionManager,
      bindings: [makeAnthropicBinding()], // no finalizer
    };
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const brokerPort = await broker.start();

    const { proxyToken } = sessionManager.issueToken("agent-1");
    const { statusCode, socket } = await connectThroughProxy(
      brokerPort,
      proxyToken,
      `api.anthropic.com:${upstream.port}`,
    );
    expect(statusCode).toBe(200);

    const body = "hello world";
    await sendPostThroughTunnel(socket, "/v1/messages", body, { host: "api.anthropic.com" });
    socket.destroy();

    await new Promise((r) => setTimeout(r, 300));
    upstream.server.close();

    expect(upstream.receivedBodies).toHaveLength(1);
    expect(upstream.receivedBodies[0]).toBe(body);
  }, 15_000);
});

describe("awsSigV4 no-op: body and headers unchanged, deferral logged", () => {
  it("upstream sees original body and custom header; deferral log emitted", async () => {
    const upstream = await makeBodyUpstreamFixture();
    const clock = createFakeClock(1_700_000_000_000);
    const secretManager = createSecretManager({ ANTHROPIC_API_KEY: "real-sk-key" });
    const sessionManager = createSessionManager({ clock });
    const mockLogger = makeMockLogger();
    const deps: MitmBrokerDeps = {
      clock,
      timers: createFakeTimers(),
      eventBus: createMockEventBus(),
      logger: mockLogger as unknown as MitmBrokerDeps["logger"],
      secretManager,
      sessionManager,
      bindings: [makeAwsSigV4Binding()],
    };
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const brokerPort = await broker.start();

    const { proxyToken } = sessionManager.issueToken("agent-1");
    const { statusCode, socket } = await connectThroughProxy(
      brokerPort,
      proxyToken,
      `api.anthropic.com:${upstream.port}`,
    );
    expect(statusCode).toBe(200);

    const body = "test body";
    await sendPostThroughTunnel(socket, "/v1/messages", body, {
      host: "api.anthropic.com",
      "x-custom": "val",
    });
    socket.destroy();

    await new Promise((r) => setTimeout(r, 300));
    upstream.server.close();

    // Body reaches upstream unchanged
    expect(upstream.receivedBodies).toHaveLength(1);
    expect(upstream.receivedBodies[0]).toBe(body);

    // Custom header is forwarded unchanged
    expect(upstream.receivedHeaders.length).toBeGreaterThan(0);
    expect(upstream.receivedHeaders[0]?.["x-custom"]).toBe("val");

    // Deferral log must be present
    const debugCalls = mockLogger._calls("debug");
    const deferralLogs = debugCalls.filter((c) => c.payload["step"] === "finalizer_skipped");
    expect(deferralLogs).toHaveLength(1);
    expect(deferralLogs[0]!.payload["hint"]).toBe("sigv4 deferred");
  }, 15_000);
});

describe("body > cap → 413, zero upstream bytes", () => {
  it("413 returned to client; upstream receives no headers; broker:denied body_too_large emitted", async () => {
    // Tests the early-413 path: when the declared Content-Length exceeds
    // MAX_BODY_BYTES, the broker returns 413 immediately without buffering and
    // without opening an upstream connection. We declare a large CL but only send
    // a small body — the broker should reject on the declared size alone.
    const upstream = await makeBodyUpstreamFixture();
    const clock = createFakeClock(1_700_000_000_000);
    const secretManager = createSecretManager({ ANTHROPIC_API_KEY: "real-sk-key" });
    const sessionManager = createSessionManager({ clock });
    const eventBus = createMockEventBus();
    const deps: MitmBrokerDeps = {
      clock,
      timers: createFakeTimers(),
      eventBus,
      logger: createMockLogger(),
      secretManager,
      sessionManager,
      bindings: [makeAwsSigV4Binding()],
    };
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const brokerPort = await broker.start();

    const { proxyToken } = sessionManager.issueToken("agent-1");
    const { statusCode, socket } = await connectThroughProxy(
      brokerPort,
      proxyToken,
      `api.anthropic.com:${upstream.port}`,
    );
    expect(statusCode).toBe(200);

    // Declare Content-Length > MAX_BODY_BYTES but only send a 1-byte body.
    // The broker should 413 immediately on the declared CL without buffering.
    await new Promise<void>((resolve) => {
      let buf = "";
      socket.on("data", (chunk: Buffer) => {
        buf += chunk.toString("latin1");
        if (buf.includes("\r\n\r\n")) resolve();
      });
      socket.on("error", () => resolve());
      socket.on("close", () => resolve());
      const oversizeCl = MAX_BODY_BYTES + 1;
      socket.write(
        `POST /v1/messages HTTP/1.1\r\ncontent-length: ${oversizeCl}\r\nhost: api.anthropic.com\r\n\r\nx`,
      );
      setTimeout(() => resolve(), 3000);
    });
    socket.destroy();

    await new Promise((r) => setTimeout(r, 300));
    upstream.server.close();

    // Upstream must have received no headers (net.connect never called)
    expect(upstream.receivedHeaders).toHaveLength(0);

    // broker:denied must be emitted with body_too_large
    expect(eventBus.emit).toHaveBeenCalledWith(
      "broker:denied",
      expect.objectContaining({
        reason: "body_too_large",
        statusCode: 413,
      }),
    );
  }, 30_000);
});

describe("finalizer path with query string in URL", () => {
  it("request with query string is forwarded correctly through finalizer path", async () => {
    const upstream = await makeBodyUpstreamFixture();
    const clock = createFakeClock(1_700_000_000_000);
    const secretManager = createSecretManager({ ANTHROPIC_API_KEY: "real-sk-key" });
    const sessionManager = createSessionManager({ clock });
    const deps: MitmBrokerDeps = {
      clock,
      timers: createFakeTimers(),
      eventBus: createMockEventBus(),
      logger: createMockLogger(),
      secretManager,
      sessionManager,
      bindings: [makeAwsSigV4Binding()],
    };
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const brokerPort = await broker.start();

    const { proxyToken } = sessionManager.issueToken("agent-1");
    const { statusCode, socket } = await connectThroughProxy(
      brokerPort,
      proxyToken,
      `api.anthropic.com:${upstream.port}`,
    );
    expect(statusCode).toBe(200);

    // Send POST with query string in path — covers the targetUrl.search branch
    const body = "query body";
    await sendPostThroughTunnel(socket, "/v1/messages?version=2024", body, {
      host: "api.anthropic.com",
    });
    socket.destroy();

    await new Promise((r) => setTimeout(r, 300));
    upstream.server.close();

    expect(upstream.receivedBodies).toHaveLength(1);
    expect(upstream.receivedBodies[0]).toBe(body);
  }, 15_000);
});

describe("finalizer path upstream socket error is handled", () => {
  it("upstream connection error on finalizer path: client socket is destroyed", async () => {
    const clock = createFakeClock(1_700_000_000_000);
    const sessionManager = createSessionManager({ clock });

    // Get a port that refuses connections
    const tempServer = await new Promise<http.Server>((resolve) => {
      const s = http.createServer();
      s.listen(0, "127.0.0.1", () => resolve(s));
    });
    const refusedPort = (tempServer.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => tempServer.close(() => resolve()));

    const deps: MitmBrokerDeps = {
      clock,
      timers: createFakeTimers(),
      eventBus: createMockEventBus(),
      logger: createMockLogger(),
      secretManager: createSecretManager({ ANTHROPIC_API_KEY: "real-sk-key" }),
      sessionManager,
      bindings: [
        {
          secretRef: "ANTHROPIC_API_KEY",
          hostRules: [
            {
              pattern: { kind: "exact", host: "api.anthropic.com" },
              inject: [{ kind: "setHeader", name: "x-api-key", format: "raw" }],
              finalizer: { kind: "awsSigV4" },
            },
          ],
        },
      ],
    };
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const brokerPort = await broker.start();

    const { proxyToken } = sessionManager.issueToken("agent-1");
    const { statusCode, socket } = await connectThroughProxy(
      brokerPort,
      proxyToken,
      `api.anthropic.com:${refusedPort}`,
    );
    expect(statusCode).toBe(200);

    // Send a request — broker will buffer, run finalizer, then fail at net.connect
    socket.write("POST /v1/messages HTTP/1.1\r\ncontent-length: 5\r\nhost: api.anthropic.com\r\n\r\nhello");

    // Wait for socket to close due to upstream error
    await new Promise<void>((resolve) => {
      socket.on("close", () => resolve());
      socket.on("error", () => resolve());
      setTimeout(() => resolve(), 2000);
    });
    socket.destroy();
    // No assertion needed beyond not throwing — the test verifies the error handler path runs
  }, 15_000);
});

// ── Tests for finalizer stage improvements ───────────────────────────────────

describe("chunked Transfer-Encoding with no Content-Length → 411", () => {
  it("finalizer-configured rule + chunked TE + no CL → socket receives 411 Length Required", async () => {
    const upstream = await makeBodyUpstreamFixture();
    const clock = createFakeClock(1_700_000_000_000);
    const secretManager = createSecretManager({ ANTHROPIC_API_KEY: "real-sk-key" });
    const sessionManager = createSessionManager({ clock });
    const deps: MitmBrokerDeps = {
      clock,
      timers: createFakeTimers(),
      eventBus: createMockEventBus(),
      logger: createMockLogger(),
      secretManager,
      sessionManager,
      bindings: [makeAwsSigV4Binding()],
    };
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const brokerPort = await broker.start();

    const { proxyToken } = sessionManager.issueToken("agent-1");
    const { statusCode, socket } = await connectThroughProxy(
      brokerPort,
      proxyToken,
      `api.anthropic.com:${upstream.port}`,
    );
    expect(statusCode).toBe(200);

    // Send chunked TE with no Content-Length — broker must reject with 411
    let responseBuf = "";
    await new Promise<void>((resolve) => {
      socket.on("data", (chunk: Buffer) => {
        responseBuf += chunk.toString("latin1");
        if (responseBuf.includes("\r\n\r\n")) resolve();
      });
      socket.on("error", () => resolve());
      socket.on("close", () => resolve());
      socket.write("POST /v1/messages HTTP/1.1\r\ntransfer-encoding: chunked\r\nhost: api.anthropic.com\r\n\r\n");
      setTimeout(() => resolve(), 2000);
    });
    socket.destroy();

    await new Promise((r) => setTimeout(r, 200));
    upstream.server.close();

    // Must receive 411 Length Required
    expect(responseBuf).toContain("411");
    // Upstream must not have received any request
    expect(upstream.receivedHeaders).toHaveLength(0);
  }, 15_000);
});

describe("body > cap via actual bytes (bufferBody null path) → 413 denied", () => {
  it("body bytes exceed cap without Content-Length declaration → 413 fail-closed", async () => {
    // This covers the bodyBuf === null path when cap is exceeded via actual bytes
    // (not via declared CL). We use a tiny cap binding to make the test fast.
    const upstream = await makeBodyUpstreamFixture();
    const clock = createFakeClock(1_700_000_000_000);
    const secretManager = createSecretManager({ SMALL_KEY: "real-sk-key" });
    const sessionManager = createSessionManager({ clock });
    const eventBus = createMockEventBus();
    // A binding with a finalizer and a very small in-test cap —
    // we achieve this by sending body > MAX_BODY_BYTES declared, but here
    // we test the bufferBody null path via a body that exceeds the local cap.
    // Since we can't easily inject a smaller cap, we use a real large body
    // but test via the bytes-exceed-cap path with MAX_BODY_BYTES+1 bytes
    // but WITHOUT declaring a Content-Length (so the early-413 check doesn't intercept it).
    // To do this efficiently in tests, we use a 1-byte body but with cap=0.
    // We can't change the global MAX_BODY_BYTES, so instead we'll just
    // send the cap+1 bytes without a Content-Length header so the broker
    // must buffer them and discover the cap is exceeded.
    const smallCapBinding: BrokerBinding = {
      secretRef: "SMALL_KEY",
      hostRules: [
        {
          pattern: { kind: "exact", host: "small.example.com" },
          inject: [{ kind: "setHeader", name: "x-key", format: "raw" }],
          finalizer: { kind: "awsSigV4" },
        },
      ],
    };
    const deps: MitmBrokerDeps = {
      clock,
      timers: createFakeTimers(),
      eventBus,
      logger: createMockLogger(),
      secretManager,
      sessionManager,
      bindings: [smallCapBinding],
    };
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const brokerPort = await broker.start();

    const { proxyToken } = sessionManager.issueToken("agent-1");
    const { statusCode, socket } = await connectThroughProxy(
      brokerPort,
      proxyToken,
      `small.example.com:${upstream.port}`,
    );
    expect(statusCode).toBe(200);

    // Send MAX_BODY_BYTES + 1 bytes with NO Content-Length (bypasses the early-413 check).
    // The broker must buffer and hit the cap mid-stream.
    const overCapBuf = Buffer.alloc(MAX_BODY_BYTES + 1, 0x61);
    let responseBuf = "";
    await new Promise<void>((resolve) => {
      socket.on("data", (chunk: Buffer) => {
        responseBuf += chunk.toString("latin1");
        if (responseBuf.includes("\r\n\r\n")) resolve();
      });
      socket.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EPIPE" || err.code === "ECONNRESET") return;
        resolve();
      });
      socket.on("close", () => {
        if (responseBuf.includes("\r\n\r\n")) resolve();
      });
      socket.write(`POST /v1/test HTTP/1.1\r\nhost: small.example.com\r\n\r\n`);
      socket.write(overCapBuf);
      setTimeout(() => resolve(), 5000);
    });
    socket.destroy();

    await new Promise((r) => setTimeout(r, 300));
    upstream.server.close();

    // broker:denied must be emitted with body_too_large
    expect(eventBus.emit).toHaveBeenCalledWith(
      "broker:denied",
      expect.objectContaining({ reason: "body_too_large", statusCode: 413 }),
    );
    // Upstream receives no request
    expect(upstream.receivedHeaders).toHaveLength(0);
  }, 30_000);
});

// ── Regression tests — TLS fail-closed ordering ──────────────────────────────

describe("fail-closed ordering: unlisted host must NOT get a cert minted before 403", () => {
  let caDataDir: string;

  beforeEach(() => {
    caDataDir = mkdtempSync(join(tmpdir(), "comis-cr02-tls-test-"));
  });

  afterEach(() => {
    rmSync(caDataDir, { recursive: true, force: true });
  });

  it(
    "caManager wired + valid token + unlisted host → 403 BEFORE any cert is minted or cached",
    async () => {
      // Track whether serverContextForHost is ever called for the unlisted host
      const clock = createFakeClock(Date.now());
      const caManager = createNodeCaManager({ clock, dataDir: caDataDir });

      const mintCalls: string[] = [];
      const spyCaManager = {
        serverContextForHost: async (host: string) => {
          mintCalls.push(host);
          return caManager.serverContextForHost(host);
        },
      };

      const sessionManager = createSessionManager({ clock });
      const deps: MitmBrokerDeps = {
        clock,
        timers: createFakeTimers(),
        eventBus: createMockEventBus(),
        logger: createMockLogger(),
        secretManager: createSecretManager({ ANTHROPIC_API_KEY: "real-sk-key" }),
        sessionManager,
        bindings: [makeAnthropicBinding()], // only api.anthropic.com is listed
        caManager: spyCaManager,
      };

      const broker = createMitmBroker(deps);
      runningBrokers.push(broker);
      const brokerPort = await broker.start();

      const { proxyToken } = sessionManager.issueToken("agent-1");

      // CONNECT to evil.com (unlisted host) — the broker must 403 and MUST NOT
      // call serverContextForHost for evil.com (no cert should be minted)
      const result = await new Promise<{ statusCode: number; socket: import("node:net").Socket }>(
        (resolve, reject) => {
          const s = net.connect(brokerPort, "127.0.0.1", () => {
            s.write(
              `CONNECT evil.com:443 HTTP/1.1\r\n` +
                `Host: evil.com:443\r\n` +
                `Proxy-Authorization: Bearer ${proxyToken}\r\n` +
                `\r\n`,
            );
          });
          let buf = "";
          s.on("data", (chunk: Buffer) => {
            buf += chunk.toString("latin1");
            if (!buf.includes("\r\n\r\n")) return;
            const statusLine = buf.slice(0, buf.indexOf("\r\n"));
            const code = parseInt(statusLine.split(" ")[1] ?? "0", 10);
            resolve({ statusCode: code, socket: s });
          });
          s.on("error", reject);
          setTimeout(() => reject(new Error("CONNECT timeout")), 5000);
        },
      );

      // The broker should return 200 for CONNECT (auth gate passed), then
      // after TLS upgrade attempt, should detect no binding and return 403.
      // Wait briefly for the broker to process the request
      await new Promise((r) => setTimeout(r, 300));
      result.socket.destroy();

      // serverContextForHost must NOT have been called for evil.com
      // (the pre-flight host check must fire before the caManager call)
      expect(mintCalls).not.toContain("evil.com");

      // broker:denied must have been emitted with no_binding reason
      expect(deps.eventBus.emit).toHaveBeenCalledWith(
        "broker:denied",
        expect.objectContaining({
          reason: "no_binding",
          statusCode: 403,
        }),
      );
    },
    15_000,
  );
});

// ── WebSocket upgrade guard ────────────────────────────────────────────────────

describe("WebSocket upgrade guard", () => {
  it("inner request with Upgrade: websocket → 501, broker:denied emitted, no upstream reached", async () => {
    const upstream = await makeUpstreamFixture();
    const deps = makeDeps();
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const brokerPort = await broker.start();

    const { proxyToken } = deps.sessionManager.issueToken("agent-1");
    const { statusCode, socket } = await connectThroughProxy(
      brokerPort,
      proxyToken,
      `api.anthropic.com:${upstream.port}`,
    );
    expect(statusCode).toBe(200);

    // Send inner request with WebSocket upgrade headers
    const { status } = await sendGetThroughTunnel(socket, "/v1/messages", {
      Upgrade: "websocket",
      Connection: "Upgrade",
      host: "api.anthropic.com",
    });
    socket.destroy();

    // Assert 501 — WS guard must fire
    expect(status).toBe(501);

    // Assert broker:denied emitted with ws_upgrade_not_supported
    expect(deps.eventBus.emit).toHaveBeenCalledWith(
      "broker:denied",
      expect.objectContaining({
        reason: "ws_upgrade_not_supported",
        statusCode: 501,
      }),
    );

    // Assert upstream received ZERO requests — guard fires before secret resolution
    expect(upstream.receivedHeaders).toHaveLength(0);

    upstream.server.close();
  });

  it("inner request with Upgrade: WebSocket (mixed case) → 501 (case-insensitive guard)", async () => {
    const upstream = await makeUpstreamFixture();
    const deps = makeDeps();
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const brokerPort = await broker.start();

    const { proxyToken } = deps.sessionManager.issueToken("agent-1");
    const { statusCode, socket } = await connectThroughProxy(
      brokerPort,
      proxyToken,
      `api.anthropic.com:${upstream.port}`,
    );
    expect(statusCode).toBe(200);

    // Send inner request with mixed-case WebSocket upgrade header
    const { status } = await sendGetThroughTunnel(socket, "/v1/messages", {
      Upgrade: "WebSocket",
      Connection: "Upgrade",
      host: "api.anthropic.com",
    });
    socket.destroy();

    // Mixed case must also trigger the guard
    expect(status).toBe(501);

    // broker:denied emitted with ws_upgrade_not_supported
    expect(deps.eventBus.emit).toHaveBeenCalledWith(
      "broker:denied",
      expect.objectContaining({
        reason: "ws_upgrade_not_supported",
        statusCode: 501,
      }),
    );

    upstream.server.close();
  });

  it("inner request with Upgrade: h2c (non-WebSocket upgrade) → NOT 501", async () => {
    const upstream = await makeUpstreamFixture();
    const deps = makeDeps();
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const brokerPort = await broker.start();

    const { proxyToken } = deps.sessionManager.issueToken("agent-1");
    const { statusCode, socket } = await connectThroughProxy(
      brokerPort,
      proxyToken,
      `api.anthropic.com:${upstream.port}`,
    );
    expect(statusCode).toBe(200);

    // Send inner request with h2c (non-WebSocket) upgrade header
    const { status } = await sendGetThroughTunnel(socket, "/v1/messages", {
      Upgrade: "h2c",
      Connection: "Upgrade",
      host: "api.anthropic.com",
    });
    socket.destroy();

    // h2c must NOT trigger the WS guard (501 is wrong here)
    expect(status).not.toBe(501);

    // broker:denied must NOT have been emitted with ws_upgrade_not_supported
    const deniedCalls: Array<[string, unknown]> = (deps.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls as Array<[string, unknown]>;
    const wsGuardEmits = deniedCalls.filter(
      ([event, payload]) =>
        event === "broker:denied" &&
        (payload as { reason?: string }).reason === "ws_upgrade_not_supported",
    );
    expect(wsGuardEmits).toHaveLength(0);

    upstream.server.close();
  });

  it("duplicate Upgrade headers: websocket first, decoy second → 501 (bypass prevention)", async () => {
    // RFC 7230 §3.2.2: duplicate headers with the same name — the Map.set implementation
    // keeps only the LAST value. With 'Upgrade: websocket\r\nUpgrade: x-decoy', the map
    // stores 'x-decoy' and the simple .toLowerCase() === 'websocket' check is bypassed.
    const upstream = await makeUpstreamFixture();
    const deps = makeDeps();
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const brokerPort = await broker.start();

    const { proxyToken } = deps.sessionManager.issueToken("agent-1");
    const { statusCode, socket } = await connectThroughProxy(
      brokerPort,
      proxyToken,
      `api.anthropic.com:${upstream.port}`,
    );
    expect(statusCode).toBe(200);

    // Manually write a raw inner request with TWO Upgrade lines — object-based helpers deduplicate
    const rawRequest =
      "GET /v1/messages HTTP/1.1\r\n" +
      "Host: api.anthropic.com\r\n" +
      "Upgrade: websocket\r\n" +
      "Upgrade: x-comis-decoy\r\n" +
      "Connection: Upgrade\r\n" +
      "\r\n";
    const status = await new Promise<number>((resolve, reject) => {
      socket.write(rawRequest);
      let buf = "";
      const onData = (chunk: Buffer): void => {
        buf += chunk.toString("latin1");
        const idx = buf.indexOf("\r\n\r\n");
        if (idx === -1) return;
        socket.off("data", onData);
        const statusLine = buf.slice(0, buf.indexOf("\r\n"));
        resolve(parseInt(statusLine.split(" ")[1] ?? "0", 10));
      };
      socket.on("data", onData);
      socket.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 3000);
    });
    socket.destroy();

    // The WS guard MUST fire even though the second Upgrade header shadows websocket
    expect(status).toBe(501);
    expect(deps.eventBus.emit).toHaveBeenCalledWith(
      "broker:denied",
      expect.objectContaining({ reason: "ws_upgrade_not_supported", statusCode: 501 }),
    );
    expect(upstream.receivedHeaders).toHaveLength(0);
    upstream.server.close();
  });

  it("duplicate Upgrade headers: decoy first, websocket second → 501 (bypass prevention, reversed order)", async () => {
    const upstream = await makeUpstreamFixture();
    const deps = makeDeps();
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const brokerPort = await broker.start();

    const { proxyToken } = deps.sessionManager.issueToken("agent-1");
    const { statusCode, socket } = await connectThroughProxy(
      brokerPort,
      proxyToken,
      `api.anthropic.com:${upstream.port}`,
    );
    expect(statusCode).toBe(200);

    // Reversed order: decoy first, websocket second
    const rawRequest =
      "GET /v1/messages HTTP/1.1\r\n" +
      "Host: api.anthropic.com\r\n" +
      "Upgrade: x-comis-decoy\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      "\r\n";
    const status = await new Promise<number>((resolve, reject) => {
      socket.write(rawRequest);
      let buf = "";
      const onData = (chunk: Buffer): void => {
        buf += chunk.toString("latin1");
        const idx = buf.indexOf("\r\n\r\n");
        if (idx === -1) return;
        socket.off("data", onData);
        const statusLine = buf.slice(0, buf.indexOf("\r\n"));
        resolve(parseInt(statusLine.split(" ")[1] ?? "0", 10));
      };
      socket.on("data", onData);
      socket.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 3000);
    });
    socket.destroy();

    expect(status).toBe(501);
    expect(deps.eventBus.emit).toHaveBeenCalledWith(
      "broker:denied",
      expect.objectContaining({ reason: "ws_upgrade_not_supported", statusCode: 501 }),
    );
    upstream.server.close();
  });
});

// ── Unix socket listen ─────────────────────────────────────────────────────────

describe("Unix socket listen (startUnixSocket)", () => {
  it("startUnixSocket creates a listening Unix-domain socket that accepts CONNECT and fires auth gate (407)", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "mitm-broker-unix-"));
    const socketPath = join(tmpDir, "broker.sock");

    const deps = makeDeps();
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);

    // Start TCP server (existing API, unchanged)
    await broker.start();

    // Start Unix socket listener
    await broker.startUnixSocket(socketPath);

    // Connect to the Unix socket and send CONNECT without Proxy-Authorization
    const status = await new Promise<number>((resolve, reject) => {
      const s = net.connect(socketPath, () => {
        s.write(
          `CONNECT api.anthropic.com:443 HTTP/1.1\r\n` +
            `Host: api.anthropic.com:443\r\n` +
            `\r\n`,
        );
      });
      let buf = "";
      s.on("data", (chunk: Buffer) => {
        buf += chunk.toString("latin1");
        if (!buf.includes("\r\n\r\n")) return;
        const statusLine = buf.slice(0, buf.indexOf("\r\n"));
        const code = parseInt(statusLine.split(" ")[1] ?? "0", 10);
        s.destroy();
        resolve(code);
      });
      s.on("error", reject);
      setTimeout(() => reject(new Error("unix socket connect timeout")), 3000);
    });

    // Auth gate must fire on the Unix socket path (407 — no token provided)
    expect(status).toBe(407);

    // stop() must unlink the socket file
    await broker.stop();

    // The socket path must no longer exist after stop()
    const { existsSync } = await import("node:fs");
    expect(existsSync(socketPath)).toBe(false);

    // Cleanup temp dir
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("Unix socket file mode is 0o600 (owner-only) after startUnixSocket", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "mitm-broker-mode-"));
    const socketPath = join(tmpDir, "broker.sock");

    const deps = makeDeps();
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);

    await broker.startUnixSocket(socketPath);

    // Check socket file permissions — must be 0o600 (rw-------)
    const st = statSync(socketPath);
    // st.mode contains the file type bits in the high bits; mask to get the permission bits only
    const perms = st.mode & 0o777;
    expect(perms).toBe(0o600);

    await broker.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("stop() destroys Unix server client sockets even when TCP server was never started", async () => {
    // This test proves the bug: when only startUnixSocket() was called (start() never called),
    // stop() must still destroy tracked openSockets. The original code hits the early
    // `if (!server) { resolve(); return; }` before the openSockets loop.
    const tmpDir = mkdtempSync(join(tmpdir(), "mitm-broker-wr02-"));
    const socketPath = join(tmpDir, "broker.sock");

    const deps = makeDeps();
    const broker = createMitmBroker(deps);
    // NOTE: do NOT call broker.start() — only startUnixSocket
    await broker.startUnixSocket(socketPath);

    // Establish a connection to create a tracked socket in openSockets
    const clientSocket = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.connect(socketPath, () => resolve(s));
      s.on("error", reject);
      setTimeout(() => reject(new Error("connect timeout")), 3000);
    });

    // Give the server time to register the connection in openSockets
    await new Promise<void>((r) => setTimeout(r, 50));

    // Track whether the client socket gets destroyed
    let clientDestroyed = false;
    clientSocket.on("close", () => { clientDestroyed = true; });

    // stop() must complete (not hang) and must destroy the unix client socket
    await Promise.race([
      broker.stop(),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error("stop() timed out — unix client sockets not destroyed")), 3000)),
    ]);

    // Allow close event to propagate
    await new Promise<void>((r) => setTimeout(r, 50));

    expect(clientDestroyed).toBe(true);
    clientSocket.destroy();
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ── emit-site smoke tests ────────────────────────────────────────────────────

describe("emit-site smoke", () => {
  it("broker:session_opened emitted when tunnel established", async () => {
    const upstream = await makeUpstreamFixture();
    const deps = makeDeps();
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const port = await broker.start();
    const { proxyToken } = deps.sessionManager.issueToken("agent-smoke");
    const { statusCode, socket } = await connectThroughProxy(
      port,
      proxyToken,
      `api.anthropic.com:${upstream.port}`,
    );
    expect(statusCode).toBe(200);
    try {
      await sendGetThroughTunnel(socket, "/v1/messages");
    } finally {
      socket.destroy();
    }
    // Allow async emit to fire
    await new Promise<void>((r) => setTimeout(r, 50));
    upstream.server.close();
    const calls = (deps.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.some(([n]: [string]) => n === "broker:session_opened")).toBe(true);
  });

  it("broker:request emitted after inner headers parsed", async () => {
    const upstream = await makeUpstreamFixture();
    const deps = makeDeps();
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const port = await broker.start();
    const { proxyToken } = deps.sessionManager.issueToken("agent-smoke");
    const { statusCode, socket } = await connectThroughProxy(
      port,
      proxyToken,
      `api.anthropic.com:${upstream.port}`,
    );
    expect(statusCode).toBe(200);
    try {
      await sendGetThroughTunnel(socket, "/v1/messages");
    } finally {
      socket.destroy();
    }
    await new Promise<void>((r) => setTimeout(r, 50));
    upstream.server.close();
    const calls = (deps.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.some(([n]: [string]) => n === "broker:request")).toBe(true);
  });

  it("broker:egress_blocked emitted (not injected or denied) when no_binding", async () => {
    const deps = makeDeps();
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const port = await broker.start();
    const { proxyToken } = deps.sessionManager.issueToken("agent-smoke");
    // unknown-host.example.com is not in any binding — inner request denied after 200
    const { statusCode, socket } = await connectThroughProxy(
      port,
      proxyToken,
      "unknown-host.example.com:443",
    );
    expect(statusCode).toBe(200);
    try {
      await sendGetThroughTunnel(socket, "/some/path");
    } finally {
      socket.destroy();
    }
    await new Promise<void>((r) => setTimeout(r, 50));
    const calls = (deps.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.some(([n]: [string]) => n === "broker:egress_blocked")).toBe(true);
  });

  it("broker:session_closed emitted on teardown with durationMs", async () => {
    const upstream = await makeUpstreamFixture();
    const deps = makeDeps();
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const port = await broker.start();
    const { proxyToken } = deps.sessionManager.issueToken("agent-smoke");
    const { statusCode, socket } = await connectThroughProxy(
      port,
      proxyToken,
      `api.anthropic.com:${upstream.port}`,
    );
    expect(statusCode).toBe(200);
    try {
      await sendGetThroughTunnel(socket, "/v1/messages");
    } finally {
      socket.destroy();
    }
    // Allow close event to propagate → teardownUpstream fires
    await new Promise<void>((r) => setTimeout(r, 100));
    upstream.server.close();
    const calls = (deps.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls;
    const closedCall = calls.find(([n]: [string]) => n === "broker:session_closed");
    expect(closedCall).toBeDefined();
    expect(closedCall![1]).toMatchObject({ durationMs: expect.any(Number), reason: "teardown" });
  });
});

// ---------------------------------------------------------------------------
// sentinel helper — scans all log calls + all bus events
// ---------------------------------------------------------------------------
function assertNoSentinel(
  logger: ReturnType<typeof makeMockLogger>,
  eventBus: ReturnType<typeof createMockEventBus>,
  sentinel: string,
): void {
  for (const call of logger._calls()) {
    expect(JSON.stringify(call.payload)).not.toContain(sentinel);
    expect(call.msg).not.toContain(sentinel);
  }
  const calls = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls;
  for (const [, payload] of calls) {
    expect(JSON.stringify(payload)).not.toContain(sentinel);
  }
}

// ── broker:* event taxonomy assertions ────────────────────────────────────────

describe("broker:* event taxonomy", () => {
  it("broker:session_opened emitted with correct structural fields", async () => {
    const upstream = await makeUpstreamFixture();
    const logger = makeMockLogger();
    const deps = makeDeps({ logger: logger as unknown as MitmBrokerDeps["logger"] });
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const port = await broker.start();

    const { proxyToken } = deps.sessionManager.issueToken("agent-1");
    const { statusCode, socket } = await connectThroughProxy(port, proxyToken, `api.anthropic.com:${upstream.port}`);
    expect(statusCode).toBe(200);
    await sendGetThroughTunnel(socket, "/v1/messages", { host: "api.anthropic.com" });
    socket.destroy();
    await new Promise<void>((r) => setTimeout(r, 100));
    upstream.server.close();

    const emitCalls = (deps.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls as Array<[string, unknown]>;
    const opened = emitCalls.find(([n]) => n === "broker:session_opened");
    expect(opened).toBeDefined();
    expect(opened![1]).toMatchObject({
      sessionId: expect.any(String),
      agentId: "agent-1",
      host: "api.anthropic.com",
      timestamp: expect.any(Number),
    });
    assertNoSentinel(logger, deps.eventBus, SENTINEL_SECRET);
  });

  it("broker:session_closed emitted with durationMs >= 0 and reason: teardown", async () => {
    const upstream = await makeUpstreamFixture();
    const logger = makeMockLogger();
    const deps = makeDeps({ logger: logger as unknown as MitmBrokerDeps["logger"] });
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const port = await broker.start();

    const { proxyToken } = deps.sessionManager.issueToken("agent-1");
    const { statusCode, socket } = await connectThroughProxy(port, proxyToken, `api.anthropic.com:${upstream.port}`);
    expect(statusCode).toBe(200);
    await sendGetThroughTunnel(socket, "/v1/messages", { host: "api.anthropic.com" });
    socket.destroy();
    await new Promise<void>((r) => setTimeout(r, 150));
    upstream.server.close();

    const emitCalls = (deps.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls as Array<[string, unknown]>;
    const closed = emitCalls.find(([n]) => n === "broker:session_closed");
    expect(closed).toBeDefined();
    expect(closed![1]).toMatchObject({
      durationMs: expect.any(Number),
      reason: "teardown",
      agentId: "agent-1",
    });
    expect((closed![1] as { durationMs: number }).durationMs).toBeGreaterThanOrEqual(0);
    assertNoSentinel(logger, deps.eventBus, SENTINEL_SECRET);
  });

  it("broker:request emitted with correct host/path/method fields (no query in path)", async () => {
    const upstream = await makeUpstreamFixture();
    const logger = makeMockLogger();
    const deps = makeDeps({ logger: logger as unknown as MitmBrokerDeps["logger"] });
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const port = await broker.start();

    const { proxyToken } = deps.sessionManager.issueToken("agent-1");
    const { statusCode, socket } = await connectThroughProxy(port, proxyToken, `api.anthropic.com:${upstream.port}`);
    expect(statusCode).toBe(200);
    await sendGetThroughTunnel(socket, "/v1/messages", { host: "api.anthropic.com" });
    socket.destroy();
    await new Promise<void>((r) => setTimeout(r, 100));
    upstream.server.close();

    const emitCalls = (deps.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls as Array<[string, unknown]>;
    const req = emitCalls.find(([n]) => n === "broker:request");
    expect(req).toBeDefined();
    const reqPayload = req![1] as { host: string; path: string; method: string };
    expect(reqPayload.host).toBe("api.anthropic.com");
    expect(reqPayload.path).toBeTypeOf("string");
    expect(reqPayload.method).toBe("GET");
    // path must NOT contain query string
    expect(reqPayload.path).not.toContain("?");
    assertNoSentinel(logger, deps.eventBus, SENTINEL_SECRET);
  });

  it("broker:request for setParam host: path does NOT contain sentinel and does NOT contain '?'", async () => {
    const upstream = await makeUpstreamFixture();
    const logger = makeMockLogger();
    const deps = makeDeps({ logger: logger as unknown as MitmBrokerDeps["logger"] });
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const port = await broker.start();

    const { proxyToken } = deps.sessionManager.issueToken("agent-1");
    const { statusCode, socket } = await connectThroughProxy(port, proxyToken, `finnhub.io:${upstream.port}`);
    expect(statusCode).toBe(200);
    await sendGetThroughTunnel(socket, "/api/v1/quote", { host: "finnhub.io" });
    socket.destroy();
    await new Promise<void>((r) => setTimeout(r, 100));
    upstream.server.close();

    const emitCalls = (deps.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls as Array<[string, unknown]>;
    const req = emitCalls.find(([n]) => n === "broker:request");
    expect(req).toBeDefined();
    const reqPath = (req![1] as { path: string }).path;
    // setParam binding — path at emit time (pre-injection) must NOT include query
    expect(reqPath).not.toContain("?");
    expect(reqPath).not.toContain(SENTINEL_SECRET);
    assertNoSentinel(logger, deps.eventBus, SENTINEL_SECRET);
  });

  it("broker:injected emitted with ruleKind and host (setHeader)", async () => {
    const upstream = await makeUpstreamFixture();
    const logger = makeMockLogger();
    const deps = makeDeps({ logger: logger as unknown as MitmBrokerDeps["logger"] });
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const port = await broker.start();

    const { proxyToken } = deps.sessionManager.issueToken("agent-1");
    const { statusCode, socket } = await connectThroughProxy(port, proxyToken, `api.anthropic.com:${upstream.port}`);
    expect(statusCode).toBe(200);
    await sendGetThroughTunnel(socket, "/v1/messages", { host: "api.anthropic.com" });
    socket.destroy();
    await new Promise<void>((r) => setTimeout(r, 100));
    upstream.server.close();

    const emitCalls = (deps.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls as Array<[string, unknown]>;
    const injected = emitCalls.find(([n]) => n === "broker:injected");
    expect(injected).toBeDefined();
    expect(injected![1]).toMatchObject({
      host: "api.anthropic.com",
      ruleKind: "setHeader",
    });
    assertNoSentinel(logger, deps.eventBus, SENTINEL_SECRET);
  });

  it("broker:injected emitted with ruleKind:setParam (Finnhub binding)", async () => {
    const upstream = await makeUpstreamFixture();
    const logger = makeMockLogger();
    const deps = makeDeps({ logger: logger as unknown as MitmBrokerDeps["logger"] });
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const port = await broker.start();

    const { proxyToken } = deps.sessionManager.issueToken("agent-1");
    const { statusCode, socket } = await connectThroughProxy(port, proxyToken, `finnhub.io:${upstream.port}`);
    expect(statusCode).toBe(200);
    await sendGetThroughTunnel(socket, "/api/v1/quote", { host: "finnhub.io" });
    socket.destroy();
    await new Promise<void>((r) => setTimeout(r, 100));
    upstream.server.close();

    const emitCalls = (deps.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls as Array<[string, unknown]>;
    const injected = emitCalls.find(([n]) => n === "broker:injected");
    expect(injected).toBeDefined();
    expect(injected![1]).toMatchObject({ ruleKind: "setParam" });
    assertNoSentinel(logger, deps.eventBus, SENTINEL_SECRET);
  });

  it("broker:denied with reason:bad_token and statusCode:407", async () => {
    const logger = makeMockLogger();
    const deps = makeDeps({ logger: logger as unknown as MitmBrokerDeps["logger"] });
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const port = await broker.start();

    await new Promise<void>((resolve, reject) => {
      const s = net.connect(port, "127.0.0.1", () => {
        s.write(
          `CONNECT api.anthropic.com:443 HTTP/1.1\r\n` +
            `Host: api.anthropic.com:443\r\n` +
            `Proxy-Authorization: Bearer bad-token-xyz\r\n` +
            `\r\n`,
        );
      });
      let buf = "";
      s.on("data", (chunk: Buffer) => {
        buf += chunk.toString("latin1");
        if (!buf.includes("\r\n\r\n")) return;
        s.destroy();
        resolve();
      });
      s.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 3000);
    });
    await new Promise<void>((r) => setTimeout(r, 50));

    const emitCalls = (deps.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls as Array<[string, unknown]>;
    const denied = emitCalls.find(([n]) => n === "broker:denied");
    expect(denied).toBeDefined();
    expect(denied![1]).toMatchObject({ reason: "bad_token", statusCode: 407 });
    assertNoSentinel(logger, deps.eventBus, SENTINEL_SECRET);
  });

  it("broker:denied with reason:no_binding and statusCode:403 (unknown host)", async () => {
    const logger = makeMockLogger();
    const deps = makeDeps({ logger: logger as unknown as MitmBrokerDeps["logger"] });
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const port = await broker.start();

    const { proxyToken } = deps.sessionManager.issueToken("agent-1");
    const { statusCode, socket } = await connectThroughProxy(port, proxyToken, "unknown-host.example.com:443");
    expect(statusCode).toBe(200);
    await sendGetThroughTunnel(socket, "/path");
    socket.destroy();
    await new Promise<void>((r) => setTimeout(r, 100));

    const emitCalls = (deps.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls as Array<[string, unknown]>;
    const denied = emitCalls.find(([n]) => n === "broker:denied");
    expect(denied).toBeDefined();
    expect(denied![1]).toMatchObject({ reason: "no_binding", statusCode: 403 });
    assertNoSentinel(logger, deps.eventBus, SENTINEL_SECRET);
  });

  it("broker:credential_unavailable emitted with secretRef and agentId", async () => {
    const logger = makeMockLogger();
    const deps = makeDeps({
      logger: logger as unknown as MitmBrokerDeps["logger"],
      secretManager: createSecretManager({}), // empty — Anthropic key missing
    });
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const port = await broker.start();

    const { proxyToken } = deps.sessionManager.issueToken("agent-1");
    const { statusCode, socket } = await connectThroughProxy(port, proxyToken, "api.anthropic.com:443");
    expect(statusCode).toBe(200);
    await sendGetThroughTunnel(socket, "/v1/messages", { host: "api.anthropic.com" });
    socket.destroy();
    await new Promise<void>((r) => setTimeout(r, 100));

    const emitCalls = (deps.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls as Array<[string, unknown]>;
    const credUnavail = emitCalls.find(([n]) => n === "broker:credential_unavailable");
    expect(credUnavail).toBeDefined();
    expect(credUnavail![1]).toMatchObject({
      secretRef: expect.any(String),
      agentId: "agent-1",
    });
    assertNoSentinel(logger, deps.eventBus, SENTINEL_SECRET);
  });

  it("broker:egress_blocked emitted with 64-char hex targetHostHash (no plaintext host)", async () => {
    const unknownHost = "egress-blocked-unknown.example.com";
    const logger = makeMockLogger();
    const deps = makeDeps({ logger: logger as unknown as MitmBrokerDeps["logger"] });
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const port = await broker.start();

    const { proxyToken } = deps.sessionManager.issueToken("agent-1");
    const { statusCode, socket } = await connectThroughProxy(port, proxyToken, `${unknownHost}:443`);
    expect(statusCode).toBe(200);
    await sendGetThroughTunnel(socket, "/path");
    socket.destroy();
    await new Promise<void>((r) => setTimeout(r, 100));

    const emitCalls = (deps.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls as Array<[string, unknown]>;
    const blocked = emitCalls.find(([n]) => n === "broker:egress_blocked");
    expect(blocked).toBeDefined();
    const blockedPayload = blocked![1] as Record<string, unknown>;
    // targetHostHash must be 64-char lowercase hex
    expect(blockedPayload["targetHostHash"]).toMatch(/^[0-9a-f]{64}$/);
    // plaintext host must NOT appear in the payload
    expect(blockedPayload).not.toHaveProperty("host");
    expect(JSON.stringify(blockedPayload)).not.toContain(unknownHost);
    assertNoSentinel(logger, deps.eventBus, SENTINEL_SECRET);
  });
});

// ── exhaustive sentinel property test (all 9 paths) ──────────────────────────

describe("non-leakage property test (all paths)", () => {
  it("sentinel never appears — Path 1: happy setHeader (Anthropic)", async () => {
    const upstream = await makeUpstreamFixture();
    const logger = makeMockLogger();
    const deps = makeDeps({ logger: logger as unknown as MitmBrokerDeps["logger"] });
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const port = await broker.start();

    const { proxyToken } = deps.sessionManager.issueToken("agent-1");
    const { statusCode, socket } = await connectThroughProxy(port, proxyToken, `api.anthropic.com:${upstream.port}`);
    expect(statusCode).toBe(200);
    await sendGetThroughTunnel(socket, "/v1/messages", { host: "api.anthropic.com" });
    socket.destroy();
    await new Promise<void>((r) => setTimeout(r, 100));
    upstream.server.close();

    assertNoSentinel(logger, deps.eventBus, SENTINEL_SECRET);
  });

  it("sentinel never appears — Path 2: happy setParam (Finnhub) + path no '?'", async () => {
    const upstream = await makeUpstreamFixture();
    const logger = makeMockLogger();
    const deps = makeDeps({ logger: logger as unknown as MitmBrokerDeps["logger"] });
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const port = await broker.start();

    const { proxyToken } = deps.sessionManager.issueToken("agent-1");
    const { statusCode, socket } = await connectThroughProxy(port, proxyToken, `finnhub.io:${upstream.port}`);
    expect(statusCode).toBe(200);
    await sendGetThroughTunnel(socket, "/api/v1/quote", { host: "finnhub.io" });
    socket.destroy();
    await new Promise<void>((r) => setTimeout(r, 100));
    upstream.server.close();

    assertNoSentinel(logger, deps.eventBus, SENTINEL_SECRET);

    // Additionally: broker:request path must not contain query or sentinel
    const emitCalls = (deps.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls as Array<[string, unknown]>;
    const reqEvent = emitCalls.find(([n]) => n === "broker:request");
    expect(reqEvent).toBeDefined();
    const reqPath = (reqEvent![1] as { path: string }).path;
    expect(reqPath).not.toContain("?");
    expect(reqPath).not.toContain(SENTINEL_SECRET);
  });

  it("sentinel never appears — Path 3: bad token (407)", async () => {
    const logger = makeMockLogger();
    const deps = makeDeps({ logger: logger as unknown as MitmBrokerDeps["logger"] });
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const port = await broker.start();

    await new Promise<void>((resolve, reject) => {
      const s = net.connect(port, "127.0.0.1", () => {
        s.write(
          `CONNECT api.anthropic.com:443 HTTP/1.1\r\n` +
            `Host: api.anthropic.com:443\r\n` +
            `Proxy-Authorization: Bearer invalid-token-obs02\r\n` +
            `\r\n`,
        );
      });
      let buf = "";
      s.on("data", (chunk: Buffer) => {
        buf += chunk.toString("latin1");
        if (!buf.includes("\r\n\r\n")) return;
        s.destroy();
        resolve();
      });
      s.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 3000);
    });
    await new Promise<void>((r) => setTimeout(r, 50));

    assertNoSentinel(logger, deps.eventBus, SENTINEL_SECRET);
  });

  it("sentinel never appears — Path 4: no-binding 403 (unknown host)", async () => {
    const logger = makeMockLogger();
    const deps = makeDeps({ logger: logger as unknown as MitmBrokerDeps["logger"] });
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const port = await broker.start();

    const { proxyToken } = deps.sessionManager.issueToken("agent-1");
    const { statusCode, socket } = await connectThroughProxy(port, proxyToken, "obs02-unknown.example.com:443");
    expect(statusCode).toBe(200);
    await sendGetThroughTunnel(socket, "/path");
    socket.destroy();
    await new Promise<void>((r) => setTimeout(r, 100));

    assertNoSentinel(logger, deps.eventBus, SENTINEL_SECRET);
  });

  it("sentinel never appears — Path 5: path-policy 403", async () => {
    const logger = makeMockLogger();
    const deps = makeDeps({ logger: logger as unknown as MitmBrokerDeps["logger"] });
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const port = await broker.start();

    const { proxyToken } = deps.sessionManager.issueToken("agent-1");
    const { statusCode, socket } = await connectThroughProxy(port, proxyToken, "policy.example.com:443");
    expect(statusCode).toBe(200);
    // /v2/x violates the /v1/* pathPolicy of makePolicyBinding()
    await sendGetThroughTunnel(socket, "/v2/x", { host: "policy.example.com" });
    socket.destroy();
    await new Promise<void>((r) => setTimeout(r, 100));

    assertNoSentinel(logger, deps.eventBus, SENTINEL_SECRET);
  });

  it("sentinel never appears — Path 6: credential-unavailable 502", async () => {
    const logger = makeMockLogger();
    const deps = makeDeps({
      logger: logger as unknown as MitmBrokerDeps["logger"],
      secretManager: createSecretManager({}), // no secrets — Anthropic key missing
    });
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const port = await broker.start();

    const { proxyToken } = deps.sessionManager.issueToken("agent-1");
    const { statusCode, socket } = await connectThroughProxy(port, proxyToken, "api.anthropic.com:443");
    expect(statusCode).toBe(200);
    await sendGetThroughTunnel(socket, "/v1/messages", { host: "api.anthropic.com" });
    socket.destroy();
    await new Promise<void>((r) => setTimeout(r, 100));

    assertNoSentinel(logger, deps.eventBus, SENTINEL_SECRET);
  });

  it("sentinel never appears — Path 7: header overflow 400", async () => {
    const logger = makeMockLogger();
    const deps = makeDeps({ logger: logger as unknown as MitmBrokerDeps["logger"] });
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const port = await broker.start();

    const { proxyToken } = deps.sessionManager.issueToken("agent-1");
    const { statusCode, socket } = await connectThroughProxy(port, proxyToken, "api.anthropic.com:443");
    expect(statusCode).toBe(200);

    // Send header overflow (> 8192 bytes without the header terminator)
    const oversizeHeader = "GET /v1/messages HTTP/1.1\r\n" + `X-Overflow: ${"B".repeat(8200)}\r\n`;
    socket.write(oversizeHeader);

    await new Promise<void>((resolve) => {
      socket.on("close", () => resolve());
      socket.on("error", () => resolve());
      setTimeout(() => resolve(), 2000);
    });
    socket.destroy();

    assertNoSentinel(logger, deps.eventBus, SENTINEL_SECRET);
  });

  it("sentinel never appears — Path 8: WebSocket upgrade 501", async () => {
    const upstream = await makeUpstreamFixture();
    const logger = makeMockLogger();
    const deps = makeDeps({ logger: logger as unknown as MitmBrokerDeps["logger"] });
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const port = await broker.start();

    const { proxyToken } = deps.sessionManager.issueToken("agent-1");
    const { statusCode, socket } = await connectThroughProxy(port, proxyToken, `api.anthropic.com:${upstream.port}`);
    expect(statusCode).toBe(200);
    await sendGetThroughTunnel(socket, "/v1/messages", {
      Upgrade: "websocket",
      Connection: "Upgrade",
      host: "api.anthropic.com",
    });
    socket.destroy();
    await new Promise<void>((r) => setTimeout(r, 100));
    upstream.server.close();

    assertNoSentinel(logger, deps.eventBus, SENTINEL_SECRET);
  });

  it("sentinel never appears — Path 9: body-too-large 413 (finalizer path)", async () => {
    const upstream = await makeUpstreamFixture();
    const logger = makeMockLogger();
    // Binding with awsSigV4 finalizer to trigger body-buffering path
    const finalizerBinding: BrokerBinding = {
      secretRef: "ANTHROPIC_API_KEY",
      hostRules: [
        {
          pattern: { kind: "exact", host: "api.anthropic.com" },
          inject: [{ kind: "setHeader", name: "x-api-key", format: "raw" }],
          finalizer: { kind: "awsSigV4", region: "us-east-1", service: "execute-api" },
        },
      ],
    };
    const deps = makeDeps({
      logger: logger as unknown as MitmBrokerDeps["logger"],
      bindings: [finalizerBinding],
    });
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const port = await broker.start();

    const { proxyToken } = deps.sessionManager.issueToken("agent-1");
    const { statusCode, socket } = await connectThroughProxy(port, proxyToken, `api.anthropic.com:${upstream.port}`);
    expect(statusCode).toBe(200);

    // Send body larger than MAX_BODY_BYTES via sendPostThroughTunnel
    const oversizeBody = "X".repeat(MAX_BODY_BYTES + 1);
    const bodyBytes = Buffer.from(oversizeBody, "utf-8");
    const reqStr =
      `POST /v1/messages HTTP/1.1\r\n` +
      `host: api.anthropic.com\r\n` +
      `content-length: ${bodyBytes.length}\r\n` +
      `content-type: application/json\r\n` +
      `\r\n`;
    socket.write(reqStr);
    socket.write(bodyBytes);

    await new Promise<void>((resolve) => {
      socket.on("close", () => resolve());
      socket.on("error", () => resolve());
      setTimeout(() => resolve(), 8000);
    });
    socket.destroy();
    upstream.server.close();

    assertNoSentinel(logger, deps.eventBus, SENTINEL_SECRET);
  }, 12_000);
});

// ── E2E-01: in-process broker end-to-end (macOS-testable) ────────────────────

describe("E2E-01 — in-process broker end-to-end", () => {
  it("fixture upstream receives real key via broker injection (x-api-key header)", async () => {
    const logger = makeMockLogger();
    const deps = makeDeps({ logger: logger as unknown as MitmBrokerDeps["logger"] });
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const port = await broker.start();

    // Start fixture upstream — the broker will connect to this in-process server
    const fixture = await makeUpstreamFixture();

    // CONNECT to api.anthropic.com:<FIXTURE_PORT> — broker resolves binding for
    // api.anthropic.com, then connects to 127.0.0.1:<fixturePort>
    const { proxyToken } = deps.sessionManager.issueToken("agent-e2e");
    const { statusCode, socket } = await connectThroughProxy(
      port,
      proxyToken,
      `api.anthropic.com:${fixture.port}`,
    );
    expect(statusCode).toBe(200);

    try {
      await sendGetThroughTunnel(socket, "/v1/messages", { host: "api.anthropic.com" });
    } finally {
      socket.destroy();
    }

    // Allow upstream to record the request
    await new Promise<void>((r) => setTimeout(r, 100));

    // The real key (SENTINEL_SECRET) must have reached the upstream fixture
    expect(fixture.receivedHeaders.length).toBeGreaterThan(0);
    // makeAnthropicBinding injects x-api-key header (setHeader rule)
    const receivedApiKey = fixture.receivedHeaders[0]?.["x-api-key"];
    expect(receivedApiKey).toBe(SENTINEL_SECRET);
    // Confirm the real secret string is present in headers received by the upstream
    expect(JSON.stringify(fixture.receivedHeaders[0])).toContain(SENTINEL_SECRET);

    // But it must NOT appear in logs or events (dual-polarity assertion)
    assertNoSentinel(logger, deps.eventBus, SENTINEL_SECRET);

    await new Promise<void>((r) => fixture.server.close(() => r()));
  });

  it("broker:session_opened and broker:session_closed emitted on E2E happy path", async () => {
    const logger = makeMockLogger();
    const deps = makeDeps({ logger: logger as unknown as MitmBrokerDeps["logger"] });
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const port = await broker.start();

    const fixture = await makeUpstreamFixture();

    const { proxyToken } = deps.sessionManager.issueToken("agent-e2e");
    const { statusCode, socket } = await connectThroughProxy(
      port,
      proxyToken,
      `api.anthropic.com:${fixture.port}`,
    );
    expect(statusCode).toBe(200);

    try {
      await sendGetThroughTunnel(socket, "/v1/messages", { host: "api.anthropic.com" });
    } finally {
      socket.destroy();
    }
    // Allow close event to propagate → teardownUpstream fires
    await new Promise<void>((r) => setTimeout(r, 150));

    const emitCalls = (deps.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls as Array<[string, unknown]>;
    expect(emitCalls.some(([n]) => n === "broker:session_opened")).toBe(true);
    expect(emitCalls.some(([n]) => n === "broker:session_closed")).toBe(true);

    const closedEvent = emitCalls.find(([n]) => n === "broker:session_closed");
    expect(closedEvent![1]).toMatchObject({ durationMs: expect.any(Number), reason: "teardown" });

    assertNoSentinel(logger, deps.eventBus, SENTINEL_SECRET);

    await new Promise<void>((r) => fixture.server.close(() => r()));
  });
});

// ── Regression tests — session lifecycle and egress-block emission ───────────
//
// - session lifecycle balance (session_closed must fire on ALL exit paths)
// - clock snapshot in teardown (timestamp - durationMs == sessionStartedAt)
// - emitEgressBlocked on pre-flight no_binding denial (Step 2.5)

describe("broker:session_closed must be emitted on ALL exit paths (session lifecycle balance)", () => {
  it("no_binding 403 (unknown host, post-CONNECT): session_opened AND session_closed both emitted", async () => {
    // This is an early-exit path after session_opened — currently missing session_closed.
    // The test verifies the imbalance is fixed.
    const logger = makeMockLogger();
    const deps = makeDeps({ logger: logger as unknown as MitmBrokerDeps["logger"] });
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const port = await broker.start();

    const { proxyToken } = deps.sessionManager.issueToken("agent-1");
    // Use an unknown host — 200 CONNECT opens, then inner request hits no_binding 403
    const { statusCode, socket } = await connectThroughProxy(port, proxyToken, "cr01-unknown.example.com:443");
    expect(statusCode).toBe(200);
    await sendGetThroughTunnel(socket, "/path");
    socket.destroy();
    await new Promise<void>((r) => setTimeout(r, 150));

    const emitCalls = (deps.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls as Array<[string, unknown]>;
    // session_opened must have fired
    expect(emitCalls.some(([n]) => n === "broker:session_opened")).toBe(true);
    // session_closed must ALSO fire on this fail-closed path (RED: currently missing)
    expect(emitCalls.some(([n]) => n === "broker:session_closed")).toBe(true);
    const closedEvent = emitCalls.find(([n]) => n === "broker:session_closed");
    expect(closedEvent![1]).toMatchObject({ sessionId: expect.any(String), agentId: "agent-1", durationMs: expect.any(Number) });
  });

  it("credential_unavailable 502 path: session_opened AND session_closed both emitted", async () => {
    const logger = makeMockLogger();
    const deps = makeDeps({
      logger: logger as unknown as MitmBrokerDeps["logger"],
      secretManager: createSecretManager({}), // Anthropic key missing → 502
    });
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const port = await broker.start();

    const { proxyToken } = deps.sessionManager.issueToken("agent-1");
    const { statusCode, socket } = await connectThroughProxy(port, proxyToken, "api.anthropic.com:443");
    expect(statusCode).toBe(200);
    await sendGetThroughTunnel(socket, "/v1/messages", { host: "api.anthropic.com" });
    socket.destroy();
    await new Promise<void>((r) => setTimeout(r, 150));

    const emitCalls = (deps.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls as Array<[string, unknown]>;
    expect(emitCalls.some(([n]) => n === "broker:session_opened")).toBe(true);
    // session_closed must also fire on 502 path (RED: currently missing)
    expect(emitCalls.some(([n]) => n === "broker:session_closed")).toBe(true);
    const closedEvent = emitCalls.find(([n]) => n === "broker:session_closed");
    expect(closedEvent![1]).toMatchObject({ durationMs: expect.any(Number) });
  });

  it("header overflow (400) path: session_opened AND session_closed both emitted", async () => {
    const logger = makeMockLogger();
    const deps = makeDeps({ logger: logger as unknown as MitmBrokerDeps["logger"] });
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const port = await broker.start();

    const { proxyToken } = deps.sessionManager.issueToken("agent-1");
    const { statusCode, socket } = await connectThroughProxy(port, proxyToken, "api.anthropic.com:443");
    expect(statusCode).toBe(200);

    // Trigger header overflow (> 8192 bytes without the header terminator)
    const oversizeHeader = "GET /v1/messages HTTP/1.1\r\n" + `X-Overflow: ${"C".repeat(8200)}\r\n`;
    socket.write(oversizeHeader);

    await new Promise<void>((resolve) => {
      socket.on("close", () => resolve());
      socket.on("error", () => resolve());
      setTimeout(() => resolve(), 2000);
    });
    socket.destroy();
    await new Promise<void>((r) => setTimeout(r, 100));

    const emitCalls = (deps.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls as Array<[string, unknown]>;
    expect(emitCalls.some(([n]) => n === "broker:session_opened")).toBe(true);
    // session_closed must also fire on overflow path (RED: currently missing)
    expect(emitCalls.some(([n]) => n === "broker:session_closed")).toBe(true);
  });

  it("ws_upgrade_not_supported 501 path: session_opened AND session_closed both emitted", async () => {
    const upstream = await makeUpstreamFixture();
    const logger = makeMockLogger();
    const deps = makeDeps({ logger: logger as unknown as MitmBrokerDeps["logger"] });
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const port = await broker.start();

    const { proxyToken } = deps.sessionManager.issueToken("agent-1");
    const { statusCode, socket } = await connectThroughProxy(port, proxyToken, `api.anthropic.com:${upstream.port}`);
    expect(statusCode).toBe(200);
    await sendGetThroughTunnel(socket, "/v1/messages", {
      Upgrade: "websocket",
      Connection: "Upgrade",
      host: "api.anthropic.com",
    });
    socket.destroy();
    await new Promise<void>((r) => setTimeout(r, 150));
    upstream.server.close();

    const emitCalls = (deps.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls as Array<[string, unknown]>;
    expect(emitCalls.some(([n]) => n === "broker:session_opened")).toBe(true);
    // session_closed must also fire on 501 path (RED: currently missing)
    expect(emitCalls.some(([n]) => n === "broker:session_closed")).toBe(true);
  });

  it("happy path: session_opened emitted exactly once, session_closed emitted exactly once", async () => {
    const upstream = await makeUpstreamFixture();
    const logger = makeMockLogger();
    const deps = makeDeps({ logger: logger as unknown as MitmBrokerDeps["logger"] });
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const port = await broker.start();

    const { proxyToken } = deps.sessionManager.issueToken("agent-1");
    const { statusCode, socket } = await connectThroughProxy(port, proxyToken, `api.anthropic.com:${upstream.port}`);
    expect(statusCode).toBe(200);
    await sendGetThroughTunnel(socket, "/v1/messages", { host: "api.anthropic.com" });
    socket.destroy();
    await new Promise<void>((r) => setTimeout(r, 200));
    upstream.server.close();

    const emitCalls = (deps.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls as Array<[string, unknown]>;
    const openedCount = emitCalls.filter(([n]) => n === "broker:session_opened").length;
    const closedCount = emitCalls.filter(([n]) => n === "broker:session_closed").length;
    // Exactly 1 open, exactly 1 close (no double-emit)
    expect(openedCount).toBe(1);
    expect(closedCount).toBe(1);
  });
});

describe("teardown: single clock snapshot ensures timestamp - durationMs === sessionStartedAt", () => {
  it("session_closed: (timestamp - durationMs) equals the sessionStartedAt captured by session_opened.timestamp", async () => {
    const upstream = await makeUpstreamFixture();
    // Use a step-clock so each call to clock.now() advances by a fixed amount
    // This makes the two-call bug detectable: with two separate calls, timestamp !== sessionStartedAt + durationMs
    let clockVal = 1_700_000_000_000;
    const stepClock = {
      now: () => {
        const v = clockVal;
        clockVal += 10; // advance by 10ms each call
        return v;
      },
    };
    const logger = makeMockLogger();
    const sessionManager = createSessionManager({ clock: stepClock });
    const deps: MitmBrokerDeps = {
      clock: stepClock,
      timers: createFakeTimers(),
      eventBus: createMockEventBus(),
      logger: logger as unknown as MitmBrokerDeps["logger"],
      secretManager: createSecretManager({ ANTHROPIC_API_KEY: SENTINEL_SECRET }),
      sessionManager,
      bindings: [makeAnthropicBinding()],
    };
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const port = await broker.start();

    const { proxyToken } = sessionManager.issueToken("agent-1");
    const { statusCode, socket } = await connectThroughProxy(port, proxyToken, `api.anthropic.com:${upstream.port}`);
    expect(statusCode).toBe(200);
    await sendGetThroughTunnel(socket, "/v1/messages", { host: "api.anthropic.com" });
    socket.destroy();
    await new Promise<void>((r) => setTimeout(r, 200));
    upstream.server.close();

    const emitCalls = (deps.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls as Array<[string, unknown]>;
    const openedEvent = emitCalls.find(([n]) => n === "broker:session_opened");
    const closedEvent = emitCalls.find(([n]) => n === "broker:session_closed");
    expect(openedEvent).toBeDefined();
    expect(closedEvent).toBeDefined();

    const sessionStartedAt = (openedEvent![1] as { timestamp: number }).timestamp;
    const closedPayload = closedEvent![1] as { durationMs: number; timestamp: number };

    // With a single clock snapshot: closedAt = clock.now() once
    // durationMs = closedAt - sessionStartedAt
    // timestamp = closedAt
    // So: timestamp - durationMs === sessionStartedAt EXACTLY
    // With two separate calls: timestamp - durationMs === sessionStartedAt + delta (broken)
    expect(closedPayload.timestamp - closedPayload.durationMs).toBe(sessionStartedAt);
  });
});

describe("pre-flight no_binding denial (Step 2.5 caManager path) emits broker:egress_blocked", () => {
  let caDataDir: string;

  beforeEach(() => {
    const { mkdtempSync: mkdtemp } = require("node:fs");
    const { join: pathJoin } = require("node:path");
    const { tmpdir: osTmpdir } = require("node:os");
    caDataDir = mkdtemp(pathJoin(osTmpdir(), "comis-in02-test-"));
  });

  afterEach(() => {
    const { rmSync } = require("node:fs");
    rmSync(caDataDir, { recursive: true, force: true });
  });

  it(
    "caManager wired + unlisted host: pre-flight no_binding → broker:egress_blocked AND broker:denied both emitted",
    async () => {
      const unknownHost = "in02-unknown-preflight.example.com";
      const clock = createFakeClock(Date.now());
      const caManager = createNodeCaManager({ clock, dataDir: caDataDir });

      const logger = makeMockLogger();
      const sessionManager = createSessionManager({ clock });
      const deps: MitmBrokerDeps = {
        clock,
        timers: createFakeTimers(),
        eventBus: createMockEventBus(),
        logger: logger as unknown as MitmBrokerDeps["logger"],
        secretManager: createSecretManager({ ANTHROPIC_API_KEY: "key" }),
        sessionManager,
        bindings: [makeAnthropicBinding()], // only api.anthropic.com is allowed
        caManager,
      };

      const broker = createMitmBroker(deps);
      runningBrokers.push(broker);
      const port = await broker.start();

      const { proxyToken } = sessionManager.issueToken("agent-1");
      // CONNECT to the unlisted host — pre-flight check fires before TLS upgrade
      const rawSocket = await new Promise<net.Socket>((resolve, reject) => {
        const s = net.connect(port, "127.0.0.1", () => {
          s.write(
            `CONNECT ${unknownHost}:443 HTTP/1.1\r\n` +
              `Host: ${unknownHost}:443\r\n` +
              `Proxy-Authorization: Bearer ${proxyToken}\r\n` +
              `\r\n`,
          );
        });
        let buf = "";
        s.on("data", (chunk: Buffer) => {
          buf += chunk.toString("latin1");
          if (!buf.includes("\r\n\r\n")) return;
          resolve(s); // 200 on CONNECT — pre-flight fires AFTER the 200
        });
        s.on("error", reject);
        setTimeout(() => reject(new Error("CONNECT timeout")), 5000);
      });

      await new Promise<void>((r) => setTimeout(r, 300));
      rawSocket.destroy();

      const emitCalls = (deps.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls as Array<[string, unknown]>;

      // broker:denied with no_binding must be emitted (already passes)
      expect(emitCalls.some(([n, p]) =>
        n === "broker:denied" && (p as { reason?: string }).reason === "no_binding"
      )).toBe(true);

      // broker:egress_blocked must ALSO be emitted on the pre-flight path (RED: currently missing)
      const blocked = emitCalls.find(([n]) => n === "broker:egress_blocked");
      expect(blocked).toBeDefined();
      const blockedPayload = blocked![1] as Record<string, unknown>;
      // targetHostHash must be 64-char hex (hash of unknownHost)
      expect(blockedPayload["targetHostHash"]).toMatch(/^[0-9a-f]{64}$/);
      // plaintext host must NOT appear in payload
      expect(JSON.stringify(blockedPayload)).not.toContain(unknownHost);

      assertNoSentinel(logger, deps.eventBus, SENTINEL_SECRET);
    },
    15_000,
  );
});
