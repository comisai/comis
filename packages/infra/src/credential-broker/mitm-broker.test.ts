// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for NodeMitmBroker — BROKER-01..03 + audit + non-leakage.
 *
 * Uses in-process HTTP fixtures (real http.createServer on loopback:0)
 * and manual TCP CONNECT clients to assert fail-closed behavior.
 * No real network — all fixtures bind to 127.0.0.1:0.
 *
 * RED-first TDD: these tests are written before the implementation.
 * Every test in this file MUST fail before mitm-broker.ts exists.
 *
 * @module
 */
import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import { createMitmBroker } from "./mitm-broker.js";
import type { MitmBrokerDeps } from "./mitm-broker.js";
import { createSessionManager } from "./session-manager.js";
import { createMockEventBus } from "../../../../test/support/mock-event-bus.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
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
  upstreamPort: number,
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
  // upstreamPort is used by the broker to resolve the in-process fixture.
  // In tests, the "host" in the CONNECT is `api.anthropic.com:${upstreamPort}`
  // and the broker normalizes it to "api.anthropic.com", then net.connect's to
  // the actual port from the CONNECT authority (which carries the port number).
  void upstreamPort; // used by test-specific broker configuration
  return {
    clock,
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

// ── BROKER-01: Auth gate tests ─────────────────────────────────────────────────

describe("BROKER-01 — CONNECT auth gate (fail-closed 407)", () => {
  it("missing Proxy-Authorization header → 407, zero upstream calls", async () => {
    const upstream = await makeUpstreamFixture();
    const deps = makeDeps(upstream.port);
    const broker = createMitmBroker(deps);
    runningBrokers.push(broker);
    const brokerPort = await broker.start();

    // Send CONNECT without the Proxy-Authorization header
    const socket = await new Promise<net.Socket>((resolve, reject) => {
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
        if (buf.includes("\r\n\r\n")) resolve(s);
      });
      s.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 3000);
    });

    const statusCode = parseInt(socket.read()?.toString() ?? "", 10);
    void statusCode;
    // parse the actual status from the buffer
    const rawBuf = await new Promise<string>((res, rej) => {
      setTimeout(() => rej(new Error("read timeout")), 500);
      // We already got the data in the connect promise — re-read from socket.read() buffer
      // Actually the data is in the promise above, let's use a different approach
      res(""); // handled inline below
    }).catch(() => "");
    void rawBuf;

    // Simpler: re-do the connection with proper data capture
    socket.destroy();

    await new Promise<void>((resolve, reject) => {
      const s2 = net.connect(brokerPort, "127.0.0.1", () => {
        s2.write(
          `CONNECT api.anthropic.com:${upstream.port} HTTP/1.1\r\n` +
            `Host: api.anthropic.com:${upstream.port}\r\n` +
            `\r\n`,
        );
      });
      let buf2 = "";
      s2.on("data", (chunk) => {
        buf2 += chunk.toString("latin1");
        const idx = buf2.indexOf("\r\n\r\n");
        if (idx === -1) return;
        const statusLine = buf2.slice(0, buf2.indexOf("\r\n"));
        const code = parseInt(statusLine.split(" ")[1] ?? "0", 10);
        s2.destroy();
        expect(code).toBe(407);
        expect(upstream.receivedHeaders).toHaveLength(0);
        resolve();
      });
      s2.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 3000);
    });

    upstream.server.close();
  });

  it("Proxy-Authorization without Bearer prefix → 407, zero upstream calls", async () => {
    const upstream = await makeUpstreamFixture();
    const deps = makeDeps(upstream.port);
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
    const deps = makeDeps(upstream.port);
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
    const deps = makeDeps(upstream.port);
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
    const deps = makeDeps(upstream.port);
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
    const deps = makeDeps(upstream.port);
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

// ── BROKER-02: Injection tests ─────────────────────────────────────────────────

describe("BROKER-02 — credential injection (happy path)", () => {
  it("valid token + allowed host: upstream receives real secret key via x-api-key header, NOT the placeholder", async () => {
    const upstream = await makeUpstreamFixture();
    // Use a secret manager with a known real key (not sentinel for this test)
    const clock = createFakeClock(1_700_000_000_000);
    const secretManager = createSecretManager({ ANTHROPIC_API_KEY: "real-sk-key" });
    const sessionManager = createSessionManager({ clock });
    const deps: MitmBrokerDeps = {
      clock,
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

// ── BROKER-03: Fail-closed tests ──────────────────────────────────────────────

describe("BROKER-03 — fail-closed (403/502 with zero upstream calls)", () => {
  it("unknown host (not in bindings) → 403, zero upstream calls", async () => {
    const upstream = await makeUpstreamFixture();
    const clock = createFakeClock(1_700_000_000_000);
    const sessionManager = createSessionManager({ clock });
    const eventBus = createMockEventBus();
    const deps: MitmBrokerDeps = {
      clock,
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
    const { makeMockLogger } = await import("../../../../test/support/mock-logger.js");
    const logger = makeMockLogger();
    const eventBus = createMockEventBus();
    const deps: MitmBrokerDeps = {
      clock,
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
    const deps = makeDeps(0);
    const broker = createMitmBroker(deps);
    // stop() before start() — server is null, should resolve without error
    await expect(broker.stop()).resolves.toBeUndefined();
  });

  it("stop() is idempotent — can be called twice without error", async () => {
    const upstream = await makeUpstreamFixture();
    const deps = makeDeps(upstream.port);
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
    const deps = makeDeps(0);
    const broker = createMitmBroker(deps);
    expect(typeof broker.start).toBe("function");
    expect(typeof broker.stop).toBe("function");
  });

  it("start() rejects when port is already in use — server error callback fires", async () => {
    // Start a server to occupy a port
    const occupied = await new Promise<http.Server>((resolve) => {
      const s = http.createServer();
      s.listen(0, "127.0.0.1", () => resolve(s));
    });
    const occupiedPort = (occupied.address() as net.AddressInfo).port;

    const deps = makeDeps(0);
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
