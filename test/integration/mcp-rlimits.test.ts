// SPDX-License-Identifier: Apache-2.0
/**
 * Phase 63 SAFETY-08 — stdio rlimits integration test (Linux-only).
 *
 * Validates the `prlimit(1)` composition end-to-end against a real
 * subprocess on Linux. Tests that:
 *   - `prlimit --version` succeeds (sanity check for util-linux presence).
 *   - `prlimit --cpu=N -- /usr/bin/env -u NODE_OPTIONS true` exits 0
 *     (the composition wrapStdioCommand emits actually works).
 *   - `prlimit --as=0 -- bash -c 'true'` exits non-zero (rlimit denial
 *     surfaces via exit code; daemon's existing catch path converts to
 *     errorKind:"platform").
 *
 * Linux-only: macOS dev runs skip the Linux block via `os.platform()` check
 * (per CLAUDE.md "Linux-only production target; macOS dev is a known
 * degraded mode"). On macOS the parallel `describe` block asserts that
 * prlimit is genuinely absent (so the WARN-skip fallback in
 * wrapStdioCommand is the correct behaviour).
 *
 * Per CLAUDE.md: integration tests import from `dist/`; this file does NOT
 * import from `@comis/skills` (the wrap-shape behaviour is unit-tested in
 * the co-located test at
 * `packages/skills/src/skills/integrations/mcp-client/mcp-client-discover.test.ts`).
 * Pure prlimit-composition integration check here.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { platform } from "node:os";

const isLinux = platform() === "linux";
const describeLinux = isLinux ? describe : describe.skip;

describeLinux("MCP stdio rlimits — SAFETY-08 integration (Linux only)", () => {
  it("prlimit binary is present on the integration-test host (sanity check)", () => {
    const result = spawnSync("prlimit", ["--version"], { encoding: "utf-8", timeout: 2000 });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/prlimit/);
  });

  it("prlimit --cpu=N -- /usr/bin/env -u NODE_OPTIONS true exits 0 (composition works end-to-end)", () => {
    // This is the exact shape wrapStdioCommand emits when only `cpu` is
    // set in rlimits. Asserting exit 0 proves the prlimit + env -u
    // composition is a valid command line on the integration-test host
    // (i.e., wrapStdioCommand's output is genuinely runnable).
    const result = spawnSync("prlimit", [
      "--cpu=10",
      "--",
      "/usr/bin/env",
      "-u",
      "NODE_OPTIONS",
      "true",
    ], { encoding: "utf-8", timeout: 5000 });
    expect(result.status).toBe(0);
  });

  it("prlimit --as=0 -- bash -c 'true' fails (rlimit denial surfaces via exit code)", () => {
    // --as=0 means 0 bytes of virtual memory — impossible to start any
    // process. The wrap must propagate failure to the caller (no silent
    // success). Caller path is the existing connectServer catch in
    // mcp-client-connect.ts:203-222 which maps to errorKind:"dependency"
    // (the SDK's StdioClientTransport surfaces spawn failure as a generic
    // error; we accept "non-zero exit" as the test signal).
    const result = spawnSync("prlimit", [
      "--as=0",
      "--",
      "bash",
      "-c",
      "true",
    ], { encoding: "utf-8", timeout: 5000 });
    // Either non-zero status, or the prlimit binary itself errored — both
    // are acceptable signals that the rlimit denial reached the child.
    expect(result.status !== 0 || result.error !== undefined).toBe(true);
  });
});

// macOS test path — confirms the assumption (prlimit absent) that motivates
// the WARN-skip fallback in mcp-client-discover.ts:wrapStdioCommand. If a
// future macOS release ships prlimit (very unlikely; util-linux is Linux-
// specific), this test will fire as a signal to revisit the Pitfall-5 logic.
if (!isLinux) {
  describe("MCP stdio rlimits — macOS dev graceful skip", () => {
    it("on macOS, prlimit is not in PATH (sanity for the WARN-skip fallback path)", () => {
      const result = spawnSync("prlimit", ["--version"], { encoding: "utf-8", timeout: 1000 });
      // Either status non-zero or the command failed entirely (ENOENT).
      // Either signals "prlimit absent" — the input to the WARN-skip path.
      expect(result.status !== 0 || result.error !== undefined).toBe(true);
    });
  });
}
