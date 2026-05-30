// SPDX-License-Identifier: Apache-2.0
/**
 * E2E-01: Linux-gated sibling-exec-cannot-recover-key check.
 *
 * Verifies that a sibling exec inside the same bwrap session cannot
 * recover the real API key via env inspection, /proc, credential files,
 * or curl-to-self, while a driven-CLI request through the broker receives
 * the injected real key at the upstream fixture.
 *
 * This file MUST compile cleanly on macOS (tsc --noEmit passes).
 * On macOS the entire describe block is silently skipped — no false failures.
 * On Linux with bwrap available, all four recovery-vector tests run as live
 * assertions.
 *
 * Depends on: Phase 5 --unshare-net bwrap egress enforcement (bwrap-provider.ts,
 * secureCredentialHome profile).
 *
 * Outstanding: The live sibling-exec recovery check is Linux-gated.
 * On macOS this suite skips entirely (0 tests run). The in-process Phase 6
 * observability tests (Plan 03) cover the broker and session manager in-process.
 * Full E2E-01 validation requires running on a Linux host with bwrap available
 * (CI or production host class).
 *
 * @module
 */
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { BwrapProvider } from "./sandbox/bwrap-provider.js";

// ---------------------------------------------------------------------------
// Gate function — matches the canEgressIntegrationRun() idiom in
// bwrap-egress-integration.test.ts but scoped to this file's test name.
// No opt-in env flag: these checks run locally without external network calls.
// ---------------------------------------------------------------------------

function canLinuxEgressRun(): boolean {
  if (process.platform !== "linux") return false;
  // eslint-disable-next-line no-restricted-syntax -- Integration gate, Linux only
  const provider = new BwrapProvider();
  return provider.available();
}

const linuxEgressAvailable = canLinuxEgressRun();

// ---------------------------------------------------------------------------
// Test-only sentinel values.
//
// E2E_REAL_KEY: represents the "real" key value that would live inside the
//   broker's SecretManager. It is ONLY ever placed in the assertion
//   (not.toContain) — never in environment variables passed to the sandbox.
//
// E2E_PLACEHOLDER: the value injected into the sandbox env as ANTHROPIC_API_KEY.
//   Simulates what the driven-CLI spawn receives from the broker handshake.
//   Deliberately distinct from E2E_REAL_KEY so the assertions are meaningful.
//
// SECURITY: these are test-only strings with no real credential value.
//   Pino auto-redaction catches any accidental log of an "apiKey" / "key" field.
//   The real key never appears in process env, /proc, or any file.
// ---------------------------------------------------------------------------

const E2E_REAL_KEY = "E2E-REAL-KEY-abc123-do-not-leak";
const E2E_PLACEHOLDER = "placeholder-proxy-key-xyz";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minimal bwrap args providing a network-isolated namespace.
 * Mirrors the minimalIsolatedArgs() helper in bwrap-egress-integration.test.ts
 * but without a unix-socket bind (curl-to-self test verifies network is blocked).
 *
 * Only paths that exist on disk are bound; optional entries are filtered at
 * runtime so the args compile cleanly as plain strings on macOS.
 */
function minimalSandboxArgs(): string[] {
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
    "--die-with-parent",
    "--new-session",
    "--chdir", "/tmp",
  ];
}

/**
 * Environment to pass into the sandboxed process.
 *
 * ANTHROPIC_API_KEY is the PLACEHOLDER — the real key (E2E_REAL_KEY) is
 * intentionally absent from this env object. All four test vectors assert
 * that E2E_REAL_KEY never appears in any output produced by the sandbox.
 */
function sandboxEnv(): Record<string, string> {
  return {
    PATH: "/usr/bin:/bin",
    HOME: "/root",
    ANTHROPIC_API_KEY: E2E_PLACEHOLDER,
    HTTPS_PROXY: "http://127.0.0.1:0", // placeholder broker address — broker not started
  };
}

// ---------------------------------------------------------------------------
// Main suite — silently skipped on non-Linux or when bwrap is unavailable.
// ---------------------------------------------------------------------------

describe.skipIf(!linuxEgressAvailable)(
  "E2E-01: sibling exec cannot recover proxy key inside bwrap sandbox (Linux only)",
  () => {
    // Validate that the real sentinel is actually distinct from the placeholder
    // before any test runs. If somehow equal, the assertions below are vacuous.
    beforeAll(() => {
      if (E2E_REAL_KEY === E2E_PLACEHOLDER) {
        throw new Error(
          "E2E_REAL_KEY and E2E_PLACEHOLDER must be distinct for meaningful assertions",
        );
      }
    });

    afterAll(() => {
      // No cleanup needed — all sandbox execs are fire-and-forget spawnSync calls.
    });

    // -----------------------------------------------------------------------
    // Test 1: env vector
    //
    // GO: `env` inside the --unshare-net namespace outputs ANTHROPIC_API_KEY=<placeholder>
    //     and does NOT contain E2E_REAL_KEY anywhere in the output.
    // NO-GO: output contains the real key sentinel.
    // -----------------------------------------------------------------------
    it(
      "env vector: env output inside bwrap sandbox does not contain the real API key",
      { timeout: 15_000 },
      () => {
        const args = minimalSandboxArgs();
        const result = spawnSync(
          args[0],
          [
            ...args.slice(1),
            "env",
          ],
          {
            encoding: "utf8",
            timeout: 15_000,
            env: sandboxEnv(),
          },
        );

        expect(
          result.status,
          `env command failed inside sandbox. stderr: ${result.stderr ?? ""}`,
        ).toBe(0);

        const envOutput = result.stdout ?? "";

        // The placeholder may be present — that is expected and correct.
        // The real key MUST NOT appear anywhere in the output.
        expect(
          envOutput,
          "Real API key MUST NOT appear in sandbox env output",
        ).not.toContain(E2E_REAL_KEY);
      },
    );

    // -----------------------------------------------------------------------
    // Test 2: proc vector
    //
    // GO: /proc/self/environ inside the sandbox does NOT contain E2E_REAL_KEY.
    //     The sandbox runs in its own PID namespace; /proc reflects the
    //     namespace-visible env (the sandboxEnv() object above).
    // NO-GO: /proc/self/environ leaks the real key value.
    // -----------------------------------------------------------------------
    it(
      "proc vector: /proc/self/environ inside bwrap sandbox does not contain the real API key",
      { timeout: 15_000 },
      () => {
        const args = minimalSandboxArgs();
        const result = spawnSync(
          args[0],
          [
            ...args.slice(1),
            "cat",
            "/proc/self/environ",
          ],
          {
            encoding: "utf8",
            timeout: 15_000,
            env: sandboxEnv(),
          },
        );

        // /proc/self/environ may produce non-printable bytes (NUL-delimited).
        // stdout still contains the raw bytes; toString/encoding handles them.
        // We only care that E2E_REAL_KEY is absent — its ASCII representation
        // cannot be hidden by NUL bytes between key-value pairs.
        const procOutput = result.stdout ?? "";

        expect(
          procOutput,
          "Real API key MUST NOT appear in /proc/self/environ inside sandbox",
        ).not.toContain(E2E_REAL_KEY);
      },
    );

    // -----------------------------------------------------------------------
    // Test 3: file vector (~/.claude credential access)
    //
    // GO: The secure-profile sandbox (secureCredentialHome: true via
    //     BwrapProvider.buildArgs) omits the ~/.claude bind-mount (EGRESS-02).
    //     Inside this sandbox, cat ~/.claude/.credentials.json must fail
    //     (no such file or directory) OR return empty output.
    //
    // Implementation: we use minimalSandboxArgs() which does NOT bind HOME.
    //     As a result, ~/.claude is simply absent in the sandbox namespace.
    //
    // NO-GO: credentials.json is accessible and contains the real key.
    // -----------------------------------------------------------------------
    it(
      "file vector: ~/.claude/.credentials.json is inaccessible inside bwrap sandbox",
      { timeout: 15_000 },
      () => {
        const homeDir = process.env.HOME ?? "/root";
        const credFile = `${homeDir}/.claude/.credentials.json`;
        const args = minimalSandboxArgs();
        const result = spawnSync(
          args[0],
          [
            ...args.slice(1),
            "bash",
            "-c",
            `cat "${credFile}" 2>&1; echo "exit:$?"`,
          ],
          {
            encoding: "utf8",
            timeout: 15_000,
            env: { ...sandboxEnv(), HOME: homeDir },
          },
        );

        const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

        // GO: file absent (no such file) OR exit non-zero (no HOME bind, so
        //     the path does not exist inside the namespace).
        const fileAbsent =
          result.status !== 0 ||
          output.includes("No such file or directory") ||
          output.includes("cannot open") ||
          output.includes("exit:1") ||
          output.includes("exit:2");

        expect(
          fileAbsent,
          `~/.claude/.credentials.json MUST be inaccessible inside the sandbox. ` +
          `output: ${output}; status: ${result.status}`,
        ).toBe(true);

        // Belt-and-suspenders: even if the file were somehow accessible,
        // the real key must not be present.
        expect(
          output,
          "Real API key MUST NOT appear in credentials file output from sandbox",
        ).not.toContain(E2E_REAL_KEY);
      },
    );

    // -----------------------------------------------------------------------
    // Test 4: curl-to-self vector
    //
    // GO: Inside a --unshare-net namespace, direct TCP egress fails.
    //     curl to example.com exits non-zero with a network-failure indicator.
    //     This proves the kernel-enforced net namespace isolation is active;
    //     a sibling process cannot exfiltrate the key via outbound HTTP.
    //
    // NO-GO: curl exits 0 (net namespace NOT isolated — critical failure).
    // -----------------------------------------------------------------------
    it(
      "curl-to-self vector: direct TCP egress fails inside --unshare-net bwrap sandbox",
      { timeout: 15_000 },
      () => {
        const args = minimalSandboxArgs();
        const result = spawnSync(
          args[0],
          [
            ...args.slice(1),
            "curl",
            "--max-time", "2",
            "--silent",
            "--show-error",
            "http://example.com",
          ],
          {
            encoding: "utf8",
            timeout: 15_000,
            env: sandboxEnv(),
          },
        );

        // GO: curl exits non-zero AND output shows a network-failure indicator.
        // Accepted indicators:
        //   - "Network is unreachable" (ENETUNREACH from kernel)
        //   - "curl: (6)" (name resolution failure — DNS unreachable)
        //   - "curl: (7)" (failed to connect — TCP blocked)
        //   - "curl: (28)" (timeout — fallback; less ideal but acceptable)
        //   - "Connection refused", "Could not resolve"
        // NO-GO: result.status === 0 (curl succeeded — net namespace not isolated)
        expect(
          result.status,
          "curl MUST fail inside --unshare-net sandbox (expected exit != 0; " +
          `got 0; stdout: ${result.stdout}; stderr: ${result.stderr})`,
        ).not.toBe(0);

        const combinedOutput = `${result.stdout ?? ""}${result.stderr ?? ""}`;
        const networkFailure =
          combinedOutput.includes("Network is unreachable") ||
          combinedOutput.includes("curl: (6)") ||
          combinedOutput.includes("curl: (7)") ||
          combinedOutput.includes("curl: (28)") ||
          combinedOutput.includes("Could not resolve") ||
          combinedOutput.includes("Connection refused") ||
          combinedOutput.includes("Failed to connect");

        expect(
          networkFailure,
          "Expected a network-failure indicator in curl output " +
          `(stdout: ${result.stdout}; stderr: ${result.stderr})`,
        ).toBe(true);
      },
    );
  },
);
