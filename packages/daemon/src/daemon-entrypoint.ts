// SPDX-License-Identifier: Apache-2.0
// @allow-throw: executable startup boundary converts closed Result failures into a non-zero daemon exit.
/**
 * Minimal daemon executable gate.
 *
 * The root-owned machine role and replay intent are resolved before the live
 * composition module is dynamically imported. A test-role machine therefore
 * cannot evaluate live adapters, listeners, schedulers, or stores.
 */
import { existsSync } from "node:fs";

import {
  systemGetEnv,
  systemNowDate,
  systemNowMs,
  type ClockPort,
  type EnvPort,
} from "@comis/core";

import type { DaemonInstance, DaemonOverrides, DaemonRuntime } from "./daemon-types.js";
import {
  createProcessReplaySignalPort,
  createStderrReplayQuarantineLogger,
  createSystemEnvironmentRolePort,
  createSystemReplayMachineIdentityPort,
  createSystemReplayRestoreAttestationPort,
  isReplayBootFailure,
  replayBootFailure,
  reportReplayBootError,
  resolveDaemonBootIntent,
  selectDaemonEntrypointAction,
  startReplayQuarantine,
  type ReplayBootIntent,
  type ReplayEnvironmentRolePort,
  type ReplayMachineIdentityPort,
  type ReplayQuarantineLogPort,
  type ReplayRestoreAttestationPort,
  type ReplaySignalPort,
} from "./replay-quarantine.js";

export type { DaemonInstance, DaemonOverrides, DaemonRuntime } from "./daemon-types.js";

interface DaemonLiveModule {
  readonly DEFAULT_CONFIG_PATHS: readonly string[];
  startLiveDaemon(overrides: DaemonOverrides): Promise<DaemonInstance>;
}

/** Narrow injectable seams for testing the executable decision boundary. */
export interface DaemonEntrypointDeps {
  readonly env?: EnvPort;
  readonly environmentRole?: ReplayEnvironmentRolePort;
  readonly machineIdentity?: ReplayMachineIdentityPort;
  readonly restoreAttestation?: ReplayRestoreAttestationPort;
  readonly clock?: ClockPort;
  readonly signals?: ReplaySignalPort;
  readonly logger?: ReplayQuarantineLogPort;
  readonly loadLiveDaemon?: () => Promise<DaemonLiveModule>;
}

interface ResolvedDaemonEntrypointDeps {
  readonly env: EnvPort;
  readonly environmentRole: ReplayEnvironmentRolePort;
  readonly machineIdentity: ReplayMachineIdentityPort;
  readonly restoreAttestation: ReplayRestoreAttestationPort;
  readonly clock: ClockPort;
  readonly signals: ReplaySignalPort;
  readonly logger: ReplayQuarantineLogPort;
  readonly loadLiveDaemon: () => Promise<DaemonLiveModule>;
}

const systemEnv: EnvPort = { get: systemGetEnv };
const systemClock: ClockPort = { now: systemNowMs, nowDate: systemNowDate };

function resolveEntrypointDeps(
  deps: DaemonEntrypointDeps,
): ResolvedDaemonEntrypointDeps {
  return {
    env: deps.env ?? systemEnv,
    environmentRole: deps.environmentRole ?? createSystemEnvironmentRolePort(),
    machineIdentity: deps.machineIdentity ?? createSystemReplayMachineIdentityPort(),
    restoreAttestation:
      deps.restoreAttestation ?? createSystemReplayRestoreAttestationPort(),
    clock: deps.clock ?? systemClock,
    signals: deps.signals ?? createProcessReplaySignalPort(),
    logger: deps.logger ?? createStderrReplayQuarantineLogger(),
    loadLiveDaemon: deps.loadLiveDaemon ?? (() => import("./daemon.js")),
  };
}

async function resolveIntent(
  deps: ResolvedDaemonEntrypointDeps,
): Promise<ReplayBootIntent> {
  const intent = await resolveDaemonBootIntent(deps.env, deps.environmentRole);
  if (!intent.ok) {
    reportReplayBootError(deps.logger, intent.error);
    throw replayBootFailure(intent.error);
  }
  return intent.value;
}

async function startResolvedDaemon(
  intent: ReplayBootIntent,
  overrides: DaemonOverrides,
  deps: ResolvedDaemonEntrypointDeps,
): Promise<DaemonRuntime> {
  if (intent.kind === "live") {
    const live = await deps.loadLiveDaemon();
    return live.startLiveDaemon(overrides);
  }
  const quarantine = await startReplayQuarantine(intent, {
    clock: deps.clock,
    signals: deps.signals,
    logger: deps.logger,
    machineIdentity: deps.machineIdentity,
    restoreAttestation: deps.restoreAttestation,
  });
  if (!quarantine.ok) throw replayBootFailure(quarantine.error);
  return quarantine.value;
}

/** Authorize the machine role and intent, then start only the selected runtime. */
export async function main(
  overrides: DaemonOverrides = {},
  injectedDeps: DaemonEntrypointDeps = {},
): Promise<DaemonRuntime> {
  const deps = resolveEntrypointDeps(injectedDeps);
  const intent = await resolveIntent(deps);
  return startResolvedDaemon(intent, overrides, deps);
}

async function runDirect(): Promise<void> {
  const deps = resolveEntrypointDeps({});
  const intent = await resolveIntent(deps);
  const action = selectDaemonEntrypointAction(
    intent,
    process.argv.includes("--restore-last-good"),
  );
  if (!action.ok) {
    reportReplayBootError(deps.logger, action.error);
    throw replayBootFailure(action.error);
  }
  if (action.value.kind === "start") {
    const runtime = await startResolvedDaemon(action.value.intent, {}, deps);
    if (runtime.kind === "replay_quarantine") await runtime.closed;
    return;
  }

  const [live, lastKnownGood] = await Promise.all([
    deps.loadLiveDaemon(),
    import("./config/last-known-good.js"),
  ]);
  const rawPaths = deps.env.get("COMIS_CONFIG_PATHS");
  const paths = (rawPaths ? rawPaths.split(":") : live.DEFAULT_CONFIG_PATHS).filter((path) =>
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- production-role restore preserves the existing configured-path discovery contract.
    existsSync(path),
  );
  lastKnownGood.handleRestoreFlag(paths, (code) => process.exit(code));
}

// Under pm2, argv points at its process container, so the runtime marker is
// the only reliable direct-execution signal.
const isDirectRun =
  process.argv[1]?.endsWith("daemon-entrypoint.js") === true ||
  process.argv[1]?.endsWith("daemon-entrypoint.ts") === true ||
  systemGetEnv("pm_id") !== undefined;

if (isDirectRun) {
  runDirect().catch((error: unknown) => {
    if (!isReplayBootFailure(error)) {
      process.stderr.write("FATAL: daemon startup failed; inspect structured service logs\n");
    }
    process.exit(1);
  });
}
