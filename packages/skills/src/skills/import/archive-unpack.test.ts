// SPDX-License-Identifier: Apache-2.0
/** Pure ZIP preflight and in-memory extraction contract for skill archives. */
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { unpackSkillArchive } from "./archive-unpack.js";

interface ZipEntryFixture {
  readonly path: string;
  readonly content: string;
  readonly flags?: number;
  readonly externalAttributes?: number;
  readonly declaredUncompressedSize?: number;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(value: number): Buffer {
  const out = Buffer.alloc(2);
  out.writeUInt16LE(value, 0);
  return out;
}

function u32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value >>> 0, 0);
  return out;
}

function makeZip(entries: readonly ZipEntryFixture[]): Uint8Array {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.path, "utf-8");
    const raw = Buffer.from(entry.content, "utf-8");
    const compressed = deflateRawSync(raw);
    const flags = (entry.flags ?? 0) | 0x0800;
    const declaredSize = entry.declaredUncompressedSize ?? raw.byteLength;
    const checksum = crc32(raw);
    const local = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(flags),
      u16(8),
      u16(0),
      u16(0),
      u32(checksum),
      u32(compressed.byteLength),
      u32(declaredSize),
      u16(name.byteLength),
      u16(0),
      name,
      compressed,
    ]);
    localParts.push(local);

    centralParts.push(
      Buffer.concat([
        u32(0x02014b50),
        u16((3 << 8) | 20),
        u16(20),
        u16(flags),
        u16(8),
        u16(0),
        u16(0),
        u32(checksum),
        u32(compressed.byteLength),
        u32(declaredSize),
        u16(name.byteLength),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(entry.externalAttributes ?? (0o100644 << 16)),
        u32(localOffset),
        name,
      ]),
    );
    localOffset += local.byteLength;
  }

  const central = Buffer.concat(centralParts);
  const end = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(central.byteLength),
    u32(localOffset),
    u16(0),
  ]);
  return Buffer.concat([...localParts, central, end]);
}

function errorCode(result: ReturnType<typeof unpackSkillArchive>): string | undefined {
  return result.ok ? undefined : result.error.code;
}

describe("unpackSkillArchive", () => {
  it("rejects a traversal member before extracting any archive bytes", () => {
    const result = unpackSkillArchive(
      makeZip([
        { path: "SKILL.md", content: "---\nname: safe\n---\n" },
        { path: "../escape", content: "owned" },
      ]),
    );

    expect(errorCode(result)).toBe("archive_unsafe_entry");
  });

  it("rejects a bomb-shaped ratio from declarations before inflation", () => {
    const result = unpackSkillArchive(
      makeZip([
        {
          path: "SKILL.md",
          content: "x".repeat(4_096),
          declaredUncompressedSize: 10_000_000,
        },
      ]),
      { maxCompressionRatio: 100 },
    );

    expect(errorCode(result)).toBe("archive_ratio_exceeded");
  });

  it("rejects an encrypted archive member as an unsupported feature", () => {
    const result = unpackSkillArchive(
      makeZip([{ path: "SKILL.md", content: "secret", flags: 0x0001 }]),
    );

    expect(errorCode(result)).toBe("archive_unsupported_feature");
  });

  it("rejects a symlink member before reading its target", () => {
    const result = unpackSkillArchive(
      makeZip([
        { path: "SKILL.md", content: "---\nname: safe\n---\n" },
        {
          path: "reference",
          content: "../../outside",
          externalAttributes: 0o120777 << 16,
        },
      ]),
    );

    expect(errorCode(result)).toBe("archive_unsafe_entry");
  });

  it("extracts one top-level skill directory and strips its root", () => {
    const result = unpackSkillArchive(
      makeZip([
        { path: "summarize/SKILL.md", content: "---\nname: summarize\n---\nBody" },
        { path: "summarize/references/guide.md", content: "Guide" },
      ]),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((file) => file.path)).toEqual([
      "SKILL.md",
      "references/guide.md",
    ]);
    expect(new TextDecoder().decode(result.value[0]?.content as Uint8Array)).toContain(
      "name: summarize",
    );
  });

  it("rejects archives with multiple possible skill roots", () => {
    const result = unpackSkillArchive(
      makeZip([
        { path: "one/SKILL.md", content: "one" },
        { path: "two/SKILL.md", content: "two" },
      ]),
    );

    expect(errorCode(result)).toBe("archive_ambiguous_root");
  });
});
