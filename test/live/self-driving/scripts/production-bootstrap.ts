// SPDX-License-Identifier: Apache-2.0
import { err, ok, type Result } from "@comis/shared";

import {
  attestSourceReadOnly,
  attestTargetMutation,
  buildHostProbeScript,
  buildInstallerRemoteArgs,
  parseHostFacts,
  type ProductionHostFacts,
} from "./production-host.js";
import type { ProductionHostProfile, ProductionReplayProfile } from "./production-profile.js";

export interface ProductionRemoteInvocation {
  readonly label: string;
  readonly host: string;
  readonly port?: number;
  readonly args: readonly string[];
  readonly stdin: string;
  readonly stdoutLimitBytes?: number;
  readonly timeoutMs?: number;
}

export interface ProductionRemoteResult {
  readonly stdout: string;
  readonly exitCode: number;
}

export interface ProductionRemoteError {
  readonly kind: "remote";
  readonly message: string;
}

export interface ProductionRemoteExecutor {
  readonly run: (
    invocation: ProductionRemoteInvocation,
  ) => Promise<Result<ProductionRemoteResult, ProductionRemoteError>>;
}

export interface ProductionBootstrapReport {
  readonly installed: boolean;
  readonly version: string;
  readonly targetMachineIdSha256: string;
  readonly serviceState: "inactive";
}

export interface ProductionHostDoctorSummary {
  readonly machineIdSha256: string;
  readonly environmentRole: "production" | "test" | "unmarked";
  readonly os: string;
  readonly arch: string;
  readonly comisInstalled: boolean;
  readonly comisVersion?: string;
  readonly serviceState: ProductionHostFacts["serviceState"];
  readonly serviceEnabled: boolean;
  readonly dataExists: boolean;
  readonly dataBytes: number;
  readonly diskFreeBytes: number;
}

export interface ProductionDoctorReport {
  readonly source: ProductionHostDoctorSummary;
  readonly target: ProductionHostDoctorSummary;
  readonly targetMutationPurpose: "bootstrap" | "restore";
}

export type ProductionBootstrapError =
  | { readonly kind: "remote_failure"; readonly stage: string; readonly message: string }
  | { readonly kind: "rollback_failure"; readonly stage: string; readonly message: string }
  | { readonly kind: "host_attestation"; readonly stage: string; readonly message: string }
  | { readonly kind: "source_not_ready"; readonly message: string }
  | { readonly kind: "target_not_ready"; readonly message: string };

const MIN_TARGET_HEADROOM_BYTES = 5 * 1024 * 1024 * 1024;

async function runChecked(
  executor: ProductionRemoteExecutor,
  invocation: ProductionRemoteInvocation,
): Promise<Result<ProductionRemoteResult, ProductionBootstrapError>> {
  const result = await executor.run(invocation);
  if (!result.ok || result.value.exitCode !== 0) {
    return err({
      kind: "remote_failure",
      stage: invocation.label,
      message: `Remote stage ${invocation.label} failed`,
    });
  }
  return ok(result.value);
}

async function probeHost(
  executor: ProductionRemoteExecutor,
  host: ProductionHostProfile,
  label: "probe-source" | "probe-target" | "probe-target-post",
): Promise<Result<ProductionHostFacts, ProductionBootstrapError>> {
  const command = await runChecked(executor, {
    label,
    host: host.ssh,
    ...(host.sshPort !== undefined ? { port: host.sshPort } : {}),
    args: ["bash", "-s", "--", host.service, host.dataDir, host.comisUser],
    stdin: buildHostProbeScript(),
  });
  if (!command.ok) return command;
  const parsed = parseHostFacts(command.value.stdout);
  if (!parsed.ok) {
    return err({
      kind: "host_attestation",
      stage: label,
      message: `Host facts failed validation during ${label}`,
    });
  }
  return ok(parsed.value);
}

export function buildTargetRoleMarkerScript(): string {
  return String.raw`set -eu
expected_machine="$1"
actual_machine="$(sha256sum /etc/machine-id | awk '{print $1}')"
if [ "$actual_machine" != "$expected_machine" ]; then
  printf '%s\n' 'target machine identity mismatch' >&2
  exit 71
fi
existing_role="$(cat /etc/comis/environment-role 2>/dev/null || true)"
case "$existing_role" in
  ""|test) ;;
  *) printf '%s\n' 'target role is not test' >&2; exit 72 ;;
esac
if [ -L /etc/comis ]; then
  printf '%s\n' 'target config directory must not be a symlink' >&2
  exit 73
fi
state_root=/var/lib/comis-self-driving
journal="$state_root/bootstrap-current"
install -d -o root -g root -m 0700 "$state_root"
if [ -e "$journal" ]; then
  printf '%s\n' 'an unfinished target bootstrap transaction exists' >&2
  exit 74
fi
install -d -o root -g root -m 0700 "$journal"
if [ -d /etc/comis ]; then printf '%s\n' true > "$journal/etc-comis-existed"; else printf '%s\n' false > "$journal/etc-comis-existed"; fi
install -d -o root -g root -m 0755 /etc/comis
marker=/etc/comis/environment-role
if [ -L "$marker" ]; then
  rm -rf "$journal"
  printf '%s\n' 'target role marker must not be a symlink' >&2
  exit 75
fi
if [ -f "$marker" ]; then
  printf '%s\n' true > "$journal/marker-existed"
  cp --archive --no-dereference "$marker" "$journal/environment-role.before"
else
  printf '%s\n' false > "$journal/marker-existed"
fi
printf '%s\n' test > "$journal/environment-role.new"
install -o root -g root -m 0644 "$journal/environment-role.new" "$marker"
`;
}

export function buildTargetQuarantineScript(): string {
  return String.raw`set -eu
expected_machine="$1"
service="$2"
actual_machine="$(sha256sum /etc/machine-id | awk '{print $1}')"
if [ "$actual_machine" != "$expected_machine" ]; then
  printf '%s\n' 'target machine identity mismatch' >&2
  exit 71
fi
if [ "$(cat /etc/comis/environment-role 2>/dev/null || true)" != test ]; then
  printf '%s\n' 'target role marker is missing' >&2
  exit 72
fi
case "$service" in
  *.service) unit="$service" ;;
  *) unit="$service.service" ;;
esac
journal=/var/lib/comis-self-driving/bootstrap-current
if [ ! -d "$journal" ]; then
  printf '%s\n' 'target bootstrap transaction is missing' >&2
  exit 74
fi
load_state="$(systemctl show "$unit" --property=LoadState --value 2>/dev/null || true)"
if [ -n "$load_state" ] && [ "$load_state" != not-found ]; then
  printf '%s\n' true > "$journal/unit-existed"
else
  printf '%s\n' false > "$journal/unit-existed"
fi
if systemctl is-enabled --quiet "$unit" 2>/dev/null; then printf '%s\n' true > "$journal/unit-enabled"; else printf '%s\n' false > "$journal/unit-enabled"; fi
if systemctl is-active --quiet "$unit" 2>/dev/null; then printf '%s\n' true > "$journal/unit-active"; else printf '%s\n' false > "$journal/unit-active"; fi
systemctl disable --now "$unit" 2>/dev/null || true
dropin_dir="/etc/systemd/system/$unit.d"
dropin="$dropin_dir/90-comis-replay-quarantine.conf"
if [ -L "$dropin" ]; then
  printf '%s\n' 'target quarantine drop-in must not be a symlink' >&2
  exit 75
fi
if [ -f "$dropin" ]; then
  printf '%s\n' true > "$journal/dropin-existed"
  cp --archive --no-dereference "$dropin" "$journal/quarantine.before"
else
  printf '%s\n' false > "$journal/dropin-existed"
fi
install -d -m 0755 "$dropin_dir"
umask 022
cat > "$journal/quarantine.new" <<'EOF'
[Service]
Environment=COMIS_REPLAY_TARGET=1
Environment=COMIS_REPLAY_RUNTIME_DIR=/run/comis-replay
RuntimeDirectory=comis-replay
RuntimeDirectoryMode=0700
RestrictAddressFamilies=AF_UNIX
IPAddressDeny=any
EOF
install -o root -g root -m 0644 "$journal/quarantine.new" "$dropin"
systemctl daemon-reload
systemctl disable --now "$unit" 2>/dev/null || true
if systemctl is-active --quiet "$unit"; then
  printf '%s\n' 'target service is still active' >&2
  exit 73
fi
`;
}

export function buildTargetRollbackScript(): string {
  return String.raw`set -eu
expected_machine="$1"
service="$2"
actual_machine="$(sha256sum /etc/machine-id | awk '{print $1}')"
if [ "$actual_machine" != "$expected_machine" ]; then exit 71; fi
case "$service" in *.service) unit="$service" ;; *) unit="$service.service" ;; esac
journal=/var/lib/comis-self-driving/bootstrap-current
if [ ! -d "$journal" ]; then exit 0; fi
systemctl disable --now "$unit" 2>/dev/null || true
dropin_dir="/etc/systemd/system/$unit.d"
dropin="$dropin_dir/90-comis-replay-quarantine.conf"
if [ "$(cat "$journal/dropin-existed" 2>/dev/null || true)" = true ]; then
  install -d -o root -g root -m 0755 "$dropin_dir"
  cp --archive --no-dereference "$journal/quarantine.before" "$dropin"
else
  rm -f "$dropin"
  rmdir "$dropin_dir" 2>/dev/null || true
fi
marker=/etc/comis/environment-role
if [ "$(cat "$journal/marker-existed" 2>/dev/null || true)" = true ]; then
  install -d -o root -g root -m 0755 /etc/comis
  cp --archive --no-dereference "$journal/environment-role.before" "$marker"
else
  rm -f "$marker"
fi
if [ "$(cat "$journal/etc-comis-existed" 2>/dev/null || true)" = false ]; then rmdir /etc/comis 2>/dev/null || true; fi
systemctl daemon-reload
if [ "$(cat "$journal/unit-enabled" 2>/dev/null || true)" = true ]; then systemctl enable "$unit" >/dev/null; fi
if [ "$(cat "$journal/unit-active" 2>/dev/null || true)" = true ]; then systemctl start "$unit"; fi
rm -rf "$journal"
`;
}

export function buildTargetCommitScript(): string {
  return String.raw`set -eu
expected_machine="$1"
service="$2"
actual_machine="$(sha256sum /etc/machine-id | awk '{print $1}')"
if [ "$actual_machine" != "$expected_machine" ]; then exit 71; fi
if [ "$(cat /etc/comis/environment-role 2>/dev/null || true)" != test ]; then exit 72; fi
case "$service" in *.service) unit="$service" ;; *) unit="$service.service" ;; esac
if systemctl is-active --quiet "$unit"; then exit 73; fi
if systemctl is-enabled --quiet "$unit"; then exit 74; fi
test -f "/etc/systemd/system/$unit.d/90-comis-replay-quarantine.conf"
rm -rf /var/lib/comis-self-driving/bootstrap-current
`;
}

function guardedInstallerInput(installer: string): string {
  const guard = String.raw`expected_machine="$1"
shift
actual_machine="$(sha256sum /etc/machine-id | awk '{print $1}')"
if [ "$actual_machine" != "$expected_machine" ]; then
  printf '%s\n' 'target machine identity mismatch' >&2
  exit 71
fi
if [ "$(cat /etc/comis/environment-role 2>/dev/null || true)" != test ]; then
  printf '%s\n' 'target role marker is missing' >&2
  exit 72
fi
`;
  return `${guard}\n${installer}`;
}

async function rollbackTargetBootstrap(
  profile: ProductionReplayProfile,
  installer: string,
  executor: ProductionRemoteExecutor,
  installationAttempted: boolean,
): Promise<Result<void, ProductionBootstrapError>> {
  let uninstallFailed = false;
  if (installationAttempted) {
    const uninstall = await runChecked(executor, {
      label: "rollback-target-install",
      host: profile.target.ssh,
      ...(profile.target.sshPort !== undefined ? { port: profile.target.sshPort } : {}),
      args: [
        "sudo",
        "bash",
        "-s",
        "--",
        profile.target.expectedMachineIdSha256,
        "--uninstall",
        "--remove-user",
        "--yes",
        "--no-prompt",
      ],
      stdin: guardedInstallerInput(installer),
    });
    uninstallFailed = !uninstall.ok;
  }
  const rollback = await runChecked(executor, {
    label: "rollback-target-bootstrap",
    host: profile.target.ssh,
    ...(profile.target.sshPort !== undefined ? { port: profile.target.sshPort } : {}),
    args: [
      "sudo",
      "bash",
      "-s",
      "--",
      profile.target.expectedMachineIdSha256,
      profile.target.service,
    ],
    stdin: buildTargetRollbackScript(),
  });
  if (uninstallFailed || !rollback.ok) {
    return err({
      kind: "rollback_failure",
      stage: "rollback-target-bootstrap",
      message: "Target bootstrap failed and could not be fully rolled back",
    });
  }
  return ok(undefined);
}

function mapAttestation(
  stage: string,
  result: Result<void, { readonly message: string }>,
): Result<void, ProductionBootstrapError> {
  if (result.ok) return ok(undefined);
  return err({ kind: "host_attestation", stage, message: result.error.message });
}

interface InspectedHostFacts {
  readonly source: ProductionHostFacts;
  readonly target: ProductionHostFacts;
  readonly targetMutationPurpose: "bootstrap" | "restore";
}

async function inspectHostFacts(
  profile: ProductionReplayProfile,
  executor: ProductionRemoteExecutor,
): Promise<Result<InspectedHostFacts, ProductionBootstrapError>> {
  const source = await probeHost(executor, profile.source, "probe-source");
  if (!source.ok) return source;
  const sourceAttestation = mapAttestation(
    "probe-source",
    attestSourceReadOnly(profile, source.value),
  );
  if (!sourceAttestation.ok) return sourceAttestation;

  const target = await probeHost(executor, profile.target, "probe-target");
  if (!target.ok) return target;
  const targetMutationPurpose = target.value.environmentRole === "test" ? "restore" : "bootstrap";
  const targetAttestation = mapAttestation(
    "probe-target",
    attestTargetMutation(profile, target.value, targetMutationPurpose),
  );
  if (!targetAttestation.ok) return targetAttestation;
  return ok({ source: source.value, target: target.value, targetMutationPurpose });
}

function doctorSummary(
  facts: ProductionHostFacts,
  environmentRole: ProductionHostDoctorSummary["environmentRole"],
): ProductionHostDoctorSummary {
  return {
    machineIdSha256: facts.machineIdSha256,
    environmentRole,
    os: `${facts.osId} ${facts.osVersion}`,
    arch: facts.arch,
    comisInstalled: facts.comisInstalled,
    ...(facts.comisVersion !== undefined ? { comisVersion: facts.comisVersion } : {}),
    serviceState: facts.serviceState,
    serviceEnabled: facts.serviceEnabled,
    dataExists: facts.dataExists,
    dataBytes: facts.dataBytes,
    diskFreeBytes: facts.diskFreeBytes,
  };
}

export async function inspectProductionReplayHosts(
  profile: ProductionReplayProfile,
  executor: ProductionRemoteExecutor,
): Promise<Result<ProductionDoctorReport, ProductionBootstrapError>> {
  const inspected = await inspectHostFacts(profile, executor);
  if (!inspected.ok) return inspected;
  return ok({
    source: doctorSummary(inspected.value.source, "production"),
    target: doctorSummary(
      inspected.value.target,
      inspected.value.target.environmentRole === "test" ? "test" : "unmarked",
    ),
    targetMutationPurpose: inspected.value.targetMutationPurpose,
  });
}

export async function prepareProductionReplayTarget(
  profile: ProductionReplayProfile,
  installer: string,
  executor: ProductionRemoteExecutor,
): Promise<Result<ProductionBootstrapReport, ProductionBootstrapError>> {
  const inspected = await inspectHostFacts(profile, executor);
  if (!inspected.ok) return inspected;
  const sourceFacts = inspected.value.source;
  const targetFacts = inspected.value.target;
  const version = sourceFacts.comisVersion;
  if (version === undefined) {
    return err({ kind: "source_not_ready", message: "Source Comis version is unavailable" });
  }

  if (
    targetFacts.diskFreeBytes <
    sourceFacts.dataBytes * 2 + MIN_TARGET_HEADROOM_BYTES
  ) {
    return err({
      kind: "target_not_ready",
      message: "Target has insufficient disk headroom for installation and an atomic restore",
    });
  }
  if (
    targetFacts.comisInstalled &&
    targetFacts.comisVersion !== sourceFacts.comisVersion
  ) {
    return err({
      kind: "target_not_ready",
      message: "Installed target version does not match the production source",
    });
  }

  const targetMachineId = profile.target.expectedMachineIdSha256;
  const markRole = await runChecked(executor, {
    label: "mark-target-role",
    host: profile.target.ssh,
    ...(profile.target.sshPort !== undefined ? { port: profile.target.sshPort } : {}),
    args: ["sudo", "bash", "-s", "--", targetMachineId],
    stdin: buildTargetRoleMarkerScript(),
  });
  if (!markRole.ok) return markRole;

  const quarantine = await runChecked(executor, {
    label: "quarantine-target",
    host: profile.target.ssh,
    ...(profile.target.sshPort !== undefined ? { port: profile.target.sshPort } : {}),
    args: ["sudo", "bash", "-s", "--", targetMachineId, profile.target.service],
    stdin: buildTargetQuarantineScript(),
  });
  if (!quarantine.ok) {
    const rollback = await rollbackTargetBootstrap(profile, installer, executor, false);
    return rollback.ok ? quarantine : rollback;
  }

  let installed = false;
  let installationAttempted = false;
  if (!targetFacts.comisInstalled) {
    const installerArgs = buildInstallerRemoteArgs(version, profile.target.comisUser);
    if (!installerArgs.ok) {
      return err({ kind: "source_not_ready", message: installerArgs.error.message });
    }
    installationAttempted = true;
    const install = await runChecked(executor, {
      label: "install-target",
      host: profile.target.ssh,
      ...(profile.target.sshPort !== undefined ? { port: profile.target.sshPort } : {}),
      args: [
        installerArgs.value[0] ?? "sudo",
        installerArgs.value[1] ?? "bash",
        installerArgs.value[2] ?? "-s",
        installerArgs.value[3] ?? "--",
        targetMachineId,
        ...installerArgs.value.slice(4),
      ],
      stdin: guardedInstallerInput(installer),
    });
    if (!install.ok) {
      const rollback = await rollbackTargetBootstrap(profile, installer, executor, true);
      return rollback.ok ? install : rollback;
    }
    installed = true;
  }

  const finalFacts = await probeHost(executor, profile.target, "probe-target-post");
  if (!finalFacts.ok) {
    const rollback = await rollbackTargetBootstrap(
      profile,
      installer,
      executor,
      installationAttempted,
    );
    return rollback.ok ? finalFacts : rollback;
  }
  const restoreAttestation = mapAttestation(
    "probe-target-post",
    attestTargetMutation(profile, finalFacts.value, "restore"),
  );
  if (!restoreAttestation.ok) {
    const rollback = await rollbackTargetBootstrap(
      profile,
      installer,
      executor,
      installationAttempted,
    );
    return rollback.ok ? restoreAttestation : rollback;
  }
  if (
    !finalFacts.value.comisInstalled ||
    finalFacts.value.comisVersion !== version ||
    finalFacts.value.serviceState !== "inactive" ||
    finalFacts.value.serviceEnabled
  ) {
    const targetError: Result<never, ProductionBootstrapError> = err({
      kind: "target_not_ready",
      message: "Target install is not pinned, inactive, and disabled after bootstrap",
    });
    const rollback = await rollbackTargetBootstrap(
      profile,
      installer,
      executor,
      installationAttempted,
    );
    return rollback.ok ? targetError : rollback;
  }

  const commit = await runChecked(executor, {
    label: "commit-target-bootstrap",
    host: profile.target.ssh,
    ...(profile.target.sshPort !== undefined ? { port: profile.target.sshPort } : {}),
    args: [
      "sudo",
      "bash",
      "-s",
      "--",
      targetMachineId,
      profile.target.service,
    ],
    stdin: buildTargetCommitScript(),
  });
  if (!commit.ok) {
    const rollback = await rollbackTargetBootstrap(
      profile,
      installer,
      executor,
      installationAttempted,
    );
    return rollback.ok ? commit : rollback;
  }

  return ok({
    installed,
    version,
    targetMachineIdSha256: finalFacts.value.machineIdSha256,
    serviceState: "inactive",
  });
}
