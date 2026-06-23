// SPDX-License-Identifier: Apache-2.0
/**
 * (Linux/VPS) — the bwrap-REAL §4.7 escape-class proof suite (JAIL-01/02/03/04).
 *
 * These four CVE-class assertions are the hard containment gate for the
 * autonomy jail. They MUST compile cleanly on macOS (`tsc --noEmit` passes) but
 * the whole describe block SKIPS on non-Linux / when bwrap is unavailable — so
 * the macOS suite run reports them skipped, never failed. On `comisvps`
 * (`pnpm validate:full`) they run as live assertions against the genuine
 * `BwrapProvider.buildArgs` (not a hand-built arg list).
 *
 * The four classes (one `it` each):
 *   1. TIOCSTI keystroke-injection (CVE-2017-5226) — the ioctl inside the jail
 *      errors (--new-session detaches the controlling TTY; --seccomp is the
 *      defense-in-depth backstop). T-211-17.
 *   2. CVE-2026-25725 writable-path — a nonexistent host config path is NOT
 *      creatable from inside the jail (no RO-bound parent smuggles a creatable
 *      child). T-211-18.
 *   3. symlink-escape — a symlinked leaf cannot smuggle a blocked path past the
 *      validator into the real jail (validateBindMount throws at construction).
 *      T-211-20.
 *   4. CVE-2025-66479 egress — the --unshare-net jail cannot reach the network
 *      (hard cut, no allowlist-empty=allow-all failure mode). T-211-19.
 *
 * @module
 */

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

import { BwrapProvider } from "./bwrap-provider.js";

/** Linux + real bwrap gate (mirrors bwrap-egress-integration.test.ts). */
function canHardeningRun(): boolean {
  if (process.platform !== "linux") return false;
  // eslint-disable-next-line no-restricted-syntax -- Integration gate, Linux only
  const provider = new BwrapProvider();
  return provider.available();
}

const hardeningAvailable = canHardeningRun();

/** A baseline open-network autonomy jail arg set built via the production path. */
function baseJailArgs(opts?: { workspacePath?: string }): string[] {
  const provider = new BwrapProvider();
  provider.available();
  return provider.buildArgs({
    workspacePath: opts?.workspacePath ?? "/tmp",
    sharedPaths: [],
    readOnlyPaths: [],
    cwd: "/tmp",
    tempDir: "/tmp",
  });
}

describe.skipIf(!hardeningAvailable)("bwrap §4.7 hardening — escape-class proofs (Linux only)", () => {
  // -- 1. TIOCSTI keystroke injection (CVE-2017-5226, JAIL-01 / T-211-17) -----
  it(
    "rejects the TIOCSTI ioctl inside the jail (--new-session + seccomp backstop)",
    { timeout: 15_000 },
    () => {
      const args = baseJailArgs();
      // python3 attempts the TIOCSTI ioctl on stdin. With --new-session the
      // child has no controlling TTY, so the ioctl fails (EINVAL/ENOTTY/EPERM);
      // the seccomp profile, when present, denies it outright. Either way the
      // injection must NOT succeed.
      const py = [
        "import fcntl, sys, termios",
        "try:",
        "    fcntl.ioctl(0, termios.TIOCSTI, 'x')",
        "    print('INJECTED')",
        "except Exception as e:",
        "    print('BLOCKED:' + type(e).__name__)",
      ].join("\n");
      const result = spawnSync(args[0], [...args.slice(1), "python3", "-c", py], {
        encoding: "utf8",
        timeout: 15_000,
        // Give the child a real PTY-free stdin.
        input: "",
      });
      const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      expect(out, `TIOCSTI must not inject; got: ${out}`).not.toContain("INJECTED");
    },
  );

  // -- 2. CVE-2026-25725 writable-path (JAIL-02 / T-211-18) -------------------
  it(
    "a nonexistent host config path is NOT creatable from inside the jail",
    { timeout: 15_000 },
    () => {
      const args = baseJailArgs();
      // Attempt to create a host config the jail must not be able to write.
      // ~/.comis/config.yaml is host-trusted; the jail does not bind it (nor a
      // writable parent), so the write must fail (EROFS/ENOENT/EACCES).
      const target = join(homedir(), ".comis", "config.yaml.escape-probe");
      const result = spawnSync(
        args[0],
        [
          ...args.slice(1),
          "bash",
          "-c",
          `echo pwned > "${target}" 2>&1; echo "exit:$?"`,
        ],
        { encoding: "utf8", timeout: 15_000 },
      );
      const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      // The write must NOT have succeeded (exit:0 with the file written).
      expect(out, `host config must not be creatable from the jail; got: ${out}`).not.toMatch(
        /exit:0\s*$/,
      );
    },
  );

  // -- 3. symlink-escape (JAIL-03 / T-211-20) --------------------------------
  it(
    "a symlinked leaf resolving to a blocked path is refused at jail construction",
    () => {
      // Build a symlink whose realpath is a denylisted system dir; buildArgs must
      // refuse to bind it (validateBindMount resolves through ancestors and
      // throws). This is the construction-time half; the kernel half is covered
      // by the credential-absence checks in bwrap-egress-integration.test.ts.
      const dir = mkdtempSync(join(tmpdir(), "comis-symlink-escape-"));
      const link = join(dir, "etc-link");
      try {
        symlinkSync("/etc", link); // realpath(link) === /etc → blocked
        const provider = new BwrapProvider();
        provider.available();
        expect(() =>
          provider.buildArgs({
            workspacePath: "/tmp",
            sharedPaths: [link], // a custom bind whose realpath is /etc
            readOnlyPaths: [],
            cwd: "/tmp",
            tempDir: "/tmp",
          }),
        ).toThrow(/unsafe jail bind/i);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  // -- 4. CVE-2025-66479 egress (JAIL-04 / T-211-19) -------------------------
  it(
    "the --unshare-net (none mode) jail cannot reach the network",
    { timeout: 15_000 },
    () => {
      const provider = new BwrapProvider();
      provider.available();
      const args = provider.buildArgs({
        workspacePath: "/tmp",
        sharedPaths: [],
        readOnlyPaths: [],
        cwd: "/tmp",
        tempDir: "/tmp",
        network: { mode: "none" },
      });
      const result = spawnSync(
        args[0],
        [...args.slice(1), "curl", "--max-time", "2", "--silent", "--show-error", "https://example.com"],
        { encoding: "utf8", timeout: 15_000 },
      );
      // Hard cut: curl must fail (no allowlist-empty=allow-all failure mode).
      expect(result.status, "direct egress must fail inside --unshare-net").not.toBe(0);
    },
  );
});
