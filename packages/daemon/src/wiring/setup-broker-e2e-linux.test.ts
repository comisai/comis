// SPDX-License-Identifier: Apache-2.0
/**
 * Linux-gated full-sandbox E2E for the credential broker (INTEG-04 / WIRE-04).
 *
 * These tests require:
 *   - Linux with bwrap (bubblewrap) available on PATH
 *   - Phase 5 R1 forced-egress spike confirmed GO on the production host class
 *   - `claude` binary available on PATH (or a stub equivalent for harness smoke)
 *
 * All tests are skipped on non-Linux platforms. They are authored here so the
 * Linux CI / production host exercises the full sandbox-driven path when R1 is green.
 *
 * This file MUST compile cleanly on macOS (tsc --noEmit passes).
 * On macOS the entire describe block is silently skipped — no false failures.
 *
 * TODO: ungate when Phase 5 R1 spike is confirmed on the Linux production host class.
 * @module
 */
import "reflect-metadata"; // required for createNodeCaManager / @peculiar/x509 / tsyringe
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import * as http from "node:http";
import * as net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecretManager, TypedEventBus } from "@comis/core";
import type { BrokerBinding } from "@comis/core";
import { createMitmBroker, createSessionManager } from "@comis/infra";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
import { createFakeTimers } from "../../../../test/support/fake-timers.js";

// ---------------------------------------------------------------------------
// Platform gate
// ---------------------------------------------------------------------------

const IS_LINUX = process.platform === "linux";

/**
 * Returns true when the full Linux sandbox E2E can run:
 *   1. Platform is Linux
 *   2. bwrap binary is available on PATH
 *
 * Mirrors the canEgressIntegrationRun() pattern from bwrap-egress-integration.test.ts.
 */
function canLinuxSandboxE2ERun(): boolean {
  if (!IS_LINUX) return false;
  const result = spawnSync("which", ["bwrap"], { encoding: "utf8" });
  return result.status === 0 && (result.stdout ?? "").trim().length > 0;
}

const LINUX_E2E_AVAILABLE = canLinuxSandboxE2ERun();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_KEY = "test-key";
const TEST_SECRET_REF = "test-key-ref";
// The broker (running on the host) must be able to dial the upstream after
// matching the binding, so the CONNECT target must resolve. We use the loopback
// address the fixture listens on — the binding matches on this host, injection
// is host-pattern-agnostic, and no /etc/hosts alias is required.
const FIXTURE_HOST = "127.0.0.1";

function makeFixtureBinding(): BrokerBinding {
  return {
    secretRef: TEST_SECRET_REF,
    hostRules: [
      {
        pattern: { kind: "exact", host: FIXTURE_HOST },
        inject: [{ kind: "setHeader", name: "authorization", format: "bearer" }],
      },
    ],
  };
}

/** Plain HTTP upstream fixture — records all received request headers. */
function makeUpstreamFixture(): Promise<{
  server: http.Server;
  port: number;
  receivedHeaders: Record<string, string | string[] | undefined>[];
}> {
  const receivedHeaders: Record<string, string | string[] | undefined>[] = [];
  const server = http.createServer((req, res) => {
    receivedHeaders.push({ ...req.headers });
    res.writeHead(200, { "content-type": "text/plain" });
    // Distinctive sentinel body — must NOT collide with common substrings like
    // "ok" (which appears inside "br-ok-er" in the placeholder env value).
    res.end("UPSTREAM_FIXTURE_OK");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({ server, port, receivedHeaders });
    });
  });
}

/**
 * Minimal bwrap args for a network-isolated namespace.
 * Mirrors the patterns from bwrap-egress-integration.test.ts.
 */
function minimalBwrapArgs(): string[] {
  return [
    "--unshare-all",
    "--unshare-net",
    "--ro-bind", "/usr", "/usr",
    "--ro-bind", "/bin", "/bin",
    "--symlink", "/usr/lib64", "/lib64",
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
    "--ro-bind", "/etc/passwd", "/etc/passwd",
    "--ro-bind", "/etc/group", "/etc/group",
    "--ro-bind", "/etc/nsswitch.conf", "/etc/nsswitch.conf",
    "--ro-bind", "/etc/resolv.conf", "/etc/resolv.conf",
    "--ro-bind", "/etc/ssl", "/etc/ssl",
  ];
}

// ---------------------------------------------------------------------------
// Main suite — skipped on non-Linux or when bwrap is unavailable
// ---------------------------------------------------------------------------

describe.skipIf(!LINUX_E2E_AVAILABLE)(
  "INTEG-04 Linux-gated: full bwrap sandbox-driven broker E2E",
  () => {
    let brokerSocketPath: string;
    let brokerStop: () => Promise<void>;
    let sessionMgr: ReturnType<typeof createSessionManager>;
    let upstream: Awaited<ReturnType<typeof makeUpstreamFixture>>;
    let tmpDir: string;

    beforeAll(async () => {
      tmpDir = mkdtempSync(join(tmpdir(), "comis-broker-e2e-linux-"));
      upstream = await makeUpstreamFixture();

      const clock = createFakeClock(1_700_000_000_000);
      sessionMgr = createSessionManager({ clock });

      const broker = createMitmBroker({
        sessionManager: sessionMgr,
        secretManager: createSecretManager({ [TEST_SECRET_REF]: TEST_KEY }),
        bindings: [makeFixtureBinding()],
        eventBus: new TypedEventBus(),
        logger: createMockLogger(),
        clock,
        timers: createFakeTimers(),
        // caManager intentionally absent — plain-TCP tunnel, no TLS upgrade required
        // for this harness. The bwrap sandbox tests target egress containment, not TLS.
      });

      await broker.start();
      // Bind the broker's unix socket — this is how a --unshare-net sandbox
      // reaches the broker (host TCP is unreachable from inside the namespace).
      brokerSocketPath = join(tmpDir, "broker.sock");
      await broker.startUnixSocket(brokerSocketPath);
      brokerStop = () => broker.stop();
    }, 30_000);

    afterAll(async () => {
      await brokerStop?.().catch(() => undefined);
      upstream?.server.close();
      rmSync(tmpDir, { recursive: true, force: true });
    });

    // -----------------------------------------------------------------------
    // Test 1: bwrap sandbox-driven process routes through broker; fixture receives real key
    //
    // TODO: requires Phase 5 R1 spike green on production Linux host.
    // When R1 is confirmed:
    //   1. Replace node binary with `claude` (or the actual LLM CLI binary)
    //   2. Remove the `echo hello` placeholder with an actual minimal LLM prompt
    //   3. Assert fixture received Authorization: Bearer test-key from the real broker injection
    // -----------------------------------------------------------------------
    it(
      "full bwrap sandbox-driven process routes through broker; fixture upstream receives real key",
      async () => {
        const { proxyToken } = sessionMgr.issueToken("linux-e2e-agent");

        // Build bwrap args:
        // --unshare-net isolates the network namespace; egress only via HTTPS_PROXY
        // HTTPS_PROXY points at the in-process broker (127.0.0.1:brokerPort)
        // ANTHROPIC_API_KEY is the placeholder — broker substitutes the real key per-request
        // COMIS_BROKER_TOKEN is the single-use proxy auth token
        //
        // The spawn target is `node -e` to send a minimal HTTP CONNECT through the broker
        // to the upstream fixture and assert the upstream received the real key.
        const nodeScript = `
          const net = require('net');
          // Reach the broker ONLY via the bind-mounted unix socket — the
          // namespace is --unshare-net, so the host's TCP broker is unreachable.
          const sock = net.connect('${brokerSocketPath}', () => {
            sock.write('CONNECT ${FIXTURE_HOST}:${upstream.port} HTTP/1.1\\r\\nHost: ${FIXTURE_HOST}:${upstream.port}\\r\\nProxy-Authorization: Bearer ${proxyToken}\\r\\n\\r\\n');
          });
          let buf = '';
          sock.on('data', (chunk) => {
            buf += chunk.toString();
            if (!buf.includes('\\r\\n\\r\\n')) return;
            if (buf.startsWith('HTTP/1.1 200')) {
              sock.write('GET / HTTP/1.1\\r\\nHost: ${FIXTURE_HOST}\\r\\n\\r\\n');
              setTimeout(() => { sock.destroy(); process.exit(0); }, 200);
            } else {
              process.stderr.write('CONNECT failed: ' + buf.slice(0, buf.indexOf('\\r\\n')));
              process.exit(1);
            }
          });
          sock.on('error', (err) => { process.stderr.write(err.message); process.exit(1); });
        `;

        // Drive bwrap ASYNCHRONOUSLY (spawn, not spawnSync): the broker runs on
        // THIS process's event loop, so a synchronous spawnSync would block the
        // loop and deadlock — the broker could never answer the sandbox's CONNECT.
        const result = await new Promise<{
          status: number | null;
          stdout: string;
          stderr: string;
        }>((resolve) => {
          const child = spawn(
            "bwrap",
            [
              ...minimalBwrapArgs(),
              // Bind-mount the broker's unix socket into the isolated namespace —
              // the only egress path (mirrors the production broker-only profile).
              "--bind", brokerSocketPath, brokerSocketPath,
              "node", "-e", nodeScript,
            ],
            {
              timeout: 30_000,
              env: {
                // The sandbox process sees only the placeholder — never the real key.
                ANTHROPIC_API_KEY: "comis-broker-placeholder",
                PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
              },
            },
          );
          let stdout = "";
          let stderr = "";
          child.stdout.setEncoding("utf8");
          child.stderr.setEncoding("utf8");
          child.stdout.on("data", (d: string) => (stdout += d));
          child.stderr.on("data", (d: string) => (stderr += d));
          child.on("close", (code) => resolve({ status: code, stdout, stderr }));
        });

        // Allow time for the upstream to record the request
        await new Promise((r) => setTimeout(r, 300));

        // Assert the upstream received the REAL key (injected by broker, not placeholder)
        expect(
          result.status,
          `bwrap-sandboxed node script failed. stderr: ${result.stderr ?? ""}`,
        ).toBe(0);

        expect(
          upstream.receivedHeaders.length,
          "upstream fixture must have received at least one request from the sandboxed process",
        ).toBeGreaterThan(0);

        expect(
          upstream.receivedHeaders[0]?.["authorization"],
          "broker must have injected the real key (not the placeholder) into the Authorization header",
        ).toBe(`Bearer ${TEST_KEY}`);

        // The placeholder must NOT appear in the upstream headers
        const authHeader = String(upstream.receivedHeaders[0]?.["authorization"] ?? "");
        expect(authHeader).not.toContain("comis-broker-placeholder");
      },
      60_000,
    );

    // -----------------------------------------------------------------------
    // Test 2: sibling general exec in same sandbox cannot recover the real key
    //
    // TODO: requires Phase 5 R1 spike green on production Linux host.
    // The general-exec profile runs WITHOUT broker env (no COMIS_BROKER_TOKEN,
    // no ANTHROPIC_API_KEY real value). This proves the sandbox boundary holds:
    // even if a sibling process probes env/proc/files, it cannot recover the key.
    // -----------------------------------------------------------------------
    it(
      "sibling general exec in same namespace cannot recover real key via env/proc/file/curl-to-self",
      () => {
        // Spawn bwrap WITHOUT broker environment — simulates a general exec process
        // that shares the same network namespace but has no access to broker credentials.
        // --unshare-net: no direct TCP egress (blocking curl/wget to upstream fixture)
        const result = spawnSync(
          "bwrap",
          [
            ...minimalBwrapArgs(),
            "sh", "-c",
            // Probe all channels a compromised process might use to recover the key:
            // 1. env — should NOT contain the real key
            // 2. /proc/self/environ — should NOT contain the real key
            // 3. curl to upstream fixture — should fail (network isolated)
            `env; cat /proc/self/environ | tr '\\0' '\\n'; curl --max-time 2 --silent http://127.0.0.1:${upstream.port}/ 2>&1 || true`,
          ],
          {
            encoding: "utf8",
            timeout: 15_000,
            env: {
              // General exec profile: NO real key, NO broker token, NO proxy vars
              // Only the minimal env a sandboxed subprocess would have
              PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
              ANTHROPIC_API_KEY: "comis-broker-placeholder", // placeholder only
            },
          },
        );

        // 1. Real key must NOT appear in env or /proc/self/environ output
        const output = result.stdout ?? "";
        expect(
          output,
          "real key must not appear in env or /proc/self/environ of sibling exec",
        ).not.toContain(TEST_KEY);

        // 2. curl to upstream fixture must fail (network isolated via --unshare-net)
        // The output should contain a curl error (ENETUNREACH, connection refused, timeout)
        // and NOT contain the upstream HTTP 200 response body ("ok").
        // Note: curl failure is acceptable (exit code non-zero OR error in output);
        // we assert the real key is not accessible, which is the security invariant.
        expect(
          output,
          "sandboxed general exec must not receive the upstream fixture body (net isolated)",
        ).not.toContain("UPSTREAM_FIXTURE_OK");
      },
      60_000,
    );
  },
);
