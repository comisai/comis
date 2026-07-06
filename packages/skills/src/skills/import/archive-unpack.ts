// SPDX-License-Identifier: Apache-2.0
/**
 * In-house bounded archive reader — the first fail-closed gate for untrusted
 * skill archive bytes. It parses a zip / `.skill` (STORE + DEFLATE) or a
 * tar / tar.gz (ustar + pax) stream into an IN-MEMORY, bounds-checked entry set
 * and never writes to disk: a caller (the import pipeline) applies the
 * text-filter and scan on the returned entries and writes only the survivors.
 *
 * Every unsafe shape rejects with a typed {@link UnpackError} carrying a `hint`
 * and an `errorKind`: absolute (POSIX + Windows) or `..` paths, symlink /
 * hardlink entries, entries past the depth cap, decompression bombs (the
 * inflate is bounded by `maxOutputLength`, so it aborts rather than allocating
 * the full output), and archives whose manifest is missing, duplicated, nested,
 * or not valid UTF-8. `__MACOSX/` and dotfile entries are dropped, not rejected.
 *
 * No new dependency: `node:zlib` (`inflateRawSync` / `gunzipSync`) does the
 * decompression and the container walks are hand-rolled.
 *
 * @module
 */
import { inflateRawSync, gunzipSync } from "node:zlib";
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import { safePath, type ErrorKind } from "@comis/core";

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/** Bounds enforced while walking + decompressing. */
export interface UnpackCaps {
  /** Reject a compressed input larger than this (bytes). */
  readonly maxArchiveBytes: number;
  /** Reject once the cumulative uncompressed output would exceed this (bytes). */
  readonly maxTotalUncompressedBytes: number;
  /** Reject any single file larger than this (bytes). */
  readonly maxFileBytes: number;
  /** Reject once the kept-file count would exceed this. */
  readonly maxFileCount: number;
  /** Reject any entry whose path is deeper than this many segments. */
  readonly maxPathDepth: number;
}

/** Conservative defaults for prompt-skill archives (all config-dialable). */
export const DEFAULT_UNPACK_CAPS: UnpackCaps = {
  maxArchiveBytes: 8_388_608, // 8 MiB
  maxTotalUncompressedBytes: 67_108_864, // 64 MiB
  maxFileBytes: 4_194_304, // 4 MiB
  maxFileCount: 200,
  maxPathDepth: 10,
};

/** One bounds-checked entry, path relative to the located skill root. */
export interface UnpackedFile {
  /** Path relative to the skill root; the manifest is always `SKILL.md`. */
  readonly relPath: string;
  /** Whether the source entry carried a Unix exec bit. */
  readonly execBit: boolean;
  /** Uncompressed file bytes (retained in memory; never written here). */
  readonly bytes: Buffer;
}

/** A successful unpack. */
export interface UnpackResult {
  readonly files: readonly UnpackedFile[];
  /** The single top-level directory the skill lived in, or `""` for the root. */
  readonly skillRootRel: string;
}

/** A typed reject. */
export interface UnpackError {
  readonly message: string;
  readonly hint: string;
  readonly errorKind: ErrorKind;
}

/** Options for {@link unpackArchive}. */
export interface UnpackOptions {
  readonly caps: UnpackCaps;
  /** Container format; `auto` (default) detects it by magic bytes. */
  readonly format?: "zip" | "tar" | "auto";
}

/** A container entry after format-specific parsing, before manifest location. */
interface Candidate {
  readonly name: string;
  readonly execBit: boolean;
  readonly bytes: Buffer;
}

// ---------------------------------------------------------------------------
// Error constructors
// ---------------------------------------------------------------------------

function mk(errorKind: ErrorKind, message: string, hint: string): UnpackError {
  return { errorKind, message, hint };
}

function fileCapError(caps: UnpackCaps): UnpackError {
  return mk(
    "resource",
    `a file exceeds the ${caps.maxFileBytes}-byte per-file limit`,
    "raise skills.import.maxFileBytes or shrink the file",
  );
}

function totalCapError(caps: UnpackCaps): UnpackError {
  return mk(
    "resource",
    `the archive's uncompressed size exceeds the ${caps.maxTotalUncompressedBytes}-byte limit`,
    "raise skills.import.maxTotalUncompressedBytes or provide a smaller archive",
  );
}

function countCapError(caps: UnpackCaps): UnpackError {
  return mk(
    "resource",
    `the archive contains more than ${caps.maxFileCount} files`,
    "raise skills.import.maxFileCount or split the archive",
  );
}

// ---------------------------------------------------------------------------
// Shared per-entry path classification
// ---------------------------------------------------------------------------

// A synthetic, non-existent absolute base: safePath resolves each entry under
// it purely to validate containment (`..`, null bytes, encoded traversal). It
// is never used for I/O, so the base need not — and does not — exist.
const NOTIONAL_BASE = "/skill-import-notional-root";

type Classification =
  | { readonly kind: "reject"; readonly error: UnpackError }
  | { readonly kind: "drop" }
  | { readonly kind: "accept"; readonly segments: readonly string[] };

/**
 * Validate one archive-relative path and decide accept / drop / reject. Order:
 * absolute + backslash + `..` + depth reject; `__MACOSX/`/dotfile drop; a final
 * `safePath` containment check (catches null bytes and encoded traversal).
 */
function classifyPath(name: string, caps: UnpackCaps): Classification {
  if (name.length === 0) {
    return { kind: "reject", error: mk("validation", "an archive entry has an empty name", "re-create the archive; an entry has no path") };
  }
  if (name.startsWith("/")) {
    return { kind: "reject", error: mk("validation", `entry "${name}" is an absolute path`, "archive entries must use relative paths") };
  }
  if (/^[A-Za-z]:/.test(name) || name.includes("\\")) {
    return { kind: "reject", error: mk("validation", `entry "${name}" is a Windows-absolute or backslash path`, "archive entries must use relative, forward-slash paths") };
  }
  const segments = name.split("/").filter((s) => s.length > 0 && s !== ".");
  if (segments.some((s) => s === "..")) {
    return { kind: "reject", error: mk("validation", `entry "${name}" escapes the archive with a ".." segment`, "remove parent-directory segments from archive paths") };
  }
  if (segments.length > caps.maxPathDepth) {
    return { kind: "reject", error: mk("resource", `entry "${name}" is nested deeper than ${caps.maxPathDepth} levels`, "flatten the archive or raise skills.import.maxPathDepth") };
  }
  if (segments.some((s) => s === "__MACOSX" || s.startsWith("."))) {
    return { kind: "drop" };
  }
  try {
    safePath(NOTIONAL_BASE, ...segments);
  } catch {
    return { kind: "reject", error: mk("validation", `entry "${name}" failed path-containment validation`, "remove traversal, null-byte, or encoded segments from archive paths") };
  }
  return { kind: "accept", segments };
}

// ---------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------

function detectFormat(bytes: Buffer): "zip" | "tar" | null {
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    ((bytes[2] === 0x03 && bytes[3] === 0x04) || (bytes[2] === 0x05 && bytes[3] === 0x06))
  ) {
    return "zip";
  }
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    return "tar"; // gzip magic → the tar reader gunzips first
  }
  if (bytes.length >= 262 && bytes.toString("latin1", 257, 262) === "ustar") {
    return "tar";
  }
  return null;
}

// ---------------------------------------------------------------------------
// zip reader
// ---------------------------------------------------------------------------

const ZIP_LOCAL_SIG = 0x04034b50;
const ZIP_CENTRAL_SIG = 0x02014b50;
const ZIP_EOCD_SIG = 0x06054b50;

/** Locate the end-of-central-directory record by scanning back from the tail. */
function findEocd(bytes: Buffer): number {
  const minPos = Math.max(0, bytes.length - 22 - 0xffff);
  for (let i = bytes.length - 22; i >= minPos; i--) {
    if (bytes.readUInt32LE(i) === ZIP_EOCD_SIG) return i;
  }
  return -1;
}

function readZipEntries(bytes: Buffer, caps: UnpackCaps): Result<Candidate[], UnpackError> {
  const eocd = findEocd(bytes);
  if (eocd < 0) {
    return err(mk("validation", "zip end-of-central-directory record not found", "the archive is not a valid zip/.skill file"));
  }
  const count = bytes.readUInt16LE(eocd + 10);
  const candidates: Candidate[] = [];
  let totalUncompressed = 0;
  let keptCount = 0;
  let p = bytes.readUInt32LE(eocd + 16);

  for (let i = 0; i < count; i++) {
    if (p + 46 > bytes.length || bytes.readUInt32LE(p) !== ZIP_CENTRAL_SIG) {
      return err(mk("validation", "zip central-directory entry is malformed", "the archive's zip structure is corrupt"));
    }
    const method = bytes.readUInt16LE(p + 10);
    const compSize = bytes.readUInt32LE(p + 20);
    const nameLen = bytes.readUInt16LE(p + 28);
    const extraLen = bytes.readUInt16LE(p + 30);
    const commentLen = bytes.readUInt16LE(p + 32);
    const externalAttr = bytes.readUInt32LE(p + 38);
    const localOffset = bytes.readUInt32LE(p + 42);
    const name = bytes.toString("utf-8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    const execBit = ((externalAttr >>> 16) & 0o111) !== 0;

    // Reject a symlink entry for parity with the tar reader: a zip symlink
    // stores the link target string as its content, so treating it as a regular
    // file would both disagree with the tar path and mis-describe the entry. A
    // DOS/Windows-authored zip carries 0 in the high mode bits, so this never
    // false-triggers on a regular file.
    if (((externalAttr >>> 16) & 0o170000) === 0o120000) {
      return err(mk("validation", `zip entry "${name}" is a symlink`, "remove link entries; only regular files are imported"));
    }

    // A directory entry (trailing slash) still needs path validation, but has
    // no content to add.
    if (name.endsWith("/")) {
      const dirClass = classifyPath(name.slice(0, -1), caps);
      if (dirClass.kind === "reject") return err(dirClass.error);
      continue;
    }

    const cls = classifyPath(name, caps);
    if (cls.kind === "reject") return err(cls.error);
    if (cls.kind === "drop") continue;
    if (keptCount >= caps.maxFileCount) return err(countCapError(caps));

    if (localOffset + 30 > bytes.length || bytes.readUInt32LE(localOffset) !== ZIP_LOCAL_SIG) {
      return err(mk("validation", "zip local file header is malformed", "the archive's zip structure is corrupt"));
    }
    const dataStart = localOffset + 30 + bytes.readUInt16LE(localOffset + 26) + bytes.readUInt16LE(localOffset + 28);
    const dataEnd = dataStart + compSize;
    if (dataEnd > bytes.length) {
      return err(mk("validation", "zip entry data extends past the archive end", "the archive is truncated or corrupt"));
    }
    const compData = bytes.subarray(dataStart, dataEnd);

    const remaining = caps.maxTotalUncompressedBytes - totalUncompressed;
    if (remaining <= 0) return err(totalCapError(caps));
    const perEntryLimit = Math.min(caps.maxFileBytes, remaining);

    let data: Buffer;
    if (method === 0) {
      if (compData.length > perEntryLimit) {
        return err(perEntryLimit === remaining ? totalCapError(caps) : fileCapError(caps));
      }
      data = Buffer.from(compData);
    } else if (method === 8) {
      try {
        data = inflateRawSync(compData, { maxOutputLength: perEntryLimit + 1 });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
          return err(perEntryLimit === remaining ? totalCapError(caps) : fileCapError(caps));
        }
        return err(mk("validation", `zip entry "${name}" is not valid DEFLATE data`, "re-create the archive; an entry's compressed data is corrupt"));
      }
    } else {
      return err(mk("validation", `zip entry "${name}" uses unsupported compression method ${method}`, "re-create the archive with standard STORE or DEFLATE compression"));
    }

    if (data.length > caps.maxFileBytes) return err(fileCapError(caps));
    totalUncompressed += data.length;
    if (totalUncompressed > caps.maxTotalUncompressedBytes) return err(totalCapError(caps));
    keptCount++;
    candidates.push({ name, execBit, bytes: data });
  }
  return ok(candidates);
}

// ---------------------------------------------------------------------------
// tar reader (ustar + pax)
// ---------------------------------------------------------------------------

const TAR_BLOCK = 512;

function readCString(buf: Buffer, start: number, len: number): string {
  let end = start;
  const limit = start + len;
  // eslint-disable-next-line security/detect-object-injection -- numeric index into a byte buffer
  while (end < limit && buf[end] !== 0) end++;
  return buf.toString("utf-8", start, end);
}

function parseOctal(buf: Buffer, start: number, len: number): number {
  const digits = buf.toString("latin1", start, start + len).replace(/[^0-7]/g, "");
  if (digits.length === 0) return 0;
  const n = parseInt(digits, 8);
  return Number.isFinite(n) ? n : 0;
}

function isZeroBlock(block: Buffer): boolean {
  for (let i = 0; i < block.length; i++) {
    // eslint-disable-next-line security/detect-object-injection -- numeric loop index into a byte block
    if (block[i] !== 0) return false;
  }
  return true;
}

/** Extract the `path` override from pax extended-header records, if present. */
function parsePaxPath(content: string): string | undefined {
  let i = 0;
  while (i < content.length) {
    const sp = content.indexOf(" ", i);
    if (sp < 0) break;
    const len = parseInt(content.slice(i, sp), 10);
    if (!Number.isFinite(len) || len <= 0 || i + len > content.length) break;
    const kv = content.slice(sp + 1, i + len).replace(/\n$/, "");
    const eq = kv.indexOf("=");
    if (eq > 0 && kv.slice(0, eq) === "path") return kv.slice(eq + 1);
    i += len;
  }
  return undefined;
}

function readTarEntries(bytes: Buffer, caps: UnpackCaps): Result<Candidate[], UnpackError> {
  let tar = bytes;
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    // Bound the outer decompression so a gzip bomb aborts rather than filling
    // memory; the framing slack covers per-file headers + terminators.
    const slack = (3 * caps.maxFileCount + 4) * TAR_BLOCK;
    try {
      tar = gunzipSync(bytes, { maxOutputLength: caps.maxTotalUncompressedBytes + slack });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") return err(totalCapError(caps));
      return err(mk("validation", "archive is not valid gzip data", "the archive is corrupt or truncated"));
    }
  }

  const candidates: Candidate[] = [];
  let totalUncompressed = 0;
  let keptCount = 0;
  let pendingPaxPath: string | undefined;
  let offset = 0;

  while (offset + TAR_BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + TAR_BLOCK);
    if (isZeroBlock(header)) break;
    if (header.toString("latin1", 257, 262) !== "ustar") {
      return err(mk("validation", "tar header is missing the ustar magic", "re-create the archive in ustar or pax format"));
    }
    const rawName = readCString(header, 0, 100);
    const prefix = readCString(header, 345, 155);
    const ustarName = prefix.length > 0 ? `${prefix}/${rawName}` : rawName;
    const mode = parseOctal(header, 100, 8);
    const size = parseOctal(header, 124, 12);
    const typeflag = String.fromCharCode(header[156]);
    const contentStart = offset + TAR_BLOCK;
    const contentEnd = contentStart + size;
    const nextOffset = contentStart + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
    if (contentEnd > tar.length) {
      return err(mk("validation", "tar entry data extends past the archive end", "the archive is truncated or corrupt"));
    }

    if (typeflag === "2" || typeflag === "1") {
      const kind = typeflag === "2" ? "symlink" : "hard link";
      return err(mk("validation", `tar entry "${ustarName}" is a ${kind}`, "remove link entries; only regular files are imported"));
    }
    if (typeflag === "x" || typeflag === "g") {
      const path = parsePaxPath(tar.toString("utf-8", contentStart, contentEnd));
      if (path !== undefined) pendingPaxPath = path;
      offset = nextOffset;
      continue;
    }

    const effectiveName = pendingPaxPath ?? ustarName;
    pendingPaxPath = undefined;

    if (typeflag === "5") {
      const dirClass = classifyPath(effectiveName.replace(/\/+$/, ""), caps);
      if (dirClass.kind === "reject") return err(dirClass.error);
      offset = nextOffset;
      continue;
    }
    if (typeflag !== "0" && typeflag !== "\0") {
      return err(mk("validation", `tar entry "${effectiveName}" uses unsupported type flag "${typeflag}"`, "only regular files, directories, and pax headers are supported"));
    }

    const cls = classifyPath(effectiveName, caps);
    if (cls.kind === "reject") return err(cls.error);
    if (cls.kind === "drop") {
      offset = nextOffset;
      continue;
    }
    if (keptCount >= caps.maxFileCount) return err(countCapError(caps));
    if (size > caps.maxFileBytes) return err(fileCapError(caps));
    totalUncompressed += size;
    if (totalUncompressed > caps.maxTotalUncompressedBytes) return err(totalCapError(caps));

    candidates.push({ name: effectiveName, execBit: (mode & 0o111) !== 0, bytes: Buffer.from(tar.subarray(contentStart, contentEnd)) });
    keptCount++;
    offset = nextOffset;
  }
  return ok(candidates);
}

// ---------------------------------------------------------------------------
// Manifest location + orchestration
// ---------------------------------------------------------------------------

function normalizeSegments(name: string): string[] {
  return name.split("/").filter((s) => s.length > 0 && s !== ".");
}

/**
 * Parse untrusted archive bytes into a bounded in-memory entry set. Performs no
 * disk writes; every unsafe entry rejects with a typed {@link UnpackError}.
 */
export function unpackArchive(bytes: Buffer, opts: UnpackOptions): Result<UnpackResult, UnpackError> {
  const { caps } = opts;
  if (bytes.length > caps.maxArchiveBytes) {
    return err(mk("resource", `archive is ${bytes.length} bytes, over the ${caps.maxArchiveBytes}-byte limit`, "raise skills.import.maxArchiveBytes or provide a smaller archive"));
  }

  const format = opts.format && opts.format !== "auto" ? opts.format : detectFormat(bytes);
  if (format === null) {
    return err(mk("validation", "archive format is not a recognized zip/.skill or tar/tar.gz", "provide a .skill/zip or tar/tar.gz archive"));
  }

  const parsed = format === "zip" ? readZipEntries(bytes, caps) : readTarEntries(bytes, caps);
  if (!parsed.ok) return parsed;
  const candidates = parsed.value;

  const manifests = candidates.filter((c) => {
    const segs = normalizeSegments(c.name);
    return segs.length > 0 && segs[segs.length - 1] === "SKILL.md";
  });
  if (manifests.length === 0) {
    return err(mk("validation", "archive does not contain a SKILL.md manifest", "a skill archive needs exactly one SKILL.md at its root or a single top-level directory"));
  }
  if (manifests.length > 1) {
    return err(mk("validation", "archive contains more than one SKILL.md", "import a single-skill archive; nested or multiple SKILL.md files are refused"));
  }

  const manifestSegs = normalizeSegments(manifests[0].name);
  let skillRootRel: string;
  if (manifestSegs.length === 1) {
    skillRootRel = "";
  } else if (manifestSegs.length === 2) {
    skillRootRel = manifestSegs[0];
  } else {
    return err(mk("validation", "SKILL.md is nested more than one directory deep", "place SKILL.md at the archive root or inside a single top-level directory"));
  }

  try {
    new TextDecoder("utf-8", { fatal: true }).decode(manifests[0].bytes);
  } catch {
    return err(mk("validation", "SKILL.md is not valid UTF-8", "save SKILL.md as UTF-8 text"));
  }

  const prefix = skillRootRel.length > 0 ? `${skillRootRel}/` : "";
  const files: UnpackedFile[] = [];
  for (const c of candidates) {
    const norm = normalizeSegments(c.name).join("/");
    if (prefix.length > 0) {
      if (!norm.startsWith(prefix)) {
        return err(mk("validation", "archive has content outside the skill directory", "a skill archive must have exactly one top-level directory (or files at the root), not several"));
      }
      files.push({ relPath: norm.slice(prefix.length), execBit: c.execBit, bytes: c.bytes });
    } else {
      files.push({ relPath: norm, execBit: c.execBit, bytes: c.bytes });
    }
  }
  return ok({ files, skillRootRel });
}
