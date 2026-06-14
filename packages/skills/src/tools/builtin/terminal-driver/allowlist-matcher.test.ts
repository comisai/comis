// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the canonical-binary allowlist matcher (spec §3.2).
 *
 * Pure FS/realpath/hash logic → runs green on macOS. Proves the canonical-binary gate:
 *   - a requested command is canonicalized via `realpath` BEFORE comparison;
 *   - a symlink / PATH-shadowed binary whose realpath != the pinned match.path
 *     is REJECTED (cannot impersonate the allowlisted canonical);
 *   - an optional sha256 hash pin rejects a content-swapped binary;
 *   - the resolved spawn is a DIRECT argv array — never `["sh","-c", …]`.
 *
 * Fixtures are built on the real FS via `mkdtempSync` + `symlinkSync` so the
 * realpath assertions are host-independent (the live-PATH-shadow exec is the
 * VPS-gated `allowlist-matcher.linux.test.ts`).
 *
 * @module
 */

import { afterEach, beforeEach, describe, it, expect } from "vitest";
import {
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  matchAllowEntry,
  buildDirectSpawn,
  canonicalize,
  type AllowEntryLike,
  type TerminalScope,
} from "./allowlist-matcher.js";

// A real, present binary on both macOS and Linux — the pinned canonical.
const CANONICAL_BASH = realpathSync("/bin/bash");
// A different real binary — the "evil" PATH-shadow target.
const OTHER_BIN = realpathSync("/bin/ls");

/** The least-privilege default scope (mirrors the config schema defaults). */
const DEFAULT_SCOPE: TerminalScope = {
  filesystem: "workspace",
  network: "none",
  credentialHome: "exclude",
  uid: "dedicated",
};

let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "allowlist-matcher-"));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

function entry(
  overrides: Partial<AllowEntryLike["match"]> = {},
  id = "bash",
  scope: TerminalScope = DEFAULT_SCOPE,
): AllowEntryLike {
  return { id, match: { path: CANONICAL_BASH, ...overrides }, scope };
}

describe("matchAllowEntry — canonical match", () => {
  it("resolves a symlink to its realpath and matches the pinned canonical entry (returning the resolved real path)", () => {
    // A symlink that points at the pinned /bin/bash → must match.
    const link = join(work, "bash-link");
    symlinkSync(CANONICAL_BASH, link);

    const matched = matchAllowEntry(link, [entry()]);
    expect(matched).toBeDefined();
    expect(matched?.entry.id).toBe("bash");
    // The matcher returns the SINGLE realpath resolution it verified, so
    // the caller can thread the exact verified inode to spawn (no second resolve).
    expect(matched?.requestedReal).toBe(CANONICAL_BASH);
  });

  it("returns undefined when the requested realpath differs from every pinned path", () => {
    // A request whose realpath is a DIFFERENT binary → no match → caller rejects.
    const matched = matchAllowEntry(OTHER_BIN, [entry()]);
    expect(matched).toBeUndefined();
  });

  it("returns undefined for a non-existent / unresolvable path (never matches)", () => {
    const matched = matchAllowEntry(join(work, "does-not-exist"), [entry()]);
    expect(matched).toBeUndefined();
  });
});

describe("matchAllowEntry — PATH-shadow rejection", () => {
  it("rejects a PATH-shadowed bash whose real target differs from the pinned canonical", () => {
    // A fixture `bash` symlink that actually points at a DIFFERENT real binary
    // (the classic PATH-hijack): its realpath != CANONICAL_BASH → rejected.
    const shadow = join(work, "bash"); // named 'bash' to mimic a PATH shadow
    symlinkSync(OTHER_BIN, shadow);

    const matched = matchAllowEntry(shadow, [entry()]);
    expect(matched).toBeUndefined();
  });
});

describe("matchAllowEntry — hash pin", () => {
  it("rejects a file whose sha256 differs from the pinned hash", () => {
    const file = join(work, "pinned-bin");
    writeFileSync(file, "real-content\n");
    const wrongHash = createHash("sha256").update("DIFFERENT-content\n").digest("hex");

    const matched = matchAllowEntry(file, [
      { id: "pinned", match: { path: realpathSync(file), hash: wrongHash }, scope: DEFAULT_SCOPE },
    ]);
    expect(matched).toBeUndefined();
  });

  it("matches a file whose sha256 equals the pinned hash", () => {
    const file = join(work, "pinned-bin");
    const content = "real-content\n";
    writeFileSync(file, content);
    const rightHash = createHash("sha256").update(content).digest("hex");

    const matched = matchAllowEntry(file, [
      { id: "pinned", match: { path: realpathSync(file), hash: rightHash }, scope: DEFAULT_SCOPE },
    ]);
    expect(matched).toBeDefined();
    expect(matched?.entry.id).toBe("pinned");
  });
});

describe("buildDirectSpawn — direct argv, never a shell", () => {
  it("returns a literal { bin, argv } with the resolved canonical bin and merged argsPrefix", () => {
    const link = join(work, "bash-link");
    symlinkSync(CANONICAL_BASH, link);
    const matched = matchAllowEntry(link, [entry({ argsPrefix: ["--noprofile", "--norc"] })]);
    expect(matched).toBeDefined();

    // buildDirectSpawn consumes the matcher's already-resolved real path
    // (NOT the raw symlink) — a single canonicalization, threaded through.
    const spawn = buildDirectSpawn(matched!.entry, matched!.requestedReal, ["-c", "echo hi"]);

    // bin is the resolved canonical (realpath), not the symlink path.
    expect(spawn.bin).toBe(CANONICAL_BASH);
    // argv merges argsPrefix THEN the caller args.
    expect(spawn.argv).toEqual(["--noprofile", "--norc", "-c", "echo hi"]);
  });

  it("never produces a sh -c wrapper — argv[0] is not a shell and the array is not ['-c', …]", () => {
    const link = join(work, "bash-link");
    symlinkSync(CANONICAL_BASH, link);
    const matched = matchAllowEntry(link, [entry()]);
    const spawn = buildDirectSpawn(matched!.entry, matched!.requestedReal, []);

    // Structural guarantee: no shell-spawn path exists.
    expect(spawn.bin).not.toMatch(/\/sh$/);
    expect(["sh", "bash", "/bin/sh", "/bin/bash"]).not.toContain(spawn.argv[0]);
    expect(spawn.argv[0]).not.toBe("-c");
    expect(Array.isArray(spawn.argv)).toBe(true);
  });
});

describe("single canonicalization (no double-realpath TOCTOU)", () => {
  it("buildDirectSpawn does NOT re-resolve the requested path — it spawns the EXACT inode the matcher hash-verified", () => {
    // The hash-pin promise ("rejects a content-swapped binary at the same path")
    // is only atomic if the verified bytes and the executed bytes are the SAME
    // inode. Pre-patch, matchAllowEntry resolves realpath(requestedCommand) to
    // hash-check, then buildDirectSpawn INDEPENDENTLY resolves
    // realpath(requestedCommand) AGAIN — a swap of the symlink between the two
    // resolutions redirects the spawn to a different, unhashed target.
    //
    // We prove the second resolve is gone: after match, DELETE the symlink the
    // agent supplied. buildDirectSpawn given the matcher's resolved real path
    // must still yield that real path — a re-resolution of the (now-deleted)
    // symlink would throw ENOENT or differ. The bin == the verified real inode.
    const link = join(work, "bash-link");
    symlinkSync(CANONICAL_BASH, link);
    const content = "pinned\n";
    const file = join(work, "real-bin");
    writeFileSync(file, content);
    const hash = createHash("sha256").update(content).digest("hex");

    // Match against a hash-pinned entry via a symlink to the pinned file.
    const linkToFile = join(work, "file-link");
    symlinkSync(file, linkToFile);
    const matched = matchAllowEntry(linkToFile, [
      { id: "pinned", match: { path: realpathSync(file), hash }, scope: DEFAULT_SCOPE },
    ]);
    expect(matched).toBeDefined();
    const verifiedReal = matched!.requestedReal;
    expect(verifiedReal).toBe(realpathSync(file));

    // Now SWAP: delete the agent's symlink and repoint it at a DIFFERENT binary.
    unlinkSync(linkToFile);
    symlinkSync(OTHER_BIN, linkToFile); // an attacker post-check swap

    // buildDirectSpawn must spawn the VERIFIED inode, immune to the swap — it is
    // handed the resolved real path and must not re-resolve linkToFile.
    const spawn = buildDirectSpawn(matched!.entry, verifiedReal, []);
    expect(spawn.bin).toBe(verifiedReal);
    expect(spawn.bin).not.toBe(OTHER_BIN); // the swap did NOT redirect the spawn
  });
});

describe("canonicalize", () => {
  it("resolves a path to its realpath, exposing the canonicalization anchor", () => {
    const link = join(work, "bash-link");
    symlinkSync(CANONICAL_BASH, link);
    expect(canonicalize(link)).toBe(CANONICAL_BASH);
  });
});

describe("AllowEntryLike.scope — the scope contract carried verbatim (no-mutate)", () => {
  it("returns the matched entry WITH its declared scope on AllowMatchResult.entry.scope", () => {
    // The operator-declared scope must survive the match so the create
    // tool can thread it into the worker create frame. Pre-patch, AllowEntryLike
    // is {id, match} only — scope is silently dropped.
    const link = join(work, "bash-link");
    symlinkSync(CANONICAL_BASH, link);
    const scope: TerminalScope = {
      filesystem: "listed-paths",
      paths: ["/srv/data"],
      network: "listed-hosts",
      hosts: ["api.example.com"],
      credentialHome: "include",
      uid: "daemon",
    };
    const matched = matchAllowEntry(link, [entry({}, "bash", scope)]);
    expect(matched).toBeDefined();
    // The whole scope object rides the entry verbatim.
    expect(matched!.entry.scope).toEqual(scope);
  });

  it("does NOT derive, default-substitute, or widen the entry's scope (scope is operator-only)", () => {
    // The matcher is a pure pass-through for scope. It must NEVER swap a
    // declared scope for a default, nor widen it. Given an entry with a NON-default
    // scope, the matcher returns EXACTLY that scope — byte-for-byte (same reference).
    const link = join(work, "bash-link");
    symlinkSync(CANONICAL_BASH, link);
    const declared: TerminalScope = {
      filesystem: "full",
      network: "full",
      credentialHome: "include",
      uid: "daemon",
    };
    const input = entry({}, "bash", declared);
    const matched = matchAllowEntry(link, [input]);
    expect(matched).toBeDefined();
    // Not a default substitution — the exact declared values survive.
    expect(matched!.entry.scope).toEqual(declared);
    expect(matched!.entry.scope.filesystem).toBe("full");
    expect(matched!.entry.scope.network).toBe("full");
    // The matcher returns the SAME entry object (no clone, no mutation of scope).
    expect(matched!.entry.scope).toBe(input.scope);
  });

  it("the least-privilege default scope rides unchanged when an entry declares it", () => {
    // The default (workspace fs, deny-all egress, credentialHome exclude, uid
    // dedicated) is the safe baseline — the matcher carries it untouched.
    const link = join(work, "bash-link");
    symlinkSync(CANONICAL_BASH, link);
    const matched = matchAllowEntry(link, [entry()]); // entry() uses DEFAULT_SCOPE
    expect(matched).toBeDefined();
    expect(matched!.entry.scope).toEqual({
      filesystem: "workspace",
      network: "none",
      credentialHome: "exclude",
      uid: "dedicated",
    });
  });
});

// A bare command name (no "/") is matched against each entry's canonical-path
// BASENAME — the operator-pinned directories are the ONLY ones consulted, so
// there is NO $PATH lookup (the deliberate no-$PATH-attack-surface property is
// preserved). This lets an agent that invokes `claude` (the natural name) hit
// the entry pinned at `/home/u/.local/bin/claude` without supplying the absolute
// path, while a content/realpath/hash pin still gates the eventual spawn.
describe("matchAllowEntry — bare command name (entry-basename match, no $PATH)", () => {
  it("matches a bare name against the entry whose pinned-path basename equals it (spawns the canonical realpath)", () => {
    // entry().match.path = CANONICAL_BASH (basename "bash"); the agent invokes bare "bash".
    const matched = matchAllowEntry("bash", [entry()]);
    expect(matched).toBeDefined();
    expect(matched?.entry.id).toBe("bash");
    expect(matched?.requestedReal).toBe(CANONICAL_BASH); // the pinned canonical realpath, not a $PATH guess
  });

  it("does NOT match a bare name whose basename differs from every entry", () => {
    // entry basename is "bash"; a bare "claude" matches nothing here.
    expect(matchAllowEntry("claude", [entry()])).toBeUndefined();
  });

  it("a bare name never consults $PATH — only operator-pinned entries are searched", () => {
    // "ls" is a real binary on PATH, but the only entry is pinned at bash → no match.
    expect(matchAllowEntry("ls", [entry()])).toBeUndefined();
  });

  it("a bare-name match still enforces the sha256 hash pin (content swap rejected)", () => {
    const file = join(work, "tool"); // basename "tool"
    writeFileSync(file, "real\n");
    const wrongHash = createHash("sha256").update("SWAPPED\n").digest("hex");
    const e: AllowEntryLike = { id: "tool", match: { path: realpathSync(file), hash: wrongHash }, scope: DEFAULT_SCOPE };
    // Bare "tool" basename-matches the entry, but the hash pin must still reject the swap.
    expect(matchAllowEntry("tool", [e])).toBeUndefined();
  });
});
