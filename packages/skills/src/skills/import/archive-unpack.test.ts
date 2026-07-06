// SPDX-License-Identifier: Apache-2.0
/**
 * Fail-closed boundary tests for the in-house bounded archive reader. Every
 * unsafe entry shape (path escape, symlink/hardlink, decompression bomb,
 * over-cap, nested/second manifest, non-UTF-8 manifest) must reject with a
 * typed Result; a clean archive must return a bounded in-memory entry set with
 * the per-entry exec bit captured. No disk is ever touched.
 */
import { describe, it, expect } from "vitest";
import type { Result } from "@comis/shared";
import { makeZip, makeTar } from "./test-fixtures/make-archive.js";
import {
  unpackArchive,
  DEFAULT_UNPACK_CAPS,
  type UnpackCaps,
  type UnpackResult,
  type UnpackError,
} from "./archive-unpack.js";

function caps(overrides: Partial<UnpackCaps> = {}): UnpackCaps {
  return { ...DEFAULT_UNPACK_CAPS, ...overrides };
}

function expectReject(r: Result<UnpackResult, UnpackError>): UnpackError {
  expect(r.ok).toBe(false);
  if (r.ok) throw new Error("expected a reject, got a result");
  expect(r.error.hint.length).toBeGreaterThan(0);
  return r.error;
}

function expectOk(r: Result<UnpackResult, UnpackError>): UnpackResult {
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error(`expected a result, got a reject: ${r.error.message}`);
  return r.value;
}

const MANIFEST = "---\nname: demo\ndescription: a demo skill\n---\nbody\n";

describe("unpackArchive rejects path-escape entries", () => {
  it("rejects a zip entry with a parent-directory escape", () => {
    const r = unpackArchive(makeZip([{ name: "../escape.md", content: "x" }]), { caps: caps() });
    expect(expectReject(r).errorKind).toBe("validation");
  });

  it("rejects a zip entry with a Windows drive-absolute path", () => {
    const r = unpackArchive(makeZip([{ name: "C:\\Windows\\evil.md", content: "x" }]), { caps: caps() });
    expect(expectReject(r).errorKind).toBe("validation");
  });

  it("rejects a zip entry with a POSIX-absolute path", () => {
    const r = unpackArchive(makeZip([{ name: "/etc/passwd", content: "x" }]), { caps: caps() });
    expect(expectReject(r).errorKind).toBe("validation");
  });

  it("rejects a tar entry containing a backslash separator", () => {
    const r = unpackArchive(makeTar([{ name: "dir\\evil.md", content: "x" }]), { caps: caps() });
    expect(expectReject(r).errorKind).toBe("validation");
  });

  it("rejects a zip entry name carrying an embedded null byte", () => {
    const r = unpackArchive(makeZip([{ name: "SKILL\u0000.md", content: "x" }]), { caps: caps() });
    expect(expectReject(r).errorKind).toBe("validation");
  });
});

describe("unpackArchive rejects link entries outright", () => {
  it("rejects a tar symlink entry rather than skipping it", () => {
    const r = unpackArchive(makeTar([{ name: "link", typeflag: "2", linkname: "/etc/passwd" }]), {
      caps: caps(),
    });
    const e = expectReject(r);
    expect(e.errorKind).toBe("validation");
    expect(e.message.toLowerCase()).toContain("symlink");
  });

  it("rejects a tar hard-link entry rather than skipping it", () => {
    const r = unpackArchive(makeTar([{ name: "link", typeflag: "1", linkname: "SKILL.md" }]), {
      caps: caps(),
    });
    expect(expectReject(r).errorKind).toBe("validation");
  });

  it("rejects a zip entry whose mode marks it a symlink, for parity with the tar reader", () => {
    // A symlink zip entry stores the link target as its content; without the
    // file-type-bit check it would be treated as a regular file (an asymmetry
    // with the tar path, which rejects symlinks). The archive is otherwise
    // valid (a SKILL.md is present), so the reject is specifically the symlink.
    const r = unpackArchive(
      makeZip([
        { name: "SKILL.md", content: MANIFEST },
        { name: "link", content: "/etc/passwd", unixMode: 0o120777 },
      ]),
      { caps: caps() },
    );
    const e = expectReject(r);
    expect(e.errorKind).toBe("validation");
    expect(e.message.toLowerCase()).toContain("symlink");
  });
});

describe("unpackArchive enforces the streamed decompression bomb cap", () => {
  it("aborts a high-ratio zip bomb at the total uncompressed cap", () => {
    // 8 MiB of one byte deflates to a few hundred bytes; a tiny total cap must
    // abort the inflate via maxOutputLength rather than allocating the full 8 MiB.
    const bomb = Buffer.alloc(8 * 1024 * 1024, 0x41);
    const r = unpackArchive(makeZip([{ name: "SKILL.md", content: bomb, method: "deflate" }]), {
      caps: caps({ maxTotalUncompressedBytes: 4096, maxFileBytes: 1024 * 1024 }),
    });
    const e = expectReject(r);
    expect(e.errorKind).toBe("resource");
    expect(e.message.toLowerCase()).toContain("uncompressed");
  });

  it("aborts a high-ratio gzip-tar bomb at the total uncompressed cap", () => {
    const bomb = Buffer.alloc(8 * 1024 * 1024, 0x42);
    const r = unpackArchive(makeTar([{ name: "SKILL.md", content: bomb }], { gzip: true }), {
      caps: caps({ maxTotalUncompressedBytes: 4096 }),
    });
    expect(expectReject(r).errorKind).toBe("resource");
  });
});

describe("unpackArchive enforces the size, count, depth, and archive caps", () => {
  it("rejects a stored file over the per-file byte cap", () => {
    const r = unpackArchive(
      makeZip([{ name: "SKILL.md", content: Buffer.alloc(5000, 0x43), method: "store" }]),
      { caps: caps({ maxFileBytes: 1000 }) },
    );
    const e = expectReject(r);
    expect(e.errorKind).toBe("resource");
    expect(e.message.toLowerCase()).toContain("per-file");
  });

  it("rejects an archive with more than the file-count cap", () => {
    const r = unpackArchive(
      makeZip([
        { name: "SKILL.md", content: MANIFEST },
        { name: "a.md", content: "a" },
        { name: "b.md", content: "b" },
      ]),
      { caps: caps({ maxFileCount: 2 }) },
    );
    const e = expectReject(r);
    expect(e.errorKind).toBe("resource");
    expect(e.message.toLowerCase()).toContain("files");
  });

  it("rejects an entry nested past the path-depth cap", () => {
    const r = unpackArchive(
      makeZip([
        { name: "SKILL.md", content: MANIFEST },
        { name: "a/b/c/deep.md", content: "x" },
      ]),
      { caps: caps({ maxPathDepth: 2 }) },
    );
    expect(expectReject(r).errorKind).toBe("resource");
  });

  it("rejects a compressed archive over the archive byte cap up front", () => {
    const r = unpackArchive(makeZip([{ name: "SKILL.md", content: MANIFEST }]), {
      caps: caps({ maxArchiveBytes: 10 }),
    });
    const e = expectReject(r);
    expect(e.errorKind).toBe("resource");
    expect(e.message.toLowerCase()).toContain("over");
  });

  it("rejects when the running uncompressed total exceeds the cap", () => {
    const r = unpackArchive(
      makeZip([
        { name: "SKILL.md", content: Buffer.alloc(3000, 0x44), method: "store" },
        { name: "extra.md", content: Buffer.alloc(3000, 0x45), method: "store" },
      ]),
      { caps: caps({ maxTotalUncompressedBytes: 5000, maxFileBytes: 1024 * 1024 }) },
    );
    const e = expectReject(r);
    expect(e.errorKind).toBe("resource");
    expect(e.message.toLowerCase()).toContain("uncompressed");
  });
});

describe("unpackArchive drops mac cruft and dotfiles without rejecting", () => {
  it("drops __MACOSX and dotfile entries from a clean archive", () => {
    const result = expectOk(
      unpackArchive(
        makeZip([
          { name: "SKILL.md", content: MANIFEST },
          { name: "__MACOSX/._SKILL.md", content: "junk" },
          { name: ".DS_Store", content: "junk" },
          { name: "references/notes.md", content: "notes" },
        ]),
        { caps: caps() },
      ),
    );
    const paths = result.files.map((f) => f.relPath).sort();
    expect(paths).toEqual(["SKILL.md", "references/notes.md"]);
  });
});

describe("unpackArchive locates and validates the SKILL.md manifest", () => {
  it("rejects an archive that contains no SKILL.md", () => {
    const r = unpackArchive(makeZip([{ name: "readme.md", content: "hi" }]), { caps: caps() });
    expect(expectReject(r).errorKind).toBe("validation");
  });

  it("rejects an archive with more than one SKILL.md", () => {
    const r = unpackArchive(
      makeZip([
        { name: "SKILL.md", content: MANIFEST },
        { name: "sub/SKILL.md", content: MANIFEST },
      ]),
      { caps: caps() },
    );
    const e = expectReject(r);
    expect(e.errorKind).toBe("validation");
    expect(e.message.toLowerCase()).toContain("skill.md");
  });

  it("rejects a SKILL.md whose bytes are not valid UTF-8", () => {
    const r = unpackArchive(
      makeZip([{ name: "SKILL.md", content: Buffer.from([0xff, 0xfe, 0xfd, 0x00]) }]),
      { caps: caps() },
    );
    const e = expectReject(r);
    expect(e.errorKind).toBe("validation");
    expect(e.message.toLowerCase()).toContain("utf-8");
  });

  it("rejects a SKILL.md nested more than one directory deep", () => {
    const r = unpackArchive(makeZip([{ name: "a/b/SKILL.md", content: MANIFEST }]), { caps: caps() });
    expect(expectReject(r).errorKind).toBe("validation");
  });

  it("locates SKILL.md at the archive root with an empty skill root", () => {
    const result = expectOk(
      unpackArchive(
        makeZip([
          { name: "SKILL.md", content: MANIFEST },
          { name: "references/x.md", content: "x" },
        ]),
        { caps: caps() },
      ),
    );
    expect(result.skillRootRel).toBe("");
    expect(result.files.map((f) => f.relPath).sort()).toEqual(["SKILL.md", "references/x.md"]);
  });

  it("locates SKILL.md under a single top-level directory and strips it", () => {
    const result = expectOk(
      unpackArchive(
        makeZip([
          { name: "my-skill/SKILL.md", content: MANIFEST },
          { name: "my-skill/references/x.md", content: "x" },
        ]),
        { caps: caps() },
      ),
    );
    expect(result.skillRootRel).toBe("my-skill");
    expect(result.files.map((f) => f.relPath).sort()).toEqual(["SKILL.md", "references/x.md"]);
  });

  it("rejects content that sits outside the located skill directory", () => {
    const r = unpackArchive(
      makeZip([
        { name: "my-skill/SKILL.md", content: MANIFEST },
        { name: "other-dir/stray.md", content: "x" },
      ]),
      { caps: caps() },
    );
    expect(expectReject(r).errorKind).toBe("validation");
  });
});

describe("unpackArchive returns a clean archive as a bounded in-memory set", () => {
  it("returns a mixed STORE and DEFLATE zip with exec bits captured", () => {
    const result = expectOk(
      unpackArchive(
        makeZip([
          { name: "SKILL.md", content: MANIFEST, method: "store" },
          { name: "references/guide.md", content: "g".repeat(500), method: "deflate" },
          { name: "scripts/helper.py", content: "print('hi')\n", method: "deflate", execBit: true },
        ]),
        { caps: caps() },
      ),
    );
    const byPath = new Map(result.files.map((f) => [f.relPath, f]));
    expect(byPath.get("SKILL.md")!.bytes.toString("utf-8")).toBe(MANIFEST);
    expect(byPath.get("SKILL.md")!.execBit).toBe(false);
    expect(byPath.get("references/guide.md")!.bytes.toString("utf-8")).toBe("g".repeat(500));
    expect(byPath.get("scripts/helper.py")!.execBit).toBe(true);
  });

  it("returns a clean tar.gz archive with its content intact", () => {
    const result = expectOk(
      unpackArchive(
        makeTar(
          [
            { name: "SKILL.md", content: MANIFEST },
            { name: "references/x.md", content: "reference body" },
          ],
          { gzip: true },
        ),
        { caps: caps() },
      ),
    );
    expect(result.skillRootRel).toBe("");
    const ref = result.files.find((f) => f.relPath === "references/x.md")!;
    expect(ref.bytes.toString("utf-8")).toBe("reference body");
  });

  it("recovers a tar entry whose name arrives via a pax extended header", () => {
    const longRel = "references/" + "z".repeat(120) + ".md";
    const result = expectOk(
      unpackArchive(
        makeTar([
          { name: "SKILL.md", content: MANIFEST },
          { name: longRel, content: "long" },
        ]),
        { caps: caps() },
      ),
    );
    expect(result.files.map((f) => f.relPath)).toContain(longRel);
  });

  it("parses and tolerates a pax global header block", () => {
    const result = expectOk(
      unpackArchive(makeTar([{ name: "SKILL.md", content: MANIFEST }], { globalPax: { comment: "hi" } }), {
        caps: caps(),
      }),
    );
    expect(result.files.map((f) => f.relPath)).toEqual(["SKILL.md"]);
  });

  it("skips a plain directory entry but keeps regular files", () => {
    const result = expectOk(
      unpackArchive(
        makeTar([
          { name: "docs/", typeflag: "5" },
          { name: "SKILL.md", content: MANIFEST },
        ]),
        { caps: caps() },
      ),
    );
    expect(result.files.map((f) => f.relPath)).toEqual(["SKILL.md"]);
  });

  it("honours an explicit tar format override", () => {
    const result = expectOk(
      unpackArchive(makeTar([{ name: "SKILL.md", content: MANIFEST }]), { caps: caps(), format: "tar" }),
    );
    expect(result.files).toHaveLength(1);
  });
});

describe("unpackArchive rejects malformed or unsupported container shapes", () => {
  it("rejects a directory entry whose path escapes the archive", () => {
    const r = unpackArchive(
      makeTar([
        { name: "../evil/", typeflag: "5" },
        { name: "SKILL.md", content: MANIFEST },
      ]),
      { caps: caps() },
    );
    expect(expectReject(r).errorKind).toBe("validation");
  });

  it("rejects a zip entry using an unsupported compression method", () => {
    const r = unpackArchive(makeZip([{ name: "SKILL.md", content: MANIFEST, methodOverride: 99 }]), {
      caps: caps(),
    });
    const e = expectReject(r);
    expect(e.errorKind).toBe("validation");
    expect(e.message.toLowerCase()).toContain("method");
  });

  it("rejects a tar entry using an unsupported type flag", () => {
    const r = unpackArchive(
      makeTar([
        { name: "SKILL.md", content: MANIFEST },
        { name: "weird", typeflag: "7", content: "x" },
      ]),
      { caps: caps() },
    );
    expect(expectReject(r).errorKind).toBe("validation");
  });

  it("rejects a zip entry carrying invalid DEFLATE data", () => {
    const zip = makeZip([{ name: "SKILL.md", content: "hello".repeat(50), method: "deflate" }]);
    // Corrupt the first byte of the deflate stream (block type 3 = reserved).
    zip[30 + Buffer.byteLength("SKILL.md")] = 0x06;
    const r = unpackArchive(zip, { caps: caps() });
    expect(expectReject(r).errorKind).toBe("validation");
  });

  it("rejects bytes that resolve to no recognized archive format", () => {
    const r = unpackArchive(Buffer.from("this is plainly not an archive"), { caps: caps() });
    const e = expectReject(r);
    expect(e.errorKind).toBe("validation");
    expect(e.message.toLowerCase()).toContain("format");
  });

  it("rejects zip bytes with no end-of-central-directory record", () => {
    const r = unpackArchive(Buffer.from("PK\x03\x04 but truncated nonsense"), { caps: caps(), format: "zip" });
    expect(expectReject(r).errorKind).toBe("validation");
  });

  it("rejects gzip bytes that are not valid gzip", () => {
    const r = unpackArchive(Buffer.concat([Buffer.from([0x1f, 0x8b]), Buffer.from("garbage")]), {
      caps: caps(),
      format: "tar",
    });
    expect(expectReject(r).errorKind).toBe("validation");
  });
});
