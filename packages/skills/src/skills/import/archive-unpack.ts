// SPDX-License-Identifier: Apache-2.0
/**
 * Dependency-free ZIP preflight and in-memory extraction for skill archives.
 *
 * The central directory is fully validated before the first member is
 * inflated. Declared sizes, compression ratios, paths, member types, local
 * header ranges, and the single-skill root are therefore refusal points before
 * decompression allocates the declared output.
 *
 * @module
 */

import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { err, ok, tryCatch, type Result } from "@comis/shared";
import type { SkillBundleFile } from "./bundle-types.js";

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const ZIP64_EXTRA_ID = 0x0001;
const MAX_EOCD_SEARCH = 65_535 + 22;
const ENCRYPTION_FLAGS = 0x2041;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
const UNIX_FILE_TYPE_MASK = 0o170000;
const UNIX_REGULAR = 0o100000;
const UNIX_DIRECTORY = 0o040000;

/** Stable archive refusal codes surfaced by every source adapter. */
export type ArchiveErrorCode =
  | "archive_size_exceeded"
  | "archive_entry_count_exceeded"
  | "archive_entry_size_exceeded"
  | "archive_total_size_exceeded"
  | "archive_ratio_exceeded"
  | "archive_unsafe_entry"
  | "archive_unsupported_feature"
  | "archive_changed_during_preflight"
  | "archive_ambiguous_root";

/** Structured archive refusal. */
export interface ArchiveError {
  readonly code: ArchiveErrorCode;
  readonly message: string;
  readonly path?: string;
}

/** Archive and inflated-bundle limits. */
export interface SkillArchiveLimits {
  readonly maxArchiveBytes: number;
  readonly maxEntries: number;
  readonly maxEntryBytes: number;
  readonly maxBundleBytes: number;
  readonly maxPathDepth: number;
  readonly maxCompressionRatio: number;
}

/** Conservative defaults for prompt-oriented skill bundles. */
export const DEFAULT_SKILL_ARCHIVE_LIMITS: SkillArchiveLimits = {
  maxArchiveBytes: 8 * 1024 * 1024,
  maxEntries: 200,
  maxEntryBytes: 4 * 1024 * 1024,
  maxBundleBytes: 32 * 1024 * 1024,
  maxPathDepth: 10,
  maxCompressionRatio: 100,
};

interface EndRecord {
  readonly entryCount: number;
  readonly centralSize: number;
  readonly centralOffset: number;
}

interface ArchiveMember {
  readonly path: string;
  readonly outputPath: string;
  readonly flags: number;
  readonly method: number;
  readonly checksum: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localOffset: number;
  readonly dataOffset: number;
  readonly dataEnd: number;
  readonly isDirectory: boolean;
  readonly mode?: number;
}

function failure(code: ArchiveErrorCode, message: string, path?: string): ArchiveError {
  return { code, message, ...(path !== undefined && { path }) };
}

function readU16(bytes: Uint8Array, offset: number): number | undefined {
  if (offset < 0 || offset + 2 > bytes.byteLength) return undefined;
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readU32(bytes: Uint8Array, offset: number): number | undefined {
  if (offset < 0 || offset + 4 > bytes.byteLength) return undefined;
  return (
    (bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>>
    0
  );
}

function findEndRecord(bytes: Uint8Array): Result<EndRecord, ArchiveError> {
  const first = Math.max(0, bytes.byteLength - MAX_EOCD_SEARCH);
  for (let offset = bytes.byteLength - 22; offset >= first; offset--) {
    if (readU32(bytes, offset) !== END_SIGNATURE) continue;
    const commentLength = readU16(bytes, offset + 20);
    if (commentLength === undefined || offset + 22 + commentLength !== bytes.byteLength) continue;
    const disk = readU16(bytes, offset + 4);
    const centralDisk = readU16(bytes, offset + 6);
    const diskEntries = readU16(bytes, offset + 8);
    const totalEntries = readU16(bytes, offset + 10);
    const centralSize = readU32(bytes, offset + 12);
    const centralOffset = readU32(bytes, offset + 16);
    if (
      disk === undefined ||
      centralDisk === undefined ||
      diskEntries === undefined ||
      totalEntries === undefined ||
      centralSize === undefined ||
      centralOffset === undefined
    ) {
      break;
    }
    if (disk !== 0 || centralDisk !== 0 || diskEntries !== totalEntries) {
      return err(
        failure("archive_unsupported_feature", "Multi-disk ZIP archives are not supported"),
      );
    }
    if (
      totalEntries === 0xffff ||
      centralSize === 0xffffffff ||
      centralOffset === 0xffffffff
    ) {
      return err(failure("archive_unsupported_feature", "ZIP64 archives are not supported"));
    }
    if (centralOffset + centralSize !== offset) {
      return err(
        failure("archive_unsupported_feature", "ZIP central-directory bounds are invalid"),
      );
    }
    return ok({ entryCount: totalEntries, centralSize, centralOffset });
  }
  return err(failure("archive_unsupported_feature", "ZIP end record was not found"));
}

function decodeName(bytes: Uint8Array): Result<string, ArchiveError> {
  const decoded = tryCatch(() => new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  return decoded.ok
    ? ok(decoded.value)
    : err(failure("archive_unsafe_entry", "Archive member name is not valid UTF-8"));
}

function containsZip64Extra(extra: Uint8Array): boolean {
  let offset = 0;
  while (offset + 4 <= extra.byteLength) {
    const id = readU16(extra, offset);
    const size = readU16(extra, offset + 2);
    if (id === undefined || size === undefined || offset + 4 + size > extra.byteLength) return true;
    if (id === ZIP64_EXTRA_ID) return true;
    offset += 4 + size;
  }
  return offset !== extra.byteLength;
}

function normalizeMemberPath(
  path: string,
  maxPathDepth: number,
): Result<{ path: string; trailingSlash: boolean }, ArchiveError> {
  const trailingSlash = path.endsWith("/");
  if (
    path.length === 0 ||
    path.includes("\0") ||
    path.includes("\\") ||
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path)
  ) {
    return err(failure("archive_unsafe_entry", `Unsafe archive member path: ${path}`, path));
  }
  const segments = path.split("/").filter((segment) => segment !== "");
  if (
    segments.length === 0 ||
    segments.length > maxPathDepth ||
    segments.some((segment) => segment === "." || segment === "..")
  ) {
    return err(failure("archive_unsafe_entry", `Unsafe archive member path: ${path}`, path));
  }
  return ok({ path: segments.join("/"), trailingSlash });
}

function memberType(
  versionMadeBy: number,
  externalAttributes: number,
  trailingSlash: boolean,
): Result<{ isDirectory: boolean; mode?: number }, ArchiveError> {
  const creatorSystem = versionMadeBy >>> 8;
  const unixMode = externalAttributes >>> 16;
  const unixType = unixMode & UNIX_FILE_TYPE_MASK;
  const dosDirectory = (externalAttributes & 0x10) !== 0;
  if (
    creatorSystem === 3 &&
    unixType !== 0 &&
    unixType !== UNIX_REGULAR &&
    unixType !== UNIX_DIRECTORY
  ) {
    return err(
      failure("archive_unsafe_entry", "Archive contains a link or special-device member"),
    );
  }
  const isDirectory = trailingSlash || dosDirectory || unixType === UNIX_DIRECTORY;
  if (isDirectory && creatorSystem === 3 && unixType === UNIX_REGULAR) {
    return err(failure("archive_unsafe_entry", "Archive member type conflicts with its path"));
  }
  return ok({
    isDirectory,
    ...(creatorSystem === 3 && unixMode !== 0 && { mode: unixMode }),
  });
}

function resolveRoot(paths: readonly string[]): Result<string, ArchiveError> {
  if (paths.some((path) => path.toLowerCase() === "skill.md")) return ok("");
  const roots = new Set(paths.map((path) => path.split("/")[0]!));
  if (roots.size !== 1) {
    return err(
      failure("archive_ambiguous_root", "Archive must contain exactly one skill root"),
    );
  }
  const root = [...roots][0]!;
  if (!paths.some((path) => path.toLowerCase() === `${root.toLowerCase()}/skill.md`)) {
    return err(
      failure("archive_ambiguous_root", "Archive root does not contain SKILL.md"),
    );
  }
  return ok(`${root}/`);
}

function parseMembers(
  bytes: Uint8Array,
  end: EndRecord,
  limits: SkillArchiveLimits,
): Result<readonly ArchiveMember[], ArchiveError> {
  if (end.entryCount > limits.maxEntries) {
    return err(
      failure(
        "archive_entry_count_exceeded",
        `Archive entries ${end.entryCount} exceed skills.installVetting.maxEntries=${limits.maxEntries}`,
      ),
    );
  }
  const pending: Omit<ArchiveMember, "outputPath">[] = [];
  const paths = new Set<string>();
  let centralCursor = end.centralOffset;
  let declaredTotal = 0;

  for (let index = 0; index < end.entryCount; index++) {
    if (readU32(bytes, centralCursor) !== CENTRAL_SIGNATURE) {
      return err(failure("archive_unsupported_feature", "ZIP central entry is malformed"));
    }
    const versionMadeBy = readU16(bytes, centralCursor + 4);
    const flags = readU16(bytes, centralCursor + 8);
    const method = readU16(bytes, centralCursor + 10);
    const checksum = readU32(bytes, centralCursor + 16);
    const compressedSize = readU32(bytes, centralCursor + 20);
    const uncompressedSize = readU32(bytes, centralCursor + 24);
    const nameLength = readU16(bytes, centralCursor + 28);
    const extraLength = readU16(bytes, centralCursor + 30);
    const commentLength = readU16(bytes, centralCursor + 32);
    const diskStart = readU16(bytes, centralCursor + 34);
    const externalAttributes = readU32(bytes, centralCursor + 38);
    const localOffset = readU32(bytes, centralCursor + 42);
    if (
      versionMadeBy === undefined ||
      flags === undefined ||
      method === undefined ||
      checksum === undefined ||
      compressedSize === undefined ||
      uncompressedSize === undefined ||
      nameLength === undefined ||
      extraLength === undefined ||
      commentLength === undefined ||
      diskStart === undefined ||
      externalAttributes === undefined ||
      localOffset === undefined
    ) {
      return err(failure("archive_unsupported_feature", "ZIP central entry is truncated"));
    }
    const centralEnd = centralCursor + 46 + nameLength + extraLength + commentLength;
    if (centralEnd > end.centralOffset + end.centralSize) {
      return err(failure("archive_unsupported_feature", "ZIP central entry exceeds its bounds"));
    }
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localOffset === 0xffffffff ||
      containsZip64Extra(bytes.subarray(centralCursor + 46 + nameLength, centralCursor + 46 + nameLength + extraLength))
    ) {
      return err(failure("archive_unsupported_feature", "ZIP64 archives are not supported"));
    }
    if (diskStart !== 0 || (flags & ENCRYPTION_FLAGS) !== 0) {
      return err(
        failure("archive_unsupported_feature", "Encrypted or multi-disk members are not supported"),
      );
    }
    if (method !== METHOD_STORED && method !== METHOD_DEFLATE) {
      return err(
        failure("archive_unsupported_feature", `ZIP compression method ${method} is not supported`),
      );
    }
    const decoded = decodeName(bytes.subarray(centralCursor + 46, centralCursor + 46 + nameLength));
    if (!decoded.ok) return decoded;
    const normalized = normalizeMemberPath(decoded.value, limits.maxPathDepth);
    if (!normalized.ok) return normalized;
    const type = memberType(versionMadeBy, externalAttributes, normalized.value.trailingSlash);
    if (!type.ok) return type;
    if (!type.value.isDirectory) {
      if (paths.has(normalized.value.path)) {
        return err(
          failure(
            "archive_unsafe_entry",
            `Archive contains duplicate member path: ${normalized.value.path}`,
            normalized.value.path,
          ),
        );
      }
      paths.add(normalized.value.path);
      if (
        uncompressedSize > 0 &&
        (compressedSize === 0 || uncompressedSize > compressedSize * limits.maxCompressionRatio)
      ) {
        return err(
          failure(
            "archive_ratio_exceeded",
            `Archive member ${normalized.value.path} ratio exceeds skills.import.maxCompressionRatio=${limits.maxCompressionRatio}`,
            normalized.value.path,
          ),
        );
      }
      if (uncompressedSize > limits.maxEntryBytes) {
        return err(
          failure(
            "archive_entry_size_exceeded",
            `Archive member ${normalized.value.path} declared ${uncompressedSize} bytes, over skills.installVetting.maxEntryBytes=${limits.maxEntryBytes}`,
            normalized.value.path,
          ),
        );
      }
      declaredTotal += uncompressedSize;
      if (declaredTotal > limits.maxBundleBytes) {
        return err(
          failure(
            "archive_total_size_exceeded",
            `Archive inflated bytes ${declaredTotal} exceed skills.installVetting.maxBundleBytes=${limits.maxBundleBytes}`,
          ),
        );
      }
    } else if (compressedSize !== 0 || uncompressedSize !== 0) {
      return err(failure("archive_unsafe_entry", "Archive directory member contains data"));
    }
    if (readU32(bytes, localOffset) !== LOCAL_SIGNATURE) {
      return err(failure("archive_unsupported_feature", "ZIP local header is missing"));
    }
    const localFlags = readU16(bytes, localOffset + 6);
    const localMethod = readU16(bytes, localOffset + 8);
    const localNameLength = readU16(bytes, localOffset + 26);
    const localExtraLength = readU16(bytes, localOffset + 28);
    if (
      localFlags === undefined ||
      localMethod === undefined ||
      localNameLength === undefined ||
      localExtraLength === undefined ||
      localFlags !== flags ||
      localMethod !== method
    ) {
      return err(failure("archive_unsupported_feature", "ZIP local header conflicts with central entry"));
    }
    const localNameStart = localOffset + 30;
    const dataOffset = localNameStart + localNameLength + localExtraLength;
    const dataEnd = dataOffset + compressedSize;
    if (dataEnd > end.centralOffset) {
      return err(failure("archive_unsupported_feature", "ZIP member data exceeds its bounds"));
    }
    const localName = decodeName(bytes.subarray(localNameStart, localNameStart + localNameLength));
    if (!localName.ok || localName.value !== decoded.value) {
      return err(failure("archive_unsafe_entry", "ZIP local and central member names differ"));
    }
    if (containsZip64Extra(bytes.subarray(localNameStart + localNameLength, dataOffset))) {
      return err(failure("archive_unsupported_feature", "ZIP64 archives are not supported"));
    }
    pending.push({
      path: normalized.value.path,
      flags,
      method,
      checksum,
      compressedSize,
      uncompressedSize,
      localOffset,
      dataOffset,
      dataEnd,
      isDirectory: type.value.isDirectory,
      ...(type.value.mode !== undefined && { mode: type.value.mode }),
    });
    centralCursor = centralEnd;
  }
  if (centralCursor !== end.centralOffset + end.centralSize) {
    return err(failure("archive_unsupported_feature", "ZIP central-directory size is inconsistent"));
  }
  const ranges = [...pending]
    .map((member) => ({ start: member.localOffset, end: member.dataEnd }))
    .sort((left, right) => left.start - right.start);
  for (let index = 1; index < ranges.length; index++) {
    if (ranges[index]!.start < ranges[index - 1]!.end) {
      return err(failure("archive_unsafe_entry", "ZIP member ranges overlap"));
    }
  }
  const root = resolveRoot([...paths]);
  if (!root.ok) return root;
  return ok(
    pending.map((member) => ({
      ...member,
      outputPath: root.value === "" ? member.path : member.path.slice(root.value.length),
    })),
  );
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function inflateMember(
  bytes: Uint8Array,
  member: ArchiveMember,
): Result<Uint8Array, ArchiveError> {
  const compressed = bytes.subarray(member.dataOffset, member.dataEnd);
  if (member.method === METHOD_STORED) return ok(Uint8Array.from(compressed));
  const inflated = tryCatch(() =>
    inflateRawSync(compressed, {
      maxOutputLength: Math.max(1, member.uncompressedSize),
    }),
  );
  return inflated.ok
    ? ok(Uint8Array.from(inflated.value))
    : err(
        failure(
          "archive_unsupported_feature",
          `Archive member ${member.path} could not be inflated`,
          member.path,
        ),
      );
}

/** Preflight and extract a ZIP-backed `.skill` archive entirely in memory. */
export function unpackSkillArchive(
  bytes: Uint8Array,
  overrides: Partial<SkillArchiveLimits> = {},
): Result<readonly SkillBundleFile[], ArchiveError> {
  const limits = { ...DEFAULT_SKILL_ARCHIVE_LIMITS, ...overrides };
  if (bytes.byteLength > limits.maxArchiveBytes) {
    return err(
      failure(
        "archive_size_exceeded",
        `Archive bytes ${bytes.byteLength} exceed skills.import.maxArchiveBytes=${limits.maxArchiveBytes}`,
      ),
    );
  }
  const hashBefore = digest(bytes);
  const end = findEndRecord(bytes);
  if (!end.ok) return end;
  const members = parseMembers(bytes, end.value, limits);
  if (!members.ok) return members;
  if (digest(bytes) !== hashBefore) {
    return err(
      failure(
        "archive_changed_during_preflight",
        "Archive bytes changed during central-directory preflight",
      ),
    );
  }

  const files: SkillBundleFile[] = [];
  let actualTotal = 0;
  for (const member of members.value) {
    if (member.isDirectory) continue;
    const inflated = inflateMember(bytes, member);
    if (!inflated.ok) return inflated;
    if (inflated.value.byteLength !== member.uncompressedSize) {
      return err(
        failure(
          "archive_unsupported_feature",
          `Archive member ${member.path} size does not match its declaration`,
          member.path,
        ),
      );
    }
    if (inflated.value.byteLength > limits.maxEntryBytes) {
      return err(
        failure(
          "archive_entry_size_exceeded",
          `Archive member ${member.path} inflated ${inflated.value.byteLength} bytes, over skills.installVetting.maxEntryBytes=${limits.maxEntryBytes}`,
          member.path,
        ),
      );
    }
    actualTotal += inflated.value.byteLength;
    if (actualTotal > limits.maxBundleBytes) {
      return err(
        failure(
          "archive_total_size_exceeded",
          `Archive inflated bytes ${actualTotal} exceed skills.installVetting.maxBundleBytes=${limits.maxBundleBytes}`,
        ),
      );
    }
    if (crc32(inflated.value) !== member.checksum) {
      return err(
        failure(
          "archive_unsupported_feature",
          `Archive member ${member.path} checksum does not match`,
          member.path,
        ),
      );
    }
    files.push({
      path: member.outputPath,
      content: inflated.value,
      type: "file",
      ...(member.mode !== undefined && { mode: member.mode }),
    });
  }
  return ok(files);
}
