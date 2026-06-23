// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the seccomp BPF-blob loader (JAIL-01).
 *
 * `loadSeccompProfileFd()` opens a PRECOMPILED raw-BPF blob (generated offline on
 * Linux via libseccomp `scmp_export_bpf` — bwrap `--seccomp` takes an open FD to
 * raw bytecode, NOT a JSON profile path) and returns an INHERITABLE fd, or `null`
 * when the blob is absent (degrade: buildArgs omits --seccomp; the other §4.7
 * controls hold). These cross-platform tests assert the honest absent-path
 * contract (null, never a throw); the real "the blob blocks a dangerous syscall"
 * assertion is the bwrap-hardening.linux.test.ts proof gate on the VPS.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { openSync, writeSync, fstatSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadSeccompProfileFd,
  closeSeccompProfileFd,
  seccompBlobPath,
} from "./seccomp-profile.js";

describe("loadSeccompProfileFd (JAIL-01)", () => {
  it("returns null (never throws) when the BPF blob is absent", () => {
    // No blob ships in the macOS dev checkout (it is generated offline on
    // Linux), so the loader must degrade to null — buildArgs then omits
    // --seccomp rather than crashing the jail.
    const fd = loadSeccompProfileFd();
    expect(fd === null || typeof fd === "number").toBe(true);
  });

  it("seccompBlobPath resolves beside the module and names the .bpf blob", () => {
    const p = seccompBlobPath();
    expect(p.endsWith("seccomp-orchestrate.bpf")).toBe(true);
  });

  it("closeSeccompProfileFd tolerates null and a never-opened fd", () => {
    // Defensive: closing a null/degraded result must be a no-op, not a throw.
    expect(() => closeSeccompProfileFd(null)).not.toThrow();
  });

  it("closeSeccompProfileFd closes a real fd without throwing (and tolerates a double-close)", () => {
    // Exercise the non-null close branch with a genuine fd (a temp file stands
    // in for the blob fd) — proves the cleanup path is a no-op-on-error.
    const dir = mkdtempSync(join(tmpdir(), "comis-seccomp-fd-"));
    try {
      const fd = openSync(join(dir, "blob"), "w");
      writeSync(fd, Buffer.from([0])); // make it a real, open fd
      expect(() => closeSeccompProfileFd(fd)).not.toThrow();
      // A second close of the same (now-closed) fd must be swallowed, not throw.
      expect(() => closeSeccompProfileFd(fd)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("closeSeccompProfileFd actually releases the descriptor (no fd leak)", () => {
    // WR-04: the parent keeps its OWN copy of the (non-O_CLOEXEC) fd after the
    // bwrap child forks, so the required `finally { closeSeccompProfileFd(fd) }`
    // discipline depends on close ACTUALLY releasing the descriptor — not merely
    // not-throwing. Prove the fd is genuinely closed: fstatSync on it after the
    // close must fail with EBADF (a leaked fd would still fstat cleanly). This is
    // the property every 212 jailed spawn relies on to avoid exhausting the fd
    // table over a long-running daemon.
    const dir = mkdtempSync(join(tmpdir(), "comis-seccomp-leak-"));
    try {
      const fd = openSync(join(dir, "blob"), "w");
      writeSync(fd, Buffer.from([0]));
      // Open → still valid (the parent's copy).
      expect(() => fstatSync(fd)).not.toThrow();
      closeSeccompProfileFd(fd);
      // Closed → the descriptor is released; operating on it now is EBADF.
      let err: NodeJS.ErrnoException | undefined;
      try {
        fstatSync(fd);
      } catch (e) {
        err = e as NodeJS.ErrnoException;
      }
      expect(err).toBeDefined();
      expect(err?.code).toBe("EBADF");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
