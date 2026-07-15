// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from "node:child_process";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  constants,
  chmodSync,
  closeSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeSync,
  type BigIntStats,
} from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { err, ok, tryCatch, type Result } from "@comis/shared";

import {
  createProductionRuntimeVaultRecoveryReceipt,
  parseAndVerifyProductionRuntimeVaultRecoveryReceipt,
  serializeProductionRuntimeVaultRecoveryReceipt,
  type ProductionRuntimeVaultRecoveryReceipt,
  type ProductionRuntimeVaultRecoveryReceiptInput,
} from "./production-runtime-vault-authority.js";

const STORE_DIRECTORY = "runtime-vault-receipts";
const RECEIPT_FILE = "recovery-receipt.json";
const RECEIPT_INCOMING_FILE = ".recovery-receipt.json.incoming";
const TERMINAL_FILE = "terminal.json";
const TERMINAL_INCOMING_FILE = ".terminal.json.incoming";
const MAX_RECEIPT_BYTES = 64 * 1024;
const MAX_TERMINAL_BYTES = 4096;
const MIN_AUTHORITY_KEY_BYTES = 32;
const SAFE_RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const ATTEMPT_ID_RE = /^[a-f0-9]{32}$/u;
const SHA256_RE = /^[a-f0-9]{64}$/u;
const TERMINAL_SCHEMA = "comis-runtime-vault-terminal-record";
const TERMINAL_HMAC_DOMAIN = "comis-runtime-vault-terminal-record-hmac-v1\0";
const activeAttemptLocks = new Set<string>();
const PYTHON_INTERPRETER = "/usr/bin/python3";
const PINNED_INTERPRETER_PATH = "/proc/self/fd/4";
const MAX_INTERPRETER_BYTES = 64 * 1024 * 1024;
const HELPER_REQUEST_MAGIC = Buffer.from("CMRSQ001", "ascii");
const HELPER_RESPONSE_MAGIC = Buffer.from("CMRSR001", "ascii");
const HELPER_HEADER_BYTES = 17;
const HELPER_TIMEOUT_MS = 30_000;

const HELPER_OPERATION = {
  probe: 0,
  publishReceipt: 1,
  readReceipt: 2,
  publishTerminal: 3,
  readPair: 4,
} as const;

const HELPER_STATUS = {
  created: 1,
  alreadyPresent: 2,
  receipt: 3,
  pair: 4,
  probed: 5,
  badProtocol: 0x80,
  unsafeRoot: 0x81,
  unsafeDirectory: 0x82,
  unsafeReceipt: 0x83,
  unsafeTerminal: 0x84,
  receiptNotFound: 0x85,
  receiptConflict: 0x86,
  terminalConflict: 0x87,
  lockTimeout: 0x88,
  ioFailure: 0x89,
} as const;

type HelperOperation = (typeof HELPER_OPERATION)[keyof typeof HELPER_OPERATION];

interface HelperResponse {
  readonly status: number;
  readonly first: Buffer;
  readonly second: Buffer;
}

interface TrustedPythonInterpreterGuard {
  readonly path: string;
  readonly descriptor: number;
  readonly identity: BigIntStats;
  readonly digestSha256: string;
}

// Node does not expose the Linux *at syscall family. This fixed, isolated helper owns each
// complete transaction so no security decision is made from an absolute descendant path.
const LINUX_DIRFD_TRANSACTION_HELPER = String.raw`
import fcntl
import os
import re
import stat
import struct
import sys
import time

REQUEST_MAGIC = b"CMRSQ001"
RESPONSE_MAGIC = b"CMRSR001"
HEADER = struct.Struct(">8sBII")
MAX_RECEIPT = 64 * 1024
MAX_TERMINAL = 4096
MAX_FRAME = HEADER.size + MAX_RECEIPT + MAX_TERMINAL
STORE_DIRECTORY = "runtime-vault-receipts"
RECEIPT_FILE = "recovery-receipt.json"
RECEIPT_INCOMING_FILE = ".recovery-receipt.json.incoming"
TERMINAL_FILE = "terminal.json"
TERMINAL_INCOMING_FILE = ".terminal.json.incoming"
LOCK_FILE = ".receipt-store.lock"
PROBE_DIRECTORY = ".receipt-store-probe"
PROBE_FINAL_FILE = "probe-final"
PROBE_INCOMING_FILE = ".probe-incoming"
PROBE_PAYLOAD = b"comis-receipt-store-probe\n"
SAFE_RUN_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
SAFE_ATTEMPT_ID = re.compile(r"^[a-f0-9]{32}$")

OP_PROBE = 0
OP_PUBLISH_RECEIPT = 1
OP_READ_RECEIPT = 2
OP_PUBLISH_TERMINAL = 3
OP_READ_PAIR = 4

CREATED = 1
ALREADY_PRESENT = 2
RECEIPT = 3
PAIR = 4
PROBED = 5
BAD_PROTOCOL = 0x80
UNSAFE_ROOT = 0x81
UNSAFE_DIRECTORY = 0x82
UNSAFE_RECEIPT = 0x83
UNSAFE_TERMINAL = 0x84
RECEIPT_NOT_FOUND = 0x85
RECEIPT_CONFLICT = 0x86
TERMINAL_CONFLICT = 0x87
LOCK_TIMEOUT = 0x88
IO_FAILURE = 0x89

DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
READ_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC
WRITE_FLAGS = os.O_WRONLY | os.O_NOFOLLOW | os.O_CLOEXEC


class StoreFailure(Exception):
    def __init__(self, status):
        self.status = status


def fail(status):
    raise StoreFailure(status)


def respond(status, first=b"", second=b""):
    output = HEADER.pack(RESPONSE_MAGIC, status, len(first), len(second)) + first + second
    sys.stdout.buffer.write(output)
    sys.stdout.buffer.flush()


def stable_fields(value):
    return (
        value.st_dev,
        value.st_ino,
        value.st_mode,
        value.st_uid,
        value.st_nlink,
        value.st_size,
        value.st_mtime_ns,
        value.st_ctime_ns,
    )


def same_inode(left, right):
    return left.st_dev == right.st_dev and left.st_ino == right.st_ino


def validate_directory(value, status_code):
    if (
        not stat.S_ISDIR(value.st_mode)
        or value.st_uid != os.geteuid()
        or stat.S_IMODE(value.st_mode) != 0o700
    ):
        fail(status_code)


def validate_file(value, status_code, maximum, links, allow_empty=False):
    if (
        not stat.S_ISREG(value.st_mode)
        or value.st_uid != os.geteuid()
        or stat.S_IMODE(value.st_mode) != 0o600
        or value.st_nlink not in links
        or value.st_size > maximum
        or (not allow_empty and value.st_size == 0)
    ):
        fail(status_code)


def validate_xattrs(descriptor, status_code):
    try:
        names = os.listxattr(descriptor)
    except (AttributeError, OSError):
        fail(status_code)
    # Receipt authority metadata has no approved extended attributes. Mandatory
    # security labels require an explicit attested policy before they can be accepted.
    if names:
        fail(status_code)


def named_stat(parent_fd, name, missing_allowed, status_code):
    try:
        return os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except FileNotFoundError:
        if missing_allowed:
            return None
        fail(status_code)
    except OSError:
        fail(status_code)


def validate_named_directory(parent_fd, name, descriptor):
    named = named_stat(parent_fd, name, False, UNSAFE_DIRECTORY)
    opened = os.fstat(descriptor)
    validate_directory(named, UNSAFE_DIRECTORY)
    validate_directory(opened, UNSAFE_DIRECTORY)
    validate_xattrs(descriptor, UNSAFE_DIRECTORY)
    if not same_inode(named, opened):
        fail(UNSAFE_DIRECTORY)


def open_child_directory(parent_fd, name, create):
    created = False
    if create:
        try:
            os.mkdir(name, 0o700, dir_fd=parent_fd)
            created = True
        except FileExistsError:
            pass
        except OSError:
            fail(IO_FAILURE)
    try:
        descriptor = os.open(name, DIRECTORY_FLAGS, dir_fd=parent_fd)
    except FileNotFoundError:
        fail(RECEIPT_NOT_FOUND)
    except OSError:
        fail(UNSAFE_DIRECTORY)
    try:
        validate_named_directory(parent_fd, name, descriptor)
        if created:
            os.fsync(descriptor)
            os.fsync(parent_fd)
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


class Hierarchy:
    def __init__(self, root_fd, names, create):
        self.root_fd = root_fd
        self.entries = []
        parent = root_fd
        for name in names:
            descriptor = open_child_directory(parent, name, create)
            self.entries.append((parent, name, descriptor))
            parent = descriptor
        self.attempt_fd = parent

    def validate(self):
        validate_directory(os.fstat(self.root_fd), UNSAFE_ROOT)
        validate_xattrs(self.root_fd, UNSAFE_ROOT)
        for parent, name, descriptor in self.entries:
            validate_named_directory(parent, name, descriptor)

    def close(self):
        primary = None
        for _, _, descriptor in reversed(self.entries):
            try:
                os.close(descriptor)
            except OSError as value:
                if primary is None:
                    primary = value
        if primary is not None:
            raise primary


def validate_lock(attempt_fd, descriptor):
    named = named_stat(attempt_fd, LOCK_FILE, False, UNSAFE_DIRECTORY)
    opened = os.fstat(descriptor)
    for value in (named, opened):
        if (
            not stat.S_ISREG(value.st_mode)
            or value.st_uid != os.geteuid()
            or stat.S_IMODE(value.st_mode) != 0o600
            or value.st_nlink != 1
            or value.st_size != 0
        ):
            fail(UNSAFE_DIRECTORY)
    if not same_inode(named, opened):
        fail(UNSAFE_DIRECTORY)
    validate_xattrs(descriptor, UNSAFE_DIRECTORY)


def acquire_lock(hierarchy):
    created = False
    try:
        descriptor = os.open(
            LOCK_FILE,
            os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
            0o600,
            dir_fd=hierarchy.attempt_fd,
        )
        created = True
    except FileExistsError:
        try:
            descriptor = os.open(
                LOCK_FILE,
                os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC,
                dir_fd=hierarchy.attempt_fd,
            )
        except OSError:
            fail(UNSAFE_DIRECTORY)
    except OSError:
        fail(IO_FAILURE)
    try:
        if created:
            os.fchmod(descriptor, 0o600)
            os.fsync(descriptor)
            os.fsync(hierarchy.attempt_fd)
        validate_lock(hierarchy.attempt_fd, descriptor)
        deadline = time.monotonic() + 2.0
        while True:
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    fail(LOCK_TIMEOUT)
                time.sleep(0.02)
        validate_lock(hierarchy.attempt_fd, descriptor)
        hierarchy.validate()
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def release_lock(hierarchy, descriptor):
    primary = None
    try:
        validate_lock(hierarchy.attempt_fd, descriptor)
        hierarchy.validate()
    except BaseException as value:
        primary = value
    try:
        fcntl.flock(descriptor, fcntl.LOCK_UN)
    except BaseException as value:
        if primary is None:
            primary = value
    try:
        os.close(descriptor)
    except BaseException as value:
        if primary is None:
            primary = value
    if primary is not None:
        raise primary


def read_file(parent_fd, name, status_code, maximum, links, missing_allowed, allow_empty=False):
    named_before = named_stat(parent_fd, name, missing_allowed, status_code)
    if named_before is None:
        return None
    validate_file(named_before, status_code, maximum, links, allow_empty)
    try:
        descriptor = os.open(name, READ_FLAGS, dir_fd=parent_fd)
    except OSError:
        fail(status_code)
    try:
        opened_before = os.fstat(descriptor)
        validate_file(opened_before, status_code, maximum, links, allow_empty)
        validate_xattrs(descriptor, status_code)
        if stable_fields(named_before) != stable_fields(opened_before):
            fail(status_code)
        remaining = opened_before.st_size
        chunks = []
        while remaining:
            chunk = os.read(descriptor, min(remaining, 65536))
            if not chunk:
                fail(status_code)
            chunks.append(chunk)
            remaining -= len(chunk)
        if os.read(descriptor, 1):
            fail(status_code)
        opened_after = os.fstat(descriptor)
        named_after = named_stat(parent_fd, name, False, status_code)
        validate_file(opened_after, status_code, maximum, links, allow_empty)
        validate_file(named_after, status_code, maximum, links, allow_empty)
        validate_xattrs(descriptor, status_code)
        if (
            stable_fields(opened_before) != stable_fields(opened_after)
            or stable_fields(opened_after) != stable_fields(named_after)
        ):
            fail(status_code)
        return b"".join(chunks), opened_after
    finally:
        os.close(descriptor)


def synchronize_named(parent_fd, name, expected, status_code, maximum, links, allow_empty=False):
    try:
        descriptor = os.open(name, READ_FLAGS, dir_fd=parent_fd)
    except OSError:
        fail(status_code)
    try:
        before = os.fstat(descriptor)
        validate_file(before, status_code, maximum, links, allow_empty)
        validate_xattrs(descriptor, status_code)
        if stable_fields(before) != stable_fields(expected):
            fail(status_code)
        os.fsync(descriptor)
        after = os.fstat(descriptor)
        named = named_stat(parent_fd, name, False, status_code)
        validate_file(after, status_code, maximum, links, allow_empty)
        validate_file(named, status_code, maximum, links, allow_empty)
        validate_xattrs(descriptor, status_code)
        if stable_fields(before) != stable_fields(after) or stable_fields(after) != stable_fields(named):
            fail(status_code)
    finally:
        os.close(descriptor)


def unlink_paired(parent_fd, final_name, incoming_name, expected, status_code, maximum):
    final_value = named_stat(parent_fd, final_name, False, status_code)
    incoming_value = named_stat(parent_fd, incoming_name, False, status_code)
    validate_file(final_value, status_code, maximum, (2,))
    validate_file(incoming_value, status_code, maximum, (2,))
    if (
        not same_inode(expected, final_value)
        or not same_inode(final_value, incoming_value)
    ):
        fail(status_code)
    os.fsync(parent_fd)
    try:
        os.unlink(incoming_name, dir_fd=parent_fd)
    except OSError:
        fail(IO_FAILURE)
    os.fsync(parent_fd)
    final_after = named_stat(parent_fd, final_name, False, status_code)
    validate_file(final_after, status_code, maximum, (1,))
    if not same_inode(expected, final_after):
        fail(status_code)


def reconcile(parent_fd, final_name, incoming_name, expected_raw, status_code, maximum):
    final_file = read_file(
        parent_fd,
        final_name,
        status_code,
        maximum,
        (1, 2),
        True,
    )
    if final_file is None:
        return "absent"
    final_raw, final_value = final_file
    incoming_file = read_file(
        parent_fd,
        incoming_name,
        status_code,
        maximum,
        (1, 2),
        True,
        True,
    )
    if final_raw != expected_raw:
        if final_value.st_nlink != 1 or incoming_file is not None:
            fail(status_code)
        return "other"
    if final_value.st_nlink == 1:
        if incoming_file is not None:
            fail(status_code)
        synchronize_named(parent_fd, final_name, final_value, status_code, maximum, (1,))
        os.fsync(parent_fd)
        return "exact"
    if incoming_file is None:
        fail(status_code)
    incoming_raw, incoming_value = incoming_file
    if (
        final_value.st_nlink != 2
        or incoming_value.st_nlink != 2
        or not same_inode(final_value, incoming_value)
        or incoming_raw != expected_raw
    ):
        fail(status_code)
    synchronize_named(parent_fd, final_name, final_value, status_code, maximum, (2,))
    unlink_paired(parent_fd, final_name, incoming_name, final_value, status_code, maximum)
    normalized = read_file(parent_fd, final_name, status_code, maximum, (1,), False)
    if normalized is None or normalized[0] != expected_raw:
        fail(status_code)
    return "exact"


def create_empty_incoming(parent_fd, name, status_code, maximum):
    try:
        descriptor = os.open(
            name,
            WRITE_FLAGS | os.O_CREAT | os.O_EXCL,
            0o600,
            dir_fd=parent_fd,
        )
    except FileExistsError:
        return False
    except OSError:
        fail(IO_FAILURE)
    try:
        os.fchmod(descriptor, 0o600)
        value = os.fstat(descriptor)
        validate_file(value, status_code, maximum, (1,), True)
        validate_xattrs(descriptor, status_code)
        if value.st_size != 0:
            fail(status_code)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    named = named_stat(parent_fd, name, False, status_code)
    validate_file(named, status_code, maximum, (1,), True)
    if named.st_size != 0:
        fail(status_code)
    os.fsync(parent_fd)
    return True


def ensure_complete_incoming(parent_fd, name, expected_raw, status_code, conflict_code, maximum):
    incoming = read_file(parent_fd, name, status_code, maximum, (1, 2), True, True)
    if incoming is None:
        create_empty_incoming(parent_fd, name, status_code, maximum)
        incoming = read_file(parent_fd, name, status_code, maximum, (1, 2), False, True)
    raw, value = incoming
    if value.st_nlink != 1:
        fail(status_code)
    if len(raw) > len(expected_raw) or expected_raw[:len(raw)] != raw:
        fail(conflict_code)
    if len(raw) < len(expected_raw):
        try:
            descriptor = os.open(name, WRITE_FLAGS | os.O_APPEND, dir_fd=parent_fd)
        except OSError:
            fail(status_code)
        failed = False
        try:
            before = os.fstat(descriptor)
            validate_file(before, status_code, maximum, (1,), True)
            validate_xattrs(descriptor, status_code)
            if stable_fields(before) != stable_fields(value):
                fail(status_code)
            offset = len(raw)
            while offset < len(expected_raw):
                written = os.write(descriptor, expected_raw[offset:])
                if written <= 0:
                    fail(IO_FAILURE)
                offset += written
            os.fsync(descriptor)
            after = os.fstat(descriptor)
            validate_file(after, status_code, maximum, (1,))
            validate_xattrs(descriptor, status_code)
            if not same_inode(before, after) or after.st_size != len(expected_raw):
                fail(status_code)
        except BaseException:
            failed = True
            try:
                os.fsync(descriptor)
            except OSError:
                pass
            raise
        finally:
            os.close(descriptor)
            if failed:
                try:
                    os.fsync(parent_fd)
                except OSError:
                    pass
    completed = read_file(parent_fd, name, status_code, maximum, (1,), False)
    if completed is None or completed[0] != expected_raw:
        fail(conflict_code)
    synchronize_named(parent_fd, name, completed[1], status_code, maximum, (1,))
    os.fsync(parent_fd)
    return completed[1]


def publish(parent_fd, final_name, incoming_name, raw, status_code, conflict_code, maximum):
    if not raw or len(raw) > maximum:
        fail(BAD_PROTOCOL)
    state = reconcile(
        parent_fd,
        final_name,
        incoming_name,
        raw,
        status_code,
        maximum,
    )
    if state == "exact":
        return ALREADY_PRESENT
    if state == "other":
        fail(conflict_code)
    ensure_complete_incoming(parent_fd, incoming_name, raw, status_code, conflict_code, maximum)
    linked = False
    try:
        os.link(
            incoming_name,
            final_name,
            src_dir_fd=parent_fd,
            dst_dir_fd=parent_fd,
            follow_symlinks=False,
        )
        linked = True
        os.fsync(parent_fd)
    except FileExistsError:
        pass
    except OSError:
        fail(IO_FAILURE)
    state = reconcile(
        parent_fd,
        final_name,
        incoming_name,
        raw,
        status_code,
        maximum,
    )
    if state != "exact":
        fail(status_code)
    return CREATED if linked else ALREADY_PRESENT


def read_published(parent_fd, final_name, incoming_name, status_code, maximum, missing_status):
    final_file = read_file(parent_fd, final_name, status_code, maximum, (1, 2), True)
    if final_file is None:
        incoming = read_file(parent_fd, incoming_name, status_code, maximum, (1,), True, True)
        if incoming is not None and incoming[1].st_nlink != 1:
            fail(status_code)
        if missing_status is None:
            return None
        fail(missing_status)
    raw, _ = final_file
    state = reconcile(parent_fd, final_name, incoming_name, raw, status_code, maximum)
    if state != "exact":
        fail(status_code)
    normalized = read_file(parent_fd, final_name, status_code, maximum, (1,), False)
    if normalized is None:
        fail(status_code)
    return normalized[0]


def run_probe(root_fd):
    hierarchy = None
    lock_fd = None
    primary = None
    try:
        hierarchy = Hierarchy(root_fd, (PROBE_DIRECTORY,), True)
        hierarchy.validate()
        lock_fd = acquire_lock(hierarchy)
        publish(
            hierarchy.attempt_fd,
            PROBE_FINAL_FILE,
            PROBE_INCOMING_FILE,
            PROBE_PAYLOAD,
            UNSAFE_DIRECTORY,
            UNSAFE_DIRECTORY,
            len(PROBE_PAYLOAD),
        )
        observed = read_file(
            hierarchy.attempt_fd,
            PROBE_FINAL_FILE,
            UNSAFE_DIRECTORY,
            len(PROBE_PAYLOAD),
            (1,),
            False,
        )
        if observed is None or observed[0] != PROBE_PAYLOAD:
            fail(UNSAFE_DIRECTORY)
        try:
            os.unlink(PROBE_FINAL_FILE, dir_fd=hierarchy.attempt_fd)
        except OSError:
            fail(IO_FAILURE)
        os.fsync(hierarchy.attempt_fd)
        if (
            named_stat(hierarchy.attempt_fd, PROBE_FINAL_FILE, True, UNSAFE_DIRECTORY) is not None
            or named_stat(hierarchy.attempt_fd, PROBE_INCOMING_FILE, True, UNSAFE_DIRECTORY) is not None
        ):
            fail(UNSAFE_DIRECTORY)
    except BaseException as value:
        primary = value
    cleanup = None
    if lock_fd is not None and hierarchy is not None:
        try:
            release_lock(hierarchy, lock_fd)
        except BaseException as value:
            cleanup = value
    if hierarchy is not None:
        try:
            hierarchy.close()
        except BaseException as value:
            if cleanup is None:
                cleanup = value
    if primary is not None:
        raise primary
    if cleanup is not None:
        raise cleanup


def validate_capabilities():
    if sys.platform != "linux" or sys.version_info < (3, 12):
        fail(BAD_PROTOCOL)
    required_dir_fd = (os.open, os.mkdir, os.stat, os.unlink, os.link)
    if any(function not in os.supports_dir_fd for function in required_dir_fd):
        fail(BAD_PROTOCOL)
    if os.stat not in os.supports_follow_symlinks or os.link not in os.supports_follow_symlinks:
        fail(BAD_PROTOCOL)
    for name in ("O_DIRECTORY", "O_NOFOLLOW", "O_CLOEXEC"):
        if not hasattr(os, name):
            fail(BAD_PROTOCOL)
    if not hasattr(os, "listxattr"):
        fail(BAD_PROTOCOL)


def parse_request():
    raw = sys.stdin.buffer.read(MAX_FRAME + 1)
    if len(raw) < HEADER.size or len(raw) > MAX_FRAME:
        fail(BAD_PROTOCOL)
    magic, operation, first_length, second_length = HEADER.unpack(raw[:HEADER.size])
    if magic != REQUEST_MAGIC or HEADER.size + first_length + second_length != len(raw):
        fail(BAD_PROTOCOL)
    first_end = HEADER.size + first_length
    first = raw[HEADER.size:first_end]
    second = raw[first_end:]
    valid_shape = (
        (operation == OP_PROBE and not first and not second)
        or (operation == OP_PUBLISH_RECEIPT and 0 < len(first) <= MAX_RECEIPT and not second)
        or (operation == OP_READ_RECEIPT and not first and not second)
        or (
            operation == OP_PUBLISH_TERMINAL
            and 0 < len(first) <= MAX_RECEIPT
            and 0 < len(second) <= MAX_TERMINAL
        )
        or (operation == OP_READ_PAIR and not first and not second)
    )
    if not valid_shape:
        fail(BAD_PROTOCOL)
    return operation, first, second


def execute():
    os.umask(0o077)
    validate_capabilities()
    operation, first, second = parse_request()
    if len(sys.argv) != 3 or not SAFE_RUN_ID.fullmatch(sys.argv[1]) or not SAFE_ATTEMPT_ID.fullmatch(sys.argv[2]):
        fail(BAD_PROTOCOL)
    try:
        root_fd = os.dup(3)
    except OSError:
        fail(UNSAFE_ROOT)
    hierarchy = None
    lock_fd = None
    result = None
    primary = None
    try:
        validate_directory(os.fstat(root_fd), UNSAFE_ROOT)
        validate_xattrs(root_fd, UNSAFE_ROOT)
        if operation == OP_PROBE:
            run_probe(root_fd)
            result = PROBED, b"", b""
        else:
            hierarchy = Hierarchy(
                root_fd,
                (STORE_DIRECTORY, sys.argv[1], sys.argv[2]),
                operation == OP_PUBLISH_RECEIPT,
            )
            hierarchy.validate()
            lock_fd = acquire_lock(hierarchy)
            if operation == OP_PUBLISH_RECEIPT:
                status_code = publish(
                    hierarchy.attempt_fd,
                    RECEIPT_FILE,
                    RECEIPT_INCOMING_FILE,
                    first,
                    UNSAFE_RECEIPT,
                    RECEIPT_CONFLICT,
                    MAX_RECEIPT,
                )
                result = status_code, b"", b""
            elif operation == OP_READ_RECEIPT:
                receipt = read_published(
                    hierarchy.attempt_fd,
                    RECEIPT_FILE,
                    RECEIPT_INCOMING_FILE,
                    UNSAFE_RECEIPT,
                    MAX_RECEIPT,
                    RECEIPT_NOT_FOUND,
                )
                result = RECEIPT, receipt, b""
            elif operation == OP_PUBLISH_TERMINAL:
                receipt = read_published(
                    hierarchy.attempt_fd,
                    RECEIPT_FILE,
                    RECEIPT_INCOMING_FILE,
                    UNSAFE_RECEIPT,
                    MAX_RECEIPT,
                    RECEIPT_NOT_FOUND,
                )
                if receipt != first:
                    fail(RECEIPT_CONFLICT)
                status_code = publish(
                    hierarchy.attempt_fd,
                    TERMINAL_FILE,
                    TERMINAL_INCOMING_FILE,
                    second,
                    UNSAFE_TERMINAL,
                    TERMINAL_CONFLICT,
                    MAX_TERMINAL,
                )
                result = status_code, b"", b""
            elif operation == OP_READ_PAIR:
                receipt = read_published(
                    hierarchy.attempt_fd,
                    RECEIPT_FILE,
                    RECEIPT_INCOMING_FILE,
                    UNSAFE_RECEIPT,
                    MAX_RECEIPT,
                    RECEIPT_NOT_FOUND,
                )
                terminal = read_published(
                    hierarchy.attempt_fd,
                    TERMINAL_FILE,
                    TERMINAL_INCOMING_FILE,
                    UNSAFE_TERMINAL,
                    MAX_TERMINAL,
                    None,
                )
                result = PAIR, receipt, terminal or b""
            else:
                fail(BAD_PROTOCOL)
            hierarchy.validate()
    except BaseException as value:
        primary = value
    cleanup = None
    if lock_fd is not None and hierarchy is not None:
        try:
            release_lock(hierarchy, lock_fd)
        except BaseException as value:
            cleanup = value
    if hierarchy is not None:
        try:
            hierarchy.close()
        except BaseException as value:
            if cleanup is None:
                cleanup = value
    try:
        os.close(root_fd)
    except BaseException as value:
        if cleanup is None:
            cleanup = value
    if primary is not None:
        raise primary
    if cleanup is not None:
        raise cleanup
    if result is None:
        fail(IO_FAILURE)
    return result


def main():
    try:
        status_code, first, second = execute()
        respond(status_code, first, second)
        return 0
    except StoreFailure as value:
        respond(value.status)
        return 70
    except BaseException:
        respond(IO_FAILURE)
        return 70


sys.exit(main())
`;

const TERMINAL_DISPOSITIONS = [
  "not_started",
  "published",
  "reused_existing",
  "rolled_back",
  "blocked_corrupt",
] as const;

const TERMINAL_UNSIGNED_KEYS = [
  "schema",
  "schemaVersion",
  "runId",
  "attemptId",
  "disposition",
  "authorityKeyIdSha256",
  "receiptAuthorityDigestSha256",
  "receiptDigestSha256",
] as const;
const TERMINAL_KEYS = [...TERMINAL_UNSIGNED_KEYS, "authenticationTagSha256"] as const;

export type ProductionRuntimeVaultTerminalDisposition =
  (typeof TERMINAL_DISPOSITIONS)[number];

export interface ProductionRuntimeVaultTerminalRecord {
  readonly schema: "comis-runtime-vault-terminal-record";
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly attemptId: string;
  readonly disposition: ProductionRuntimeVaultTerminalDisposition;
  readonly authorityKeyIdSha256: string;
  readonly receiptAuthorityDigestSha256: string;
  readonly receiptDigestSha256: string;
  readonly authenticationTagSha256: string;
}

export interface ProductionRuntimeVaultReceiptPaths {
  readonly receiptDirectory: string;
  readonly receiptPath: string;
  readonly receiptIncomingPath: string;
  readonly terminalPath: string;
  readonly terminalIncomingPath: string;
}

export interface ProductionRuntimeVaultReceiptStoreIo {
  readonly write: (
    descriptor: number,
    data: Uint8Array,
    offset: number,
    length: number,
  ) => number;
}

export interface CreateProductionRuntimeVaultReceiptStoreOptions {
  readonly stateRoot: string;
  readonly authorityKey: Uint8Array;
}

export interface CreateProductionRuntimeVaultReceiptStoreTestOptions
  extends CreateProductionRuntimeVaultReceiptStoreOptions {
  readonly io?: ProductionRuntimeVaultReceiptStoreIo;
}

export interface ProductionRuntimeVaultReceiptPersistence {
  readonly status: "created" | "already_present";
  readonly path: string;
}

export interface ProductionRuntimeVaultCreatedReceipt
  extends ProductionRuntimeVaultReceiptPersistence {
  readonly receipt: ProductionRuntimeVaultRecoveryReceipt;
}

export interface ProductionRuntimeVaultReceiptStore {
  readonly dispose: () => Result<void, ProductionRuntimeVaultReceiptStoreError>;
  readonly createAndPersistReceipt: (
    input: ProductionRuntimeVaultRecoveryReceiptInput,
  ) => Result<ProductionRuntimeVaultCreatedReceipt, ProductionRuntimeVaultReceiptStoreError>;
  readonly paths: (
    runId: string,
    attemptId: string,
  ) => Result<ProductionRuntimeVaultReceiptPaths, ProductionRuntimeVaultReceiptStoreError>;
  readonly readReceipt: (
    runId: string,
    attemptId: string,
  ) => Result<ProductionRuntimeVaultRecoveryReceipt, ProductionRuntimeVaultReceiptStoreError>;
  readonly recordTerminal: (
    receipt: ProductionRuntimeVaultRecoveryReceipt,
    disposition: ProductionRuntimeVaultTerminalDisposition,
  ) => Result<ProductionRuntimeVaultReceiptPersistence, ProductionRuntimeVaultReceiptStoreError>;
  readonly readTerminal: (
    runId: string,
    attemptId: string,
  ) => Result<
    ProductionRuntimeVaultTerminalRecord | undefined,
    ProductionRuntimeVaultReceiptStoreError
  >;
}

export interface ProductionRuntimeVaultReceiptStoreTestHarness
  extends ProductionRuntimeVaultReceiptStore {
  readonly persistReceipt: (
    receipt: ProductionRuntimeVaultRecoveryReceipt,
  ) => Result<ProductionRuntimeVaultReceiptPersistence, ProductionRuntimeVaultReceiptStoreError>;
}

export type ProductionRuntimeVaultReceiptStoreError =
  | {
      readonly kind: "invalid_request";
      readonly field: string;
      readonly message: string;
    }
  | {
      readonly kind: "unsafe_state_root";
      readonly field: "stateRoot";
      readonly message: string;
    }
  | {
      readonly kind: "unsafe_directory";
      readonly field: "receiptDirectory";
      readonly message: string;
    }
  | {
      readonly kind: "unsafe_file";
      readonly field: "receiptFile" | "terminalFile";
      readonly message: string;
    }
  | {
      readonly kind: "invalid_receipt";
      readonly field: "receipt";
      readonly message: string;
    }
  | {
      readonly kind: "invalid_terminal_record";
      readonly field: "terminalRecord";
      readonly message: string;
    }
  | {
      readonly kind: "not_found";
      readonly field: "receipt";
      readonly message: string;
    }
  | {
      readonly kind: "conflict";
      readonly field: "receipt" | "terminalRecord";
      readonly message: string;
    }
  | {
      readonly kind: "unsupported_platform";
      readonly field: "platform" | "toolchain";
      readonly message: string;
    }
  | {
      readonly kind: "operation_locked";
      readonly field: "attempt";
      readonly message: string;
    }
  | {
      readonly kind: "io_failure";
      readonly operation: string;
      readonly message: string;
    };

interface DirectoryGuard {
  readonly path: string;
  readonly descriptor: number;
  readonly identity: BigIntStats;
}

interface OpenHierarchy {
  readonly paths: ProductionRuntimeVaultReceiptPaths;
  readonly runId: string;
  readonly attemptId: string;
  readonly guards: readonly DirectoryGuard[];
}

interface RawFile {
  readonly raw: Buffer;
}

interface StrictFile extends RawFile {
  readonly identity: BigIntStats;
}

interface StrictReceipt extends RawFile {
  readonly receipt: ProductionRuntimeVaultRecoveryReceipt;
}

interface UnsignedTerminalRecord {
  readonly schema: "comis-runtime-vault-terminal-record";
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly attemptId: string;
  readonly disposition: ProductionRuntimeVaultTerminalDisposition;
  readonly authorityKeyIdSha256: string;
  readonly receiptAuthorityDigestSha256: string;
  readonly receiptDigestSha256: string;
}

function failure(
  error: ProductionRuntimeVaultReceiptStoreError,
): Result<never, ProductionRuntimeVaultReceiptStoreError> {
  return err(error);
}

function invalidRequest(
  field: string,
  message: string,
): Result<never, ProductionRuntimeVaultReceiptStoreError> {
  return failure({ kind: "invalid_request", field, message });
}

function unsafeRoot(): Result<never, ProductionRuntimeVaultReceiptStoreError> {
  return failure({
    kind: "unsafe_state_root",
    field: "stateRoot",
    message: "Controller state root must be an existing canonical private directory owned by the effective user",
  });
}

function unsafeDirectory(): Result<never, ProductionRuntimeVaultReceiptStoreError> {
  return failure({
    kind: "unsafe_directory",
    field: "receiptDirectory",
    message: "Receipt directory hierarchy failed its private directory invariant",
  });
}

function unsafeFile(
  field: "receiptFile" | "terminalFile",
): Result<never, ProductionRuntimeVaultReceiptStoreError> {
  return failure({
    kind: "unsafe_file",
    field,
    message: "Stored file failed its regular private single-link invariant",
  });
}

function ioFailure(operation: string): Result<never, ProductionRuntimeVaultReceiptStoreError> {
  return failure({
    kind: "io_failure",
    operation,
    message: "Controller receipt store filesystem operation failed",
  });
}

function operationLocked(): Result<never, ProductionRuntimeVaultReceiptStoreError> {
  return failure({
    kind: "operation_locked",
    field: "attempt",
    message: "Another controller operation holds the runtime-vault attempt lock",
  });
}

function disposedStore(): Result<never, ProductionRuntimeVaultReceiptStoreError> {
  return invalidRequest("store", "Controller receipt store has been disposed");
}

function withAttemptLock<T>(
  stateRoot: string,
  runId: string,
  attemptId: string,
  operation: () => Result<T, ProductionRuntimeVaultReceiptStoreError>,
): Result<T, ProductionRuntimeVaultReceiptStoreError> {
  const key = `${stateRoot}\0${runId}\0${attemptId}`;
  if (activeAttemptLocks.has(key)) return operationLocked();
  activeAttemptLocks.add(key);
  const outcome = tryCatch(operation);
  activeAttemptLocks.delete(key);
  return outcome.ok ? outcome.value : ioFailure("attempt_lock_operation");
}

function errorCode(value: Error): string | undefined {
  const code = (value as NodeJS.ErrnoException).code;
  return typeof code === "string" ? code : undefined;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return "null";
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function terminalAuthenticationTag(unsigned: UnsignedTerminalRecord, key: Uint8Array): string {
  return createHmac("sha256", key)
    .update(TERMINAL_HMAC_DOMAIN)
    .update(canonicalJson(unsigned))
    .digest("hex");
}

function equalDigest(left: string, right: string): boolean {
  if (!SHA256_RE.test(left) || !SHA256_RE.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function currentEffectiveUid(): Result<number, ProductionRuntimeVaultReceiptStoreError> {
  if (typeof process.geteuid !== "function") {
    return invalidRequest("platform", "Controller receipt store requires effective-user ownership checks");
  }
  return ok(process.geteuid());
}

function sameInode(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameStableFile(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameInode(left, right) &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.nlink === right.nlink &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function isPrivateDirectory(value: BigIntStats, effectiveUid: number): boolean {
  return (
    value.isDirectory() &&
    value.uid === BigInt(effectiveUid) &&
    (value.mode & 0o7777n) === 0o700n
  );
}

function isPrivateFile(
  value: BigIntStats,
  effectiveUid: number,
  maximumBytes: number,
  allowedLinks: readonly bigint[] = [1n],
  allowEmpty = false,
): boolean {
  return (
    value.isFile() &&
    value.uid === BigInt(effectiveUid) &&
    (value.mode & 0o7777n) === 0o600n &&
    allowedLinks.includes(value.nlink) &&
    (allowEmpty || value.size > 0n) &&
    value.size <= BigInt(maximumBytes)
  );
}

function closeDescriptor(descriptor: number): Result<void, ProductionRuntimeVaultReceiptStoreError> {
  const closed = tryCatch(() => closeSync(descriptor));
  if (!closed.ok) return ioFailure("close_descriptor");
  return ok(undefined);
}

function closeGuards(
  guards: readonly DirectoryGuard[],
): Result<void, ProductionRuntimeVaultReceiptStoreError> {
  let failed = false;
  for (const guard of [...guards].reverse()) {
    if (!tryCatch(() => closeSync(guard.descriptor)).ok) failed = true;
  }
  return failed ? ioFailure("close_directory_guards") : ok(undefined);
}

function openDirectoryGuard(
  path: string,
  effectiveUid: number,
  root: boolean,
): Result<DirectoryGuard, ProductionRuntimeVaultReceiptStoreError> {
  const before = tryCatch(() => lstatSync(path, { bigint: true }));
  if (!before.ok || !isPrivateDirectory(before.value, effectiveUid)) {
    return root ? unsafeRoot() : unsafeDirectory();
  }
  const canonical = tryCatch(() => realpathSync(path));
  if (!canonical.ok || canonical.value !== path) return root ? unsafeRoot() : unsafeDirectory();

  const opened = tryCatch(() =>
    openSync(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    ),
  );
  if (!opened.ok) return root ? unsafeRoot() : unsafeDirectory();
  const after = tryCatch(() => fstatSync(opened.value, { bigint: true }));
  if (
    !after.ok ||
    !sameInode(before.value, after.value) ||
    !isPrivateDirectory(after.value, effectiveUid)
  ) {
    const closed = closeDescriptor(opened.value);
    if (!closed.ok) return closed;
    return root ? unsafeRoot() : unsafeDirectory();
  }
  return ok({ path, descriptor: opened.value, identity: after.value });
}

function validateGuard(
  guard: DirectoryGuard,
  effectiveUid: number,
  root: boolean,
): Result<void, ProductionRuntimeVaultReceiptStoreError> {
  const pathValue = tryCatch(() => lstatSync(guard.path, { bigint: true }));
  const descriptorValue = tryCatch(() => fstatSync(guard.descriptor, { bigint: true }));
  const canonical = tryCatch(() => realpathSync(guard.path));
  if (
    !pathValue.ok ||
    !descriptorValue.ok ||
    !canonical.ok ||
    canonical.value !== guard.path ||
    !sameInode(guard.identity, pathValue.value) ||
    !sameInode(guard.identity, descriptorValue.value) ||
    !isPrivateDirectory(pathValue.value, effectiveUid) ||
    !isPrivateDirectory(descriptorValue.value, effectiveUid)
  ) {
    return root ? unsafeRoot() : unsafeDirectory();
  }
  return ok(undefined);
}

function validateGuards(
  guards: readonly DirectoryGuard[],
  effectiveUid: number,
): Result<void, ProductionRuntimeVaultReceiptStoreError> {
  for (const [index, guard] of guards.entries()) {
    const valid = validateGuard(guard, effectiveUid, index === 0);
    if (!valid.ok) return valid;
  }
  return ok(undefined);
}

function synchronizeGuards(
  guards: readonly DirectoryGuard[],
): Result<void, ProductionRuntimeVaultReceiptStoreError> {
  for (const guard of [...guards].reverse()) {
    const synchronized = tryCatch(() => fsyncSync(guard.descriptor));
    if (!synchronized.ok) return ioFailure("synchronize_directory");
  }
  return ok(undefined);
}

function ensureChildDirectory(
  parentGuards: readonly DirectoryGuard[],
  path: string,
  effectiveUid: number,
  create: boolean,
): Result<DirectoryGuard, ProductionRuntimeVaultReceiptStoreError> {
  const stable = validateGuards(parentGuards, effectiveUid);
  if (!stable.ok) return stable;

  const existing = tryCatch(() => lstatSync(path, { bigint: true }));
  let created = false;
  if (!existing.ok) {
    if (errorCode(existing.error) !== "ENOENT") return unsafeDirectory();
    if (!create) {
      return failure({
        kind: "not_found",
        field: "receipt",
        message: "Stored recovery receipt does not exist",
      });
    }
    const made = tryCatch(() => mkdirSync(path, { mode: 0o700 }));
    if (!made.ok && errorCode(made.error) !== "EEXIST") return ioFailure("create_directory");
    created = made.ok;
  }

  if (created) {
    const parentStable = validateGuards(parentGuards, effectiveUid);
    if (!parentStable.ok) return parentStable;
    const createdValue = tryCatch(() => lstatSync(path, { bigint: true }));
    const createdCanonical = tryCatch(() => realpathSync(path));
    if (
      !createdValue.ok ||
      !createdCanonical.ok ||
      createdCanonical.value !== path ||
      !createdValue.value.isDirectory() ||
      createdValue.value.uid !== BigInt(effectiveUid) ||
      (createdValue.value.mode & 0o7077n) !== 0n
    ) {
      return unsafeDirectory();
    }
    const restricted = tryCatch(() => chmodSync(path, 0o700));
    const restrictedValue = tryCatch(() => lstatSync(path, { bigint: true }));
    if (
      !restricted.ok ||
      !restrictedValue.ok ||
      !sameInode(createdValue.value, restrictedValue.value) ||
      !isPrivateDirectory(restrictedValue.value, effectiveUid)
    ) {
      return unsafeDirectory();
    }
  }

  const guard = openDirectoryGuard(path, effectiveUid, false);
  if (!guard.ok) return guard;
  if (created) {
    const restricted = tryCatch(() => fchmodSync(guard.value.descriptor, 0o700));
    if (!restricted.ok) {
      const closed = closeDescriptor(guard.value.descriptor);
      if (!closed.ok) return closed;
      return ioFailure("restrict_directory");
    }
    const parentSynchronized = tryCatch(() =>
      fsyncSync(parentGuards[parentGuards.length - 1]!.descriptor),
    );
    const childSynchronized = tryCatch(() => fsyncSync(guard.value.descriptor));
    if (!parentSynchronized.ok || !childSynchronized.ok) {
      const closed = closeDescriptor(guard.value.descriptor);
      if (!closed.ok) return closed;
      return ioFailure("synchronize_directory_creation");
    }
  }
  return ok(guard.value);
}

function resolvePaths(
  stateRoot: string,
  runId: string,
  attemptId: string,
): Result<ProductionRuntimeVaultReceiptPaths, ProductionRuntimeVaultReceiptStoreError> {
  if (typeof runId !== "string" || !SAFE_RUN_ID_RE.test(runId)) {
    return invalidRequest("runId", "Recovery receipt run identifier is invalid");
  }
  if (typeof attemptId !== "string" || !ATTEMPT_ID_RE.test(attemptId)) {
    return invalidRequest("attemptId", "Recovery receipt attempt identifier is invalid");
  }
  const receiptDirectory = resolve(stateRoot, STORE_DIRECTORY, runId, attemptId);
  return ok({
    receiptDirectory,
    receiptPath: resolve(receiptDirectory, RECEIPT_FILE),
    receiptIncomingPath: resolve(receiptDirectory, RECEIPT_INCOMING_FILE),
    terminalPath: resolve(receiptDirectory, TERMINAL_FILE),
    terminalIncomingPath: resolve(receiptDirectory, TERMINAL_INCOMING_FILE),
  });
}

function openHierarchy(
  stateRoot: string,
  runId: string,
  attemptId: string,
  effectiveUid: number,
  create: boolean,
): Result<OpenHierarchy, ProductionRuntimeVaultReceiptStoreError> {
  const paths = resolvePaths(stateRoot, runId, attemptId);
  if (!paths.ok) return paths;
  const root = openDirectoryGuard(stateRoot, effectiveUid, true);
  if (!root.ok) return root;
  const guards: DirectoryGuard[] = [root.value];
  const components = [
    resolve(stateRoot, STORE_DIRECTORY),
    resolve(stateRoot, STORE_DIRECTORY, runId),
    paths.value.receiptDirectory,
  ];
  for (const component of components) {
    const child = ensureChildDirectory(guards, component, effectiveUid, create);
    if (!child.ok) {
      const closed = closeGuards(guards);
      if (!closed.ok) return closed;
      return child;
    }
    guards.push(child.value);
  }
  const stable = validateGuards(guards, effectiveUid);
  if (!stable.ok) {
    const closed = closeGuards(guards);
    if (!closed.ok) return closed;
    return stable;
  }
  return ok({ paths: paths.value, runId, attemptId, guards });
}

function readStrictFile(
  path: string,
  field: "receiptFile" | "terminalFile",
  maximumBytes: number,
  hierarchy: OpenHierarchy,
  effectiveUid: number,
  missingAllowed: boolean,
  allowedLinks: readonly bigint[] = [1n],
  allowEmpty = false,
): Result<StrictFile | undefined, ProductionRuntimeVaultReceiptStoreError> {
  const stableBefore = validateGuards(hierarchy.guards, effectiveUid);
  if (!stableBefore.ok) return stableBefore;
  const pathValue = tryCatch(() => lstatSync(path, { bigint: true }));
  if (!pathValue.ok) {
    if (errorCode(pathValue.error) === "ENOENT" && missingAllowed) return ok(undefined);
    if (errorCode(pathValue.error) === "ENOENT") {
      return failure({
        kind: "not_found",
        field: "receipt",
        message: "Stored recovery receipt does not exist",
      });
    }
    return unsafeFile(field);
  }
  if (
    !isPrivateFile(pathValue.value, effectiveUid, maximumBytes, allowedLinks, allowEmpty)
  ) {
    return unsafeFile(field);
  }

  const opened = tryCatch(() => openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW));
  if (!opened.ok) return unsafeFile(field);
  const before = tryCatch(() => fstatSync(opened.value, { bigint: true }));
  if (
    !before.ok ||
    !sameStableFile(pathValue.value, before.value) ||
    !isPrivateFile(before.value, effectiveUid, maximumBytes, allowedLinks, allowEmpty)
  ) {
    const closed = closeDescriptor(opened.value);
    if (!closed.ok) return closed;
    return unsafeFile(field);
  }

  const raw = Buffer.alloc(Number(before.value.size));
  let offset = 0;
  while (offset < raw.length) {
    const read = tryCatch(() =>
      readSync(opened.value, raw, offset, raw.length - offset, offset),
    );
    if (!read.ok || read.value <= 0 || read.value > raw.length - offset) {
      const closed = closeDescriptor(opened.value);
      if (!closed.ok) return closed;
      return unsafeFile(field);
    }
    offset += read.value;
  }

  const after = tryCatch(() => fstatSync(opened.value, { bigint: true }));
  const closed = closeDescriptor(opened.value);
  if (!closed.ok) return closed;
  const finalPathValue = tryCatch(() => lstatSync(path, { bigint: true }));
  if (
    !after.ok ||
    !finalPathValue.ok ||
    !sameStableFile(before.value, after.value) ||
    !sameStableFile(after.value, finalPathValue.value) ||
    !isPrivateFile(
      finalPathValue.value,
      effectiveUid,
      maximumBytes,
      allowedLinks,
      allowEmpty,
    )
  ) {
    return unsafeFile(field);
  }
  const stableAfter = validateGuards(hierarchy.guards, effectiveUid);
  if (!stableAfter.ok) return stableAfter;
  return ok({ raw, identity: after.value });
}

function decodeStrictUtf8(
  raw: Buffer,
  field: "receipt" | "terminalRecord",
): Result<string, ProductionRuntimeVaultReceiptStoreError> {
  const decoded = tryCatch(() => new TextDecoder("utf-8", { fatal: true }).decode(raw));
  if (!decoded.ok || !Buffer.from(decoded.value, "utf8").equals(raw)) {
    return field === "receipt"
      ? failure({
          kind: "invalid_receipt",
          field: "receipt",
          message: "Stored recovery receipt is not strict canonical UTF-8",
        })
      : failure({
          kind: "invalid_terminal_record",
          field: "terminalRecord",
          message: "Stored terminal record is not strict canonical UTF-8",
        });
  }
  return ok(decoded.value);
}

function parseStrictReceipt(
  strictFile: RawFile,
  authorityKey: Uint8Array,
  runId: string,
  attemptId: string,
): Result<StrictReceipt, ProductionRuntimeVaultReceiptStoreError> {
  const decoded = decodeStrictUtf8(strictFile.raw, "receipt");
  if (!decoded.ok) return decoded;
  const parsed = parseAndVerifyProductionRuntimeVaultRecoveryReceipt(
    decoded.value,
    authorityKey,
  );
  if (!parsed.ok || parsed.value.runId !== runId || parsed.value.attemptId !== attemptId) {
    return failure({
      kind: "invalid_receipt",
      field: "receipt",
      message: "Stored recovery receipt failed strict authority verification",
    });
  }
  return ok({ raw: strictFile.raw, receipt: parsed.value });
}

function authenticateReceiptValue(
  receipt: ProductionRuntimeVaultRecoveryReceipt,
  authorityKey: Uint8Array,
): Result<StrictReceipt, ProductionRuntimeVaultReceiptStoreError> {
  const encoded = tryCatch(() => {
    if (
      !isRecord(receipt) ||
      typeof receipt.runId !== "string" ||
      typeof receipt.attemptId !== "string"
    ) {
      return undefined;
    }
    return {
      runId: receipt.runId,
      attemptId: receipt.attemptId,
      raw: Buffer.from(serializeProductionRuntimeVaultRecoveryReceipt(receipt), "utf8"),
    };
  });
  if (!encoded.ok || encoded.value === undefined || encoded.value.raw.length > MAX_RECEIPT_BYTES) {
    return failure({
      kind: "invalid_receipt",
      field: "receipt",
      message: "Recovery receipt failed its bounded canonical input contract",
    });
  }
  return parseStrictReceipt(
    { raw: encoded.value.raw },
    authorityKey,
    encoded.value.runId,
    encoded.value.attemptId,
  );
}

function readReceiptFromHierarchy(
  hierarchy: OpenHierarchy,
  authorityKey: Uint8Array,
  effectiveUid: number,
): Result<StrictReceipt, ProductionRuntimeVaultReceiptStoreError> {
  const raw = readStrictFile(
    hierarchy.paths.receiptPath,
    "receiptFile",
    MAX_RECEIPT_BYTES,
    hierarchy,
    effectiveUid,
    false,
  );
  if (!raw.ok) return raw;
  if (raw.value === undefined) {
    return failure({
      kind: "not_found",
      field: "receipt",
      message: "Stored recovery receipt does not exist",
    });
  }
  return parseStrictReceipt(raw.value, authorityKey, hierarchy.runId, hierarchy.attemptId);
}

type PublicationField = "receiptFile" | "terminalFile";

type ExistingPublication =
  | { readonly kind: "absent" }
  | { readonly kind: "exact" }
  | { readonly kind: "other" };

function publicationConflict(
  field: PublicationField,
): Result<never, ProductionRuntimeVaultReceiptStoreError> {
  return failure({
    kind: "conflict",
    field: field === "receiptFile" ? "receipt" : "terminalRecord",
    message: "A different crash-recovery file already occupies the deterministic publication slot",
  });
}

function isExactPrefix(actual: Buffer, expected: Buffer): boolean {
  return actual.length <= expected.length && expected.subarray(0, actual.length).equals(actual);
}

function synchronizeFile(
  path: string,
  expected: BigIntStats,
  field: PublicationField,
  maximumBytes: number,
  hierarchy: OpenHierarchy,
  effectiveUid: number,
  allowedLinks: readonly bigint[],
  allowEmpty: boolean,
): Result<void, ProductionRuntimeVaultReceiptStoreError> {
  const stableBefore = validateGuards(hierarchy.guards, effectiveUid);
  if (!stableBefore.ok) return stableBefore;
  const opened = tryCatch(() => openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW));
  if (!opened.ok) return unsafeFile(field);
  const before = tryCatch(() => fstatSync(opened.value, { bigint: true }));
  if (
    !before.ok ||
    !sameStableFile(expected, before.value) ||
    !isPrivateFile(before.value, effectiveUid, maximumBytes, allowedLinks, allowEmpty)
  ) {
    const closed = closeDescriptor(opened.value);
    if (!closed.ok) return closed;
    return unsafeFile(field);
  }
  const synchronized = tryCatch(() => fsyncSync(opened.value));
  const after = tryCatch(() => fstatSync(opened.value, { bigint: true }));
  const closed = closeDescriptor(opened.value);
  if (!closed.ok) return closed;
  const pathValue = tryCatch(() => lstatSync(path, { bigint: true }));
  if (
    !synchronized.ok ||
    !after.ok ||
    !pathValue.ok ||
    !sameStableFile(before.value, after.value) ||
    !sameStableFile(after.value, pathValue.value) ||
    !isPrivateFile(pathValue.value, effectiveUid, maximumBytes, allowedLinks, allowEmpty)
  ) {
    return unsafeFile(field);
  }
  return validateGuards(hierarchy.guards, effectiveUid);
}

function unlinkPairedIncoming(
  finalPath: string,
  incomingPath: string,
  expectedIdentity: BigIntStats,
  field: PublicationField,
  maximumBytes: number,
  hierarchy: OpenHierarchy,
  effectiveUid: number,
): Result<void, ProductionRuntimeVaultReceiptStoreError> {
  const stableBefore = validateGuards(hierarchy.guards, effectiveUid);
  if (!stableBefore.ok) return stableBefore;
  const finalValue = tryCatch(() => lstatSync(finalPath, { bigint: true }));
  const incomingValue = tryCatch(() => lstatSync(incomingPath, { bigint: true }));
  if (
    !finalValue.ok ||
    !incomingValue.ok ||
    !sameInode(expectedIdentity, finalValue.value) ||
    !sameInode(finalValue.value, incomingValue.value) ||
    !isPrivateFile(finalValue.value, effectiveUid, maximumBytes, [2n], false) ||
    !isPrivateFile(incomingValue.value, effectiveUid, maximumBytes, [2n], false)
  ) {
    return unsafeFile(field);
  }
  const linkDurable = synchronizeGuards(hierarchy.guards);
  if (!linkDurable.ok) return linkDurable;
  const removed = tryCatch(() => unlinkSync(incomingPath));
  if (!removed.ok) return ioFailure("unlink_paired_incoming");
  const unlinkDurable = synchronizeGuards(hierarchy.guards);
  if (!unlinkDurable.ok) return unlinkDurable;
  const finalAfter = tryCatch(() => lstatSync(finalPath, { bigint: true }));
  if (
    !finalAfter.ok ||
    !sameInode(expectedIdentity, finalAfter.value) ||
    !isPrivateFile(finalAfter.value, effectiveUid, maximumBytes, [1n], false)
  ) {
    return unsafeFile(field);
  }
  return ok(undefined);
}

function reconcileExistingPublication(
  finalPath: string,
  incomingPath: string,
  expectedRaw: Buffer,
  field: PublicationField,
  maximumBytes: number,
  hierarchy: OpenHierarchy,
  effectiveUid: number,
): Result<ExistingPublication, ProductionRuntimeVaultReceiptStoreError> {
  const finalFile = readStrictFile(
    finalPath,
    field,
    maximumBytes,
    hierarchy,
    effectiveUid,
    true,
    [1n, 2n],
    true,
  );
  if (!finalFile.ok) return finalFile;
  if (finalFile.value === undefined) return ok({ kind: "absent" });

  const incomingFile = readStrictFile(
    incomingPath,
    field,
    maximumBytes,
    hierarchy,
    effectiveUid,
    true,
    [1n, 2n],
    true,
  );
  if (!incomingFile.ok) return incomingFile;
  if (!finalFile.value.raw.equals(expectedRaw)) {
    if (finalFile.value.identity.nlink !== 1n || incomingFile.value !== undefined) {
      return unsafeFile(field);
    }
    return ok({ kind: "other" });
  }

  if (finalFile.value.identity.nlink === 1n) {
    if (incomingFile.value !== undefined) return unsafeFile(field);
    const fileDurable = synchronizeFile(
      finalPath,
      finalFile.value.identity,
      field,
      maximumBytes,
      hierarchy,
      effectiveUid,
      [1n],
      false,
    );
    if (!fileDurable.ok) return fileDurable;
    const directoriesDurable = synchronizeGuards(hierarchy.guards);
    return directoriesDurable.ok ? ok({ kind: "exact" }) : directoriesDurable;
  }

  if (
    incomingFile.value === undefined ||
    incomingFile.value.identity.nlink !== 2n ||
    !sameInode(finalFile.value.identity, incomingFile.value.identity) ||
    !incomingFile.value.raw.equals(expectedRaw)
  ) {
    return unsafeFile(field);
  }
  const fileDurable = synchronizeFile(
    finalPath,
    finalFile.value.identity,
    field,
    maximumBytes,
    hierarchy,
    effectiveUid,
    [2n],
    false,
  );
  if (!fileDurable.ok) return fileDurable;
  const unlinked = unlinkPairedIncoming(
    finalPath,
    incomingPath,
    finalFile.value.identity,
    field,
    maximumBytes,
    hierarchy,
    effectiveUid,
  );
  if (!unlinked.ok) return unlinked;
  const normalized = readStrictFile(
    finalPath,
    field,
    maximumBytes,
    hierarchy,
    effectiveUid,
    false,
  );
  if (!normalized.ok || normalized.value === undefined || !normalized.value.raw.equals(expectedRaw)) {
    return normalized.ok ? unsafeFile(field) : normalized;
  }
  return ok({ kind: "exact" });
}

function createEmptyIncoming(
  incomingPath: string,
  field: PublicationField,
  maximumBytes: number,
  hierarchy: OpenHierarchy,
  effectiveUid: number,
): Result<"created" | "exists", ProductionRuntimeVaultReceiptStoreError> {
  const stable = validateGuards(hierarchy.guards, effectiveUid);
  if (!stable.ok) return stable;
  const opened = tryCatch(() =>
    openSync(
      incomingPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    ),
  );
  if (!opened.ok) {
    return errorCode(opened.error) === "EEXIST" ? ok("exists") : ioFailure("create_incoming");
  }
  const restricted = tryCatch(() => fchmodSync(opened.value, 0o600));
  const value = tryCatch(() => fstatSync(opened.value, { bigint: true }));
  const synchronized = tryCatch(() => fsyncSync(opened.value));
  const closed = closeDescriptor(opened.value);
  if (!closed.ok) return closed;
  const pathValue = tryCatch(() => lstatSync(incomingPath, { bigint: true }));
  if (
    !restricted.ok ||
    !value.ok ||
    !synchronized.ok ||
    !pathValue.ok ||
    !sameStableFile(value.value, pathValue.value) ||
    !isPrivateFile(pathValue.value, effectiveUid, maximumBytes, [1n], true) ||
    pathValue.value.size !== 0n
  ) {
    return unsafeFile(field);
  }
  const directoriesDurable = synchronizeGuards(hierarchy.guards);
  return directoriesDurable.ok ? ok("created") : directoriesDurable;
}

function preserveFailedIncomingWrite(
  descriptor: number,
  hierarchy: OpenHierarchy,
): Result<void, ProductionRuntimeVaultReceiptStoreError> {
  const fileSynchronized = tryCatch(() => fsyncSync(descriptor));
  const closed = closeDescriptor(descriptor);
  if (!closed.ok) return closed;
  const directoriesSynchronized = synchronizeGuards(hierarchy.guards);
  if (!fileSynchronized.ok || !directoriesSynchronized.ok) {
    return ioFailure("preserve_partial_incoming");
  }
  return ok(undefined);
}

function ensureCompleteIncoming(
  incomingPath: string,
  expectedRaw: Buffer,
  field: PublicationField,
  maximumBytes: number,
  hierarchy: OpenHierarchy,
  effectiveUid: number,
  io: ProductionRuntimeVaultReceiptStoreIo,
): Result<StrictFile, ProductionRuntimeVaultReceiptStoreError> {
  let incoming = readStrictFile(
    incomingPath,
    field,
    maximumBytes,
    hierarchy,
    effectiveUid,
    true,
    [1n, 2n],
    true,
  );
  if (!incoming.ok) return incoming;
  if (incoming.value === undefined) {
    const created = createEmptyIncoming(
      incomingPath,
      field,
      maximumBytes,
      hierarchy,
      effectiveUid,
    );
    if (!created.ok) return created;
    incoming = readStrictFile(
      incomingPath,
      field,
      maximumBytes,
      hierarchy,
      effectiveUid,
      false,
      [1n, 2n],
      true,
    );
    if (!incoming.ok || incoming.value === undefined) {
      return incoming.ok ? unsafeFile(field) : incoming;
    }
  }
  if (incoming.value.identity.nlink !== 1n) return unsafeFile(field);
  if (!isExactPrefix(incoming.value.raw, expectedRaw)) return publicationConflict(field);

  if (incoming.value.raw.length < expectedRaw.length) {
    const opened = tryCatch(() =>
      openSync(
        incomingPath,
        constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW,
      ),
    );
    if (!opened.ok) return unsafeFile(field);
    const before = tryCatch(() => fstatSync(opened.value, { bigint: true }));
    if (
      !before.ok ||
      !sameStableFile(incoming.value.identity, before.value) ||
      !isPrivateFile(before.value, effectiveUid, maximumBytes, [1n], true)
    ) {
      const closed = closeDescriptor(opened.value);
      if (!closed.ok) return closed;
      return unsafeFile(field);
    }

    let offset = incoming.value.raw.length;
    while (offset < expectedRaw.length) {
      const written = tryCatch(() =>
        io.write(opened.value, expectedRaw, offset, expectedRaw.length - offset),
      );
      if (!written.ok || written.value <= 0 || written.value > expectedRaw.length - offset) {
        const preserved = preserveFailedIncomingWrite(opened.value, hierarchy);
        if (!preserved.ok) return preserved;
        return ioFailure("write_incoming");
      }
      offset += written.value;
    }
    const fileSynchronized = tryCatch(() => fsyncSync(opened.value));
    const finalValue = tryCatch(() => fstatSync(opened.value, { bigint: true }));
    const closed = closeDescriptor(opened.value);
    if (!closed.ok) return closed;
    if (
      !fileSynchronized.ok ||
      !finalValue.ok ||
      !sameInode(before.value, finalValue.value) ||
      !isPrivateFile(finalValue.value, effectiveUid, maximumBytes, [1n], false) ||
      finalValue.value.size !== BigInt(expectedRaw.length)
    ) {
      return ioFailure("complete_incoming");
    }
  }

  const completed = readStrictFile(
    incomingPath,
    field,
    maximumBytes,
    hierarchy,
    effectiveUid,
    false,
    [1n],
    false,
  );
  if (!completed.ok || completed.value === undefined) {
    return completed.ok ? unsafeFile(field) : completed;
  }
  if (!completed.value.raw.equals(expectedRaw)) return publicationConflict(field);
  const fileDurable = synchronizeFile(
    incomingPath,
    completed.value.identity,
    field,
    maximumBytes,
    hierarchy,
    effectiveUid,
    [1n],
    false,
  );
  if (!fileDurable.ok) return fileDurable;
  const directoriesDurable = synchronizeGuards(hierarchy.guards);
  if (!directoriesDurable.ok) return directoriesDurable;
  return ok(completed.value);
}

function publishCrashSafeFile(
  finalPath: string,
  incomingPath: string,
  raw: Buffer,
  field: PublicationField,
  maximumBytes: number,
  hierarchy: OpenHierarchy,
  effectiveUid: number,
  io: ProductionRuntimeVaultReceiptStoreIo,
): Result<"created" | "exists", ProductionRuntimeVaultReceiptStoreError> {
  const existing = reconcileExistingPublication(
    finalPath,
    incomingPath,
    raw,
    field,
    maximumBytes,
    hierarchy,
    effectiveUid,
  );
  if (!existing.ok) return existing;
  if (existing.value.kind !== "absent") return ok("exists");

  const incoming = ensureCompleteIncoming(
    incomingPath,
    raw,
    field,
    maximumBytes,
    hierarchy,
    effectiveUid,
    io,
  );
  if (!incoming.ok) return incoming;
  const linked = tryCatch(() => linkSync(incomingPath, finalPath));
  if (!linked.ok && errorCode(linked.error) !== "EEXIST") {
    return ioFailure("publish_final_link");
  }
  const reconciled = reconcileExistingPublication(
    finalPath,
    incomingPath,
    raw,
    field,
    maximumBytes,
    hierarchy,
    effectiveUid,
  );
  if (!reconciled.ok) return reconciled;
  if (reconciled.value.kind !== "exact") return unsafeFile(field);
  return ok(linked.ok ? "created" : "exists");
}

function makeTerminalRecord(
  receipt: ProductionRuntimeVaultRecoveryReceipt,
  rawReceipt: Buffer,
  disposition: ProductionRuntimeVaultTerminalDisposition,
  authorityKey: Uint8Array,
): ProductionRuntimeVaultTerminalRecord {
  const unsigned: UnsignedTerminalRecord = {
    schema: TERMINAL_SCHEMA,
    schemaVersion: 1,
    runId: receipt.runId,
    attemptId: receipt.attemptId,
    disposition,
    authorityKeyIdSha256: receipt.seal.authorityKeyIdSha256,
    receiptAuthorityDigestSha256: receipt.seal.authorityDigestSha256,
    receiptDigestSha256: sha256(rawReceipt),
  };
  return { ...unsigned, authenticationTagSha256: terminalAuthenticationTag(unsigned, authorityKey) };
}

function serializeTerminalRecord(record: ProductionRuntimeVaultTerminalRecord): Buffer {
  return Buffer.from(`${canonicalJson(record)}\n`, "utf8");
}

function parseTerminalRecord(
  raw: Buffer,
  receipt: StrictReceipt,
  authorityKey: Uint8Array,
): Result<ProductionRuntimeVaultTerminalRecord, ProductionRuntimeVaultReceiptStoreError> {
  const decodedText = decodeStrictUtf8(raw, "terminalRecord");
  if (!decodedText.ok) return decodedText;
  const text = decodedText.value;
  const decoded = tryCatch(() => JSON.parse(text.slice(0, -1)) as unknown);
  if (
    raw.length > MAX_TERMINAL_BYTES ||
    !text.endsWith("\n") ||
    text.slice(0, -1).includes("\n") ||
    text.includes("\r") ||
    text.includes("\0") ||
    !decoded.ok ||
    !isRecord(decoded.value) ||
    !hasExactKeys(decoded.value, TERMINAL_KEYS) ||
    `${canonicalJson(decoded.value)}\n` !== text
  ) {
    return failure({
      kind: "invalid_terminal_record",
      field: "terminalRecord",
      message: "Stored terminal record is not a strict canonical authenticated record",
    });
  }

  const value = decoded.value;
  const disposition = value.disposition;
  if (
    value.schema !== TERMINAL_SCHEMA ||
    value.schemaVersion !== 1 ||
    typeof value.runId !== "string" ||
    !SAFE_RUN_ID_RE.test(value.runId) ||
    typeof value.attemptId !== "string" ||
    !ATTEMPT_ID_RE.test(value.attemptId) ||
    typeof disposition !== "string" ||
    !TERMINAL_DISPOSITIONS.includes(disposition as ProductionRuntimeVaultTerminalDisposition) ||
    typeof value.authorityKeyIdSha256 !== "string" ||
    !SHA256_RE.test(value.authorityKeyIdSha256) ||
    typeof value.receiptAuthorityDigestSha256 !== "string" ||
    !SHA256_RE.test(value.receiptAuthorityDigestSha256) ||
    typeof value.receiptDigestSha256 !== "string" ||
    !SHA256_RE.test(value.receiptDigestSha256) ||
    typeof value.authenticationTagSha256 !== "string" ||
    !SHA256_RE.test(value.authenticationTagSha256)
  ) {
    return failure({
      kind: "invalid_terminal_record",
      field: "terminalRecord",
      message: "Stored terminal record fields are invalid",
    });
  }

  const unsigned: UnsignedTerminalRecord = {
    schema: TERMINAL_SCHEMA,
    schemaVersion: 1,
    runId: value.runId,
    attemptId: value.attemptId,
    disposition: disposition as ProductionRuntimeVaultTerminalDisposition,
    authorityKeyIdSha256: value.authorityKeyIdSha256,
    receiptAuthorityDigestSha256: value.receiptAuthorityDigestSha256,
    receiptDigestSha256: value.receiptDigestSha256,
  };
  const valid =
    unsigned.runId === receipt.receipt.runId &&
    unsigned.attemptId === receipt.receipt.attemptId &&
    equalDigest(unsigned.authorityKeyIdSha256, receipt.receipt.seal.authorityKeyIdSha256) &&
    equalDigest(
      unsigned.receiptAuthorityDigestSha256,
      receipt.receipt.seal.authorityDigestSha256,
    ) &&
    equalDigest(unsigned.receiptDigestSha256, sha256(receipt.raw)) &&
    equalDigest(value.authenticationTagSha256, terminalAuthenticationTag(unsigned, authorityKey));
  if (!valid) {
    return failure({
      kind: "invalid_terminal_record",
      field: "terminalRecord",
      message: "Stored terminal record failed receipt binding or authority verification",
    });
  }
  return ok({ ...unsigned, authenticationTagSha256: value.authenticationTagSha256 });
}

function unsupportedPlatform(
  field: "platform" | "toolchain",
): Result<never, ProductionRuntimeVaultReceiptStoreError> {
  return failure({
    kind: "unsupported_platform",
    field,
    message:
      field === "platform"
        ? "Controller receipt transactions require the Linux dirfd syscall contract"
        : "Controller receipt transactions require the trusted Python 3.12 dirfd helper",
  });
}

function resolveTrustedPythonInterpreterPath(): Result<
  string,
  ProductionRuntimeVaultReceiptStoreError
> {
  const boundary = tryCatch(() => {
    const trustedDirectories = [
      ["/", lstatSync("/", { bigint: true }), realpathSync("/")],
      ["/usr", lstatSync("/usr", { bigint: true }), realpathSync("/usr")],
      ["/usr/bin", lstatSync("/usr/bin", { bigint: true }), realpathSync("/usr/bin")],
    ] as const;
    for (const [directory, value, canonicalDirectory] of trustedDirectories) {
      if (
        !value.isDirectory() ||
        value.uid !== 0n ||
        (value.mode & 0o022n) !== 0n ||
        canonicalDirectory !== directory
      ) {
        return undefined;
      }
    }
    const entry = lstatSync(PYTHON_INTERPRETER, { bigint: true });
    if (entry.uid !== 0n || (!entry.isFile() && !entry.isSymbolicLink())) return undefined;
    if (entry.isFile() && (entry.mode & 0o022n) !== 0n) return undefined;
    const canonical = realpathSync(PYTHON_INTERPRETER);
    const versionSuffix = canonical.slice("/usr/bin/python3.".length);
    if (
      canonical !== "/usr/bin/python3" &&
      (!canonical.startsWith("/usr/bin/python3.") || !/^[0-9]+$/u.test(versionSuffix))
    ) {
      return undefined;
    }
    return canonical;
  });
  return boundary.ok && boundary.value !== undefined
    ? ok(boundary.value)
    : unsupportedPlatform("toolchain");
}

function isTrustedInterpreterFile(value: BigIntStats): boolean {
  return (
    value.isFile() &&
    value.uid === 0n &&
    (value.mode & 0o022n) === 0n &&
    (value.mode & 0o111n) !== 0n &&
    value.size > 0n &&
    value.size <= BigInt(MAX_INTERPRETER_BYTES)
  );
}

function computeDescriptorSha256(
  descriptor: number,
  identity: BigIntStats,
): Result<string, ProductionRuntimeVaultReceiptStoreError> {
  const computed = tryCatch(() => {
    const digest = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    let offset = 0;
    const size = Number(identity.size);
    while (offset < size) {
      const read = readSync(descriptor, buffer, 0, Math.min(buffer.length, size - offset), offset);
      if (read <= 0) return undefined;
      digest.update(buffer.subarray(0, read));
      offset += read;
    }
    const after = fstatSync(descriptor, { bigint: true });
    return sameStableFile(identity, after) ? digest.digest("hex") : undefined;
  });
  return computed.ok && computed.value !== undefined
    ? ok(computed.value)
    : unsupportedPlatform("toolchain");
}

function openTrustedPythonInterpreter(): Result<
  TrustedPythonInterpreterGuard,
  ProductionRuntimeVaultReceiptStoreError
> {
  const path = resolveTrustedPythonInterpreterPath();
  if (!path.ok) return path;
  const target = tryCatch(() => lstatSync(path.value, { bigint: true }));
  if (!target.ok || !isTrustedInterpreterFile(target.value)) {
    return unsupportedPlatform("toolchain");
  }
  const opened = tryCatch(() =>
    openSync(path.value, constants.O_RDONLY | constants.O_NOFOLLOW),
  );
  if (!opened.ok) return unsupportedPlatform("toolchain");
  const identity = tryCatch(() => fstatSync(opened.value, { bigint: true }));
  if (
    !identity.ok ||
    !isTrustedInterpreterFile(identity.value) ||
    !sameStableFile(target.value, identity.value)
  ) {
    const closed = closeDescriptor(opened.value);
    return closed.ok ? unsupportedPlatform("toolchain") : closed;
  }
  const digest = computeDescriptorSha256(opened.value, identity.value);
  if (!digest.ok) {
    const closed = closeDescriptor(opened.value);
    return closed.ok ? digest : closed;
  }
  return ok({
    path: path.value,
    descriptor: opened.value,
    identity: identity.value,
    digestSha256: digest.value,
  });
}

function validateTrustedPythonInterpreter(
  guard: TrustedPythonInterpreterGuard,
): Result<void, ProductionRuntimeVaultReceiptStoreError> {
  const path = resolveTrustedPythonInterpreterPath();
  if (!path.ok || path.value !== guard.path) return unsupportedPlatform("toolchain");
  const named = tryCatch(() => lstatSync(guard.path, { bigint: true }));
  const opened = tryCatch(() => fstatSync(guard.descriptor, { bigint: true }));
  if (
    !named.ok ||
    !opened.ok ||
    !isTrustedInterpreterFile(named.value) ||
    !isTrustedInterpreterFile(opened.value) ||
    !sameStableFile(guard.identity, named.value) ||
    !sameStableFile(guard.identity, opened.value)
  ) {
    return unsupportedPlatform("toolchain");
  }
  const digest = computeDescriptorSha256(guard.descriptor, guard.identity);
  return digest.ok && equalDigest(digest.value, guard.digestSha256)
    ? ok(undefined)
    : unsupportedPlatform("toolchain");
}

function encodeHelperRequest(
  operation: HelperOperation,
  first: Buffer,
  second: Buffer,
): Buffer {
  const header = Buffer.alloc(HELPER_HEADER_BYTES);
  HELPER_REQUEST_MAGIC.copy(header, 0);
  header.writeUInt8(operation, 8);
  header.writeUInt32BE(first.length, 9);
  header.writeUInt32BE(second.length, 13);
  return Buffer.concat([header, first, second]);
}

function mapHelperFailure(
  status: number,
): Result<never, ProductionRuntimeVaultReceiptStoreError> {
  switch (status) {
    case HELPER_STATUS.unsafeRoot:
      return unsafeRoot();
    case HELPER_STATUS.unsafeDirectory:
      return unsafeDirectory();
    case HELPER_STATUS.unsafeReceipt:
      return unsafeFile("receiptFile");
    case HELPER_STATUS.unsafeTerminal:
      return unsafeFile("terminalFile");
    case HELPER_STATUS.receiptNotFound:
      return failure({
        kind: "not_found",
        field: "receipt",
        message: "Stored recovery receipt does not exist",
      });
    case HELPER_STATUS.receiptConflict:
      return failure({
        kind: "conflict",
        field: "receipt",
        message: "A different authenticated recovery receipt already exists for this attempt",
      });
    case HELPER_STATUS.terminalConflict:
      return failure({
        kind: "conflict",
        field: "terminalRecord",
        message: "A different authenticated terminal disposition already exists",
      });
    case HELPER_STATUS.lockTimeout:
      return operationLocked();
    case HELPER_STATUS.badProtocol:
      return unsupportedPlatform("toolchain");
    case HELPER_STATUS.ioFailure:
      return ioFailure("dirfd_helper_transaction");
    default:
      return ioFailure("dirfd_helper_response_status");
  }
}

function runLinuxDirfdHelper(
  rootDescriptor: number,
  interpreterDescriptor: number,
  operation: HelperOperation,
  runId: string,
  attemptId: string,
  first: Buffer = Buffer.alloc(0),
  second: Buffer = Buffer.alloc(0),
): Result<HelperResponse, ProductionRuntimeVaultReceiptStoreError> {
  const request = encodeHelperRequest(operation, first, second);
  const executed = tryCatch(() =>
    spawnSync(
      PINNED_INTERPRETER_PATH,
      ["-I", "-S", "-B", "-c", LINUX_DIRFD_TRANSACTION_HELPER, runId, attemptId],
      {
        cwd: "/",
        env: { PATH: "/usr/bin:/bin", LC_ALL: "C", TZ: "Etc/UTC" },
        input: request,
        stdio: ["pipe", "pipe", "pipe", rootDescriptor, interpreterDescriptor],
        timeout: HELPER_TIMEOUT_MS,
        killSignal: "SIGKILL",
        maxBuffer: HELPER_HEADER_BYTES + MAX_RECEIPT_BYTES + MAX_TERMINAL_BYTES,
      },
    ),
  );
  if (!executed.ok) return ioFailure("execute_dirfd_helper");
  const child = executed.value;
  if (
    child.error !== undefined ||
    child.signal !== null ||
    !Buffer.isBuffer(child.stdout) ||
    !Buffer.isBuffer(child.stderr) ||
    child.stderr.length !== 0 ||
    child.stdout.length < HELPER_HEADER_BYTES
  ) {
    return ioFailure("execute_dirfd_helper");
  }
  const output = child.stdout;
  if (!output.subarray(0, 8).equals(HELPER_RESPONSE_MAGIC)) {
    return ioFailure("dirfd_helper_protocol");
  }
  const status = output.readUInt8(8);
  const firstLength = output.readUInt32BE(9);
  const secondLength = output.readUInt32BE(13);
  if (
    firstLength > MAX_RECEIPT_BYTES ||
    secondLength > MAX_TERMINAL_BYTES ||
    HELPER_HEADER_BYTES + firstLength + secondLength !== output.length
  ) {
    return ioFailure("dirfd_helper_protocol");
  }
  const success = status < HELPER_STATUS.badProtocol;
  if (
    (success && child.status !== 0) ||
    (!success && child.status !== 70) ||
    (!success && (firstLength !== 0 || secondLength !== 0))
  ) {
    return ioFailure("dirfd_helper_protocol");
  }
  if (!success) return mapHelperFailure(status);
  const firstEnd = HELPER_HEADER_BYTES + firstLength;
  const response = {
    status,
    first: output.subarray(HELPER_HEADER_BYTES, firstEnd),
    second: output.subarray(firstEnd),
  };
  const validShape =
    ((status === HELPER_STATUS.created ||
      status === HELPER_STATUS.alreadyPresent ||
      status === HELPER_STATUS.probed) &&
      response.first.length === 0 &&
      response.second.length === 0) ||
    (status === HELPER_STATUS.receipt &&
      response.first.length > 0 &&
      response.second.length === 0) ||
    (status === HELPER_STATUS.pair && response.first.length > 0);
  return validShape ? ok(response) : ioFailure("dirfd_helper_protocol");
}

function invokeLinuxDirfdHelper(
  root: DirectoryGuard,
  effectiveUid: number,
  interpreter: TrustedPythonInterpreterGuard,
  operation: HelperOperation,
  runId: string,
  attemptId: string,
  first: Buffer = Buffer.alloc(0),
  second: Buffer = Buffer.alloc(0),
): Result<HelperResponse, ProductionRuntimeVaultReceiptStoreError> {
  const rootStableBefore = validateGuard(root, effectiveUid, true);
  if (!rootStableBefore.ok) return rootStableBefore;
  const interpreterStableBefore = validateTrustedPythonInterpreter(interpreter);
  if (!interpreterStableBefore.ok) return interpreterStableBefore;
  const response = runLinuxDirfdHelper(
    root.descriptor,
    interpreter.descriptor,
    operation,
    runId,
    attemptId,
    first,
    second,
  );
  const rootStableAfter = validateGuard(root, effectiveUid, true);
  const interpreterStableAfter = validateTrustedPythonInterpreter(interpreter);
  if (!rootStableAfter.ok) return rootStableAfter;
  if (!interpreterStableAfter.ok) return interpreterStableAfter;
  return response;
}

export function createProductionRuntimeVaultReceiptStore(
  options: CreateProductionRuntimeVaultReceiptStoreOptions,
): Result<ProductionRuntimeVaultReceiptStore, ProductionRuntimeVaultReceiptStoreError> {
  if (!isRecord(options)) return invalidRequest("options", "Receipt store options are required");
  if (
    typeof options.stateRoot !== "string" ||
    !isAbsolute(options.stateRoot) ||
    resolve(options.stateRoot) !== options.stateRoot
  ) {
    return unsafeRoot();
  }
  if (
    !(options.authorityKey instanceof Uint8Array) ||
    options.authorityKey.byteLength < MIN_AUTHORITY_KEY_BYTES
  ) {
    return invalidRequest("authorityKey", "Receipt authority key must contain at least 32 bytes");
  }
  if (process.platform !== "linux") return unsupportedPlatform("platform");
  const effectiveUid = currentEffectiveUid();
  if (!effectiveUid.ok) return effectiveUid;
  const interpreter = openTrustedPythonInterpreter();
  if (!interpreter.ok) return interpreter;
  const initialRoot = openDirectoryGuard(options.stateRoot, effectiveUid.value, true);
  if (!initialRoot.ok) {
    closeDescriptor(interpreter.value.descriptor);
    return initialRoot;
  }
  const rootGuard = initialRoot.value;
  const interpreterGuard = interpreter.value;

  const stateRoot = options.stateRoot;
  const authorityKey = Uint8Array.from(options.authorityKey);
  let disposed = false;

  function dispose(): Result<void, ProductionRuntimeVaultReceiptStoreError> {
    if (disposed) return ok(undefined);
    disposed = true;
    authorityKey.fill(0);
    const rootClosed = closeDescriptor(rootGuard.descriptor);
    const interpreterClosed = closeDescriptor(interpreterGuard.descriptor);
    if (!rootClosed.ok) return rootClosed;
    return interpreterClosed;
  }

  const invoke = (
    operation: HelperOperation,
    runId: string,
    attemptId: string,
    first: Buffer = Buffer.alloc(0),
    second: Buffer = Buffer.alloc(0),
  ): Result<HelperResponse, ProductionRuntimeVaultReceiptStoreError> => {
    if (disposed) return disposedStore();
    return invokeLinuxDirfdHelper(
      rootGuard,
      effectiveUid.value,
      interpreterGuard,
      operation,
      runId,
      attemptId,
      first,
      second,
    );
  };

  const probe = invoke(HELPER_OPERATION.probe, "probe", "0".repeat(32));
  if (!probe.ok) {
    dispose();
    return probe;
  }
  if (probe.value.status !== HELPER_STATUS.probed) {
    dispose();
    return unsupportedPlatform("toolchain");
  }

  function paths(
    runId: string,
    attemptId: string,
  ): Result<ProductionRuntimeVaultReceiptPaths, ProductionRuntimeVaultReceiptStoreError> {
    if (disposed) return disposedStore();
    return resolvePaths(stateRoot, runId, attemptId);
  }

  function createAndPersistReceipt(
    input: ProductionRuntimeVaultRecoveryReceiptInput,
  ): Result<ProductionRuntimeVaultCreatedReceipt, ProductionRuntimeVaultReceiptStoreError> {
    if (disposed) return disposedStore();
    const createdBoundary = tryCatch(() =>
      createProductionRuntimeVaultRecoveryReceipt(input, authorityKey),
    );
    if (!createdBoundary.ok || !createdBoundary.value.ok) {
      return failure({
        kind: "invalid_receipt",
        field: "receipt",
        message: "Recovery receipt input failed strict authority validation",
      });
    }
    const authenticated = authenticateReceiptValue(createdBoundary.value.value, authorityKey);
    if (!authenticated.ok) return authenticated;
    const receipt = authenticated.value.receipt;
    const receiptPaths = paths(receipt.runId, receipt.attemptId);
    if (!receiptPaths.ok) return receiptPaths;
    const published = invoke(
      HELPER_OPERATION.publishReceipt,
      receipt.runId,
      receipt.attemptId,
      authenticated.value.raw,
    );
    if (!published.ok) return published;
    if (
      published.value.status !== HELPER_STATUS.created &&
      published.value.status !== HELPER_STATUS.alreadyPresent
    ) {
      return ioFailure("dirfd_helper_publish_receipt_status");
    }
    return ok({
      status:
        published.value.status === HELPER_STATUS.created ? "created" : "already_present",
      path: receiptPaths.value.receiptPath,
      receipt,
    });
  }

  function readReceipt(
    runId: string,
    attemptId: string,
  ): Result<ProductionRuntimeVaultRecoveryReceipt, ProductionRuntimeVaultReceiptStoreError> {
    const receiptPaths = paths(runId, attemptId);
    if (!receiptPaths.ok) return receiptPaths;
    const read = invoke(HELPER_OPERATION.readReceipt, runId, attemptId);
    if (!read.ok) return read;
    if (
      read.value.status !== HELPER_STATUS.receipt ||
      read.value.first.length === 0 ||
      read.value.second.length !== 0
    ) {
      return ioFailure("dirfd_helper_read_receipt_status");
    }
    const parsed = parseStrictReceipt({ raw: read.value.first }, authorityKey, runId, attemptId);
    return parsed.ok ? ok(parsed.value.receipt) : parsed;
  }

  function recordTerminal(
    receipt: ProductionRuntimeVaultRecoveryReceipt,
    disposition: ProductionRuntimeVaultTerminalDisposition,
  ): Result<ProductionRuntimeVaultReceiptPersistence, ProductionRuntimeVaultReceiptStoreError> {
    if (disposed) return disposedStore();
    if (!TERMINAL_DISPOSITIONS.includes(disposition)) {
      return invalidRequest("disposition", "Terminal disposition is not part of the closed contract");
    }
    const authenticated = authenticateReceiptValue(receipt, authorityKey);
    if (!authenticated.ok) return authenticated;
    const receiptPaths = paths(receipt.runId, receipt.attemptId);
    if (!receiptPaths.ok) return receiptPaths;
    const record = makeTerminalRecord(receipt, authenticated.value.raw, disposition, authorityKey);
    const raw = serializeTerminalRecord(record);
    const published = invoke(
      HELPER_OPERATION.publishTerminal,
      receipt.runId,
      receipt.attemptId,
      authenticated.value.raw,
      raw,
    );
    if (!published.ok) return published;
    if (
      published.value.status !== HELPER_STATUS.created &&
      published.value.status !== HELPER_STATUS.alreadyPresent
    ) {
      return ioFailure("dirfd_helper_publish_terminal_status");
    }
    return ok({
      status:
        published.value.status === HELPER_STATUS.created ? "created" : "already_present",
      path: receiptPaths.value.terminalPath,
    });
  }

  function readTerminal(
    runId: string,
    attemptId: string,
  ): Result<
    ProductionRuntimeVaultTerminalRecord | undefined,
    ProductionRuntimeVaultReceiptStoreError
  > {
    const receiptPaths = paths(runId, attemptId);
    if (!receiptPaths.ok) return receiptPaths;
    const read = invoke(HELPER_OPERATION.readPair, runId, attemptId);
    if (!read.ok) return read;
    if (read.value.status !== HELPER_STATUS.pair || read.value.first.length === 0) {
      return ioFailure("dirfd_helper_read_pair_status");
    }
    const receipt = parseStrictReceipt({ raw: read.value.first }, authorityKey, runId, attemptId);
    if (!receipt.ok) return receipt;
    if (read.value.second.length === 0) return ok(undefined);
    return parseTerminalRecord(read.value.second, receipt.value, authorityKey);
  }

  return ok({ createAndPersistReceipt, dispose, paths, readReceipt, recordTerminal, readTerminal });
}

export function createProductionRuntimeVaultReceiptStoreForTests(
  options: CreateProductionRuntimeVaultReceiptStoreTestOptions,
): Result<ProductionRuntimeVaultReceiptStoreTestHarness, ProductionRuntimeVaultReceiptStoreError> {
  if (!isRecord(options)) return invalidRequest("options", "Receipt store options are required");
  if (
    typeof options.stateRoot !== "string" ||
    !isAbsolute(options.stateRoot) ||
    resolve(options.stateRoot) !== options.stateRoot
  ) {
    return unsafeRoot();
  }
  if (!(options.authorityKey instanceof Uint8Array) || options.authorityKey.byteLength < MIN_AUTHORITY_KEY_BYTES) {
    return invalidRequest("authorityKey", "Receipt authority key must contain at least 32 bytes");
  }
  if (options.io !== undefined && typeof options.io.write !== "function") {
    return invalidRequest("io", "Receipt store I/O dependency is invalid");
  }
  const effectiveUid = currentEffectiveUid();
  if (!effectiveUid.ok) return effectiveUid;
  const uid = effectiveUid.value;
  const root = openDirectoryGuard(options.stateRoot, uid, true);
  if (!root.ok) return root;
  const rootClosed = closeDescriptor(root.value.descriptor);
  if (!rootClosed.ok) return rootClosed;

  const stateRoot = options.stateRoot;
  const authorityKey = Uint8Array.from(options.authorityKey);
  let disposed = false;
  const io: ProductionRuntimeVaultReceiptStoreIo =
    options.io ?? {
      write(descriptor, data, offset, length) {
        return writeSync(descriptor, data, offset, length);
      },
    };

  function dispose(): Result<void, ProductionRuntimeVaultReceiptStoreError> {
    if (disposed) return ok(undefined);
    disposed = true;
    authorityKey.fill(0);
    return ok(undefined);
  }

  function paths(
    runId: string,
    attemptId: string,
  ): Result<ProductionRuntimeVaultReceiptPaths, ProductionRuntimeVaultReceiptStoreError> {
    if (disposed) return disposedStore();
    return resolvePaths(stateRoot, runId, attemptId);
  }

  function createAndPersistReceipt(
    input: ProductionRuntimeVaultRecoveryReceiptInput,
  ): Result<ProductionRuntimeVaultCreatedReceipt, ProductionRuntimeVaultReceiptStoreError> {
    if (disposed) return disposedStore();
    const createdBoundary = tryCatch(() =>
      createProductionRuntimeVaultRecoveryReceipt(input, authorityKey),
    );
    if (!createdBoundary.ok || !createdBoundary.value.ok) {
      return failure({
        kind: "invalid_receipt",
        field: "receipt",
        message: "Recovery receipt input failed strict authority validation",
      });
    }
    const persisted = persistReceipt(createdBoundary.value.value);
    if (!persisted.ok) return persisted;
    return ok({ ...persisted.value, receipt: createdBoundary.value.value });
  }

  function persistReceipt(
    receipt: ProductionRuntimeVaultRecoveryReceipt,
  ): Result<ProductionRuntimeVaultReceiptPersistence, ProductionRuntimeVaultReceiptStoreError> {
    if (disposed) return disposedStore();
    const authenticated = authenticateReceiptValue(receipt, authorityKey);
    if (!authenticated.ok) return authenticated;
    return withAttemptLock(
      stateRoot,
      authenticated.value.receipt.runId,
      authenticated.value.receipt.attemptId,
      () => persistAuthenticatedReceipt(authenticated.value),
    );
  }

  function persistAuthenticatedReceipt(
    authenticated: StrictReceipt,
  ): Result<ProductionRuntimeVaultReceiptPersistence, ProductionRuntimeVaultReceiptStoreError> {
    const raw = authenticated.raw;
    const canonicalReceipt = authenticated.receipt;
    const hierarchy = openHierarchy(
      stateRoot,
      canonicalReceipt.runId,
      canonicalReceipt.attemptId,
      uid,
      true,
    );
    if (!hierarchy.ok) return hierarchy;
    const written = publishCrashSafeFile(
      hierarchy.value.paths.receiptPath,
      hierarchy.value.paths.receiptIncomingPath,
      raw,
      "receiptFile",
      MAX_RECEIPT_BYTES,
      hierarchy.value,
      uid,
      io,
    );
    if (!written.ok) {
      const closed = closeGuards(hierarchy.value.guards);
      if (!closed.ok) return closed;
      return written;
    }
    if (written.value === "exists") {
      const existing = readReceiptFromHierarchy(
        hierarchy.value,
        authorityKey,
        uid,
      );
      const closed = closeGuards(hierarchy.value.guards);
      if (!closed.ok) return closed;
      if (!existing.ok) return existing;
      if (!existing.value.raw.equals(raw)) {
        return failure({
          kind: "conflict",
          field: "receipt",
          message: "A different authenticated recovery receipt already exists for this attempt",
        });
      }
      return ok({ status: "already_present", path: hierarchy.value.paths.receiptPath });
    }
    const closed = closeGuards(hierarchy.value.guards);
    if (!closed.ok) return closed;
    return ok({ status: "created", path: hierarchy.value.paths.receiptPath });
  }

  function readReceipt(
    runId: string,
    attemptId: string,
  ): Result<ProductionRuntimeVaultRecoveryReceipt, ProductionRuntimeVaultReceiptStoreError> {
    if (disposed) return disposedStore();
    const hierarchy = openHierarchy(stateRoot, runId, attemptId, uid, false);
    if (!hierarchy.ok) return hierarchy;
    const receipt = readReceiptFromHierarchy(hierarchy.value, authorityKey, uid);
    const closed = closeGuards(hierarchy.value.guards);
    if (!closed.ok) return closed;
    return receipt.ok ? ok(receipt.value.receipt) : receipt;
  }

  function recordTerminal(
    receipt: ProductionRuntimeVaultRecoveryReceipt,
    disposition: ProductionRuntimeVaultTerminalDisposition,
  ): Result<ProductionRuntimeVaultReceiptPersistence, ProductionRuntimeVaultReceiptStoreError> {
    if (disposed) return disposedStore();
    if (!TERMINAL_DISPOSITIONS.includes(disposition)) {
      return invalidRequest("disposition", "Terminal disposition is not part of the closed contract");
    }
    const proposedReceipt = authenticateReceiptValue(receipt, authorityKey);
    if (!proposedReceipt.ok) return proposedReceipt;
    return withAttemptLock(
      stateRoot,
      proposedReceipt.value.receipt.runId,
      proposedReceipt.value.receipt.attemptId,
      () => recordTerminalAuthenticated(proposedReceipt.value, disposition),
    );
  }

  function recordTerminalAuthenticated(
    proposedReceipt: StrictReceipt,
    disposition: ProductionRuntimeVaultTerminalDisposition,
  ): Result<ProductionRuntimeVaultReceiptPersistence, ProductionRuntimeVaultReceiptStoreError> {
    const hierarchy = openHierarchy(
      stateRoot,
      proposedReceipt.receipt.runId,
      proposedReceipt.receipt.attemptId,
      uid,
      false,
    );
    if (!hierarchy.ok) return hierarchy;
    const storedReceipt = readReceiptFromHierarchy(
      hierarchy.value,
      authorityKey,
      uid,
    );
    if (!storedReceipt.ok) {
      const closed = closeGuards(hierarchy.value.guards);
      if (!closed.ok) return closed;
      return storedReceipt;
    }
    const proposedRaw = proposedReceipt.raw;
    if (!storedReceipt.value.raw.equals(proposedRaw)) {
      const closed = closeGuards(hierarchy.value.guards);
      if (!closed.ok) return closed;
      return failure({
        kind: "conflict",
        field: "receipt",
        message: "Terminal record receipt does not match the durable recovery authority",
      });
    }
    const record = makeTerminalRecord(
      proposedReceipt.receipt,
      proposedRaw,
      disposition,
      authorityKey,
    );
    const raw = serializeTerminalRecord(record);
    const written = publishCrashSafeFile(
      hierarchy.value.paths.terminalPath,
      hierarchy.value.paths.terminalIncomingPath,
      raw,
      "terminalFile",
      MAX_TERMINAL_BYTES,
      hierarchy.value,
      uid,
      io,
    );
    if (!written.ok) {
      const closed = closeGuards(hierarchy.value.guards);
      if (!closed.ok) return closed;
      return written;
    }
    if (written.value === "exists") {
      const existingRaw = readStrictFile(
        hierarchy.value.paths.terminalPath,
        "terminalFile",
        MAX_TERMINAL_BYTES,
        hierarchy.value,
        uid,
        false,
      );
      if (!existingRaw.ok || existingRaw.value === undefined) {
        const closed = closeGuards(hierarchy.value.guards);
        if (!closed.ok) return closed;
        return existingRaw.ok
          ? failure({
              kind: "invalid_terminal_record",
              field: "terminalRecord",
              message: "Stored terminal record disappeared during verification",
            })
          : existingRaw;
      }
      const parsed = parseTerminalRecord(existingRaw.value.raw, storedReceipt.value, authorityKey);
      const closed = closeGuards(hierarchy.value.guards);
      if (!closed.ok) return closed;
      if (!parsed.ok) return parsed;
      if (!existingRaw.value.raw.equals(raw)) {
        return failure({
          kind: "conflict",
          field: "terminalRecord",
          message: "A different authenticated terminal disposition already exists",
        });
      }
      return ok({ status: "already_present", path: hierarchy.value.paths.terminalPath });
    }
    const closed = closeGuards(hierarchy.value.guards);
    if (!closed.ok) return closed;
    return ok({ status: "created", path: hierarchy.value.paths.terminalPath });
  }

  function readTerminal(
    runId: string,
    attemptId: string,
  ): Result<
    ProductionRuntimeVaultTerminalRecord | undefined,
    ProductionRuntimeVaultReceiptStoreError
  > {
    if (disposed) return disposedStore();
    const hierarchy = openHierarchy(stateRoot, runId, attemptId, uid, false);
    if (!hierarchy.ok) return hierarchy;
    const receipt = readReceiptFromHierarchy(hierarchy.value, authorityKey, uid);
    if (!receipt.ok) {
      const closed = closeGuards(hierarchy.value.guards);
      if (!closed.ok) return closed;
      return receipt;
    }
    const terminal = readStrictFile(
      hierarchy.value.paths.terminalPath,
      "terminalFile",
      MAX_TERMINAL_BYTES,
      hierarchy.value,
      uid,
      true,
    );
    if (!terminal.ok) {
      const closed = closeGuards(hierarchy.value.guards);
      if (!closed.ok) return closed;
      return terminal;
    }
    if (terminal.value === undefined) {
      const closed = closeGuards(hierarchy.value.guards);
      if (!closed.ok) return closed;
      return ok(undefined);
    }
    const parsed = parseTerminalRecord(terminal.value.raw, receipt.value, authorityKey);
    const closed = closeGuards(hierarchy.value.guards);
    if (!closed.ok) return closed;
    return parsed;
  }

  return ok({
    createAndPersistReceipt,
    dispose,
    paths,
    persistReceipt,
    readReceipt,
    recordTerminal,
    readTerminal,
  });
}
