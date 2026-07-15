// SPDX-License-Identifier: Apache-2.0
import { runtimeVaultJournalPhaseFile } from "./production-runtime-vault-journal-shell.js";
import {
  RUNTIME_VAULT_FORWARD_PHASES,
  RUNTIME_VAULT_ROLLBACK_PHASES,
  RUNTIME_VAULT_TRANSACTION_STATUS_BEGIN,
  RUNTIME_VAULT_TRANSACTION_STATUS_END,
} from "./production-runtime-vault-transaction.js";

const PHASES = [
  ...RUNTIME_VAULT_FORWARD_PHASES,
  ...RUNTIME_VAULT_ROLLBACK_PHASES,
] as const;

function pythonString(value: string): string {
  return JSON.stringify(value);
}

export function buildProductionRuntimeVaultTransactionObservationProgram(
  expectedUid = 0,
  expectedGid = 0,
  requireXattrSupport = true,
): string {
  const uid = Number.isSafeInteger(expectedUid) && expectedUid >= 0 ? expectedUid : -1;
  const gid = Number.isSafeInteger(expectedGid) && expectedGid >= 0 ? expectedGid : -1;
  const phaseRows = PHASES.map(
    (phase) =>
      `    (${pythonString(phase)}, ${pythonString(runtimeVaultJournalPhaseFile(phase))}),`,
  ).join("\n");
  return String.raw`set -euo pipefail
if [ "$#" -ne 5 ]; then exit 2; fi
python3 - "$@" <<'COMIS_RUNTIME_TRANSACTION_OBSERVATION'
import os
import re
import stat
import sys

EXPECTED_UID = ${uid}
EXPECTED_GID = ${gid}
REQUIRE_XATTR_SUPPORT = ${requireXattrSupport ? "True" : "False"}
STATUS_BEGIN = ${pythonString(RUNTIME_VAULT_TRANSACTION_STATUS_BEGIN)}
STATUS_END = ${pythonString(RUNTIME_VAULT_TRANSACTION_STATUS_END)}
SHA256 = re.compile(r"^[a-f0-9]{64}$")
PHASES = (
${phaseRows}
)
FORWARD = tuple(phase for phase, _name in PHASES[:9])
PHASE_FILE = dict(PHASES)
FILE_PHASE = {name: phase for phase, name in PHASES}


class CorruptState(Exception):
    pass


def xattrs(descriptor):
    if not hasattr(os, "listxattr"):
        if REQUIRE_XATTR_SUPPORT:
            raise CorruptState()
        return []
    try:
        return os.listxattr(descriptor)
    except (AttributeError, OSError, TypeError):
        if REQUIRE_XATTR_SUPPORT:
            raise CorruptState()
        return []


def secure_directory_descriptor(descriptor):
    value = os.fstat(descriptor)
    if (
        not stat.S_ISDIR(value.st_mode)
        or value.st_uid != EXPECTED_UID
        or value.st_gid != EXPECTED_GID
        or stat.S_IMODE(value.st_mode) != 0o700
        or xattrs(descriptor)
    ):
        raise CorruptState()
    return value


def open_directory(path_or_name, parent=None):
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    try:
        descriptor = os.open(path_or_name, flags, dir_fd=parent)
    except OSError as error:
        raise CorruptState() from error
    try:
        secure_directory_descriptor(descriptor)
    except Exception:
        os.close(descriptor)
        raise
    return descriptor


def read_file(directory, name, maximum, links):
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC
    try:
        descriptor = os.open(name, flags, dir_fd=directory)
    except OSError as error:
        raise CorruptState() from error
    try:
        before = os.fstat(descriptor)
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_uid != EXPECTED_UID
            or before.st_gid != EXPECTED_GID
            or stat.S_IMODE(before.st_mode) != 0o400
            or before.st_nlink not in links
            or before.st_size > maximum
            or xattrs(descriptor)
        ):
            raise CorruptState()
        chunks = []
        remaining = maximum + 1
        while remaining > 0:
            chunk = os.read(descriptor, remaining)
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        after = os.fstat(descriptor)
        if (
            (after.st_dev, after.st_ino, after.st_size, after.st_nlink)
            != (before.st_dev, before.st_ino, before.st_size, before.st_nlink)
        ):
            raise CorruptState()
        content = b"".join(chunks)
        if len(content) != before.st_size:
            raise CorruptState()
        return before, content
    except OSError as error:
        raise CorruptState() from error
    finally:
        os.close(descriptor)


def valid_history(phases):
    if "rollback_intent" not in phases:
        return tuple(phases) == FORWARD[:len(phases)]
    index = phases.index("rollback_intent")
    prefix = tuple(phases[:index])
    suffix = tuple(phases[index:])
    return (
        prefix == FORWARD[:len(prefix)]
        and len(prefix) <= FORWARD.index("published")
        and suffix in (("rollback_intent",), ("rollback_intent", "rolled_back"))
    )


def next_phases(history):
    if "rollback_intent" in history:
        return ("rolled_back",) if history[-1] == "rollback_intent" else ()
    output = []
    if len(history) < len(FORWARD):
        output.append(FORWARD[len(history)])
    if len(history) <= FORWARD.index("published"):
        output.append("rollback_intent")
    return tuple(output)


def emit(lines):
    sys.stdout.write("\n".join((STATUS_BEGIN, *lines, STATUS_END, "")))


def emit_corrupt(final_state):
    emit(("transactionState=present", "manifestState=corrupt", "finalState=" + final_state))


def emit_valid(authority, identity, history, final_state):
    lines = [
        "transactionState=present",
        "manifestState=valid",
        "authorityDigestSha256=" + authority,
        "transactionIdentitySha256=" + identity,
    ]
    lines.extend("phase=" + phase for phase in history)
    lines.append("finalState=" + final_state)
    emit(tuple(lines))


def parse_manifest(content):
    try:
        text = content.decode("ascii")
    except UnicodeDecodeError as error:
        raise CorruptState() from error
    match = re.fullmatch(
        r"COMIS_RUNTIME_VAULT_TRANSACTION_V1_BEGIN\n"
        r"authorityDigestSha256=([a-f0-9]{64})\n"
        r"transactionIdentitySha256=([a-f0-9]{64})\n"
        r"COMIS_RUNTIME_VAULT_TRANSACTION_V1_END\n",
        text,
    )
    if match is None:
        raise CorruptState()
    return match.group(1), match.group(2)


if len(sys.argv) != 6:
    raise SystemExit(2)
transaction_parent, transaction_dir, expected_authority, expected_identity, final_state = sys.argv[1:]
if (
    not os.path.isabs(transaction_parent)
    or not os.path.isabs(transaction_dir)
    or os.path.dirname(transaction_dir) != transaction_parent
    or os.path.basename(transaction_dir) in ("", ".", "..")
    or not SHA256.fullmatch(expected_authority)
    or not SHA256.fullmatch(expected_identity)
    or final_state not in ("absent", "exact", "conflict")
):
    raise SystemExit(2)

parent_descriptor = None
transaction_descriptor = None
try:
    parent_descriptor = open_directory(transaction_parent)
    transaction_name = os.path.basename(transaction_dir)
    try:
        transaction_value = os.stat(
            transaction_name,
            dir_fd=parent_descriptor,
            follow_symlinks=False,
        )
    except FileNotFoundError:
        emit(("transactionState=absent", "finalState=" + final_state))
        raise SystemExit(0)
    if not stat.S_ISDIR(transaction_value.st_mode) or stat.S_ISLNK(transaction_value.st_mode):
        raise CorruptState()
    transaction_descriptor = open_directory(transaction_name, parent_descriptor)
    opened_transaction = os.fstat(transaction_descriptor)
    if (opened_transaction.st_dev, opened_transaction.st_ino) != (
        transaction_value.st_dev,
        transaction_value.st_ino,
    ):
        raise CorruptState()
    try:
        names = set(os.listdir(transaction_descriptor))
    except OSError as error:
        raise CorruptState() from error

    expected_manifest = (
        "COMIS_RUNTIME_VAULT_TRANSACTION_V1_BEGIN\n"
        + "authorityDigestSha256=" + expected_authority + "\n"
        + "transactionIdentitySha256=" + expected_identity + "\n"
        + "COMIS_RUNTIME_VAULT_TRANSACTION_V1_END\n"
    ).encode("ascii")
    manifest_present = "manifest" in names
    manifest_incoming = ".incoming-manifest" in names
    if not manifest_present:
        if names == set():
            emit_valid(expected_authority, expected_identity, (), final_state)
            raise SystemExit(0)
        if names != {".incoming-manifest"}:
            raise CorruptState()
        _incoming_value, incoming_content = read_file(
            transaction_descriptor,
            ".incoming-manifest",
            len(expected_manifest),
            (1,),
        )
        if not expected_manifest.startswith(incoming_content):
            raise CorruptState()
        emit_valid(expected_authority, expected_identity, (), final_state)
        raise SystemExit(0)

    manifest_links = (2,) if manifest_incoming else (1,)
    manifest_value, manifest_content = read_file(
        transaction_descriptor,
        "manifest",
        512,
        manifest_links,
    )
    authority, identity = parse_manifest(manifest_content)
    if manifest_incoming:
        incoming_value, incoming_content = read_file(
            transaction_descriptor,
            ".incoming-manifest",
            512,
            (2,),
        )
        if (
            incoming_content != manifest_content
            or (incoming_value.st_dev, incoming_value.st_ino)
            != (manifest_value.st_dev, manifest_value.st_ino)
        ):
            raise CorruptState()

    allowed = {"manifest", ".incoming-manifest"}
    allowed.update(FILE_PHASE)
    allowed.update(".incoming-" + phase for phase, _name in PHASES)
    if not names.issubset(allowed):
        raise CorruptState()
    phase_partials = sorted(
        name for name in names
        if name.startswith(".incoming-") and name != ".incoming-manifest"
    )
    if len(phase_partials) > 1:
        raise CorruptState()

    history = []
    for phase, filename in PHASES:
        if filename not in names:
            continue
        paired = ".incoming-" + phase in names
        _phase_value, phase_content = read_file(
            transaction_descriptor,
            filename,
            len(phase) + 1,
            (2,) if paired else (1,),
        )
        if phase_content != (phase + "\n").encode("ascii"):
            raise CorruptState()
        history.append(phase)
    if not valid_history(history):
        raise CorruptState()

    if phase_partials:
        partial_name = phase_partials[0]
        partial_phase = partial_name[len(".incoming-"):]
        if partial_phase not in PHASE_FILE:
            raise CorruptState()
        paired = PHASE_FILE[partial_phase] in names
        expected_phase = (partial_phase + "\n").encode("ascii")
        partial_value, partial_content = read_file(
            transaction_descriptor,
            partial_name,
            len(expected_phase),
            (2,) if paired else (1,),
        )
        if not expected_phase.startswith(partial_content):
            raise CorruptState()
        if paired:
            final_value, final_content = read_file(
                transaction_descriptor,
                PHASE_FILE[partial_phase],
                len(expected_phase),
                (2,),
            )
            if (
                partial_content != expected_phase
                or final_content != expected_phase
                or (partial_value.st_dev, partial_value.st_ino)
                != (final_value.st_dev, final_value.st_ino)
                or not history
                or history[-1] != partial_phase
            ):
                raise CorruptState()
        elif partial_phase not in next_phases(history):
            raise CorruptState()
    emit_valid(authority, identity, tuple(history), final_state)
except SystemExit:
    raise
except Exception:
    emit_corrupt(final_state)
finally:
    if transaction_descriptor is not None:
        os.close(transaction_descriptor)
    if parent_descriptor is not None:
        os.close(parent_descriptor)
COMIS_RUNTIME_TRANSACTION_OBSERVATION
`;
}
