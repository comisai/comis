// SPDX-License-Identifier: Apache-2.0
/**
 * In-memory archive fixture builders — the inverse writers used by the unpack
 * reader's tests (and reused by the import-pipeline tests). They hand-assemble
 * standards-valid zip (local headers + central directory + EOCD) and ustar/pax
 * tar bytes, compressing with `node:zlib` so Node's own decompressors recover
 * the input. They are deliberately unvalidating: a caller can author hostile
 * shapes (a `../escape` name, a Windows drive path, a symlink entry, a
 * high-ratio compressible payload, a nested manifest) so the reader's
 * fail-closed guards can be exercised. This module is test-support only and
 * performs no I/O.
 *
 * @module
 */
import { deflateRawSync, gzipSync } from "node:zlib";

// ---------------------------------------------------------------------------
// Public input shapes
// ---------------------------------------------------------------------------

/** One zip member to author. */
export interface ZipEntryInput {
  /** Archive-relative name (forward-slash separated); may be hostile. */
  readonly name: string;
  /** File bytes; a string is encoded UTF-8. Omitted → empty. */
  readonly content?: Buffer | string;
  /** Compression: `store` (method 0) or `deflate` (method 8). Default deflate. */
  readonly method?: "store" | "deflate";
  /** When true, set the Unix exec bit in the external attributes. */
  readonly execBit?: boolean;
  /**
   * Force a raw compression-method code (e.g. 99), overriding {@link method},
   * so the reader's unsupported-method reject can be authored. The raw bytes
   * are stored verbatim under the forced method code.
   */
  readonly methodOverride?: number;
}

/** One tar member to author. */
export interface TarEntryInput {
  /** Archive-relative name; may exceed 100 bytes (a pax header is emitted). */
  readonly name: string;
  /** File bytes; a string is encoded UTF-8. Omitted → empty. */
  readonly content?: Buffer | string;
  /**
   * ustar type flag: `0` regular (default), `5` directory, `2` symlink,
   * `1` hard link, or any other single character for negative tests.
   */
  readonly typeflag?: string;
  /** When true, set the exec bits (0o755 vs 0o644) in the mode field. */
  readonly execBit?: boolean;
  /** Link target, written into the ustar linkname field (offset 157). */
  readonly linkname?: string;
}

/** Options for {@link makeTar}. */
export interface MakeTarOptions {
  /** Wrap the ustar stream with gzip (produces a tar.gz). */
  readonly gzip?: boolean;
  /** Emit a leading pax global-header block carrying these records. */
  readonly globalPax?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// zip
// ---------------------------------------------------------------------------

const ZIP_LOCAL_SIG = 0x04034b50;
const ZIP_CENTRAL_SIG = 0x02014b50;
const ZIP_EOCD_SIG = 0x06054b50;

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    // eslint-disable-next-line security/detect-object-injection -- numeric loop index into a local table
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    // eslint-disable-next-line security/detect-object-injection -- numeric byte index + table lookup
    c = (CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function asBuffer(content: Buffer | string | undefined): Buffer {
  if (content === undefined) return Buffer.alloc(0);
  return typeof content === "string" ? Buffer.from(content, "utf-8") : content;
}

/**
 * Assemble a zip archive from the given members. Each member becomes a local
 * file header + data record; a matching central-directory record and an EOCD
 * close the archive. Node's `inflateRawSync` recovers every DEFLATE member.
 */
export function makeZip(entries: readonly ZipEntryInput[]): Buffer {
  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const raw = asBuffer(entry.content);
    const method = entry.methodOverride ?? (entry.method === "store" ? 0 : 8);
    const data = method === 8 ? deflateRawSync(raw) : raw;
    const nameBuf = Buffer.from(entry.name, "utf-8");
    const crc = crc32(raw);
    const unixMode = entry.execBit === true ? 0o100755 : 0o100644;
    const externalAttr = (unixMode << 16) >>> 0;

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(ZIP_LOCAL_SIG, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // general-purpose flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0x21, 12); // mod date (1980-01-01)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(raw.length, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    nameBuf.copy(local, 30);
    localChunks.push(local, data);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(ZIP_CENTRAL_SIG, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // version made by: Unix host
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12); // mod time
    central.writeUInt16LE(0x21, 14); // mod date
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(externalAttr, 38);
    central.writeUInt32LE(localOffset, 42); // relative offset of local header
    nameBuf.copy(central, 46);
    centralChunks.push(central);

    localOffset += local.length + data.length;
  }

  const localPart = Buffer.concat(localChunks);
  const centralPart = Buffer.concat(centralChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(ZIP_EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with central dir
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralPart.length, 12);
  eocd.writeUInt32LE(localPart.length, 16); // central dir starts after the local part
  eocd.writeUInt16LE(0, 20); // comment length
  return Buffer.concat([localPart, centralPart, eocd]);
}

// ---------------------------------------------------------------------------
// tar (ustar + pax)
// ---------------------------------------------------------------------------

const TAR_BLOCK = 512;
const USTAR_NAME_MAX = 100;

/** Encode an unsigned integer as a NUL-terminated octal field of `len` bytes. */
function octalField(value: number, len: number): Buffer {
  const digits = value.toString(8).padStart(len - 1, "0");
  return Buffer.from(digits + "\0", "latin1");
}

/** Pad a buffer up to the next 512-byte boundary with zeros. */
function padToBlock(buf: Buffer): Buffer {
  const remainder = buf.length % TAR_BLOCK;
  if (remainder === 0) return buf;
  return Buffer.concat([buf, Buffer.alloc(TAR_BLOCK - remainder)]);
}

/** Build one 512-byte ustar header block with a correct checksum. */
function tarHeaderBlock(fields: {
  name: string;
  mode: number;
  size: number;
  typeflag: string;
  linkname?: string;
}): Buffer {
  const header = Buffer.alloc(TAR_BLOCK);
  Buffer.from(fields.name, "utf-8").copy(header, 0, 0, USTAR_NAME_MAX);
  octalField(fields.mode, 8).copy(header, 100);
  octalField(0, 8).copy(header, 108); // uid
  octalField(0, 8).copy(header, 116); // gid
  octalField(fields.size, 12).copy(header, 124);
  octalField(0, 12).copy(header, 136); // mtime
  header.fill(0x20, 148, 156); // checksum placeholder = spaces
  header.write(fields.typeflag.slice(0, 1), 156, "latin1");
  if (fields.linkname !== undefined) {
    Buffer.from(fields.linkname, "utf-8").copy(header, 157, 0, USTAR_NAME_MAX);
  }
  header.write("ustar\0", 257, "latin1");
  header.write("00", 263, "latin1");
  let sum = 0;
  // eslint-disable-next-line security/detect-object-injection -- numeric loop index over a fixed block
  for (let i = 0; i < TAR_BLOCK; i++) sum += header[i]!;
  header.write(sum.toString(8).padStart(6, "0"), 148, "latin1");
  header[154] = 0; // NUL
  header[155] = 0x20; // space
  return header;
}

/** Build a self-describing pax record: `"<len> key=value\n"`. */
function paxRecord(key: string, value: string): string {
  const suffix = ` ${key}=${value}\n`;
  let len = suffix.length;
  for (;;) {
    const candidate = String(len).length + suffix.length;
    if (candidate === len) break;
    len = candidate;
  }
  return `${len}${suffix}`;
}

function paxBlocks(name: string, records: string): Buffer[] {
  const content = Buffer.from(records, "utf-8");
  return [
    tarHeaderBlock({ name, mode: 0o644, size: content.length, typeflag: name === "pax_global_header" ? "g" : "x" }),
    padToBlock(content),
  ];
}

/**
 * Assemble a ustar tar archive from the given members. Names longer than 100
 * bytes get a preceding pax `x` extended header carrying the full `path`.
 * `gzip: true` wraps the stream with `gzipSync` (a tar.gz).
 */
export function makeTar(entries: readonly TarEntryInput[], opts?: MakeTarOptions): Buffer {
  const blocks: Buffer[] = [];

  if (opts?.globalPax !== undefined) {
    const records = Object.entries(opts.globalPax)
      .map(([k, v]) => paxRecord(k, v))
      .join("");
    blocks.push(...paxBlocks("pax_global_header", records));
  }

  for (const entry of entries) {
    const typeflag = entry.typeflag ?? "0";
    const isFile = typeflag === "0" || typeflag === "";
    const raw = isFile ? asBuffer(entry.content) : Buffer.alloc(0);
    const mode = entry.execBit === true ? 0o755 : 0o644;

    if (Buffer.byteLength(entry.name, "utf-8") > USTAR_NAME_MAX) {
      blocks.push(...paxBlocks("PaxHeader", paxRecord("path", entry.name)));
    }
    const storedName = entry.name.slice(0, USTAR_NAME_MAX);
    blocks.push(
      tarHeaderBlock({ name: storedName, mode, size: raw.length, typeflag, linkname: entry.linkname }),
    );
    if (raw.length > 0) blocks.push(padToBlock(raw));
  }

  // Two zero blocks terminate the archive.
  blocks.push(Buffer.alloc(TAR_BLOCK), Buffer.alloc(TAR_BLOCK));
  const tar = Buffer.concat(blocks);
  return opts?.gzip === true ? gzipSync(tar) : tar;
}
