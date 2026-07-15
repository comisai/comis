// SPDX-License-Identifier: Apache-2.0
import { basename, dirname, isAbsolute } from "node:path";

import { err, ok, type Result } from "@comis/shared";

import type {
  BinarySshEndpoint,
  ProductionBinarySshBridge,
} from "./production-binary-ssh.js";
import {
  TARGET_REPLAY_QUARANTINE_SHA256,
  type ProductionRemoteExecutor,
  type ProductionRemoteInvocation,
} from "./production-bootstrap.js";
import type { ProductionReplayProfile } from "./production-profile.js";
import {
  compareRuntimePackageArtifacts,
  inspectRuntimeArtifactAttestations,
  type RuntimeArtifactAttestation,
} from "./production-runtime.js";

export interface ProductionRuntimeCloneRequest {
  readonly runId: string;
  readonly profile: ProductionReplayProfile;
  readonly source: RuntimeArtifactAttestation;
  readonly target: RuntimeArtifactAttestation;
}

export interface ProductionRuntimeCloneStreamPlan {
  readonly source: BinarySshEndpoint;
  readonly target: BinarySshEndpoint;
  readonly maximumBytes: number;
}

export interface ProductionRuntimeClonePlan {
  readonly sourcePrepare: ProductionRemoteInvocation;
  readonly targetPrepare: ProductionRemoteInvocation;
  readonly stream: ProductionRuntimeCloneStreamPlan;
  readonly targetPromote: ProductionRemoteInvocation;
  readonly targetBootGuard: ProductionRemoteInvocation;
  readonly targetRollback: ProductionRemoteInvocation;
  readonly targetCommit: ProductionRemoteInvocation;
  readonly sourceCleanup: ProductionRemoteInvocation;
}

export interface ProductionRuntimeCloneError {
  readonly kind: "invalid_request" | "precondition";
  readonly field: string;
  readonly message: string;
}

export interface ExecuteProductionRuntimeCloneRequest {
  readonly runId: string;
  readonly profile: ProductionReplayProfile;
  readonly executor: ProductionRemoteExecutor;
  readonly bridge: ProductionBinarySshBridge;
}

export interface ProductionRuntimeCloneReport {
  readonly changed: boolean;
  readonly bytesTransferred: number;
  readonly digestSha256: string;
}

export type ProductionRuntimeCloneExecutionError =
  | ProductionRuntimeCloneError
  | { readonly kind: "remote_failure"; readonly stage: string; readonly message: string }
  | { readonly kind: "transfer_failure"; readonly stage: string; readonly message: string }
  | { readonly kind: "attestation_failure"; readonly stage: string; readonly message: string }
  | { readonly kind: "rollback_failure"; readonly stage: string; readonly message: string };

const SAFE_RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const STREAM_ENTRY_OVERHEAD_BYTES = 16 * 1024;
const STREAM_FIXED_OVERHEAD_BYTES = 64 * 1024 * 1024;

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function invalid(
  kind: ProductionRuntimeCloneError["kind"],
  field: string,
  message: string,
): Result<never, ProductionRuntimeCloneError> {
  return err({ kind, field, message });
}

function isSafePackageRoot(value: string): boolean {
  if (
    !isAbsolute(value) ||
    basename(value) !== "comisai" ||
    basename(dirname(value)) !== "node_modules" ||
    value.includes("\\") ||
    hasControlCharacters(value)
  ) {
    return false;
  }
  return !value.split("/").some((segment) => segment === "." || segment === "..");
}

function invocation(
  label: string,
  host: ProductionReplayProfile["source"] | ProductionReplayProfile["target"],
  args: readonly string[],
  stdin: string,
): ProductionRemoteInvocation {
  return {
    label,
    host: host.ssh,
    ...(host.sshPort !== undefined ? { port: host.sshPort } : {}),
    args,
    stdin,
  };
}

function endpoint(
  host: ProductionReplayProfile["source"] | ProductionReplayProfile["target"],
  args: readonly string[],
): BinarySshEndpoint {
  return {
    host: host.ssh,
    ...(host.sshPort !== undefined ? { port: host.sshPort } : {}),
    args,
  };
}

function targetBootGuardInvocation(
  runId: string,
  profile: ProductionReplayProfile,
  packageRoot: string,
): ProductionRemoteInvocation {
  return invocation(
    "verify-runtime-replay-gate-target",
    profile.target,
    [
      "sudo",
      "bash",
      "-s",
      "--",
      profile.target.expectedMachineIdSha256,
      packageRoot,
      runId,
      profile.target.service,
    ],
    TARGET_BOOT_GUARD_SCRIPT,
  );
}

const SOURCE_PREPARE_SCRIPT = String.raw`set -euo pipefail
expected_machine="$1"
package_root="$2"
run_id="$3"
actual_machine="$(sha256sum /etc/machine-id | awk '{print $1}')"
if [ "$actual_machine" != "$expected_machine" ]; then exit 71; fi
case "$run_id" in
  [A-Za-z0-9]* ) ;;
  *) exit 72 ;;
esac
case "$run_id" in *[!A-Za-z0-9_-]*) exit 72 ;; esac
case "$package_root" in /*/node_modules/comisai) ;; *) exit 73 ;; esac
if [ "$(readlink -f -- "$package_root")" != "$package_root" ] || [ ! -d "$package_root" ]; then
  exit 74
fi
replay_entrypoint="$package_root/node_modules/@comis/daemon/dist/daemon-entrypoint.js"
if [ -L "$replay_entrypoint" ] || [ ! -f "$replay_entrypoint" ]; then exit 77; fi
if ! command -v zstd >/dev/null 2>&1; then exit 75; fi
stage_root=/run/comis-self-driving
stage_dir="$stage_root/runtime-$run_id"
stage_created=0
cleanup_source_prepare() {
  rc=$?
  trap - EXIT HUP INT TERM
  if [ "$rc" -ne 0 ] && [ "$stage_created" -eq 1 ]; then rm -rf -- "$stage_dir"; fi
  exit "$rc"
}
trap cleanup_source_prepare EXIT HUP INT TERM
if [ "$(findmnt -n -o FSTYPE --target /run)" != tmpfs ] || [ -L "$stage_root" ]; then exit 75; fi
install -d -m 0700 -o root -g root "$stage_root"
if [ -e "$stage_dir" ] || [ -L "$stage_dir" ]; then exit 76; fi
stage_created=1
install -d -m 0700 -o root -g root "$stage_dir"
cat > "$stage_dir/read.sh" <<'READER'
#!/usr/bin/env bash
set -euo pipefail
expected_machine="$1"
package_root="$2"
actual_machine="$(sha256sum /etc/machine-id | awk '{print $1}')"
if [ "$actual_machine" != "$expected_machine" ]; then exit 71; fi
case "$package_root" in /*/node_modules/comisai) ;; *) exit 73 ;; esac
if [ "$(readlink -f -- "$package_root")" != "$package_root" ] || [ ! -d "$package_root" ]; then
  exit 74
fi
replay_entrypoint="$package_root/node_modules/@comis/daemon/dist/daemon-entrypoint.js"
if [ -L "$replay_entrypoint" ] || [ ! -f "$replay_entrypoint" ]; then exit 76; fi
package_parent="$(dirname -- "$package_root")"
package_name="$(basename -- "$package_root")"
if ! command -v zstd >/dev/null 2>&1; then exit 75; fi
control_dir="$(dirname -- "$0")"
printf '%s\n' "$$" > "$control_dir/reader.pid.tmp"
chmod 0600 "$control_dir/reader.pid.tmp"
mv -- "$control_dir/reader.pid.tmp" "$control_dir/reader.pid"
exec tar --create --file=- --format=posix --zstd --acls --xattrs --numeric-owner \
  --atime-preserve=system --sparse --directory="$package_parent" "$package_name"
READER
chmod 0700 "$stage_dir/read.sh"
trap - EXIT HUP INT TERM
`;

const TARGET_GUARD = String.raw`actual_machine="$(sha256sum /etc/machine-id | awk '{print $1}')"
if [ "$actual_machine" != "$expected_machine" ]; then exit 71; fi
if [ "$(cat /etc/comis/environment-role 2>/dev/null || true)" != test ]; then exit 72; fi
case "$service" in *.service) unit="$service" ;; *) unit="$service.service" ;; esac
if systemctl is-active --quiet "$unit"; then exit 73; fi
if systemctl is-enabled --quiet "$unit"; then exit 74; fi
quarantine="/etc/systemd/system/$unit.d/90-comis-replay-quarantine.conf"
if [ ! -f "$quarantine" ] || [ -L "$quarantine" ] || \
   [ "$(stat -c '%u:%g:%a' "$quarantine" 2>/dev/null || true)" != 0:0:644 ] || \
   [ "$(sha256sum "$quarantine" 2>/dev/null | awk '{print $1}')" != ${TARGET_REPLAY_QUARANTINE_SHA256} ] || \
   ! grep -Fqx 'IPAddressDeny=any' "$quarantine" || \
   ! grep -Fqx 'PrivateNetwork=yes' "$quarantine" || \
   ! grep -Fqx 'ProtectSystem=strict' "$quarantine" || \
   ! grep -Fqx 'NoNewPrivileges=yes' "$quarantine" || \
   ! grep -Fqx 'SocketBindDeny=any' "$quarantine"; then exit 75; fi
case "$run_id" in
  [A-Za-z0-9]* ) ;;
  *) exit 76 ;;
esac
case "$run_id" in *[!A-Za-z0-9_-]*) exit 76 ;; esac
case "$package_root" in /*/node_modules/comisai) ;; *) exit 77 ;; esac
if [ "$(readlink -f -- "$package_root")" != "$package_root" ] || [ ! -d "$package_root" ]; then
  exit 78
fi
package_parent="$(dirname -- "$package_root")"
stage_parent="$package_parent/.comis-runtime-$run_id"
control_dir="/var/lib/comis-self-driving/runtime-$run_id"
rollback_root="$package_parent/.comisai.rollback-$run_id"
`;

const TARGET_PREPARE_SCRIPT = String.raw`set -euo pipefail
expected_machine="$1"
package_root="$2"
run_id="$3"
service="$4"
service_user="$5"
source_bytes="$6"
${TARGET_GUARD}
if ! id "$service_user" >/dev/null 2>&1; then exit 79; fi
if ! command -v zstd >/dev/null 2>&1; then exit 79; fi
if [ -e "$stage_parent" ] || [ -L "$stage_parent" ] || \
   [ -e "$control_dir" ] || [ -L "$control_dir" ] || \
   [ -e "$rollback_root" ] || [ -L "$rollback_root" ]; then exit 80; fi
prepare_started=0
cleanup_target_prepare() {
  rc=$?
  trap - EXIT HUP INT TERM
  if [ "$rc" -ne 0 ] && [ "$prepare_started" -eq 1 ]; then
    rm -rf -- "$stage_parent" "$control_dir"
  fi
  exit "$rc"
}
trap cleanup_target_prepare EXIT HUP INT TERM
available_bytes="$(df -PB1 "$package_parent" | awk 'NR == 2 {print $4}')"
required_bytes=$(( source_bytes + 536870912 ))
if [ "$available_bytes" -lt "$required_bytes" ]; then exit 81; fi
install -d -m 0700 -o root -g root /var/lib/comis-self-driving
prepare_started=1
install -d -m 0700 -o root -g root "$control_dir" "$stage_parent"
cat > "$control_dir/receive.sh" <<'RECEIVER'
#!/usr/bin/env bash
set -euo pipefail
expected_machine="$1"
package_root="$2"
run_id="$3"
service="$4"
actual_machine="$(sha256sum /etc/machine-id | awk '{print $1}')"
if [ "$actual_machine" != "$expected_machine" ]; then exit 71; fi
if [ "$(cat /etc/comis/environment-role 2>/dev/null || true)" != test ]; then exit 72; fi
case "$service" in *.service) unit="$service" ;; *) unit="$service.service" ;; esac
if systemctl is-active --quiet "$unit" || systemctl is-enabled --quiet "$unit"; then exit 73; fi
quarantine="/etc/systemd/system/$unit.d/90-comis-replay-quarantine.conf"
 if [ ! -f "$quarantine" ] || [ -L "$quarantine" ] || \
   [ "$(stat -c '%u:%g:%a' "$quarantine" 2>/dev/null || true)" != 0:0:644 ] || \
   [ "$(sha256sum "$quarantine" 2>/dev/null | awk '{print $1}')" != ${TARGET_REPLAY_QUARANTINE_SHA256} ] || \
   ! grep -Fqx 'IPAddressDeny=any' "$quarantine" || \
   ! grep -Fqx 'PrivateNetwork=yes' "$quarantine" || \
   ! grep -Fqx 'ProtectSystem=strict' "$quarantine" || \
   ! grep -Fqx 'NoNewPrivileges=yes' "$quarantine" || \
   ! grep -Fqx 'SocketBindDeny=any' "$quarantine"; then exit 74; fi
case "$run_id" in [A-Za-z0-9]*) ;; *) exit 75 ;; esac
case "$run_id" in *[!A-Za-z0-9_-]*) exit 75 ;; esac
case "$package_root" in /*/node_modules/comisai) ;; *) exit 76 ;; esac
package_parent="$(dirname -- "$package_root")"
stage_parent="$package_parent/.comis-runtime-$run_id"
if [ -L "$stage_parent" ] || [ "$(stat -c '%u:%a' "$stage_parent")" != 0:700 ]; then exit 77; fi
if [ -n "$(find "$stage_parent" -mindepth 1 -print -quit)" ]; then exit 78; fi
if ! command -v zstd >/dev/null 2>&1; then exit 79; fi
control_dir="$(dirname -- "$0")"
printf '%s\n' "$$" > "$control_dir/receiver.pid.tmp"
chmod 0600 "$control_dir/receiver.pid.tmp"
mv -- "$control_dir/receiver.pid.tmp" "$control_dir/receiver.pid"
exec tar --extract --file=- --zstd --acls --xattrs --no-same-owner --same-permissions \
  --delay-directory-restore --directory="$stage_parent"
RECEIVER
chmod 0700 "$control_dir/receive.sh"
trap - EXIT HUP INT TERM
`;

const TARGET_PROMOTE_SCRIPT = String.raw`set -euo pipefail
expected_machine="$1"
package_root="$2"
run_id="$3"
service="$4"
service_user="$5"
${TARGET_GUARD}
staged_root="$stage_parent/comisai"
if [ ! -d "$staged_root" ] || [ -L "$staged_root" ] || \
   [ ! -f "$staged_root/package.json" ]; then exit 82; fi
if find -P "$staged_root" ! -type f ! -type d ! -type l -print -quit | grep -q .; then exit 83; fi
chown -hR "$service_user:$service_user" "$staged_root"
promoted=0
rollback_promote() {
  rc=$?
  trap - EXIT HUP INT TERM
  if [ "$promoted" -eq 1 ]; then
    rm -rf -- "$package_root"
    mv -- "$rollback_root" "$package_root"
  fi
  exit "$rc"
}
trap rollback_promote EXIT HUP INT TERM
mv -- "$package_root" "$rollback_root"
promoted=1
mv -- "$staged_root" "$package_root"
promoted=2
trap - EXIT HUP INT TERM
`;

const TARGET_BOOT_GUARD_SCRIPT = String.raw`set -euo pipefail
expected_machine="$1"
package_root="$2"
run_id="$3"
service="$4"
${TARGET_GUARD}
role_marker=/etc/comis/environment-role
if [ -L "$role_marker" ] || [ ! -f "$role_marker" ] || \
   [ "$(stat -c '%u:%g:%a:%s' "$role_marker" 2>/dev/null || true)" != 0:0:644:5 ] || \
   [ "$(cat "$role_marker" 2>/dev/null || true)" != test ]; then exit 85; fi
entrypoint="$package_root/node_modules/@comis/daemon/dist/daemon-entrypoint.js"
if [ -L "$entrypoint" ] || [ ! -f "$entrypoint" ]; then exit 86; fi
unit_exec="$(systemctl show "$unit" --property=ExecStart --value 2>/dev/null || true)"
case "$unit_exec" in *"$entrypoint"*) ;; *) exit 87 ;; esac
if [ "$(stat -c '%u:%g:%a' "$quarantine" 2>/dev/null || true)" != 0:0:644 ] || \
   ! grep -Fqx 'Environment=COMIS_REPLAY_TARGET=1' "$quarantine" || \
   ! grep -Fqx 'RestrictAddressFamilies=AF_UNIX' "$quarantine" || \
   ! grep -Fqx 'IPAddressDeny=any' "$quarantine" || \
   ! grep -Fqx 'PrivateNetwork=yes' "$quarantine" || \
   ! grep -Fqx 'PrivateDevices=yes' "$quarantine" || \
   ! grep -Fqx 'PrivateMounts=yes' "$quarantine" || \
   ! grep -Fqx 'ProtectSystem=strict' "$quarantine" || \
   ! grep -Fqx 'ProtectHome=read-only' "$quarantine" || \
   ! grep -Fqx 'NoNewPrivileges=yes' "$quarantine" || \
   ! grep -Fqx 'SocketBindDeny=any' "$quarantine" || \
   ! grep -Fqx 'ReadWritePaths=/run/comis-replay' "$quarantine"; then exit 88; fi
`;

const CANCEL_RUN_PROCESS = String.raw`cancel_run_process() {
  pid_file="$1"
  expected_marker="$2"
  if [ ! -f "$pid_file" ] || [ -L "$pid_file" ]; then return; fi
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  case "$pid" in ''|*[!0-9]*) return ;; esac
  if ! kill -0 "$pid" 2>/dev/null; then return; fi
  pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')"
  case "$pgid" in ''|*[!0-9]*) return ;; esac
  leader_args="$(ps -o args= -p "$pgid" 2>/dev/null || true)"
  case "$leader_args" in *"$expected_marker"*) ;; *) return ;; esac
  kill -TERM -- "-$pgid" 2>/dev/null || true
  for _attempt in 1 2 3 4 5 6 7 8 9 10; do
    if ! kill -0 "$pid" 2>/dev/null; then return; fi
    sleep 0.1
  done
  kill -KILL -- "-$pgid" 2>/dev/null || true
}`;

const TARGET_ROLLBACK_SCRIPT = String.raw`set -euo pipefail
expected_machine="$1"
package_root="$2"
run_id="$3"
service="$4"
${TARGET_GUARD}
${CANCEL_RUN_PROCESS}
cancel_run_process "$control_dir/receiver.pid" "$control_dir/receive.sh"
if [ -e "$rollback_root" ] && [ ! -L "$rollback_root" ]; then
  rm -rf -- "$package_root"
  mv -- "$rollback_root" "$package_root"
fi
rm -rf -- "$stage_parent" "/var/lib/comis-self-driving/runtime-$run_id"
`;

const TARGET_COMMIT_SCRIPT = String.raw`set -euo pipefail
expected_machine="$1"
package_root="$2"
run_id="$3"
service="$4"
${TARGET_GUARD}
if [ ! -d "$package_root" ] || [ ! -d "$rollback_root" ]; then exit 84; fi
rm -rf -- "$rollback_root" "$stage_parent" "/var/lib/comis-self-driving/runtime-$run_id"
`;

const SOURCE_CLEANUP_SCRIPT = String.raw`set -euo pipefail
expected_machine="$1"
run_id="$2"
actual_machine="$(sha256sum /etc/machine-id | awk '{print $1}')"
if [ "$actual_machine" != "$expected_machine" ]; then exit 71; fi
case "$run_id" in [A-Za-z0-9]*) ;; *) exit 72 ;; esac
case "$run_id" in *[!A-Za-z0-9_-]*) exit 72 ;; esac
stage_dir="/run/comis-self-driving/runtime-$run_id"
${CANCEL_RUN_PROCESS}
cancel_run_process "$stage_dir/reader.pid" "$stage_dir/read.sh"
rm -rf -- "/run/comis-self-driving/runtime-$run_id"
`;

function calculateMaximumStreamBytes(
  source: RuntimeArtifactAttestation,
): Result<number, ProductionRuntimeCloneError> {
  const maximum =
    source.bytes + source.entryCount * STREAM_ENTRY_OVERHEAD_BYTES + STREAM_FIXED_OVERHEAD_BYTES;
  if (!Number.isSafeInteger(maximum) || maximum <= source.bytes) {
    return invalid("invalid_request", "source", "Runtime stream size bound is unsafe");
  }
  return ok(maximum);
}

export function buildProductionRuntimeClonePlan(
  request: ProductionRuntimeCloneRequest,
): Result<ProductionRuntimeClonePlan, ProductionRuntimeCloneError> {
  if (!SAFE_RUN_ID_RE.test(request.runId)) {
    return invalid("invalid_request", "runId", "Runtime clone run ID contains unsafe characters");
  }
  if (!isSafePackageRoot(request.source.packageRoot)) {
    return invalid("invalid_request", "source.packageRoot", "Source package root is unsafe");
  }
  if (!isSafePackageRoot(request.target.packageRoot)) {
    return invalid("invalid_request", "target.packageRoot", "Target package root is unsafe");
  }
  if (request.source.version !== request.target.version) {
    return invalid(
      "precondition",
      "version",
      "Source and target package versions must match before exact cloning",
    );
  }
  if (compareRuntimePackageArtifacts(request.source, request.target).ok) {
    return invalid("precondition", "runtime", "Runtime artifacts already match");
  }
  const maximumBytes = calculateMaximumStreamBytes(request.source);
  if (!maximumBytes.ok) return maximumBytes;

  const sourceControlDir = `/run/comis-self-driving/runtime-${request.runId}`;
  const targetControlDir = `/var/lib/comis-self-driving/runtime-${request.runId}`;
  const sourceBaseArgs = [
    request.profile.source.expectedMachineIdSha256,
    request.source.packageRoot,
    request.runId,
  ] as const;
  const targetBaseArgs = [
    request.profile.target.expectedMachineIdSha256,
    request.target.packageRoot,
    request.runId,
    request.profile.target.service,
  ] as const;

  return ok({
    sourcePrepare: invocation(
      "prepare-runtime-source",
      request.profile.source,
      ["sudo", "bash", "-s", "--", ...sourceBaseArgs],
      SOURCE_PREPARE_SCRIPT,
    ),
    targetPrepare: invocation(
      "prepare-runtime-target",
      request.profile.target,
      [
        "sudo",
        "bash",
        "-s",
        "--",
        ...targetBaseArgs,
        request.profile.target.comisUser,
        String(request.source.bytes),
      ],
      TARGET_PREPARE_SCRIPT,
    ),
    stream: {
      maximumBytes: maximumBytes.value,
      source: endpoint(request.profile.source, [
        "sudo",
        "bash",
        `${sourceControlDir}/read.sh`,
        request.profile.source.expectedMachineIdSha256,
        request.source.packageRoot,
      ]),
      target: endpoint(request.profile.target, [
        "sudo",
        "bash",
        `${targetControlDir}/receive.sh`,
        ...targetBaseArgs,
      ]),
    },
    targetPromote: invocation(
      "promote-runtime-target",
      request.profile.target,
      ["sudo", "bash", "-s", "--", ...targetBaseArgs, request.profile.target.comisUser],
      TARGET_PROMOTE_SCRIPT,
    ),
    targetBootGuard: targetBootGuardInvocation(
      request.runId,
      request.profile,
      request.target.packageRoot,
    ),
    targetRollback: invocation(
      "rollback-runtime-target",
      request.profile.target,
      ["sudo", "bash", "-s", "--", ...targetBaseArgs],
      TARGET_ROLLBACK_SCRIPT,
    ),
    targetCommit: invocation(
      "commit-runtime-target",
      request.profile.target,
      ["sudo", "bash", "-s", "--", ...targetBaseArgs],
      TARGET_COMMIT_SCRIPT,
    ),
    sourceCleanup: invocation(
      "cleanup-runtime-source",
      request.profile.source,
      [
        "sudo",
        "bash",
        "-s",
        "--",
        request.profile.source.expectedMachineIdSha256,
        request.runId,
      ],
      SOURCE_CLEANUP_SCRIPT,
    ),
  });
}

async function runRemoteStage(
  executor: ProductionRemoteExecutor,
  command: ProductionRemoteInvocation,
): Promise<Result<void, ProductionRuntimeCloneExecutionError>> {
  const result = await executor.run(command);
  if (!result.ok || result.value.exitCode !== 0) {
    return err({
      kind: "remote_failure",
      stage: command.label,
      message: `Runtime clone stage ${command.label} failed`,
    });
  }
  return ok(undefined);
}

async function rollbackRuntimeClone(
  executor: ProductionRemoteExecutor,
  plan: ProductionRuntimeClonePlan,
  options: { readonly target: boolean; readonly source: boolean },
): Promise<Result<void, ProductionRuntimeCloneExecutionError>> {
  const operations: Array<Promise<Result<void, ProductionRuntimeCloneExecutionError>>> = [];
  if (options.target) operations.push(runRemoteStage(executor, plan.targetRollback));
  if (options.source) operations.push(runRemoteStage(executor, plan.sourceCleanup));
  const results = await Promise.all(operations);
  if (results.some((result) => !result.ok)) {
    return err({
      kind: "rollback_failure",
      stage: "rollback-runtime-clone",
      message: "Runtime clone transaction could not be fully rolled back",
    });
  }
  return ok(undefined);
}

async function failAfterRollback(
  executor: ProductionRemoteExecutor,
  plan: ProductionRuntimeClonePlan,
  options: { readonly target: boolean; readonly source: boolean },
  failure: ProductionRuntimeCloneExecutionError,
): Promise<Result<never, ProductionRuntimeCloneExecutionError>> {
  const rollback = await rollbackRuntimeClone(executor, plan, options);
  if (!rollback.ok) return rollback;
  return err(failure);
}

export async function cloneProductionRuntime(
  request: ExecuteProductionRuntimeCloneRequest,
): Promise<Result<ProductionRuntimeCloneReport, ProductionRuntimeCloneExecutionError>> {
  const before = await inspectRuntimeArtifactAttestations(request.profile, request.executor);
  if (!before.ok) {
    return err({
      kind: "attestation_failure",
      stage: "attest-runtime-before-clone",
      message: "Runtime artifacts could not be attested before cloning",
    });
  }
  if (compareRuntimePackageArtifacts(before.value.source, before.value.target).ok) {
    const bootGuard = await runRemoteStage(
      request.executor,
      targetBootGuardInvocation(
        request.runId,
        request.profile,
        before.value.target.packageRoot,
      ),
    );
    if (!bootGuard.ok) return bootGuard;
    return ok({
      changed: false,
      bytesTransferred: 0,
      digestSha256: before.value.source.digestSha256,
    });
  }

  const plan = buildProductionRuntimeClonePlan({
    runId: request.runId,
    profile: request.profile,
    source: before.value.source,
    target: before.value.target,
  });
  if (!plan.ok) return plan;

  const sourcePrepare = await runRemoteStage(request.executor, plan.value.sourcePrepare);
  if (!sourcePrepare.ok) return sourcePrepare;
  const targetPrepare = await runRemoteStage(request.executor, plan.value.targetPrepare);
  if (!targetPrepare.ok) {
    return failAfterRollback(
      request.executor,
      plan.value,
      { target: true, source: true },
      targetPrepare.error,
    );
  }

  const transfer = await request.bridge.transfer({
    label: "stream-runtime-clone",
    maximumBytes: plan.value.stream.maximumBytes,
    source: plan.value.stream.source,
    target: plan.value.stream.target,
  });
  if (!transfer.ok) {
    return failAfterRollback(
      request.executor,
      plan.value,
      { target: true, source: true },
      {
        kind: "transfer_failure",
        stage: "stream-runtime-clone",
        message: "Runtime clone stream failed",
      },
    );
  }

  const promote = await runRemoteStage(request.executor, plan.value.targetPromote);
  if (!promote.ok) {
    return failAfterRollback(
      request.executor,
      plan.value,
      { target: true, source: true },
      promote.error,
    );
  }

  const bootGuard = await runRemoteStage(request.executor, plan.value.targetBootGuard);
  if (!bootGuard.ok) {
    return failAfterRollback(
      request.executor,
      plan.value,
      { target: true, source: true },
      bootGuard.error,
    );
  }

  const after = await inspectRuntimeArtifactAttestations(request.profile, request.executor);
  if (!after.ok) {
    return failAfterRollback(
      request.executor,
      plan.value,
      { target: true, source: true },
      {
        kind: "attestation_failure",
        stage: "attest-runtime-after-clone",
        message: "Runtime artifacts could not be attested after cloning",
      },
    );
  }
  const sourceStable = compareRuntimePackageArtifacts(before.value.source, after.value.source);
  const targetExact = compareRuntimePackageArtifacts(after.value.source, after.value.target);
  if (!sourceStable.ok || !targetExact.ok) {
    return failAfterRollback(
      request.executor,
      plan.value,
      { target: true, source: true },
      {
        kind: "attestation_failure",
        stage: "verify-runtime-clone",
        message: "Runtime clone did not reproduce the stable production artifact",
      },
    );
  }

  const sourceCleanup = await runRemoteStage(request.executor, plan.value.sourceCleanup);
  if (!sourceCleanup.ok) {
    const retryCleanup = await runRemoteStage(request.executor, plan.value.sourceCleanup);
    if (!retryCleanup.ok) {
      return failAfterRollback(
        request.executor,
        plan.value,
        { target: true, source: false },
        sourceCleanup.error,
      );
    }
  }
  const commit = await runRemoteStage(request.executor, plan.value.targetCommit);
  if (!commit.ok) {
    return failAfterRollback(
      request.executor,
      plan.value,
      { target: true, source: false },
      commit.error,
    );
  }

  return ok({
    changed: true,
    bytesTransferred: transfer.value.bytesTransferred,
    digestSha256: after.value.source.digestSha256,
  });
}
