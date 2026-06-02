// SPDX-License-Identifier: Apache-2.0
/**
 * Canonical-binary allowlist matcher (spec §3.2 / SEC-14).
 *
 * The daemon-side gate that decides whether an agent-named command is an
 * allowlisted binary, and resolves the exact `{ bin, argv }` to spawn. SEC-14:
 *   - match by CANONICAL binary — the requested command is resolved via
 *     `fs.realpathSync` BEFORE comparison, so a symlink / PATH-shadowed binary
 *     whose real target differs from the operator-pinned `match.path` cannot
 *     impersonate it;
 *   - an optional sha256 `hash` pin additionally rejects a content-swapped
 *     binary at the same path;
 *   - the resolved spawn is a DIRECT argv array (`{ bin, argv }`) — the driven
 *     binary is spawned as `spawn(bin, argv)`, never wrapped in a shell
 *     interpreter, so there is no shell metacharacter / PATH-hijack surface.
 *
 * Pure JS — `node:fs` + `node:crypto` only. `buildDirectSpawn` is the SOLE
 * canonicalization site for a spawn (M-1): the bin it returns is always the
 * `realpath`, never the agent-supplied path. PATH resolution of a bare command
 * name is deliberately NOT performed here — the agent supplies an absolute or
 * relative path, removing the `$PATH`-lookup attack surface entirely.
 *
 * The daemon-side tool (119-04) maps a parsed `TerminalAllowEntry` config entry
 * onto {@link AllowEntryLike}; this module intentionally does NOT import the
 * core config schema (it stays a pure, Wave-1-independent primitive).
 *
 * @module
 */

import { realpathSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";

/** The canonical-binary clause of an allow entry (a structural subset of the config). */
export interface AllowMatch {
  /** The operator-pinned canonical path (an absolute path or a daemon-resolved realpath). */
  path: string;
  /** Args prepended to the spawn argv (e.g. `--noprofile --norc`). */
  argsPrefix?: string[];
  /** Optional sha256 (hex) content pin — rejects a swapped binary at the same path. */
  hash?: string;
}

/** A minimal allow entry — `match` is the only field this matcher needs. */
export interface AllowEntryLike {
  id: string;
  match: AllowMatch;
}

/**
 * Resolve a path to its canonical realpath — the SEC-14 anchor.
 *
 * A symlink / PATH-shadow is collapsed to its real target here, so the caller
 * compares real targets, not surface paths. Throws (`ENOENT`, etc.) for an
 * unresolvable path; callers treat a throw as a no-match (a non-existent path
 * never matches an allow entry).
 */
export function canonicalize(path: string): string {
  return realpathSync(path);
}

/** Compute the sha256 (hex) of a file's contents for the optional `hash` pin. */
function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Find the allow entry whose canonical binary matches the requested command.
 *
 * The requested command is resolved to its `realpath` and compared to each
 * entry's `realpath(match.path)`. When `match.hash` is set, the file's sha256
 * must additionally equal the pin. Returns the first matching entry, or
 * `undefined` (no match → the caller rejects the spawn).
 *
 * Any FS error (unresolvable request path, unreadable file, unresolvable pinned
 * path) is treated as a no-match for that entry — fail-closed, never throw.
 */
export function matchAllowEntry(
  requestedCommand: string,
  entries: AllowEntryLike[],
): AllowEntryLike | undefined {
  let requestedReal: string;
  try {
    requestedReal = canonicalize(requestedCommand);
  } catch {
    return undefined; // unresolvable request → never matches
  }

  for (const entry of entries) {
    let pinnedReal: string;
    try {
      pinnedReal = canonicalize(entry.match.path);
    } catch {
      continue; // an unresolvable pinned path cannot match
    }
    if (pinnedReal !== requestedReal) continue;

    if (entry.match.hash !== undefined) {
      let actualHash: string;
      try {
        actualHash = sha256File(requestedReal);
      } catch {
        continue; // unreadable file cannot satisfy a hash pin
      }
      if (actualHash !== entry.match.hash) continue; // content swap → reject
    }
    return entry;
  }
  return undefined;
}

/**
 * Build the direct-argv spawn descriptor for a matched entry — the SOLE
 * canonicalization site for a spawn (M-1).
 *
 * `bin` is the resolved canonical (`realpath`), NOT the agent-supplied path, so
 * the symlink/PATH-shadow can never be the executed binary. `argv` merges the
 * entry's `argsPrefix` then the caller's args. The driven binary is spawned as
 * `spawn(bin, argv)` — there is no shell-interpreter wrapper path anywhere, so
 * agent-controlled args cannot inject shell syntax (SEC-14).
 */
export function buildDirectSpawn(
  entry: AllowEntryLike,
  requestedCommand: string,
  args: string[],
): { bin: string; argv: string[] } {
  const bin = canonicalize(requestedCommand);
  const argv = [...(entry.match.argsPrefix ?? []), ...args];
  return { bin, argv };
}
