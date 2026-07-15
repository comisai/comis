// SPDX-License-Identifier: Apache-2.0
import { createHash, randomBytes } from "node:crypto";
import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
  type SpawnSyncReturns,
} from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  TARGET_REPLAY_QUARANTINE_CONTENT,
  TARGET_REPLAY_QUARANTINE_SHA256,
  type ProductionRemoteInvocation,
} from "./production-bootstrap.js";
import type { ProductionReplayProfile } from "./production-profile.js";
import type { RuntimeArtifactAttestation } from "./production-runtime.js";
import {
  buildRuntimeTreeProbeScript,
  compareRuntimeTreeAttestations,
  parseRuntimeTreeFacts,
  type RuntimeTreeAttestation,
} from "./production-runtime-tree.js";
import {
  buildProductionRuntimeVaultJournalShellLibrary,
  runtimeVaultJournalPhaseFile,
} from "./production-runtime-vault-journal-shell.js";
import {
  buildProductionRuntimeVaultPlan,
  type ProductionRuntimeVaultPlan,
} from "./production-runtime-vault.js";

const UBUNTU_IMAGE = "mirror.gcr.io/library/ubuntu:24.04";
const PYTHON_TOOLCHAIN_IMAGE = "mirror.gcr.io/library/node:22-bookworm";
const TARGET_MACHINE_ID_VALUE = "comis-runtime-vault-ground-truth";
const TARGET_MACHINE_ID = `${TARGET_MACHINE_ID_VALUE}\n`;
const TARGET_MACHINE_ID_SHA256 = createHash("sha256")
  .update(TARGET_MACHINE_ID, "utf8")
  .digest("hex");
const SOURCE_MACHINE_ID_SHA256 = "b".repeat(64);
const AUTHORITY_DIGEST_SHA256 = "a".repeat(64);
const SERVICE = "comis-ground-truth";
const SOURCE_PACKAGE_ROOT = "/opt/source/node_modules/comisai";
const TARGET_PACKAGE_ROOT = "/srv/target/node_modules/comisai";
const TARGET_DATA_DIR = "/srv/target/.comis";

function dockerCommand(
  args: readonly string[],
  input?: string,
  timeout = 30_000,
): SpawnSyncReturns<string> {
  return spawnSync("docker", [...args], {
    encoding: "utf8",
    ...(input === undefined ? {} : { input }),
    maxBuffer: 16 * 1024 * 1024,
    timeout,
  });
}

function dockerSucceeded(args: readonly string[]): boolean {
  const result = dockerCommand(args, undefined, 5_000);
  return result.status === 0 && result.error === undefined;
}

const dockerGroundTruthAvailable =
  dockerSucceeded(["info", "--format", "{{.ServerVersion}}"])
  && dockerSucceeded(["image", "inspect", UBUNTU_IMAGE])
  && dockerSucceeded(["image", "inspect", PYTHON_TOOLCHAIN_IMAGE]);

const describeDocker = dockerGroundTruthAvailable ? describe : describe.skip;
const resourceSuffix = `${process.pid}-${randomBytes(6).toString("hex")}`;
const pythonVolume = `comis-runtime-vault-python-${resourceSuffix}`;
const containers = new Set<string>();

function requireSuccess(result: SpawnSyncReturns<string>, stage: string): string {
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `${stage} failed with status ${String(result.status)}: ${result.stderr.trim()}`,
    );
  }
  return result.stdout;
}

function dockerExec(
  container: string,
  args: readonly string[],
  input?: string,
): SpawnSyncReturns<string> {
  return dockerCommand(
    ["exec", "-i", "--user", "0:0", container, ...args],
    input,
  );
}

function runInvocation(
  container: string,
  invocation: ProductionRemoteInvocation,
): SpawnSyncReturns<string> {
  return dockerExec(container, invocation.args, invocation.stdin);
}

function setupScript(): string {
  return `set -euo pipefail
printf '%s\\n' ${JSON.stringify(TARGET_MACHINE_ID_VALUE)} > /etc/machine-id
install -d -m 0755 /etc/comis
printf 'test\\n' > /etc/comis/environment-role
chmod 0644 /etc/comis/environment-role
install -d -m 0755 /etc/systemd/system/${SERVICE}.service.d
cat > /etc/systemd/system/${SERVICE}.service.d/90-comis-replay-quarantine.conf <<'COMIS_RUNTIME_QUARANTINE'
${TARGET_REPLAY_QUARANTINE_CONTENT}COMIS_RUNTIME_QUARANTINE
chmod 0644 /etc/systemd/system/${SERVICE}.service.d/90-comis-replay-quarantine.conf
cat > /usr/bin/python3 <<'COMIS_RUNTIME_PYTHON'
#!/usr/bin/bash
set -euo pipefail
export PYTHONHOME=/opt/python
export LD_LIBRARY_PATH=/opt/python/runtime-libs
exec /opt/python/bin/python3.11 "$@"
COMIS_RUNTIME_PYTHON
chmod 0755 /usr/bin/python3
cat > /usr/bin/sudo <<'COMIS_RUNTIME_SUDO'
#!/usr/bin/bash
set -euo pipefail
if [ "$(id -u)" -ne 0 ] || [ "$#" -lt 2 ] || [ "$1" != -- ]; then exit 125; fi
shift
exec "$@"
COMIS_RUNTIME_SUDO
chmod 0755 /usr/bin/sudo
cat > /usr/bin/systemctl <<'COMIS_RUNTIME_SYSTEMCTL'
#!/usr/bin/bash
set -euo pipefail
command="$1"
shift
case "$command" in
  is-active)
    [ "$#" -eq 1 ]
    printf '%s\\n' inactive
    ;;
  is-enabled)
    [ "$#" -eq 1 ]
    printf '%s\\n' disabled
    ;;
  show)
    property=
    for argument in "$@"; do
      case "$argument" in --property=*) property="\${argument#--property=}" ;; esac
    done
    case "$property" in
      LoadState) printf '%s\\n' loaded ;;
      DropInPaths) printf '%s\\n' /etc/systemd/system/${SERVICE}.service.d/90-comis-replay-quarantine.conf ;;
      PrivateNetwork|PrivateDevices|PrivateTmp|PrivateMounts|NoNewPrivileges|ProtectKernelTunables|ProtectControlGroups|RestrictNamespaces) printf '%s\\n' yes ;;
      RestrictAddressFamilies) printf '%s\\n' AF_UNIX ;;
      ProtectSystem) printf '%s\\n' strict ;;
      ProtectHome) printf '%s\\n' read-only ;;
      SocketBindDeny) printf '%s\\n' any ;;
      ReadWritePaths) printf '%s\\n' /run/comis-replay ;;
      UMask) printf '%s\\n' 0077 ;;
      CapabilityBoundingSet|AmbientCapabilities) printf '\\n' ;;
      *) exit 1 ;;
    esac
    ;;
  *) exit 1 ;;
esac
COMIS_RUNTIME_SYSTEMCTL
chmod 0755 /usr/bin/systemctl
install -d -m 0755 ${SOURCE_PACKAGE_ROOT}/lib ${TARGET_PACKAGE_ROOT} ${TARGET_DATA_DIR}
printf '{"version":"1.2.3"}\\n' > ${SOURCE_PACKAGE_ROOT}/package.json
printf 'runtime vault rollback ground truth\\n' > ${SOURCE_PACKAGE_ROOT}/lib/runtime.js
chmod 0644 ${SOURCE_PACKAGE_ROOT}/package.json ${SOURCE_PACKAGE_ROOT}/lib/runtime.js
touch -d '@1700000000' ${SOURCE_PACKAGE_ROOT}/package.json ${SOURCE_PACKAGE_ROOT}/lib/runtime.js
touch -d '@1700000000' ${SOURCE_PACKAGE_ROOT}/lib ${SOURCE_PACKAGE_ROOT}
`;
}

function makeProfile(): ProductionReplayProfile {
  return {
    source: {
      ssh: "source-ground-truth",
      role: "production",
      comisUser: "comis",
      dataDir: "/srv/source/.comis",
      service: "comis-source",
      expectedMachineIdSha256: SOURCE_MACHINE_ID_SHA256,
    },
    target: {
      ssh: "target-ground-truth",
      role: "test",
      comisUser: "comis-test",
      dataDir: TARGET_DATA_DIR,
      service: SERVICE,
      expectedMachineIdSha256: TARGET_MACHINE_ID_SHA256,
    },
  };
}

function makeRuntimeArtifacts(sourceTree: RuntimeTreeAttestation): {
  readonly source: RuntimeArtifactAttestation;
  readonly target: RuntimeArtifactAttestation;
} {
  const shared = {
    digestSha256: sourceTree.digestSha256,
    entryCount: sourceTree.entryCount,
    bytes: sourceTree.bytes,
    version: sourceTree.version,
    osId: "ubuntu",
    osVersion: "24.04",
    architecture: "container",
    kernelRelease: "container",
    libcKind: "glibc" as const,
    libcVersion: "container",
    nodeVersion: "22.0.0",
    nodeAbi: "127",
    timezone: "Etc/UTC",
    tzdataSha256: "1".repeat(64),
    launcherKind: "systemd" as const,
    applicationLauncherSha256: "2".repeat(64),
    browserStatus: "unavailable" as const,
    browserSha256: "none",
    mediaStatus: "unavailable" as const,
    mediaSha256: "none",
    nativeToolsStatus: "unavailable" as const,
    nativeToolsSha256: "none",
  };
  return {
    source: {
      ...shared,
      packageRoot: SOURCE_PACKAGE_ROOT,
      confinementKind: "source",
      confinementSha256: "none",
    },
    target: {
      ...shared,
      packageRoot: TARGET_PACKAGE_ROOT,
      confinementKind: "target_quarantine",
      confinementSha256: TARGET_REPLAY_QUARANTINE_SHA256,
    },
  };
}

interface HeldControllerLease {
  readonly release: () => Promise<void>;
}

async function acquireControllerLease(
  container: string,
  plan: ProductionRuntimeVaultPlan,
): Promise<HeldControllerLease> {
  const request = plan.controllerLease;
  const child: ChildProcessWithoutNullStreams = spawn(
    "docker",
    ["exec", "-i", "--user", "0:0", container, ...request.args],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  let closed: number | null | undefined;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const ready = await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`controller lease did not become ready: ${stderr.trim()}`));
    }, 15_000);
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.includes(`${request.readyLine}\n`)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("close", (code) => {
      closed = code;
      clearTimeout(timer);
      reject(
        new Error(
          `controller lease closed before readiness with status ${String(code)}: ${stderr.trim()}`,
        ),
      );
    });
    child.stdin.write(request.remoteProgram, "utf8", (error) => {
      if (error !== null && error !== undefined) {
        clearTimeout(timer);
        reject(error);
      }
    });
  });
  void ready;

  return {
    release: async () => {
      if (closed !== undefined) {
        if (closed !== 0) {
          throw new Error(`controller lease closed with status ${String(closed)}`);
        }
        return;
      }
      const completion = new Promise<number | null>((resolve) => {
        child.once("close", (code) => {
          closed = code;
          resolve(code);
        });
      });
      child.stdin.end();
      const code = await completion;
      if (code !== 0) {
        throw new Error(
          `controller lease release failed with status ${String(code)}: ${stderr.trim()}`,
        );
      }
    },
  };
}

interface RuntimeVaultPaths {
  readonly finalRoot: string;
  readonly payloadPath: string;
  readonly incomingRoot: string;
  readonly controlDir: string;
  readonly transactionParent: string;
  readonly transactionDir: string;
  readonly operationLock: string;
  readonly identityPath: string;
  readonly activeCapture: string;
}

function runtimeVaultPaths(
  runId: string,
  attemptId: string,
  digestSha256: string,
): RuntimeVaultPaths {
  const vaultRoot = "/opt/comis-replay/runtimes/sha256";
  const coordinationRoot = "/var/lib/comis-self-driving/runtime-vault";
  return {
    finalRoot: `${vaultRoot}/${digestSha256}`,
    payloadPath: `${vaultRoot}/${digestSha256}/payload`,
    incomingRoot: `${vaultRoot}/.incoming-${runId}-${attemptId}-${digestSha256}`,
    controlDir: `${coordinationRoot}/capture-${runId}-${attemptId}`,
    transactionParent: `${coordinationRoot}/transactions`,
    transactionDir: `${coordinationRoot}/transactions/${runId}-${attemptId}`,
    operationLock: `${coordinationRoot}/operation.lock`,
    identityPath: `${coordinationRoot}/capture-${runId}-${attemptId}.identity`,
    activeCapture: `${coordinationRoot}/active-capture`,
  };
}

function appendJournalPhases(
  container: string,
  plan: ProductionRuntimeVaultPlan,
  paths: RuntimeVaultPaths,
  phases: readonly string[],
): void {
  const script = [
    "set -euo pipefail",
    `transaction_parent=${JSON.stringify(paths.transactionParent)}`,
    `transaction_dir=${JSON.stringify(paths.transactionDir)}`,
    `expected_authority_digest=${plan.authorityDigestSha256}`,
    `expected_transaction_identity=${plan.transactionIdentitySha256}`,
    buildProductionRuntimeVaultJournalShellLibrary(),
    ...phases.map((phase) => `runtime_journal_append ${phase}`),
    "",
  ].join("\n");
  requireSuccess(
    dockerExec(container, ["/usr/bin/bash", "--noprofile", "--norc", "-s"], script),
    `append journal phases ${phases.join(",")}`,
  );
}

function attestTree(container: string, root: string): RuntimeTreeAttestation {
  const stdout = requireSuccess(
    dockerExec(
      container,
      ["/usr/bin/bash", "--noprofile", "--norc", "-s", "--", root],
      buildRuntimeTreeProbeScript(),
    ),
    `attest runtime tree ${root}`,
  );
  const parsed = parseRuntimeTreeFacts(stdout);
  if (!parsed.ok) {
    throw new Error(`runtime tree attestation was malformed: ${parsed.error.message}`);
  }
  return parsed.value;
}

function pathIdentity(container: string, path: string): string {
  return requireSuccess(
    dockerExec(container, ["/usr/bin/stat", "-c", "%d:%i", "--", path]),
    `inspect inode ${path}`,
  ).trim();
}

function exactTreeSnapshot(container: string, root: string): string {
  const script = `set -euo pipefail
find "$1" -xdev -printf '%P|%y|%m|%U|%G|%D|%i|%n|%s|%T@\n' | LC_ALL=C sort
find "$1" -xdev -type f -exec sha256sum -- {} + | LC_ALL=C sort
`;
  return requireSuccess(
    dockerExec(
      container,
      ["/usr/bin/bash", "--noprofile", "--norc", "-s", "--", root],
      script,
    ),
    `capture exact tree ${root}`,
  );
}

function preservedStateSnapshot(
  container: string,
  paths: RuntimeVaultPaths,
): string {
  const roots = [
    paths.finalRoot,
    paths.incomingRoot,
    paths.controlDir,
    paths.identityPath,
    paths.activeCapture,
    paths.transactionDir,
    paths.operationLock,
  ];
  const script = `set -euo pipefail
for root in "$@"; do
  printf 'ROOT=%s\\n' "$root"
  find "$root" -xdev -printf '%P|%y|%m|%U|%G|%D|%i|%n|%s|%T@\\n' | LC_ALL=C sort
  find "$root" -xdev -type f -exec sha256sum -- {} + | LC_ALL=C sort
done
`;
  return requireSuccess(
    dockerExec(
      container,
      ["/usr/bin/bash", "--noprofile", "--norc", "-s", "--", ...roots],
      script,
    ),
    "capture preserved runtime-vault state",
  );
}

interface RuntimeVaultFixture {
  readonly container: string;
  readonly plan: ProductionRuntimeVaultPlan;
  readonly paths: RuntimeVaultPaths;
  readonly sourceTree: RuntimeTreeAttestation;
  readonly release: () => Promise<void>;
}

async function createFixture(
  runId: string,
  attemptId: string,
): Promise<RuntimeVaultFixture> {
  const container = `comis-runtime-vault-${resourceSuffix}-${attemptId.slice(0, 4)}`;
  const started = dockerCommand([
    "run",
    "--pull=never",
    "--network=none",
    "--rm",
    "--detach",
    "--name",
    container,
    "--mount",
    `type=volume,src=${pythonVolume},dst=/opt/python,readonly`,
    UBUNTU_IMAGE,
    "/usr/bin/sleep",
    "300",
  ]);
  requireSuccess(started, "start disposable Ubuntu target");
  containers.add(container);
  let lease: HeldControllerLease | undefined;
  try {
    requireSuccess(
      dockerExec(
        container,
        ["/usr/bin/bash", "--noprofile", "--norc", "-s"],
        setupScript(),
      ),
      "prepare disposable Ubuntu target",
    );
    const sourceTree = attestTree(container, SOURCE_PACKAGE_ROOT);
    const runtime = makeRuntimeArtifacts(sourceTree);
    const built = buildProductionRuntimeVaultPlan({
      runId,
      attemptId,
      profile: makeProfile(),
      sourceRuntime: runtime.source,
      targetRuntime: runtime.target,
      sourceTree,
      authorityDigestSha256: AUTHORITY_DIGEST_SHA256,
    });
    if (!built.ok) {
      throw new Error(`runtime vault plan failed: ${built.error.message}`);
    }
    const plan = built.value;
    const paths = runtimeVaultPaths(runId, attemptId, sourceTree.digestSha256);
    expect(plan.payloadPath).toBe(paths.payloadPath);
    lease = await acquireControllerLease(container, plan);

    requireSuccess(
      runInvocation(container, plan.targetPrepare),
      "execute generated target preparation",
    );
    requireSuccess(
      dockerExec(
        container,
        [
          "/usr/bin/bash",
          "--noprofile",
          "--norc",
          "-c",
          'set -euo pipefail; rm -rf -- "$1/payload"; mv -- "$2" "$1/payload"',
          "--",
          paths.incomingRoot,
          SOURCE_PACKAGE_ROOT,
        ],
      ),
      "place attested payload in target staging",
    );
    appendJournalPhases(container, plan, paths, ["receive_intent", "received"]);
    requireSuccess(
      runInvocation(container, plan.targetVerify),
      "execute generated target verification",
    );
    requireSuccess(
      dockerExec(
        container,
        [
          "/usr/bin/bash",
          "--noprofile",
          "--norc",
          "-c",
          'set -euo pipefail; cp -a -- "$1" "$2"; sync -f "$2"; sync -f "$(dirname "$2")"',
          "--",
          paths.incomingRoot,
          paths.finalRoot,
        ],
      ),
      "materialize exact published payload",
    );
    appendJournalPhases(container, plan, paths, ["rollback_intent"]);

    return {
      container,
      plan,
      paths,
      sourceTree,
      release: async () => {
        let releaseError: unknown;
        try {
          await lease?.release();
        } catch (error: unknown) {
          releaseError = error;
        } finally {
          dockerCommand(["rm", "--force", container], undefined, 15_000);
          containers.delete(container);
        }
        if (releaseError !== undefined) throw releaseError;
      },
    };
  } catch (error: unknown) {
    try {
      await lease?.release();
    } finally {
      dockerCommand(["rm", "--force", container], undefined, 15_000);
      containers.delete(container);
    }
    throw error;
  }
}

describeDocker("production runtime vault rollback on disposable Linux", () => {
  beforeAll(() => {
    requireSuccess(
      dockerCommand(["volume", "create", pythonVolume]),
      "create offline Python toolchain volume",
    );
    const populate = `set -euo pipefail
install -d -m 0755 /export/bin /export/lib /export/runtime-libs
cp /usr/bin/python3.11 /export/bin/python3.11
cp -a /usr/lib/python3.11 /export/lib/python3.11
expat="$(ldd /usr/bin/python3.11 | awk '$1 == "libexpat.so.1" { print $3 }')"
test -n "$expat"
cp -L "$expat" /export/runtime-libs/libexpat.so.1
`;
    requireSuccess(
      dockerCommand(
        [
          "run",
          "--pull=never",
          "--network=none",
          "--rm",
          "--interactive",
          "--mount",
          `type=volume,src=${pythonVolume},dst=/export`,
          PYTHON_TOOLCHAIN_IMAGE,
          "/usr/bin/bash",
          "--noprofile",
          "--norc",
          "-s",
        ],
        populate,
      ),
      "populate offline Python toolchain volume",
    );
  });

  afterAll(() => {
    for (const container of containers) {
      dockerCommand(["rm", "--force", container], undefined, 15_000);
    }
    containers.clear();
    dockerCommand(["volume", "rm", "--force", pythonVolume]);
  });

  it("preserves an exact published tree while finishing an owned rollback", async () => {
    const fixture = await createFixture("linux-owned-rollback", "1".repeat(32));
    try {
      const finalInode = pathIdentity(fixture.container, fixture.paths.finalRoot);
      const payloadInode = pathIdentity(fixture.container, fixture.paths.payloadPath);
      const before = attestTree(fixture.container, fixture.paths.payloadPath);
      expect(compareRuntimeTreeAttestations(fixture.sourceTree, before)).toEqual({
        ok: true,
        value: undefined,
      });
      const exactFinalBefore = exactTreeSnapshot(
        fixture.container,
        fixture.paths.finalRoot,
      );

      const rolledBack = runInvocation(fixture.container, fixture.plan.targetRollback);
      expect(rolledBack.status, rolledBack.stderr).toBe(0);
      expect(pathIdentity(fixture.container, fixture.paths.finalRoot)).toBe(finalInode);
      expect(pathIdentity(fixture.container, fixture.paths.payloadPath)).toBe(payloadInode);
      const after = attestTree(fixture.container, fixture.paths.payloadPath);
      expect(compareRuntimeTreeAttestations(fixture.sourceTree, after)).toEqual({
        ok: true,
        value: undefined,
      });
      expect(
        exactTreeSnapshot(fixture.container, fixture.paths.finalRoot),
      ).toBe(exactFinalBefore);
      expect(
        dockerExec(
          fixture.container,
          [
            "/usr/bin/bash",
            "-c",
            'for path in "$@"; do test ! -e "$path" && test ! -L "$path"; done',
            "--",
            fixture.paths.incomingRoot,
            fixture.paths.controlDir,
            fixture.paths.identityPath,
            fixture.paths.activeCapture,
          ],
        ).status,
      ).toBe(0);
      expect(
        dockerExec(
          fixture.container,
          [
            "/usr/bin/test",
            "-f",
            `${fixture.paths.transactionDir}/${runtimeVaultJournalPhaseFile("rolled_back")}`,
          ],
        ).status,
      ).toBe(0);
    } finally {
      await fixture.release();
    }
  });

  it("rejects a foreign active claim without mutating any durable target state", async () => {
    const fixture = await createFixture("linux-foreign-claim", "2".repeat(32));
    try {
      requireSuccess(
        dockerExec(
          fixture.container,
          [
            "/usr/bin/bash",
            "--noprofile",
            "--norc",
            "-c",
            'set -euo pipefail; printf "%s\\n" "$1" > "$2"; sync -f "$2"',
            "--",
            "0".repeat(64),
            fixture.paths.identityPath,
          ],
        ),
        "replace the active claim with foreign authority",
      );
      const before = preservedStateSnapshot(fixture.container, fixture.paths);

      const rejected = runInvocation(fixture.container, fixture.plan.targetRollback);
      expect(rejected.error).toBeUndefined();
      expect(rejected.status).not.toBeNull();
      expect(rejected.status).not.toBe(0);
      expect(preservedStateSnapshot(fixture.container, fixture.paths)).toBe(before);
      expect(
        dockerExec(
          fixture.container,
          [
            "/usr/bin/test",
            "-f",
            `${fixture.paths.transactionDir}/${runtimeVaultJournalPhaseFile("rollback_intent")}`,
          ],
        ).status,
      ).toBe(0);
      expect(
        dockerExec(
          fixture.container,
          [
            "/usr/bin/test",
            "!",
            "-e",
            `${fixture.paths.transactionDir}/${runtimeVaultJournalPhaseFile("rolled_back")}`,
          ],
        ).status,
      ).toBe(0);
    } finally {
      await fixture.release();
    }
  });
});
