// SPDX-License-Identifier: Apache-2.0
/**
 * Canonical-binary allowlist matcher (spec §3.2).
 *
 * The daemon-side gate that decides whether an agent-named command is an
 * allowlisted binary, and resolves the exact `{ bin, argv }` to spawn. The
 * canonical-binary guarantees:
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
 * Pure JS — `node:fs` + `node:path` + `node:crypto` only. `buildDirectSpawn` is
 * the SOLE canonicalization site for a spawn: the bin it returns is always the
 * `realpath`, never the agent-supplied path. A `$PATH` lookup is still NOT
 * performed — that would let an env/`$PATH`-controlled binary be selected. A
 * BARE command name (no `/`) is instead matched against each entry's
 * canonical-path BASENAME, so only the OPERATOR-PINNED directories are ever
 * consulted (an agent that invokes `claude` hits the entry pinned at
 * `/home/u/.local/bin/claude` without supplying the absolute path). The spawn is
 * still the entry's `realpath` (hash-pin enforced) — a bare name can never select
 * an unpinned binary. A path-bearing request keeps the strict realpath-equality
 * gate unchanged.
 *
 * The daemon-side tool maps a parsed `TerminalAllowEntry` config entry
 * onto {@link AllowEntryLike}; this module intentionally does NOT import the
 * core config schema (it stays a pure, Wave-1-independent primitive).
 *
 * @module
 */

import { realpathSync, readFileSync } from "node:fs";
import { basename } from "node:path";
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

/**
 * The per-entry sandbox scope (spec §3.3) — the EXACT union mirror of the
 * config `scope` strictObject (the `TerminalAllowEntrySchema.scope` in the core
 * skills config schema).
 *
 * This is the canonical TS contract threaded operator-config → matcher →
 * `CreateRequest` → the worker create frame, so a later step can
 * materialize it into a bwrap jail. It is MIRRORED by hand, NOT imported from the
 * core schema: the matcher is a Wave-1-independent pure `node:fs`/`node:crypto`
 * primitive (JSDoc :17, :24-25) and must not pull `zod` / the config module in.
 *
 * The defaults are LEAST-PRIVILEGE (`filesystem: "workspace"`, `network: "none"`,
 * `credentialHome: "exclude"`, `uid: "dedicated"`) — applied by the config schema's
 * `.default(...)`, so an entry that omits a sub-field already arrives least-privilege.
 * Scope is OPERATOR-DIALABLE ONLY: the agent has no tool param that can
 * set or widen it (the create tool's TypeBox params expose no `scope` field).
 */
export interface TerminalScope {
  /** Filesystem reach (default `workspace`). `listed-paths` consumes `paths`. */
  filesystem: "workspace" | "listed-paths" | "home" | "full";
  /** Extra RW binds for `filesystem: "listed-paths"`. */
  paths?: string[];
  /** Egress posture (default `none` = deny-all). `listed-hosts` consumes `hosts`. */
  network: "none" | "listed-hosts" | "full";
  /** Allowlisted CONNECT hosts for `network: "listed-hosts"`. */
  hosts?: string[];
  /** CLI credential dir (`~/.claude`) visibility (default `exclude` = never bound). */
  credentialHome: "exclude" | "include";
  /** Child uid (default `dedicated` = a net-new uid ≠ the daemon). */
  uid: "dedicated" | "daemon";
}

/**
 * A minimal allow entry — `match` resolves the canonical binary; `scope` is the
 * operator-declared sandbox scope carried verbatim by {@link matchAllowEntry}.
 */
export interface AllowEntryLike {
  id: string;
  match: AllowMatch;
  /** The per-session sandbox scope (operator config only). */
  scope: TerminalScope;
  /**
   * When true, `session_create` for this entry must clear the operator approval
   * gate before any spawn (§3.7) — a high-risk entry pauses for the
   * operator (not the prompt-injectable agent). Operator config only; absent →
   * the current create path (no approval prompt). A sibling of {@link scope}.
   */
  approveOnCreate?: boolean;
  /**
   * The per-entry usage caps — a STRUCTURAL mirror of the closed
   * config `limits` (`TerminalAllowEntrySchema.limits`, schema-skills.ts), a sibling
   * of {@link scope}/{@link approveOnCreate}. Operator config only — carried verbatim
   * by `mapAllowEntry` (never dropped at the daemon boundary) so the daemon can build
   * the per-agent `SessionCaps` from these values: `maxRequestsPerSession` (REJECT on
   * breach; session survives), `maxInteractions` + `wallClockMs` (EVICT on breach),
   * `maxSessions` (the reaper's overflow cap). All optional; absent → no cap. The
   * matcher itself stays a pure `node:fs`/`node:crypto` primitive — no zod import.
   */
  limits?: {
    maxSessions?: number;
    maxRequestsPerSession?: number;
    wallClockMs?: number;
    maxInteractions?: number;
  };
}

/**
 * The result of a successful {@link matchAllowEntry} — the matched entry plus the
 * SINGLE canonical realpath the matcher resolved + hash-verified.
 *
 * `requestedReal` is the SOLE canonicalization of the agent-supplied path; the
 * caller threads it straight into {@link buildDirectSpawn} so the hash-verified
 * inode and the spawned inode are provably identical. There is no second,
 * independent `realpath` of the agent path — collapsing the TOCTOU window where a
 * symlink/dir swap between the hash check and the spawn could redirect the exec.
 */
export interface AllowMatchResult {
  entry: AllowEntryLike;
  /** The canonical realpath of the requested command — verified + spawned (one resolution). */
  requestedReal: string;
}

/**
 * Resolve a path to its canonical realpath — the canonicalization anchor.
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
 * The requested command is resolved to its `realpath` ONCE and compared to each
 * entry's `realpath(match.path)`. When `match.hash` is set, the file's sha256
 * must additionally equal the pin. Returns `{ entry, requestedReal }` for the
 * first matching entry, or `undefined` (no match → the caller rejects the spawn).
 *
 * The SINGLE `requestedReal` resolution is returned so the caller threads
 * the SAME verified path into {@link buildDirectSpawn} — the hash check and the
 * spawn target are provably the same inode (no second, independent `realpath` of
 * the agent-supplied path that a post-check symlink/dir swap could redirect).
 *
 * Any FS error (unresolvable request path, unreadable file, unresolvable pinned
 * path) is treated as a no-match for that entry — fail-closed, never throw.
 */
export function matchAllowEntry(
  requestedCommand: string,
  entries: AllowEntryLike[],
): AllowMatchResult | undefined {
  // A BARE name (no `/`) is matched by the entry's canonical-path basename (no
  // realpath of the request — there is nothing to resolve). A path-bearing request
  // is realpath-resolved ONCE and compared by realpath equality (unchanged).
  const isBare = !requestedCommand.includes("/");
  let requestedReal: string | undefined;
  if (!isBare) {
    try {
      requestedReal = canonicalize(requestedCommand);
    } catch {
      return undefined; // unresolvable request → never matches
    }
  }

  for (const entry of entries) {
    let pinnedReal: string;
    try {
      pinnedReal = canonicalize(entry.match.path);
    } catch {
      continue; // an unresolvable pinned path cannot match
    }
    if (isBare) {
      // Only the operator-pinned path's basename is consulted — no $PATH.
      if (basename(entry.match.path) !== requestedCommand) continue;
    } else if (pinnedReal !== requestedReal) {
      continue;
    }
    // The spawn target is ALWAYS the entry's verified realpath (a bare name can
    // never select an unpinned binary); the hash pin gates that exact inode.
    const real = isBare ? pinnedReal : (requestedReal as string);

    if (entry.match.hash !== undefined) {
      let actualHash: string;
      try {
        actualHash = sha256File(real);
      } catch {
        continue; // unreadable file cannot satisfy a hash pin
      }
      if (actualHash !== entry.match.hash) continue; // content swap → reject
    }
    return { entry, requestedReal: real };
  }
  return undefined;
}

/**
 * Build the direct-argv spawn descriptor for a matched entry.
 *
 * `bin` is the matcher's already-resolved canonical realpath (`requestedReal`
 * from {@link matchAllowEntry}), NOT a fresh resolution of the agent-supplied
 * path — so the hash-verified inode and the executed inode are provably the same
 * (a single canonicalization, threaded through, closing the double-resolve
 * TOCTOU). `canonicalize` (in `matchAllowEntry`) remains the SOLE realpath site
 * for a spawn; this function does NOT re-resolve. `argv` merges the entry's
 * `argsPrefix` then the caller's args. The driven binary is spawned as
 * `spawn(bin, argv)` — there is no shell-interpreter wrapper path anywhere, so
 * agent-controlled args cannot inject shell syntax.
 */
export function buildDirectSpawn(
  entry: AllowEntryLike,
  requestedReal: string,
  args: string[],
): { bin: string; argv: string[] } {
  const argv = [...(entry.match.argsPrefix ?? []), ...args];
  return { bin: requestedReal, argv };
}
