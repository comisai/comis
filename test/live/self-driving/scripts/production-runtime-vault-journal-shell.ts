// SPDX-License-Identifier: Apache-2.0
import type { ProductionRuntimeVaultJournalPhase } from "./production-runtime-vault-transaction.js";

const PHASE_FILES: Readonly<Record<ProductionRuntimeVaultJournalPhase, string>> = {
  prepare_intent: "100-prepare_intent",
  prepared: "110-prepared",
  receive_intent: "200-receive_intent",
  received: "210-received",
  verify_intent: "300-verify_intent",
  verified: "310-verified",
  publish_intent: "400-publish_intent",
  published: "410-published",
  cleanup_complete: "420-cleanup_complete",
  rollback_intent: "900-rollback_intent",
  rolled_back: "910-rolled_back",
};

export function runtimeVaultJournalPhaseFile(
  phase: ProductionRuntimeVaultJournalPhase,
): string {
  return PHASE_FILES[phase];
}

export function buildProductionRuntimeVaultJournalShellLibrary(
  expectedUid = 0,
  expectedGid = 0,
  requireXattrSupport = true,
): string {
  const uid = Number.isSafeInteger(expectedUid) && expectedUid >= 0 ? expectedUid : -1;
  const gid = Number.isSafeInteger(expectedGid) && expectedGid >= 0 ? expectedGid : -1;
  return String.raw`runtime_journal_manage() {
  journal_action="$1"
  journal_phase="$2"
  python3 - "$journal_action" "$journal_phase" "$transaction_parent" "$transaction_dir" \
    "$expected_authority_digest" "$expected_transaction_identity" <<'COMIS_RUNTIME_TRANSACTION_MANIFEST'
import os
import re
import stat
import sys

EXPECTED_UID = ${uid}
EXPECTED_GID = ${gid}
REQUIRE_XATTR_SUPPORT = ${requireXattrSupport ? "True" : "False"}
SHA256 = re.compile(r"^[a-f0-9]{64}$")
PHASES = (
    ("prepare_intent", "100-prepare_intent"),
    ("prepared", "110-prepared"),
    ("receive_intent", "200-receive_intent"),
    ("received", "210-received"),
    ("verify_intent", "300-verify_intent"),
    ("verified", "310-verified"),
    ("publish_intent", "400-publish_intent"),
    ("published", "410-published"),
    ("cleanup_complete", "420-cleanup_complete"),
    ("rollback_intent", "900-rollback_intent"),
    ("rolled_back", "910-rolled_back"),
)
FORWARD = tuple(phase for phase, _name in PHASES[:9])
PHASE_FILE = dict(PHASES)
FILE_PHASE = {name: phase for phase, name in PHASES}


def fail():
    raise SystemExit(1)


def xattrs(path):
    if not hasattr(os, "listxattr"):
        if REQUIRE_XATTR_SUPPORT:
            fail()
        return []
    try:
        return os.listxattr(path, follow_symlinks=False)
    except (AttributeError, OSError):
        fail()


def secure_directory(path):
    try:
        value = os.lstat(path)
    except OSError:
        fail()
    if (
        not stat.S_ISDIR(value.st_mode)
        or stat.S_ISLNK(value.st_mode)
        or value.st_uid != EXPECTED_UID
        or value.st_gid != EXPECTED_GID
        or stat.S_IMODE(value.st_mode) != 0o700
        or xattrs(path)
    ):
        fail()
    return value


def secure_file(path, expected, links=(1,)):
    try:
        value = os.lstat(path)
    except OSError:
        fail()
    if (
        not stat.S_ISREG(value.st_mode)
        or stat.S_ISLNK(value.st_mode)
        or value.st_uid != EXPECTED_UID
        or value.st_gid != EXPECTED_GID
        or stat.S_IMODE(value.st_mode) != 0o400
        or value.st_nlink not in links
        or value.st_size > len(expected)
        or xattrs(path)
    ):
        fail()
    flags = os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags)
        opened = os.fstat(descriptor)
        chunks = []
        remaining = len(expected) + 1
        while remaining > 0:
            chunk = os.read(descriptor, remaining)
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        after = os.fstat(descriptor)
    except OSError:
        fail()
    finally:
        try:
            os.close(descriptor)
        except (OSError, UnboundLocalError):
            pass
    if (
        (opened.st_dev, opened.st_ino) != (value.st_dev, value.st_ino)
        or (after.st_dev, after.st_ino, after.st_size, after.st_nlink)
        != (opened.st_dev, opened.st_ino, opened.st_size, opened.st_nlink)
    ):
        fail()
    return value, b"".join(chunks)


def sync_directory(path):
    flags = os.O_RDONLY | os.O_CLOEXEC | os.O_DIRECTORY | os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags)
        os.fsync(descriptor)
    except OSError:
        fail()
    finally:
        try:
            os.close(descriptor)
        except (OSError, UnboundLocalError):
            pass


def remove_partial(path, expected):
    value, content = secure_file(path, expected)
    if not expected.startswith(content):
        fail()
    try:
        os.unlink(path)
    except OSError:
        fail()
    sync_directory(transaction_dir)


def publish_file(label, final_name, content):
    incoming_name = ".incoming-" + label
    incoming_path = os.path.join(transaction_dir, incoming_name)
    final_path = os.path.join(transaction_dir, final_name)
    incoming_exists = os.path.lexists(incoming_path)
    final_exists = os.path.lexists(final_path)
    if final_exists:
        final_value, final_content = secure_file(final_path, content, (1, 2))
        if final_content != content:
            fail()
        if incoming_exists:
            incoming_value, incoming_content = secure_file(incoming_path, content, (2,))
            if (
                incoming_content != content
                or (incoming_value.st_dev, incoming_value.st_ino)
                != (final_value.st_dev, final_value.st_ino)
            ):
                fail()
            try:
                os.unlink(incoming_path)
            except OSError:
                fail()
            sync_directory(transaction_dir)
            secure_file(final_path, content)
        elif final_value.st_nlink != 1:
            fail()
        return
    if incoming_exists:
        remove_partial(incoming_path, content)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW
    try:
        descriptor = os.open(incoming_path, flags, 0o400)
        os.fchmod(descriptor, 0o400)
        offset = 0
        while offset < len(content):
            written = os.write(descriptor, content[offset:])
            if written <= 0:
                fail()
            offset += written
        os.fsync(descriptor)
    except OSError:
        fail()
    finally:
        try:
            os.close(descriptor)
        except (OSError, UnboundLocalError):
            pass
    secure_file(incoming_path, content)
    try:
        os.link(incoming_path, final_path, follow_symlinks=False)
    except OSError:
        fail()
    sync_directory(transaction_dir)
    incoming_value, incoming_content = secure_file(incoming_path, content, (2,))
    final_value, final_content = secure_file(final_path, content, (2,))
    if (
        incoming_content != content
        or final_content != content
        or (incoming_value.st_dev, incoming_value.st_ino)
        != (final_value.st_dev, final_value.st_ino)
    ):
        fail()
    try:
        os.unlink(incoming_path)
    except OSError:
        fail()
    sync_directory(transaction_dir)
    secure_file(final_path, content)


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


def inspect_inventory(requested=None):
    secure_directory(transaction_dir)
    try:
        names = set(os.listdir(transaction_dir))
    except OSError:
        fail()
    allowed = {"manifest", ".incoming-manifest"}
    allowed.update(FILE_PHASE)
    allowed.update(".incoming-" + phase for phase, _name in PHASES)
    if not names.issubset(allowed) or "manifest" not in names:
        fail()
    manifest_path = os.path.join(transaction_dir, "manifest")
    _manifest_value, manifest_content = secure_file(manifest_path, MANIFEST)
    if manifest_content != MANIFEST:
        fail()
    if ".incoming-manifest" in names:
        fail()
    partials = sorted(name for name in names if name.startswith(".incoming-"))
    if len(partials) > 1:
        fail()
    history = []
    for phase, filename in PHASES:
        if filename not in names:
            continue
        paired = ".incoming-" + phase in names
        _value, content = secure_file(
            os.path.join(transaction_dir, filename),
            (phase + "\n").encode("ascii"),
            (2,) if paired else (1,),
        )
        if content != (phase + "\n").encode("ascii"):
            fail()
        history.append(phase)
    if not valid_history(history):
        fail()
    partial_phase = None
    paired_final = False
    if partials:
        partial_phase = partials[0][len(".incoming-"):]
        paired_final = PHASE_FILE.get(partial_phase) in names
        if (
            partial_phase not in next_phases(history)
            and not (paired_final and history and history[-1] == partial_phase)
        ):
            fail()
        expected = (partial_phase + "\n").encode("ascii")
        partial_value, content = secure_file(
            os.path.join(transaction_dir, partials[0]),
            expected,
            (2,) if paired_final else (1,),
        )
        if not expected.startswith(content):
            fail()
        if paired_final:
            final_value, final_content = secure_file(
                os.path.join(transaction_dir, PHASE_FILE[partial_phase]),
                expected,
                (2,),
            )
            if (
                content != expected
                or final_content != expected
                or (partial_value.st_dev, partial_value.st_ino)
                != (final_value.st_dev, final_value.st_ino)
            ):
                fail()
        if (
            requested is not None
            and partial_phase != requested
            and not paired_final
            and requested != "rollback_intent"
        ):
            fail()
    return tuple(history), partial_phase, paired_final


try:
    if len(sys.argv) != 7:
        fail()
    action, requested, transaction_parent, transaction_dir, authority, identity = sys.argv[1:]
    if (
        action not in ("initialize", "append", "finish_forward")
        or not SHA256.fullmatch(authority)
        or not SHA256.fullmatch(identity)
        or not os.path.isabs(transaction_parent)
        or not os.path.isabs(transaction_dir)
        or os.path.dirname(transaction_dir) != transaction_parent
    ):
        fail()
    MANIFEST = (
        "COMIS_RUNTIME_VAULT_TRANSACTION_V1_BEGIN\n"
        + "authorityDigestSha256=" + authority + "\n"
        + "transactionIdentitySha256=" + identity + "\n"
        + "COMIS_RUNTIME_VAULT_TRANSACTION_V1_END\n"
    ).encode("ascii")
    secure_directory(transaction_parent)
    if not os.path.lexists(transaction_dir):
        try:
            os.mkdir(transaction_dir, 0o700)
        except OSError:
            fail()
        sync_directory(transaction_parent)
    secure_directory(transaction_dir)
    publish_file("manifest", "manifest", MANIFEST)
    if action == "initialize":
        inspect_inventory()
    elif action == "finish_forward":
        history, partial_phase, _paired_final = inspect_inventory()
        if requested not in ("published", "cleanup_complete"):
            fail()
        minimum = FORWARD.index("publish_intent") + 1
        if (
            "rollback_intent" in history
            or len(history) < minimum
            or tuple(history[:minimum]) != FORWARD[:minimum]
            or (
                requested == "published"
                and partial_phase not in (None, "published", "cleanup_complete")
            )
            or (
                requested == "cleanup_complete"
                and (
                    "published" not in history
                    or partial_phase not in (None, "cleanup_complete")
                )
            )
        ):
            fail()
        publish_file(
            requested,
            PHASE_FILE[requested],
            (requested + "\n").encode("ascii"),
        )
        inspect_inventory()
    else:
        if requested not in PHASE_FILE:
            fail()
        history, partial_phase, paired_final = inspect_inventory(requested)
        if partial_phase is not None and partial_phase != requested:
            expected = (partial_phase + "\n").encode("ascii")
            if paired_final:
                publish_file(partial_phase, PHASE_FILE[partial_phase], expected)
            elif requested == "rollback_intent":
                remove_partial(os.path.join(transaction_dir, ".incoming-" + partial_phase), expected)
            else:
                fail()
            history, partial_phase, paired_final = inspect_inventory(requested)
        if requested in history:
            if history[-1] != requested:
                fail()
            publish_file(requested, PHASE_FILE[requested], (requested + "\n").encode("ascii"))
        elif requested not in next_phases(history):
            fail()
        else:
            publish_file(requested, PHASE_FILE[requested], (requested + "\n").encode("ascii"))
        inspect_inventory()
except SystemExit:
    raise
except Exception:
    fail()
COMIS_RUNTIME_TRANSACTION_MANIFEST
}
runtime_journal_initialize() {
  runtime_journal_manage initialize -
}
runtime_journal_append() {
  runtime_journal_manage append "$1"
}
runtime_journal_finish_forward() {
  runtime_journal_manage finish_forward "$1"
}
`;
}
