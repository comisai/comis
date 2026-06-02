// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the canonical-binary allowlist matcher (spec §3.2 / SEC-14).
 *
 * Pure FS/realpath/hash logic → runs green on macOS. Proves the SEC-14 gate:
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
} from "./allowlist-matcher.js";

// A real, present binary on both macOS and Linux — the pinned canonical.
const CANONICAL_BASH = realpathSync("/bin/bash");
// A different real binary — the "evil" PATH-shadow target.
const OTHER_BIN = realpathSync("/bin/ls");

let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "allowlist-matcher-"));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

function entry(overrides: Partial<AllowEntryLike["match"]> = {}, id = "bash"): AllowEntryLike {
  return { id, match: { path: CANONICAL_BASH, ...overrides } };
}

describe("matchAllowEntry — canonical match", () => {
  it("resolves a symlink to its realpath and matches the pinned canonical entry", () => {
    // A symlink that points at the pinned /bin/bash → must match.
    const link = join(work, "bash-link");
    symlinkSync(CANONICAL_BASH, link);

    const matched = matchAllowEntry(link, [entry()]);
    expect(matched).toBeDefined();
    expect(matched?.id).toBe("bash");
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

describe("matchAllowEntry — PATH-shadow rejection (SEC-14)", () => {
  it("rejects a PATH-shadowed bash whose real target differs from the pinned canonical", () => {
    // A fixture `bash` symlink that actually points at a DIFFERENT real binary
    // (the classic PATH-hijack): its realpath != CANONICAL_BASH → rejected.
    const shadow = join(work, "bash"); // named 'bash' to mimic a PATH shadow
    symlinkSync(OTHER_BIN, shadow);

    const matched = matchAllowEntry(shadow, [entry()]);
    expect(matched).toBeUndefined();
  });
});

describe("matchAllowEntry — hash pin (SEC-14)", () => {
  it("rejects a file whose sha256 differs from the pinned hash", () => {
    const file = join(work, "pinned-bin");
    writeFileSync(file, "real-content\n");
    const wrongHash = createHash("sha256").update("DIFFERENT-content\n").digest("hex");

    const matched = matchAllowEntry(file, [
      { id: "pinned", match: { path: realpathSync(file), hash: wrongHash } },
    ]);
    expect(matched).toBeUndefined();
  });

  it("matches a file whose sha256 equals the pinned hash", () => {
    const file = join(work, "pinned-bin");
    const content = "real-content\n";
    writeFileSync(file, content);
    const rightHash = createHash("sha256").update(content).digest("hex");

    const matched = matchAllowEntry(file, [
      { id: "pinned", match: { path: realpathSync(file), hash: rightHash } },
    ]);
    expect(matched).toBeDefined();
    expect(matched?.id).toBe("pinned");
  });
});

describe("buildDirectSpawn — direct argv, never a shell (SEC-14)", () => {
  it("returns a literal { bin, argv } with the canonical bin and merged argsPrefix", () => {
    const link = join(work, "bash-link");
    symlinkSync(CANONICAL_BASH, link);
    const e = entry({ argsPrefix: ["--noprofile", "--norc"] });

    const spawn = buildDirectSpawn(e, link, ["-c", "echo hi"]);

    // bin is the resolved canonical (realpath), not the symlink path.
    expect(spawn.bin).toBe(CANONICAL_BASH);
    // argv merges argsPrefix THEN the caller args.
    expect(spawn.argv).toEqual(["--noprofile", "--norc", "-c", "echo hi"]);
  });

  it("never produces a sh -c wrapper — argv[0] is not a shell and the array is not ['-c', …]", () => {
    const link = join(work, "bash-link");
    symlinkSync(CANONICAL_BASH, link);
    const spawn = buildDirectSpawn(entry(), link, []);

    // Structural guarantee: no shell-spawn path exists.
    expect(spawn.bin).not.toMatch(/\/sh$/);
    expect(["sh", "bash", "/bin/sh", "/bin/bash"]).not.toContain(spawn.argv[0]);
    expect(spawn.argv[0]).not.toBe("-c");
    expect(Array.isArray(spawn.argv)).toBe(true);
  });
});

describe("canonicalize", () => {
  it("resolves a path to its realpath, exposing the SEC-14 canonicalization anchor", () => {
    const link = join(work, "bash-link");
    symlinkSync(CANONICAL_BASH, link);
    expect(canonicalize(link)).toBe(CANONICAL_BASH);
  });
});
