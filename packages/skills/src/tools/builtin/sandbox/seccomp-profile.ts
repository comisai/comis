// SPDX-License-Identifier: Apache-2.0
/**
 * Seccomp BPF-blob loader for the bwrap jail (JAIL-01, Phase 211 §4.7).
 *
 * bwrap `--seccomp N` takes an open FILE DESCRIPTOR to RAW BPF bytecode — NOT a
 * JSON profile name/path (that is Docker/runc). The blob is a PRECOMPILED data
 * artifact generated OFFLINE on Linux via libseccomp `scmp_export_bpf` (a
 * documented one-time step — see `seccomp-orchestrate.bpf.README`), committed as
 * bytes so this loader has a file to `open()`. We do NOT generate it at runtime
 * (no runtime libseccomp dependency, and macOS cannot build it at all).
 *
 * Contract:
 *  - `loadSeccompProfileFd()` opens the blob and returns an INHERITABLE fd (the
 *    bwrap child must inherit it, so FD_CLOEXEC is NOT set) or `null` when the
 *    blob is absent. Absence is a graceful DEGRADE — `buildArgs` omits
 *    `--seccomp` and the other §4.7 controls (`--new-session`,
 *    `--die-with-parent`, `--unshare-net`, the bind-mount validator) still hold.
 *    The `.linux.test.ts` "blocked syscall" assertion is the proof gate that the
 *    blob actually denies the dangerous surface on the VPS.
 *
 * @module
 */

import { openSync, closeSync, constants as fsConstants } from "node:fs";
import { fileURLToPath } from "node:url";

import { tryCatch } from "@comis/shared";

/**
 * The committed raw-BPF blob, resolved relative to this module so it works from
 * both `dist/` (production) and a direct source run. Generated offline on Linux;
 * absent in the macOS dev checkout (the loader degrades to null there).
 */
const SECCOMP_BLOB_FILENAME = "seccomp-orchestrate.bpf";

/** Absolute path to the blob beside this module (dist or src). */
export function seccompBlobPath(): string {
  return fileURLToPath(new URL(`./${SECCOMP_BLOB_FILENAME}`, import.meta.url));
}

/**
 * Open the seccomp BPF blob and return an inheritable fd, or `null` when the
 * blob is absent (degrade — buildArgs omits `--seccomp`).
 *
 * The fd is opened read-only WITHOUT `O_CLOEXEC` so the bwrap child inherits it
 * (bwrap reads the BPF program from the inherited descriptor).
 */
export function loadSeccompProfileFd(): number | null {
  // openSync throws (ENOENT) when the blob is absent — wrap at this fs boundary
  // and map the throw to the honest null degrade rather than crashing the jail.
  const opened = tryCatch(() =>
    // O_RDONLY only — deliberately NOT O_CLOEXEC so the fd is inheritable by the
    // bwrap child that consumes it via --seccomp <fd>.
    openSync(seccompBlobPath(), fsConstants.O_RDONLY),
  );
  if (!opened.ok) return null;
  return opened.value;
}

/**
 * Close a previously-opened seccomp fd. Tolerates `null` (the degraded result)
 * and an already-closed/invalid fd — closing is best-effort cleanup, never a
 * throw that could mask the real spawn outcome.
 */
export function closeSeccompProfileFd(fd: number | null): void {
  if (fd === null) return;
  // Best-effort: a double-close / invalid fd must not throw into the caller.
  void tryCatch(() => closeSync(fd));
}
