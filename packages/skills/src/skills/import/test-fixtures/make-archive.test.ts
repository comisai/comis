// SPDX-License-Identifier: Apache-2.0
/**
 * Round-trip + structural-consistency tests for the in-memory archive fixture
 * builders. These prove the builders emit standards-valid bytes (Node's own
 * `node:zlib` decompresses them back to the input, and the header offsets are
 * internally consistent) BEFORE the unpack reader is allowed to depend on them.
 */
import { describe, it, expect } from "vitest";
import { inflateRawSync, gunzipSync } from "node:zlib";
import { makeZip, makeTar } from "./make-archive.js";

// --- minimal, independent zip/tar readers used only to verify the fixtures ---

const ZIP_LOCAL_SIG = 0x04034b50;
const ZIP_CENTRAL_SIG = 0x02014b50;
const ZIP_EOCD_SIG = 0x06054b50;

/** Read the first local file header + its raw (possibly compressed) data slice. */
function firstLocalEntry(zip: Buffer): {
  name: string;
  method: number;
  compSize: number;
  uncompSize: number;
  data: Buffer;
} {
  expect(zip.readUInt32LE(0)).toBe(ZIP_LOCAL_SIG);
  const method = zip.readUInt16LE(8);
  const compSize = zip.readUInt32LE(18);
  const uncompSize = zip.readUInt32LE(22);
  const nameLen = zip.readUInt16LE(26);
  const extraLen = zip.readUInt16LE(28);
  const name = zip.toString("utf-8", 30, 30 + nameLen);
  const dataStart = 30 + nameLen + extraLen;
  const data = zip.subarray(dataStart, dataStart + compSize);
  return { name, method, compSize, uncompSize, data };
}

/** Read the EOCD, then the central-directory entries it points at. */
function centralDirectory(zip: Buffer): Array<{ name: string; externalAttr: number; method: number }> {
  const eocd = zip.length - 22;
  expect(zip.readUInt32LE(eocd)).toBe(ZIP_EOCD_SIG);
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  const entries: Array<{ name: string; externalAttr: number; method: number }> = [];
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(p)).toBe(ZIP_CENTRAL_SIG);
    const method = zip.readUInt16LE(p + 10);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const externalAttr = zip.readUInt32LE(p + 38);
    const name = zip.toString("utf-8", p + 46, p + 46 + nameLen);
    entries.push({ name, externalAttr, method });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Walk 512-byte ustar blocks, returning each non-terminator entry. */
function tarEntries(tar: Buffer): Array<{ name: string; typeflag: string; mode: number; content: Buffer }> {
  const out: Array<{ name: string; typeflag: string; mode: number; content: Buffer }> = [];
  let offset = 0;
  let trailingZeroBlocks = 0;
  while (offset + 512 <= tar.length) {
    const block = tar.subarray(offset, offset + 512);
    if (block.every((b) => b === 0)) {
      trailingZeroBlocks++;
      offset += 512;
      continue;
    }
    expect(tar.toString("latin1", offset + 257, offset + 262)).toBe("ustar");
    let nameEnd = offset;
    while (nameEnd < offset + 100 && tar[nameEnd] !== 0) nameEnd++;
    const name = tar.toString("utf-8", offset, nameEnd);
    const mode = parseInt(tar.toString("latin1", offset + 100, offset + 108).replace(/[\0 ]/g, "") || "0", 8);
    const size = parseInt(tar.toString("latin1", offset + 124, offset + 136).replace(/[\0 ]/g, "") || "0", 8);
    const typeflag = String.fromCharCode(tar[offset + 156]);
    const contentStart = offset + 512;
    const content = tar.subarray(contentStart, contentStart + size);
    out.push({ name, typeflag, mode, content });
    offset = contentStart + Math.ceil(size / 512) * 512;
  }
  // A well-formed archive ends with at least two zero blocks.
  expect(trailingZeroBlocks).toBeGreaterThanOrEqual(2);
  return out;
}

describe("makeZip emits standards-valid zip bytes", () => {
  it("recovers a STORE entry byte-for-byte through a manual walk", () => {
    const content = Buffer.from("hello from a stored file\n");
    const zip = makeZip([{ name: "SKILL.md", content, method: "store" }]);
    const entry = firstLocalEntry(zip);
    expect(entry.name).toBe("SKILL.md");
    expect(entry.method).toBe(0);
    expect(entry.data).toEqual(content);
    expect(entry.uncompSize).toBe(content.length);
  });

  it("recovers a DEFLATE entry via Node's own inflateRawSync", () => {
    const content = Buffer.from("x".repeat(4096) + "\n" + "compress me");
    const zip = makeZip([{ name: "references/notes.md", content, method: "deflate" }]);
    const entry = firstLocalEntry(zip);
    expect(entry.method).toBe(8);
    expect(entry.compSize).toBeLessThan(content.length);
    expect(inflateRawSync(entry.data)).toEqual(content);
  });

  it("places the EOCD so it points at a valid central directory", () => {
    const central = centralDirectory(
      makeZip([
        { name: "SKILL.md", content: "a", method: "store" },
        { name: "references/x.md", content: "b".repeat(200), method: "deflate" },
      ]),
    );
    expect(central.map((e) => e.name)).toEqual(["SKILL.md", "references/x.md"]);
    expect(central[1]!.method).toBe(8);
  });

  it("stamps the Unix exec bit into the external attributes", () => {
    const central = centralDirectory(
      makeZip([
        { name: "SKILL.md", content: "manifest", method: "store" },
        { name: "scripts/helper.py", content: "print('hi')\n", method: "deflate", execBit: true },
      ]),
    );
    const script = central.find((e) => e.name === "scripts/helper.py")!;
    const manifest = central.find((e) => e.name === "SKILL.md")!;
    expect((script.externalAttr >>> 16) & 0o111).not.toBe(0);
    expect((manifest.externalAttr >>> 16) & 0o111).toBe(0);
  });

  it("can author an entry whose name is a parent-directory escape", () => {
    const entry = firstLocalEntry(makeZip([{ name: "../escape.md", content: "x", method: "store" }]));
    expect(entry.name).toBe("../escape.md");
  });
});

describe("makeTar emits standards-valid ustar bytes", () => {
  it("recovers regular-file content through a block walk", () => {
    const content = Buffer.from("tar body content\n");
    const entries = tarEntries(makeTar([{ name: "SKILL.md", content }]));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.name).toBe("SKILL.md");
    expect(entries[0]!.typeflag).toBe("0");
    expect(entries[0]!.content).toEqual(content);
  });

  it("round-trips through gunzipSync when gzip is requested", () => {
    const content = Buffer.from("gzip-wrapped tar body\n".repeat(100));
    const gz = makeTar([{ name: "SKILL.md", content }], { gzip: true });
    expect(gz[0]).toBe(0x1f);
    expect(gz[1]).toBe(0x8b);
    const entries = tarEntries(gunzipSync(gz));
    expect(entries[0]!.content).toEqual(content);
  });

  it("stamps the Unix exec bit into the file mode", () => {
    const entries = tarEntries(
      makeTar([
        { name: "SKILL.md", content: "manifest" },
        { name: "scripts/helper.py", content: "print('hi')\n", execBit: true },
      ]),
    );
    const script = entries.find((e) => e.name === "scripts/helper.py")!;
    const manifest = entries.find((e) => e.name === "SKILL.md")!;
    expect(script.mode & 0o111).not.toBe(0);
    expect(manifest.mode & 0o111).toBe(0);
  });

  it("authors a symlink entry via the typeflag override", () => {
    const entries = tarEntries(makeTar([{ name: "link", typeflag: "2", linkname: "/etc/passwd" }]));
    expect(entries[0]!.typeflag).toBe("2");
  });

  it("emits a pax extended header for a name longer than 100 bytes", () => {
    const longName = "deeply/" + "a".repeat(140) + "/SKILL.md";
    const entries = tarEntries(makeTar([{ name: longName, content: "x" }]));
    // The pax header block precedes the truncated ustar header.
    expect(entries[0]!.typeflag).toBe("x");
  });
});
