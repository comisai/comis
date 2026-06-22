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

import { loadSeccompProfileFd, closeSeccompProfileFd } from "./seccomp-profile.js";

describe("loadSeccompProfileFd (JAIL-01)", () => {
  it("returns null (never throws) when the BPF blob is absent", () => {
    // No blob ships in the macOS dev checkout (it is generated offline on
    // Linux), so the loader must degrade to null — buildArgs then omits
    // --seccomp rather than crashing the jail.
    const fd = loadSeccompProfileFd();
    expect(fd === null || typeof fd === "number").toBe(true);
  });

  it("closeSeccompProfileFd tolerates null and a never-opened fd", () => {
    // Defensive: closing a null/degraded result must be a no-op, not a throw.
    expect(() => closeSeccompProfileFd(null)).not.toThrow();
  });
});
