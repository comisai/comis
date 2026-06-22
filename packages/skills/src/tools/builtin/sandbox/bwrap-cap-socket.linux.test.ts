// SPDX-License-Identifier: Apache-2.0
/**
 * (Linux/VPS) — the cap-socket bwrap network mode real-reachability proof
 * (ENDPOINT-03).
 *
 * The capability-lease loopback endpoint (Phase 211-06) listens on a 0600 unix
 * socket the jailed orchestrate child must reach. The kernel network namespace
 * (`--unshare-net`) affects IP sockets ONLY — a bind-mounted unix path stays
 * reachable. This suite PROVES that on the production Linux host class by driving
 * the genuine `BwrapProvider.buildArgs({ network: { mode: "cap-socket", ... } })`
 * (not a hand-built arg list) and asserting a jailed child connects to the bound
 * socket while direct TCP egress stays cut.
 *
 * It MUST compile cleanly on macOS (`tsc --noEmit` passes) but the whole describe
 * block SKIPS on non-Linux / when bwrap is unavailable — so the macOS suite run
 * reports it skipped, never failed. On `comisvps` (`pnpm validate:full`) it runs
 * as a live assertion: this is the VPS-tier gate for the cap-socket claim.
 *
 * @module
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import * as net from "node:net";
import { existsSync, unlinkSync } from "node:fs";

import { systemNowMs } from "@comis/core";
import { BwrapProvider } from "./bwrap-provider.js";

/** Linux + real bwrap gate (mirrors bwrap-egress-integration.test.ts). */
function canCapSocketRun(): boolean {
  if (process.platform !== "linux") return false;
  // eslint-disable-next-line no-restricted-syntax -- Integration gate, Linux only
  const provider = new BwrapProvider();
  return provider.available();
}

const capSocketAvailable = canCapSocketRun();

/** Track per-test socket paths for cleanup. */
const createdSocketPaths: string[] = [];

afterAll(() => {
  for (const p of createdSocketPaths) {
    try {
      unlinkSync(p);
    } catch {
      /* already gone — ok */
    }
  }
});

describe.skipIf(!capSocketAvailable)(
  "cap-socket bwrap network mode: bound unix socket reachable inside --unshare-net (Linux only)",
  () => {
    let server: net.Server;
    let socketPath: string;
    let workspacePath: string;

    beforeEach(async () => {
      socketPath = `/tmp/comis-cap-socket-test-${systemNowMs()}.sock`;
      workspacePath = `/tmp/comis-cap-socket-ws-${systemNowMs()}`;
      createdSocketPaths.push(socketPath);

      server = net.createServer((conn) => {
        conn.on("data", () => {
          conn.write(
            "HTTP/1.1 200 OK\r\n" +
              "Content-Length: 2\r\n" +
              "Connection: close\r\n" +
              "\r\n" +
              "OK",
          );
          conn.end();
        });
      });

      // Await 'listening' so the socket file exists before bwrap evaluates --bind.
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => resolve());
      });
    });

    afterEach((ctx) => {
      server?.close();
      void ctx;
    });

    it(
      "a jailed child built via the production cap-socket mode connects to the bound socket",
      { timeout: 15_000 },
      async () => {
        expect(existsSync(socketPath), "socket file must exist before bwrap spawn").toBe(true);

        // Drive the REAL provider — buildArgs with the cap-socket network mode.
        const provider = new BwrapProvider();
        provider.available();
        const bwrapArgs = provider.buildArgs({
          workspacePath,
          sharedPaths: [],
          readOnlyPaths: [],
          cwd: "/tmp",
          tempDir: "/tmp",
          network: { mode: "cap-socket", capSocketPath: socketPath },
        });

        const result = await new Promise<{
          status: number | null;
          stdout: string;
          stderr: string;
        }>((resolve) => {
          const child = spawn(bwrapArgs[0], [
            ...bwrapArgs.slice(1),
            "curl",
            "--silent",
            "--show-error",
            "--include",
            "--max-time",
            "5",
            "--unix-socket",
            socketPath,
            "http://cap/",
          ]);
          let stdout = "";
          let stderr = "";
          child.stdout.setEncoding("utf8");
          child.stderr.setEncoding("utf8");
          child.stdout.on("data", (d: string) => (stdout += d));
          child.stderr.on("data", (d: string) => (stderr += d));
          child.on("close", (code) => resolve({ status: code, stdout, stderr }));
        });

        // GO: the jailed child reached the bound unix socket under --unshare-net.
        expect(
          result.status,
          `curl --unix-socket to the cap socket failed. stderr: ${result.stderr}`,
        ).toBe(0);
        expect(result.stdout, "expected HTTP 200 from the host cap-socket server").toContain(
          "200 OK",
        );
      },
    );

    it(
      "the same cap-socket jail still cuts direct TCP egress (--unshare-net holds)",
      { timeout: 15_000 },
      async () => {
        const provider = new BwrapProvider();
        provider.available();
        const bwrapArgs = provider.buildArgs({
          workspacePath,
          sharedPaths: [],
          readOnlyPaths: [],
          cwd: "/tmp",
          tempDir: "/tmp",
          network: { mode: "cap-socket", capSocketPath: socketPath },
        });

        const result = await new Promise<{ status: number | null; stderr: string }>((resolve) => {
          const child = spawn(bwrapArgs[0], [
            ...bwrapArgs.slice(1),
            "curl",
            "--max-time",
            "2",
            "--silent",
            "--show-error",
            "https://example.com",
          ]);
          let stderr = "";
          child.stderr.setEncoding("utf8");
          child.stderr.on("data", (d: string) => (stderr += d));
          child.on("close", (code) => resolve({ status: code, stderr }));
        });

        // The cap socket is reachable; general IP egress is NOT — non-zero exit
        // with a network-unreachable / resolution failure.
        expect(result.status, "direct TCP egress must fail inside the cap-socket jail").not.toBe(0);
      },
    );
  },
);
