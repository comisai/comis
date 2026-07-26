// SPDX-License-Identifier: Apache-2.0
/**
 * Spec for the canonical bundle content hash.
 *
 * Pre-patch state: `./bundle-hash.js` does not exist.
 *
 * The hash is the anchor for the sibling doc's tamper detection
 * (`SKILL-ARCHIVE-IMPORT-DESIGN.md` WS-1): a re-import whose hash differs from
 * a higher-trust incumbent is refused. That only works if the canonicalization
 * is stable across sources — the same skill fetched as an archive, as a
 * per-file well-known bundle, or via the GitHub Contents walk must hash
 * identically. Hence: sort by path, then `path \0 bytes` per member.
 */
import { describe, it, expect } from "vitest";
import { hashSkillBundle } from "./bundle-hash.js";
import type { SkillBundleFile } from "./vet-bundle.js";

const A: SkillBundleFile = { path: "SKILL.md", content: "---\nname: s\ndescription: d\n---\n\nBody.\n" };
const B: SkillBundleFile = { path: "references/notes.md", content: "# Notes\n" };

describe("hashSkillBundle — shape", () => {
  it("returns a sha256-prefixed lowercase hex digest", () => {
    expect(hashSkillBundle([A])).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("is deterministic across repeated calls on the same bundle", () => {
    expect(hashSkillBundle([A, B])).toBe(hashSkillBundle([A, B]));
  });
});

describe("hashSkillBundle — canonicalization", () => {
  it("is INDEPENDENT of member order (sources enumerate differently)", () => {
    expect(hashSkillBundle([A, B])).toBe(hashSkillBundle([B, A]));
  });

  it("treats a string member and its UTF-8 bytes as identical", () => {
    // An archive yields bytes; a Contents-API walk yields a decoded string.
    // The same skill must hash the same either way.
    const asBytes: SkillBundleFile = { path: A.path, content: new TextEncoder().encode(A.content as string) };
    expect(hashSkillBundle([asBytes])).toBe(hashSkillBundle([A]));
  });

  it("ignores mode and type — they are not content", () => {
    expect(hashSkillBundle([{ ...A, mode: 0o600, type: "file" }])).toBe(hashSkillBundle([A]));
  });
});

describe("hashSkillBundle — sensitivity", () => {
  it("changes when any byte of any member changes", () => {
    const tampered: SkillBundleFile = { path: B.path, content: "# Notes\n\nexfil\n" };
    expect(hashSkillBundle([A, tampered])).not.toBe(hashSkillBundle([A, B]));
  });

  it("changes when a member is added", () => {
    expect(hashSkillBundle([A, B])).not.toBe(hashSkillBundle([A]));
  });

  it("changes when a member is RENAMED but its bytes are unchanged", () => {
    const moved: SkillBundleFile = { path: "templates/notes.md", content: B.content };
    expect(hashSkillBundle([A, moved])).not.toBe(hashSkillBundle([A, B]));
  });

  it("distinguishes a path/content split ambiguity (the NUL separator earns its keep)", () => {
    // Without a separator, {path:"ab", content:"c"} and {path:"a", content:"bc"}
    // would feed the same byte stream. They must not collide.
    const one: SkillBundleFile[] = [{ path: "ab", content: "c" }];
    const two: SkillBundleFile[] = [{ path: "a", content: "bc" }];
    expect(hashSkillBundle(one)).not.toBe(hashSkillBundle(two));
  });
});

describe("hashSkillBundle — edge cases", () => {
  it("handles an empty member list without throwing", () => {
    expect(hashSkillBundle([])).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("handles a zero-byte member distinctly from its absence", () => {
    expect(hashSkillBundle([A, { path: "empty.md", content: "" }])).not.toBe(hashSkillBundle([A]));
  });

  it("does not mutate the input list", () => {
    const files: SkillBundleFile[] = [B, A];
    const snapshot = files.map((f) => f.path).join("|");
    hashSkillBundle(files);
    // A naive in-place `.sort()` on the caller's array is the bug this catches.
    expect(files.map((f) => f.path).join("|")).toBe(snapshot);
  });
});
