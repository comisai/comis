// SPDX-License-Identifier: Apache-2.0
import { isAbsolute, normalize } from "node:path";

import { err, ok, type Result } from "@comis/shared";

export const RUNTIME_TREE_FACTS_BEGIN = "COMIS_RUNTIME_TREE_ATTESTATION_V2_BEGIN";
export const RUNTIME_TREE_FACTS_END = "COMIS_RUNTIME_TREE_ATTESTATION_V2_END";

const MAX_RUNTIME_TREE_FACTS_BYTES = 8192;
const MAX_RUNTIME_TREE_ENTRIES = 250_000;
const MAX_RUNTIME_TREE_BYTES = 64 * 1024 * 1024 * 1024;
const MAX_RUNTIME_TREE_ROOT_BYTES = 4096;
const SHA256_RE = /^[a-f0-9]{64}$/u;
const VERSION_RE =
  // eslint-disable-next-line security/detect-unsafe-regex -- inputs are capped at 128 bytes before matching
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const FACT_FIELDS = ["digestSha256", "entryCount", "bytes", "root", "version"] as const;

type RuntimeTreeFactField = (typeof FACT_FIELDS)[number];
type RuntimeTreeIdentityField = Exclude<RuntimeTreeFactField, "root">;

export interface RuntimeTreeAttestation {
  /**
   * SHA-256 over raw relative path bytes, entry type, exact mode, numeric
   * uid/gid, mtime_ns, and file bytes or symlink target bytes for every entry.
   */
  readonly digestSha256: string;
  /** Directories, regular files, and symbolic links, including the tree root. */
  readonly entryCount: number;
  /** Sum of regular-file content bytes. */
  readonly bytes: number;
  /** Canonical absolute path used as the read-only attestation anchor. */
  readonly root: string;
  /** Pinned version read from the root package.json regular file. */
  readonly version: string;
}

export type RuntimeTreeError =
  | {
      readonly kind: "malformed_runtime_tree_facts";
      readonly field: RuntimeTreeFactField | "envelope";
      readonly message: string;
    }
  | {
      readonly kind: "runtime_tree_mismatch";
      readonly field: RuntimeTreeIdentityField;
      readonly message: string;
    };

function malformed(
  field: RuntimeTreeFactField | "envelope",
  message: string,
): Result<never, RuntimeTreeError> {
  return err({ kind: "malformed_runtime_tree_facts", field, message });
}

function parseCanonicalInteger(
  raw: string,
  field: "entryCount" | "bytes",
  minimum: number,
  maximum: number,
): Result<number, RuntimeTreeError> {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(raw)) {
    return malformed(field, `${field} must be a canonical non-negative integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    return malformed(field, `${field} is outside the supported attestation bounds`);
  }
  return ok(value);
}

function isCanonicalAbsoluteRoot(root: string): boolean {
  let hasControlCharacter = false;
  for (const character of root) {
    const codePoint = character.charCodeAt(0);
    if (codePoint <= 31 || codePoint === 127) {
      hasControlCharacter = true;
      break;
    }
  }
  return (
    root.length > 0 &&
    Buffer.byteLength(root, "utf8") <= MAX_RUNTIME_TREE_ROOT_BYTES &&
    isAbsolute(root) &&
    normalize(root) === root &&
    !hasControlCharacter
  );
}

function isPinnedVersion(version: string): boolean {
  return version.length <= 128 && VERSION_RE.test(version);
}

function serializeRuntimeTreeFacts(facts: RuntimeTreeAttestation): string {
  return [
    RUNTIME_TREE_FACTS_BEGIN,
    `digestSha256=${facts.digestSha256}`,
    `entryCount=${facts.entryCount}`,
    `bytes=${facts.bytes}`,
    `root=${facts.root}`,
    `version=${facts.version}`,
    RUNTIME_TREE_FACTS_END,
    "",
  ].join("\n");
}

/** Parse the probe's bounded, exact-order, content-free facts envelope. */
export function parseRuntimeTreeFacts(
  raw: string,
): Result<RuntimeTreeAttestation, RuntimeTreeError> {
  if (Buffer.byteLength(raw, "utf8") > MAX_RUNTIME_TREE_FACTS_BYTES) {
    return malformed("envelope", "Runtime tree facts exceed the 8192-byte limit");
  }
  if (!raw.endsWith("\n") || raw.includes("\r") || raw.includes("\0")) {
    return malformed("envelope", "Runtime tree facts do not use the canonical line envelope");
  }

  const lines = raw.slice(0, -1).split("\n");
  if (
    lines.length !== FACT_FIELDS.length + 2 ||
    lines[0] !== RUNTIME_TREE_FACTS_BEGIN ||
    lines.at(-1) !== RUNTIME_TREE_FACTS_END
  ) {
    return malformed("envelope", "Runtime tree facts have an unexpected envelope");
  }

  const values = new Map<RuntimeTreeFactField, string>();
  for (const [index, field] of FACT_FIELDS.entries()) {
    const line = lines[index + 1] as string;
    const prefix = `${field}=`;
    if (!line.startsWith(prefix)) {
      return malformed("envelope", "Runtime tree facts have unknown, missing, or reordered fields");
    }
    values.set(field, line.slice(prefix.length));
  }

  const digestSha256 = values.get("digestSha256") as string;
  const root = values.get("root") as string;
  const version = values.get("version") as string;
  if (!SHA256_RE.test(digestSha256)) {
    return malformed("digestSha256", "digestSha256 must be a lowercase SHA-256 digest");
  }
  const entryCount = parseCanonicalInteger(
    values.get("entryCount") as string,
    "entryCount",
    1,
    MAX_RUNTIME_TREE_ENTRIES,
  );
  if (!entryCount.ok) return entryCount;
  const bytes = parseCanonicalInteger(
    values.get("bytes") as string,
    "bytes",
    0,
    MAX_RUNTIME_TREE_BYTES,
  );
  if (!bytes.ok) return bytes;
  if (!isCanonicalAbsoluteRoot(root)) {
    return malformed("root", "root must be a bounded canonical absolute path");
  }
  if (!isPinnedVersion(version)) {
    return malformed("version", "version must be a pinned semantic version");
  }

  const facts: RuntimeTreeAttestation = {
    digestSha256,
    entryCount: entryCount.value,
    bytes: bytes.value,
    root,
    version,
  };
  if (serializeRuntimeTreeFacts(facts) !== raw) {
    return malformed("envelope", "Runtime tree facts are not canonically encoded");
  }
  return ok(facts);
}

function mismatch(field: RuntimeTreeIdentityField): Result<void, RuntimeTreeError> {
  return err({
    kind: "runtime_tree_mismatch",
    field,
    message: `Target runtime tree ${field} does not match the production source`,
  });
}

/** Compare path-independent tree identity while retaining each root as provenance. */
export function compareRuntimeTreeAttestations(
  expected: RuntimeTreeAttestation,
  actual: RuntimeTreeAttestation,
): Result<void, RuntimeTreeError> {
  if (
    !SHA256_RE.test(expected.digestSha256) ||
    !SHA256_RE.test(actual.digestSha256) ||
    expected.digestSha256 !== actual.digestSha256
  ) {
    return mismatch("digestSha256");
  }
  if (
    !Number.isSafeInteger(expected.entryCount) ||
    !Number.isSafeInteger(actual.entryCount) ||
    expected.entryCount < 1 ||
    actual.entryCount < 1 ||
    expected.entryCount > MAX_RUNTIME_TREE_ENTRIES ||
    actual.entryCount > MAX_RUNTIME_TREE_ENTRIES ||
    expected.entryCount !== actual.entryCount
  ) {
    return mismatch("entryCount");
  }
  if (
    !Number.isSafeInteger(expected.bytes) ||
    !Number.isSafeInteger(actual.bytes) ||
    expected.bytes < 0 ||
    actual.bytes < 0 ||
    expected.bytes > MAX_RUNTIME_TREE_BYTES ||
    actual.bytes > MAX_RUNTIME_TREE_BYTES ||
    expected.bytes !== actual.bytes
  ) {
    return mismatch("bytes");
  }
  if (
    !isPinnedVersion(expected.version) ||
    !isPinnedVersion(actual.version) ||
    expected.version !== actual.version
  ) {
    return mismatch("version");
  }
  return ok(undefined);
}

const RUNTIME_TREE_PYTHON_PROBE = String.raw`
import errno
import ctypes
import hashlib
import json
import os
import re
import stat
import struct
import sys

FACTS_BEGIN = "COMIS_RUNTIME_TREE_ATTESTATION_V2_BEGIN"
FACTS_END = "COMIS_RUNTIME_TREE_ATTESTATION_V2_END"
DIGEST_DOMAIN = b"comis-runtime-tree-v2\0"
MAX_FACTS_BYTES = 8192
MAX_ROOT_BYTES = 4096
MAX_PATH_BYTES = 4096
MAX_LINK_BYTES = 4096
MAX_ENTRIES = 250000
MAX_TOTAL_BYTES = 64 * 1024 * 1024 * 1024
MAX_PACKAGE_JSON_BYTES = 1024 * 1024
MAX_DEPTH = 256
VERSION_RE = re.compile(
    r"^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)"
    r"(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"
)
LIBC = ctypes.CDLL(None, use_errno=True)


class AttestationFailure(Exception):
    pass


def fail(code):
    raise AttestationFailure(code)


def require_platform_guards():
    for name in ("O_DIRECTORY", "O_NOFOLLOW", "O_CLOEXEC"):
        if not hasattr(os, name):
            fail("platform-guard-unavailable")
    for operation in (os.open, os.readlink):
        if operation not in os.supports_dir_fd:
            fail("dir-fd-unavailable")
    if not hasattr(LIBC, "flistxattr"):
        fail("xattr-inspection-unavailable")
    if sys.platform == "darwin" and not hasattr(LIBC, "listxattr"):
        fail("xattr-inspection-unavailable")
    if sys.platform != "darwin" and not hasattr(LIBC, "llistxattr"):
        fail("xattr-inspection-unavailable")


def no_atime_flag():
    flag = getattr(os, "O_NOATIME", 0)
    if flag == 0 and hasattr(os, "geteuid") and os.geteuid() == 0:
        fail("root-no-atime-guard-unavailable")
    return flag


def directory_flags():
    return os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC | no_atime_flag()


def regular_file_flags():
    return os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | no_atime_flag()


def stat_signature(value):
    return (
        value.st_mode,
        value.st_dev,
        value.st_ino,
        value.st_nlink,
        value.st_uid,
        value.st_gid,
        value.st_size,
        value.st_mtime_ns,
        value.st_ctime_ns,
    )


def require_xattr_result(result):
    if result >= 0:
        return result
    error_number = ctypes.get_errno()
    if error_number in (errno.ENOTSUP, getattr(errno, "EOPNOTSUPP", errno.ENOTSUP)):
        fail("xattr-inspection-unavailable")
    raise OSError(error_number, "extended attribute inspection failed")


def reject_xattr_names(raw_names):
    names = [name for name in raw_names.split(b"\0") if name]
    # Current Darwin kernels attach this non-removable provenance marker to
    # locally created test artifacts. It carries no package payload or replay
    # semantics; every other xattr remains a hard failure.
    if sys.platform == "darwin":
        names = [name for name in names if name != b"com.apple.provenance"]
    if names:
        fail("extended-attributes-present")


def ensure_no_xattrs_fd(descriptor):
    ctypes.set_errno(0)
    if sys.platform == "darwin":
        size = LIBC.flistxattr(descriptor, None, 0, 0)
    else:
        size = LIBC.flistxattr(descriptor, None, 0)
    size = require_xattr_result(size)
    if size == 0:
        return
    buffer = ctypes.create_string_buffer(size)
    ctypes.set_errno(0)
    if sys.platform == "darwin":
        observed = LIBC.flistxattr(descriptor, buffer, size, 0)
    else:
        observed = LIBC.flistxattr(descriptor, buffer, size)
    observed = require_xattr_result(observed)
    if observed != size:
        fail("tree-mutated")
    reject_xattr_names(bytes(buffer.raw[:observed]))


def ensure_no_symlink_xattrs(parent_fd, raw_name):
    saved_cwd = os.open(b".", directory_flags())
    try:
        os.fchdir(parent_fd)
        ctypes.set_errno(0)
        if sys.platform == "darwin":
            size = LIBC.listxattr(raw_name, None, 0, 0x0001)
        else:
            size = LIBC.llistxattr(raw_name, None, 0)
        size = require_xattr_result(size)
        if size != 0:
            buffer = ctypes.create_string_buffer(size)
            ctypes.set_errno(0)
            if sys.platform == "darwin":
                observed = LIBC.listxattr(raw_name, buffer, size, 0x0001)
            else:
                observed = LIBC.llistxattr(raw_name, buffer, size)
            observed = require_xattr_result(observed)
            if observed != size:
                fail("tree-mutated")
            reject_xattr_names(bytes(buffer.raw[:observed]))
    finally:
        os.fchdir(saved_cwd)
        os.close(saved_cwd)


def open_absolute_directory(raw_root):
    current = os.open(b"/", directory_flags())
    try:
        for component in raw_root.split(b"/"):
            if component == b"":
                continue
            following = os.open(component, directory_flags(), dir_fd=current)
            os.close(current)
            current = following
        return current
    except BaseException:
        os.close(current)
        raise


def classify_entry(value):
    if stat.S_ISDIR(value.st_mode):
        return b"D"
    if stat.S_ISREG(value.st_mode):
        return b"F"
    if stat.S_ISLNK(value.st_mode):
        return b"L"
    fail("special-file-rejected")


def validate_stat(value, kind):
    if value.st_mode & (stat.S_ISUID | stat.S_ISGID):
        fail("privileged-mode-rejected")
    if kind in (b"F", b"L") and value.st_nlink != 1:
        fail("hardlinked-entry-rejected")
    if value.st_size < 0:
        fail("negative-file-size")


def add_record(records, relative_path, value, kind, link_target):
    if len(relative_path) > MAX_PATH_BYTES:
        fail("relative-path-too-long")
    if relative_path in records:
        fail("duplicate-relative-path")
    validate_stat(value, kind)
    records[relative_path] = (
        kind,
        stat.S_IMODE(value.st_mode),
        stat_signature(value),
        link_target,
    )
    if len(records) > MAX_ENTRIES:
        fail("entry-limit-exceeded")


def scan_directory(directory_fd, relative_components, records, depth):
    if depth > MAX_DEPTH:
        fail("directory-depth-exceeded")
    with os.scandir(directory_fd) as iterator:
        entries = [(os.fsencode(entry.name), entry) for entry in iterator]
    entries.sort(key=lambda pair: pair[0])
    for raw_name, entry in entries:
        if raw_name in (b"", b".", b"..") or b"/" in raw_name or b"\0" in raw_name:
            fail("invalid-entry-name")
        components = relative_components + [raw_name]
        relative_path = b"/".join(components)
        value = entry.stat(follow_symlinks=False)
        kind = classify_entry(value)
        link_target = None
        if kind == b"L":
            link_target = os.readlink(raw_name, dir_fd=directory_fd)
            if not isinstance(link_target, bytes):
                link_target = os.fsencode(link_target)
            if len(link_target) == 0 or len(link_target) > MAX_LINK_BYTES or b"\0" in link_target:
                fail("invalid-link-target")
            ensure_no_symlink_xattrs(directory_fd, raw_name)
        add_record(records, relative_path, value, kind, link_target)

        if kind == b"D":
            child_fd = os.open(raw_name, directory_flags(), dir_fd=directory_fd)
            try:
                if stat_signature(os.fstat(child_fd)) != stat_signature(value):
                    fail("tree-mutated")
                ensure_no_xattrs_fd(child_fd)
                scan_directory(child_fd, components, records, depth + 1)
                if stat_signature(os.fstat(child_fd)) != stat_signature(value):
                    fail("tree-mutated")
            finally:
                os.close(child_fd)
        elif kind == b"F":
            file_fd = os.open(raw_name, regular_file_flags(), dir_fd=directory_fd)
            try:
                if stat_signature(os.fstat(file_fd)) != stat_signature(value):
                    fail("tree-mutated")
                ensure_no_xattrs_fd(file_fd)
                if stat_signature(os.fstat(file_fd)) != stat_signature(value):
                    fail("tree-mutated")
            finally:
                os.close(file_fd)


def collect_inventory(root_fd):
    records = {}
    root_stat = os.fstat(root_fd)
    if not stat.S_ISDIR(root_stat.st_mode):
        fail("root-not-directory")
    ensure_no_xattrs_fd(root_fd)
    add_record(records, b".", root_stat, b"D", None)
    scan_directory(root_fd, [], records, 1)
    if stat_signature(os.fstat(root_fd)) != stat_signature(root_stat):
        fail("tree-mutated")
    total_bytes = 0
    for kind, _mode, signature, _target in records.values():
        if kind == b"F":
            total_bytes += signature[6]
            if total_bytes > MAX_TOTAL_BYTES:
                fail("byte-limit-exceeded")
    return records, total_bytes


def validate_symlinks(records):
    for relative_path, record in records.items():
        kind, _mode, _signature, target = record
        if kind != b"L":
            continue
        if target.startswith(b"/"):
            fail("absolute-link-rejected")
        output = relative_path.split(b"/")[:-1]
        pending = target.split(b"/")
        seen = {relative_path}
        while pending:
            component = pending.pop(0)
            if component in (b"", b"."):
                continue
            if component == b"..":
                if not output:
                    fail("escaping-link-rejected")
                output.pop()
                continue
            output.append(component)
            candidate = b"/".join(output) if output else b"."
            target_record = records.get(candidate)
            if target_record is None:
                fail("dangling-link-rejected")
            target_kind, _target_mode, _target_signature, nested_target = target_record
            if target_kind == b"L":
                if candidate in seen:
                    fail("cyclic-link-rejected")
                seen.add(candidate)
                if nested_target.startswith(b"/"):
                    fail("absolute-link-rejected")
                output.pop()
                pending = nested_target.split(b"/") + pending
            elif pending and target_kind != b"D":
                fail("invalid-link-traversal")
        resolved = b"/".join(output) if output else b"."
        if resolved not in records:
            fail("dangling-link-rejected")


def open_parent(root_fd, relative_path):
    components = relative_path.split(b"/")
    current = os.dup(root_fd)
    try:
        for component in components[:-1]:
            following = os.open(component, directory_flags(), dir_fd=current)
            os.close(current)
            current = following
        return current, components[-1]
    except BaseException:
        os.close(current)
        raise


def update_uint64(digest, value):
    if value < 0 or value > 0xFFFFFFFFFFFFFFFF:
        fail("canonical-length-overflow")
    digest.update(struct.pack(">Q", value))


def update_field(digest, value):
    update_uint64(digest, len(value))
    digest.update(value)


def read_and_hash_file(root_fd, relative_path, expected, digest, capture_content):
    parent_fd, raw_name = open_parent(root_fd, relative_path)
    try:
        file_fd = os.open(raw_name, regular_file_flags(), dir_fd=parent_fd)
    finally:
        os.close(parent_fd)
    try:
        expected_signature = expected[2]
        if stat_signature(os.fstat(file_fd)) != expected_signature:
            fail("tree-mutated")
        ensure_no_xattrs_fd(file_fd)
        expected_size = expected_signature[6]
        update_uint64(digest, expected_size)
        observed = 0
        captured = bytearray() if capture_content else None
        while True:
            chunk = os.read(file_fd, 1024 * 1024)
            if not chunk:
                break
            observed += len(chunk)
            if observed > expected_size:
                fail("tree-mutated")
            digest.update(chunk)
            if captured is not None:
                if observed > MAX_PACKAGE_JSON_BYTES:
                    fail("package-json-too-large")
                captured.extend(chunk)
        if observed != expected_size or stat_signature(os.fstat(file_fd)) != expected_signature:
            fail("tree-mutated")
        return bytes(captured) if captured is not None else None
    finally:
        os.close(file_fd)


def reject_duplicate_json_keys(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            fail("duplicate-package-json-key")
        value[key] = item
    return value


def parse_version(package_json):
    if package_json is None:
        fail("package-json-missing")
    try:
        decoded = package_json.decode("utf-8", "strict")
        manifest = json.loads(decoded, object_pairs_hook=reject_duplicate_json_keys)
    except (UnicodeError, json.JSONDecodeError):
        fail("package-json-invalid")
    if not isinstance(manifest, dict):
        fail("package-json-invalid")
    version = manifest.get("version")
    if not isinstance(version, str) or len(version) > 128 or VERSION_RE.fullmatch(version) is None:
        fail("package-version-unpinned")
    return version


def attest(root):
    raw_root = os.fsencode(root)
    root_fd = open_absolute_directory(raw_root)
    try:
        first_inventory, total_bytes = collect_inventory(root_fd)
        validate_symlinks(first_inventory)
        digest = hashlib.sha256()
        digest.update(DIGEST_DOMAIN)
        package_json = None
        for relative_path in sorted(first_inventory):
            record = first_inventory[relative_path]
            kind, mode, signature, target = record
            digest.update(kind)
            update_field(digest, relative_path)
            update_field(digest, format(mode, "04o").encode("ascii"))
            update_field(digest, str(signature[4]).encode("ascii"))
            update_field(digest, str(signature[5]).encode("ascii"))
            update_field(digest, str(signature[7]).encode("ascii"))
            if kind == b"D":
                update_field(digest, b"")
            elif kind == b"L":
                update_field(digest, target)
            elif kind == b"F":
                captured = read_and_hash_file(
                    root_fd,
                    relative_path,
                    record,
                    digest,
                    relative_path == b"package.json",
                )
                if captured is not None:
                    package_json = captured
            else:
                fail("unknown-entry-kind")

        second_inventory, second_total_bytes = collect_inventory(root_fd)
        validate_symlinks(second_inventory)
        if first_inventory != second_inventory or total_bytes != second_total_bytes:
            fail("tree-mutated")
        verification_fd = open_absolute_directory(raw_root)
        try:
            if stat_signature(os.fstat(verification_fd)) != stat_signature(os.fstat(root_fd)):
                fail("root-path-mutated")
        finally:
            os.close(verification_fd)
        version = parse_version(package_json)
        return digest.hexdigest(), len(first_inventory), total_bytes, version
    finally:
        os.close(root_fd)


def validate_root(raw):
    if not isinstance(raw, str) or raw == "" or "\0" in raw or "\n" in raw or "\r" in raw:
        fail("invalid-root")
    if not os.path.isabs(raw):
        fail("root-not-absolute")
    canonical = os.path.normpath(raw)
    if canonical != raw:
        fail("root-not-canonical")
    encoded = os.fsencode(raw)
    if len(encoded) > MAX_ROOT_BYTES:
        fail("root-too-long")
    try:
        encoded.decode("utf-8", "strict")
    except UnicodeError:
        fail("root-not-utf8")
    return canonical


def main():
    if len(sys.argv) != 2:
        fail("root-argument-required")
    require_platform_guards()
    root = validate_root(sys.argv[1])
    digest, entry_count, byte_count, version = attest(root)
    facts = "\n".join(
        [
            FACTS_BEGIN,
            "digestSha256=" + digest,
            "entryCount=" + str(entry_count),
            "bytes=" + str(byte_count),
            "root=" + root,
            "version=" + version,
            FACTS_END,
            "",
        ]
    )
    if len(facts.encode("utf-8")) > MAX_FACTS_BYTES:
        fail("facts-limit-exceeded")
    sys.stdout.write(facts)


try:
    main()
except AttestationFailure as error:
    sys.stderr.write("Runtime tree attestation failed: " + str(error) + "\n")
    raise SystemExit(1)
except (OSError, OverflowError, UnicodeError, ValueError):
    sys.stderr.write("Runtime tree attestation failed\n")
    raise SystemExit(1)
`;

/**
 * Build the metadata-read-only Bash/Python3 probe sent to an arbitrary absolute
 * package root. Python uses only its standard library and opens every traversed
 * entry relative to no-follow directory descriptors.
 */
export function buildRuntimeTreeProbeScript(): string {
  return [
    "set -eu",
    "set -f",
    "LC_ALL=C",
    "PYTHONUTF8=1",
    "export LC_ALL PYTHONUTF8",
    'root="${1:?absolute runtime tree root is required}"',
    '[ "$#" -eq 1 ] || { printf "%s\\n" "Runtime tree probe accepts one root" >&2; exit 64; }',
    'exec python3 - "$root" <<\'COMIS_RUNTIME_TREE_PYTHON\'',
    RUNTIME_TREE_PYTHON_PROBE.trimStart(),
    "COMIS_RUNTIME_TREE_PYTHON",
    "",
  ].join("\n");
}
