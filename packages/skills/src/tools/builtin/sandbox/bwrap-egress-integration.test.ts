// SPDX-License-Identifier: Apache-2.0
/**
 * EGRESS GO/NO-GO: This suite is the hard gate for the egress containment claims.
 * Status: OUTSTANDING — must be run on the Linux production host class.
 * The containment claims ("non-bypassable", "kernel-locked egress") are
 * publish-gated on this suite passing on that host class.
 *
 * This file MUST compile cleanly on macOS (tsc --noEmit passes).
 * On macOS the entire describe block is silently skipped — no false failures.
 * On Linux with bwrap available, all three groups run as live assertions.
 *
 * FILE SPLIT: this file owns the egress-TRANSPORT proof — Group A
 * (unix-socket bind reachable inside `--unshare-net`), Group B (raw direct-TCP
 * egress blocked), Group C (secure-profile credential absence + the child-env
 * scrub). The terminal-driver SCOPE cells built via the production
 * `buildScopeArgs` composer (filesystem/credentialPaths/uid + the always-on
 * `~/.comis` carve-out, the allowlist-proxy ALLOW/DENY decision, no-provider
 * fail-closed) live in the sibling `terminal-driver/terminal-scope-matrix.linux.test.ts`
 * so the two compose WITHOUT overlap. Both run on `comisvps`; both skip on macOS.
 *
 * @module
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import * as net from "node:net";
import { existsSync, unlinkSync } from "node:fs";

import { systemNowMs } from "@comis/core";
import { BwrapProvider } from "./bwrap-provider.js";
// The production child-env scrubber (a sibling terminal-driver primitive,
// same package). Group C asserts it strips the interpreter-control / nested-CLI
// markers BEFORE the secure-profile bwrap forwards the env into the jail.
import { scrubChildEnv } from "../terminal-driver/terminal-env-scrub.js";

// ---------------------------------------------------------------------------
// Gate function — mirrors the canRealBwrapSandbox() idiom from exec-tool.test.ts
// but WITHOUT the opt-in env flag: these spike tests use only the local broker
// (no public network), so no cost-gate is needed.
// ---------------------------------------------------------------------------

function canEgressIntegrationRun(): boolean {
  if (process.platform !== "linux") return false;
  // eslint-disable-next-line no-restricted-syntax -- Integration gate, Linux only
  const provider = new BwrapProvider();
  return provider.available();
}

const egressIntegrationAvailable = canEgressIntegrationRun();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal bwrap args for a network-isolated namespace (no socket, no workspace). */
function minimalIsolatedArgs(): string[] {
  return [
    "bwrap",
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

/** Build bwrap args that include a unix socket bind-mount. */
function argsWithSocketBind(socketPath: string): string[] {
  return [
    ...minimalIsolatedArgs(),
    "--bind", socketPath, socketPath,
  ];
}

/** Track per-test socket paths for cleanup. */
const createdSocketPaths: string[] = [];

// ---------------------------------------------------------------------------
// Main suite — skipped on non-Linux or when bwrap is unavailable
// ---------------------------------------------------------------------------

describe.skipIf(!egressIntegrationAvailable)(
  "egress spike: rootless --unshare-net broker-only egress (Linux only)",
  () => {
    // -----------------------------------------------------------------------
    // Group A: GO criterion — Unix socket bind-mount reachable from inside
    //          the --unshare-net namespace.
    // -----------------------------------------------------------------------
    describe("Group A: unix socket bind-mount is reachable inside --unshare-net namespace", () => {
      let server: net.Server;
      let socketPath: string;

      beforeEach(async () => {
        socketPath = `/tmp/comis-egress-test-${systemNowMs()}.sock`;
        createdSocketPaths.push(socketPath);

        // Create a minimal Node server on the unix socket.
        // Any connection receives a simple HTTP/1.1 200 response so the test
        // can confirm data flows through the bind-mounted socket.
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

        // Await the 'listening' event so the socket is bound and the file
        // exists before bwrap evaluates its --bind argument (pitfall 1).
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(socketPath, () => resolve());
        });
      });

      afterEach((ctx) => {
        server?.close();
        // afterAll handles the final file cleanup; this is just for the server.
        void ctx;
      });

      it(
        "curl through the bind-mounted unix socket receives a response from the host server",
        { timeout: 15_000 },
        async () => {
          expect(existsSync(socketPath), "socket file must exist before bwrap spawn").toBe(true);

          const bwrapArgs = argsWithSocketBind(socketPath);
          // Inside the namespace: dial the bind-mounted unix socket with an HTTP
          // client and read back the host server's response. We use
          // `curl --unix-socket` (curl is already bound into the namespace via
          // /usr and is used by Group B) rather than socat: curl is guaranteed
          // present on any host that can run the broker, needs no TCP (so it
          // works under --unshare-net), and mirrors how a real driven CLI dials
          // the broker — HTTP over a unix socket. The product never spawns
          // socat (it is a *blocked* command in exec-security), so socat is not
          // a prod-host dependency and must not gate this property.
          //
          // The client MUST be driven asynchronously (spawn, not spawnSync):
          // the responder runs on THIS process's event loop, so a synchronous
          // spawnSync would block the loop and deadlock — the server could never
          // write its reply and curl would time out.
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
              "--include", // emit the status line so we can assert "200 OK"
              "--max-time", "5",
              "--unix-socket", socketPath,
              "http://broker/",
            ]);
            let stdout = "";
            let stderr = "";
            child.stdout.setEncoding("utf8");
            child.stderr.setEncoding("utf8");
            child.stdout.on("data", (d: string) => (stdout += d));
            child.stderr.on("data", (d: string) => (stderr += d));
            child.on("close", (code) =>
              resolve({ status: code, stdout, stderr }),
            );
          });

          // GO: curl received a response from the host-side server through the
          //     bind-mounted unix socket.
          // NO-GO: exit != 0 (ENOTSOCK, EACCES, or namespace setup failure)
          expect(
            result.status,
            `curl --unix-socket to bind-mounted broker socket failed. stderr: ${result.stderr}`,
          ).toBe(0);
          expect(result.stdout, "expected HTTP 200 response from host server").toContain("200 OK");
        },
      );
    });

    // -----------------------------------------------------------------------
    // Group B: GO criterion — Direct TCP egress fails inside --unshare-net.
    //          This is the live proof that --unshare-net actually isolates the
    //          network namespace (not just the route table).
    // -----------------------------------------------------------------------
    describe("Group B: direct TCP egress is blocked inside --unshare-net namespace", () => {
      it(
        "curl to an external host inside --unshare-net returns a network-unreachable error",
        { timeout: 15_000 },
        () => {
          const bwrapArgs = minimalIsolatedArgs();
          const result = spawnSync(
            bwrapArgs[0],
            [
              ...bwrapArgs.slice(1),
              "curl",
              "--max-time", "2",
              "--silent",
              "--show-error",
              "https://example.com",
            ],
            { encoding: "utf8", timeout: 15_000 },
          );

          // GO: curl exits non-zero AND stderr/stdout indicates network failure.
          // Accepted indicators:
          //   - "Network is unreachable" (ENETUNREACH from kernel)
          //   - "curl: (6)" (name resolution failure — also acceptable when DNS unreachable)
          //   - "curl: (7)" (failed to connect — also acceptable)
          //   - "curl: (28)" (timeout — fallback indicator; less ideal but acceptable)
          // NO-GO: result.status === 0 (curl succeeded — net namespace not isolated).
          expect(
            result.status,
            "curl MUST fail inside --unshare-net (expected exit != 0; " +
            `got 0; stdout: ${result.stdout}; stderr: ${result.stderr})`,
          ).not.toBe(0);

          const combinedOutput = `${result.stdout ?? ""}${result.stderr ?? ""}`;
          const networkFailureIndicator =
            combinedOutput.includes("Network is unreachable") ||
            combinedOutput.includes("curl: (6)") ||
            combinedOutput.includes("curl: (7)") ||
            combinedOutput.includes("curl: (28)") ||
            combinedOutput.includes("Could not resolve") ||
            combinedOutput.includes("Connection refused");

          expect(
            networkFailureIndicator,
            "expected a network-failure indicator in curl output " +
            `(stdout: ${result.stdout}; stderr: ${result.stderr})`,
          ).toBe(true);
        },
      );
    });

    // -----------------------------------------------------------------------
    // Group C: live — credential files absent inside the
    //          secure-profile namespace.
    //          Uses BwrapProvider.buildArgs() with secureCredentialHome:true
    //          to generate args via the same production code path.
    // -----------------------------------------------------------------------
    describe("Group C: credential files absent inside secure-profile namespace", () => {
      let provider: BwrapProvider;
      let sandboxArgs: string[];

      beforeEach(() => {
        provider = new BwrapProvider();
        // available() resolves and caches the bwrap binary path. buildArgs()
        // returns [this.bwrapPath, ...] and assumes availability was checked
        // first — the production sandbox-selection contract (the sandbox manager
        // always gates on available() before building args). Without this call
        // bwrapPath stays null and sandboxArgs[0] would be null.
        expect(
          provider.available(),
          "bwrap must be available for the Group C secure-profile checks",
        ).toBe(true);
        // Construct the bwrap args via the production code path.
        // brokerSocketPath points to a non-existent socket — this test only
        // verifies the credential-file absence, not broker connectivity.
        // We use a path that does NOT exist on disk; the --bind arg for it
        // should not cause issues because bwrap only binds it if the file
        // exists... but to avoid bwrap startup failure we use a minimal
        // custom arg set rather than delegating fully to buildArgs for the
        // CONNECT portion.
        sandboxArgs = provider.buildArgs({
          workspacePath: "/tmp",
          sharedPaths: [],
          readOnlyPaths: [],
          cwd: "/tmp",
          tempDir: "/tmp",
          secureCredentialHome: true,
          network: { mode: "broker-only", brokerSocketPath: "/tmp/nonexistent-broker.sock" },
        });
        // Remove the --bind for the nonexistent socket so bwrap doesn't fail
        // at namespace setup. We splice out the three-tuple
        // --bind /tmp/nonexistent-broker.sock /tmp/nonexistent-broker.sock.
        const socketBindIdx = sandboxArgs.findIndex(
          (a, i) =>
            a === "--bind" &&
            sandboxArgs[i + 1] === "/tmp/nonexistent-broker.sock" &&
            sandboxArgs[i + 2] === "/tmp/nonexistent-broker.sock",
        );
        if (socketBindIdx !== -1) {
          sandboxArgs.splice(socketBindIdx, 3);
        }
      });

      it(
        "cat ~/.claude/.credentials.json returns a non-zero exit code (file absent inside secure sandbox)",
        { timeout: 15_000 },
        () => {
          const homeDir = process.env.HOME ?? "/root";
          const credFile = `${homeDir}/.claude/.credentials.json`;
          const result = spawnSync(
            sandboxArgs[0],
            [
              ...sandboxArgs.slice(1),
              "bash",
              "-c",
              `cat "${credFile}"; echo "exit: $?"`,
            ],
            { encoding: "utf8", timeout: 15_000 },
          );

          // GO: cat fails (file not found inside namespace)
          // NO-GO: file is accessible (credential bind-mount leaked into secure sandbox)
          // Accept: exit != 0, OR output contains "No such file or directory"
          const noFile =
            result.status !== 0 ||
            (result.stdout ?? "").includes("No such file or directory") ||
            (result.stderr ?? "").includes("No such file or directory");

          expect(
            noFile,
            `~/.claude/.credentials.json MUST be absent inside the secure sandbox. ` +
            `stdout: ${result.stdout}; stderr: ${result.stderr}; status: ${result.status}`,
          ).toBe(true);
        },
      );

      it(
        "ls ~/.claude/ returns a non-zero exit code or empty output (directory absent inside secure sandbox)",
        { timeout: 15_000 },
        () => {
          const homeDir = process.env.HOME ?? "/root";
          const claudeDir = `${homeDir}/.claude`;
          const result = spawnSync(
            sandboxArgs[0],
            [
              ...sandboxArgs.slice(1),
              "bash",
              "-c",
              `ls "${claudeDir}" 2>&1; echo "status: $?"`,
            ],
            { encoding: "utf8", timeout: 15_000 },
          );

          // GO: ls fails or produces empty output (no dir in namespace)
          // NO-GO: ls succeeds and lists credential directory contents
          const dirAbsent =
            result.status !== 0 ||
            (result.stdout ?? "").includes("No such file or directory") ||
            (result.stderr ?? "").includes("No such file or directory");

          expect(
            dirAbsent,
            `~/.claude/ directory MUST be absent inside the secure sandbox. ` +
            `stdout: ${result.stdout}; stderr: ${result.stderr}; status: ${result.status}`,
          ).toBe(true);
        },
      );

      it(
        "env output inside secure sandbox does not contain ANTHROPIC_API_KEY with a real key value",
        { timeout: 15_000 },
        () => {
          const result = spawnSync(
            sandboxArgs[0],
            [
              ...sandboxArgs.slice(1),
              "env",
            ],
            { encoding: "utf8", timeout: 15_000 },
          );

          // GO: env exits 0 and ANTHROPIC_API_KEY is absent OR contains only
          //     the broker-placeholder value (never a real key starting with sk-ant-).
          // NO-GO: env output contains a real Anthropic API key.
          expect(result.status, `env command failed: ${result.stderr ?? ""}`).toBe(0);

          const envOutput = result.stdout ?? "";
          const apiKeyLine = envOutput
            .split("\n")
            .find((line) => line.startsWith("ANTHROPIC_API_KEY="));

          if (apiKeyLine) {
            const keyValue = apiKeyLine.slice("ANTHROPIC_API_KEY=".length);
            // Real Anthropic keys start with "sk-ant-"; broker-placeholder or
            // empty values are acceptable.
            expect(
              keyValue.startsWith("sk-ant-"),
              `Real Anthropic API key MUST NOT be present in secure sandbox env. ` +
              `Found ANTHROPIC_API_KEY with suspicious value (redacted for security).`,
            ).toBe(false);
          }
          // If ANTHROPIC_API_KEY is absent entirely, the test passes trivially.
        },
      );

      it(
        "the production scrubChildEnv strips NODE_OPTIONS / CLAUDECODE / CLAUDE_CODE_* before the jail spawn",
        { timeout: 15_000 },
        () => {
          // Env-scrub. IMPORTANT: BwrapProvider.buildArgs emits NO
          // --clearenv, so bwrap forwards the spawner env VERBATIM — the secure
          // PROFILE does not itself drop NODE_OPTIONS. The defense is the worker's
          // scrubChildEnv step (terminal-env-scrub.ts), which the terminal worker
          // runs over its env snapshot BEFORE handing it to bwrap. This case
          // exercises that production scrubber against a dangerous spawner env and
          // confirms (a) the markers are removed, then (b) the bwrap profile
          // forwards the SCRUBBED env into the jail with the markers gone. The
          // end-to-end production path (buildSpawnPlan -> bwrap) is also asserted
          // in the sibling terminal-scope-matrix.linux.test.ts env-scrub cell; this
          // keeps the transport file's env claim honest about WHERE the scrub lives.
          const dangerousEnv: NodeJS.ProcessEnv = {
            ...process.env,
            NODE_OPTIONS: "--require /tmp/evil.js",
            CLAUDECODE: "1",
            CLAUDE_CODE_ENTRYPOINT: "cli",
            SAFE_KEEPER: "keep-me",
          };
          const scrubbed = scrubChildEnv(dangerousEnv);
          // (a) the scrubber removed the markers (a blocklist, not a wipe).
          expect(scrubbed.NODE_OPTIONS, "scrubChildEnv MUST drop NODE_OPTIONS").toBeUndefined();
          expect(scrubbed.CLAUDECODE, "scrubChildEnv MUST drop CLAUDECODE").toBeUndefined();
          expect(
            Object.keys(scrubbed).some((k) => k.startsWith("CLAUDE_CODE_")),
            "scrubChildEnv MUST drop CLAUDE_CODE_*",
          ).toBe(false);
          expect(scrubbed.SAFE_KEEPER, "scrubChildEnv MUST keep benign vars").toBe("keep-me");

          // (b) hand the SCRUBBED env to the secure-profile bwrap (the worker's
          // contract) and confirm the jail env carries no markers.
          const result = spawnSync(
            sandboxArgs[0],
            [...sandboxArgs.slice(1), "env"],
            {
              encoding: "utf8",
              timeout: 15_000,
              env: scrubbed as NodeJS.ProcessEnv,
            },
          );
          expect(result.status, `env command failed: ${result.stderr ?? ""}`).toBe(0);
          const lines = (result.stdout ?? "").split("\n");
          expect(
            lines.some((l) => l.startsWith("NODE_OPTIONS=")),
            "NODE_OPTIONS MUST be absent in the jail env after the scrub.",
          ).toBe(false);
          expect(
            lines.some((l) => l.startsWith("CLAUDECODE=")),
            "CLAUDECODE MUST be absent in the jail env after the scrub.",
          ).toBe(false);
          expect(
            lines.some((l) => l.startsWith("CLAUDE_CODE_")),
            "CLAUDE_CODE_* MUST be absent in the jail env after the scrub.",
          ).toBe(false);
        },
      );
    });

    // -----------------------------------------------------------------------
    // afterAll: assert no socket files from this test run remain on disk.
    // -----------------------------------------------------------------------
    afterAll(() => {
      for (const socketPath of createdSocketPaths) {
        try {
          if (existsSync(socketPath)) {
            unlinkSync(socketPath);
          }
        } catch {
          // Best-effort cleanup — ignore ENOENT / permission errors.
        }
      }
      // Verify cleanup was successful.
      const remaining = createdSocketPaths.filter((p) => existsSync(p));
      expect(
        remaining,
        `Socket files must be cleaned up after test run. Still on disk: ${remaining.join(", ")}`,
      ).toHaveLength(0);
    });
  },
);
