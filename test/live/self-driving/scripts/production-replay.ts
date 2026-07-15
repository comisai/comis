#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { err, fromPromise, ok, tryCatch, type Result } from "@comis/shared";

import {
  inspectProductionReplayHosts,
  prepareProductionReplayTarget,
  type ProductionRemoteExecutor,
} from "./production-bootstrap.js";
import {
  compareProductionEvidenceReports,
  executeProductionEvidenceProbe,
} from "./production-evidence.js";
import { executeProductionMessagesAttestation } from "./production-messages.js";
import { parseProductionProfile, productionProfileSummary } from "./production-profile.js";
import { executeRuntimeArtifactAttestation } from "./production-runtime.js";
import {
  createProductionRuntimeVaultController,
  type ProductionRuntimeVaultController,
  type ProductionRuntimeVaultControllerError,
} from "./production-runtime-vault-controller.js";
import type {
  ProductionRuntimeVaultRecoveryReport,
  ProductionRuntimeVaultReport,
} from "./production-runtime-vault.js";
import { createProductionSshExecutor } from "./production-ssh.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ENV_PATH = resolve(SCRIPT_DIR, ".live-env");
const DEFAULT_INSTALLER_PATH = resolve(SCRIPT_DIR, "../../../../website/public/install.sh");
const DEFAULT_CONTROLLER_STATE_ROOT = "/var/lib/comis-replay-controller";
const SAFE_RUNTIME_RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;

export interface ProductionReplayCliIoError {
  readonly kind: "io";
  readonly message: string;
}

export interface ProductionReplayCliDeps {
  readonly readText: (
    path: string,
  ) => Promise<Result<string, ProductionReplayCliIoError>>;
  readonly executor: ProductionRemoteExecutor;
  readonly runtimeVault: () => Result<
    ProductionRuntimeVaultController,
    ProductionRuntimeVaultControllerError
  >;
  readonly writeOutput: (line: string) => void;
}

export type ProductionReplayTerminationSignal = "SIGHUP" | "SIGINT" | "SIGTERM";

export interface ProductionReplaySignalPort {
  readonly on: (
    signal: ProductionReplayTerminationSignal,
    listener: () => void,
  ) => void;
  readonly off: (
    signal: ProductionReplayTerminationSignal,
    listener: () => void,
  ) => void;
}

const PRODUCTION_REPLAY_TERMINATION_SIGNALS = [
  "SIGHUP",
  "SIGINT",
  "SIGTERM",
] as const satisfies readonly ProductionReplayTerminationSignal[];

type CliCommand =
  | "profile"
  | "doctor"
  | "prepare-target"
  | "runtime-attest"
  | "seal-runtime"
  | "recover-runtime"
  | "messages-attest"
  | "evidence-source"
  | "evidence-target"
  | "evidence-parity";

interface ParsedCliArgs {
  readonly command: CliCommand;
  readonly envPath: string;
  readonly installerPath: string;
  readonly runId?: string;
  readonly attemptId?: string;
  readonly packageRoot?: string;
  readonly channel?: string;
}

type CliArgError =
  | { readonly kind: "unknown_command"; readonly message: string }
  | { readonly kind: "invalid_arguments"; readonly message: string };

function parseCliArgs(argv: readonly string[]): Result<ParsedCliArgs, CliArgError> {
  const command = argv[0];
  if (
    command !== "profile" &&
    command !== "doctor" &&
    command !== "prepare-target" &&
    command !== "runtime-attest" &&
    command !== "seal-runtime" &&
    command !== "recover-runtime" &&
    command !== "messages-attest" &&
    command !== "evidence-source" &&
    command !== "evidence-target" &&
    command !== "evidence-parity"
  ) {
    return err({
      kind: "unknown_command",
      message:
        "Expected profile, doctor, prepare-target, runtime-attest, seal-runtime, recover-runtime, messages-attest, evidence-source, evidence-target, or evidence-parity",
    });
  }
  let envPath = DEFAULT_ENV_PATH;
  let installerPath = DEFAULT_INSTALLER_PATH;
  let runId: string | undefined;
  let attemptId: string | undefined;
  let packageRoot: string | undefined;
  let channel: string | undefined;
  const singletonFlags = new Set<string>();
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv.at(index);
    const value = argv.at(index + 1);
    if (
      (flag !== "--env" &&
        flag !== "--installer" &&
        flag !== "--run-id" &&
        flag !== "--attempt-id" &&
        flag !== "--package-root" &&
        flag !== "--channel") ||
      value === undefined ||
      value === ""
    ) {
      return err({ kind: "invalid_arguments", message: "Invalid controller arguments" });
    }
    if (singletonFlags.has(flag)) {
      return err({
        kind: "invalid_arguments",
        message: "Controller singleton arguments cannot be repeated",
      });
    }
    singletonFlags.add(flag);
    if (flag === "--env") envPath = resolve(value);
    if (flag === "--installer") installerPath = resolve(value);
    if (flag === "--run-id") runId = value;
    if (flag === "--attempt-id") attemptId = value;
    if (flag === "--package-root") packageRoot = value;
    if (flag === "--channel") channel = value;
    index += 1;
  }
  const isRuntimeVaultCommand =
    command === "seal-runtime" || command === "recover-runtime";
  const requiresRunId = isRuntimeVaultCommand;
  if (requiresRunId && runId === undefined) {
    return err({ kind: "invalid_arguments", message: `${command} requires --run-id` });
  }
  if (isRuntimeVaultCommand && runId !== undefined && !SAFE_RUNTIME_RUN_ID_RE.test(runId)) {
    return err({
      kind: "invalid_arguments",
      message: "Runtime vault run ID is invalid",
    });
  }
  if (!requiresRunId && runId !== undefined) {
    return err({
      kind: "invalid_arguments",
      message: "--run-id is only valid for runtime vault commands",
    });
  }
  if (isRuntimeVaultCommand && attemptId === undefined) {
    return err({ kind: "invalid_arguments", message: `${command} requires --attempt-id` });
  }
  if (
    isRuntimeVaultCommand &&
    attemptId !== undefined &&
    !/^[a-f0-9]{32}$/u.test(attemptId)
  ) {
    return err({
      kind: "invalid_arguments",
      message: "Runtime vault attempt ID must be 32 lowercase hexadecimal characters",
    });
  }
  if (!isRuntimeVaultCommand && attemptId !== undefined) {
    return err({
      kind: "invalid_arguments",
      message: "--attempt-id is only valid for runtime vault commands",
    });
  }
  if (command === "messages-attest" && channel === undefined) {
    return err({ kind: "invalid_arguments", message: "messages-attest requires --channel" });
  }
  if (command !== "messages-attest" && channel !== undefined) {
    return err({ kind: "invalid_arguments", message: "--channel is only valid for messages-attest" });
  }
  if ((command === "evidence-source" || command === "evidence-target") && packageRoot === undefined) {
    return err({
      kind: "invalid_arguments",
      message: `${command} requires --package-root`,
    });
  }
  if (command !== "evidence-source" && command !== "evidence-target" && packageRoot !== undefined) {
    return err({
      kind: "invalid_arguments",
      message: "--package-root is only valid for evidence-source or evidence-target",
    });
  }
  return ok({
    command,
    envPath,
    installerPath,
    ...(runId !== undefined ? { runId } : {}),
    ...(attemptId !== undefined ? { attemptId } : {}),
    ...(packageRoot !== undefined ? { packageRoot } : {}),
    ...(channel !== undefined ? { channel } : {}),
  });
}

function emit(deps: ProductionReplayCliDeps, value: unknown): void {
  deps.writeOutput(JSON.stringify(value));
}

function runtimeVaultSealOutput(report: ProductionRuntimeVaultReport): object {
  return {
    disposition: report.disposition,
    bytesTransferred: report.bytesTransferred,
    payload: report.payload,
    payloadPath: report.payloadPath,
    compatibility: report.compatibility,
    sourceConsistency: report.sourceConsistency,
    targetInstallationPreserved: report.targetInstallationPreserved,
    normalServiceTouched: report.normalServiceTouched,
  };
}

function runtimeVaultRecoveryOutput(
  report: ProductionRuntimeVaultRecoveryReport,
): object {
  return {
    disposition: report.disposition,
    payload: report.payload,
    payloadPath: report.payloadPath,
    sourceConsistency: report.sourceConsistency,
    targetInstallationPreserved: report.targetInstallationPreserved,
    normalServiceTouched: report.normalServiceTouched,
  };
}

interface RuntimeVaultBoundaryError {
  readonly kind: "runtime_vault_boundary_failure";
  readonly stage: "composition" | "operation" | "dispose";
  readonly message: string;
}

type RuntimeVaultCliError = ProductionRuntimeVaultControllerError | RuntimeVaultBoundaryError;

function runtimeVaultBoundaryFailure(
  stage: RuntimeVaultBoundaryError["stage"],
): RuntimeVaultBoundaryError {
  return {
    kind: "runtime_vault_boundary_failure",
    stage,
    message: "Runtime vault controller boundary failed unexpectedly",
  };
}

function runtimeVaultErrorOutput(error: RuntimeVaultCliError): object {
  if (error.kind === "receipt_store_failure") {
    return { kind: error.kind, stage: error.stage, message: error.message };
  }
  return error;
}

interface RuntimeVaultCorrelation {
  readonly command: "seal-runtime" | "recover-runtime";
  readonly runId: string;
  readonly attemptId: string;
}

function finishRuntimeVaultOperation<T>(
  deps: ProductionReplayCliDeps,
  correlation: RuntimeVaultCorrelation,
  controller: ProductionRuntimeVaultController,
  report: Result<T, RuntimeVaultCliError>,
  project: (value: T) => object,
): number {
  const disposalAttempt = tryCatch(() => controller.dispose());
  const closed: Result<void, RuntimeVaultCliError> = disposalAttempt.ok
    ? disposalAttempt.value
    : err(runtimeVaultBoundaryFailure("dispose"));
  if (!report.ok && !closed.ok) {
    emit(deps, {
      ok: false,
      ...correlation,
      error: {
        kind: "runtime_vault_operation_and_cleanup_failure",
        message: "Runtime vault operation and controller cleanup both failed",
        primary: runtimeVaultErrorOutput(report.error),
        cleanup: runtimeVaultErrorOutput(closed.error),
      },
    });
    return 1;
  }
  if (!report.ok) {
    emit(deps, {
      ok: false,
      ...correlation,
      error: runtimeVaultErrorOutput(report.error),
    });
    return 1;
  }
  if (!closed.ok) {
    emit(deps, {
      ok: false,
      ...correlation,
      error: runtimeVaultErrorOutput(closed.error),
    });
    return 1;
  }
  emit(deps, { ok: true, ...correlation, report: project(report.value) });
  return 0;
}

export async function runProductionReplayCli(
  argv: readonly string[],
  deps: ProductionReplayCliDeps,
): Promise<number> {
  const args = parseCliArgs(argv);
  if (!args.ok) {
    emit(deps, { ok: false, error: args.error });
    return 2;
  }
  const profileText = await deps.readText(args.value.envPath);
  if (!profileText.ok) {
    emit(deps, { ok: false, error: profileText.error });
    return 1;
  }
  const profile = parseProductionProfile(profileText.value);
  if (!profile.ok) {
    emit(deps, { ok: false, error: profile.error });
    return 1;
  }

  if (args.value.command === "profile") {
    emit(deps, { ok: true, profile: productionProfileSummary(profile.value) });
    return 0;
  }
  if (args.value.command === "doctor") {
    const report = await inspectProductionReplayHosts(profile.value, deps.executor);
    if (!report.ok) {
      emit(deps, { ok: false, error: report.error });
      return 1;
    }
    emit(deps, { ok: true, report: report.value });
    return 0;
  }
  if (
    args.value.command === "seal-runtime" ||
    args.value.command === "recover-runtime"
  ) {
    const correlation = {
      command: args.value.command,
      runId: args.value.runId as string,
      attemptId: args.value.attemptId as string,
    };
    const compositionAttempt = tryCatch(() => deps.runtimeVault());
    if (!compositionAttempt.ok) {
      emit(deps, {
        ok: false,
        ...correlation,
        error: runtimeVaultBoundaryFailure("composition"),
      });
      return 1;
    }
    const composed = compositionAttempt.value;
    if (!composed.ok) {
      emit(deps, {
        ok: false,
        ...correlation,
        error: runtimeVaultErrorOutput(composed.error),
      });
      return 1;
    }
    const controller = composed.value;
    const request = {
      runId: correlation.runId,
      attemptId: correlation.attemptId,
      profile: profile.value,
    };
    if (args.value.command === "seal-runtime") {
      const attempted = await fromPromise(
        Promise.resolve().then(() => controller.seal(request)),
      );
      return finishRuntimeVaultOperation(
        deps,
        correlation,
        controller,
        attempted.ok
          ? attempted.value
          : err(runtimeVaultBoundaryFailure("operation")),
        runtimeVaultSealOutput,
      );
    }
    const attempted = await fromPromise(
      Promise.resolve().then(() => controller.recover(request)),
    );
    return finishRuntimeVaultOperation(
      deps,
      correlation,
      controller,
      attempted.ok
        ? attempted.value
        : err(runtimeVaultBoundaryFailure("operation")),
      runtimeVaultRecoveryOutput,
    );
  }
  if (args.value.command === "evidence-source" || args.value.command === "evidence-target") {
    const host =
      args.value.command === "evidence-source" ? profile.value.source : profile.value.target;
    const report = await executeProductionEvidenceProbe(
      {
        host: host.ssh,
        ...(host.sshPort !== undefined
          ? { port: host.sshPort }
          : {}),
        dataDir: host.dataDir,
        packageRoot: args.value.packageRoot as string,
        serviceUser: host.comisUser,
      },
      deps.executor,
    );
    if (!report.ok) {
      emit(deps, { ok: false, error: report.error });
      return 1;
    }
    emit(deps, { ok: true, report: report.value });
    return 0;
  }
  if (args.value.command === "evidence-parity") {
    const runtime = await executeRuntimeArtifactAttestation(profile.value, deps.executor);
    if (!runtime.ok) {
      emit(deps, { ok: false, error: runtime.error });
      return 1;
    }
    const source = await executeProductionEvidenceProbe(
      {
        host: profile.value.source.ssh,
        ...(profile.value.source.sshPort !== undefined
          ? { port: profile.value.source.sshPort }
          : {}),
        dataDir: profile.value.source.dataDir,
        packageRoot: runtime.value.source.packageRoot,
        serviceUser: profile.value.source.comisUser,
      },
      {
        run: (invocation) =>
          deps.executor.run({ ...invocation, label: "production-evidence-inventory-source" }),
      },
    );
    if (!source.ok) {
      emit(deps, { ok: false, error: source.error });
      return 1;
    }
    const target = await executeProductionEvidenceProbe(
      {
        host: profile.value.target.ssh,
        ...(profile.value.target.sshPort !== undefined
          ? { port: profile.value.target.sshPort }
          : {}),
        dataDir: profile.value.target.dataDir,
        packageRoot: runtime.value.target.packageRoot,
        serviceUser: profile.value.target.comisUser,
      },
      {
        run: (invocation) =>
          deps.executor.run({ ...invocation, label: "production-evidence-inventory-target" }),
      },
    );
    if (!target.ok) {
      emit(deps, { ok: false, error: target.error });
      return 1;
    }
    const comparison = compareProductionEvidenceReports(source.value, target.value);
    if (!comparison.ok) {
      emit(deps, { ok: false, error: comparison.error });
      return 1;
    }
    emit(deps, { ok: true, report: comparison.value });
    return 0;
  }
  if (args.value.command === "runtime-attest") {
    const report = await executeRuntimeArtifactAttestation(profile.value, deps.executor);
    if (!report.ok) {
      emit(deps, { ok: false, error: report.error });
      return 1;
    }
    emit(deps, { ok: true, report: report.value });
    return 0;
  }
  if (args.value.command === "messages-attest") {
    const report = await executeProductionMessagesAttestation(
      profile.value,
      args.value.channel as string,
      deps.executor,
    );
    if (!report.ok) {
      emit(deps, { ok: false, error: report.error });
      return 1;
    }
    emit(deps, { ok: true, report: report.value });
    return 0;
  }
  const installerText = await deps.readText(args.value.installerPath);
  if (!installerText.ok) {
    emit(deps, { ok: false, error: installerText.error });
    return 1;
  }
  const report = await prepareProductionReplayTarget(
    profile.value,
    installerText.value,
    deps.executor,
  );
  if (!report.ok) {
    emit(deps, { ok: false, error: report.error });
    return 1;
  }
  emit(deps, { ok: true, report: report.value });
  return 0;
}

function terminationExitCode(signal: ProductionReplayTerminationSignal): number {
  switch (signal) {
    case "SIGHUP":
      return 129;
    case "SIGINT":
      return 130;
    case "SIGTERM":
      return 143;
    default: {
      const _exhaustive: never = signal;
      return _exhaustive;
    }
  }
}

/**
 * A termination request changes the eventual process status but never tears down
 * controller authority while an operation is reconciling its durable receipt.
 */
export async function runProductionReplayProcess(
  argv: readonly string[],
  deps: ProductionReplayCliDeps,
  signals: ProductionReplaySignalPort,
): Promise<number> {
  let termination: ProductionReplayTerminationSignal | undefined;
  const listeners = new Map<ProductionReplayTerminationSignal, () => void>();
  for (const signal of PRODUCTION_REPLAY_TERMINATION_SIGNALS) {
    const listener = (): void => {
      termination ??= signal;
    };
    listeners.set(signal, listener);
    signals.on(signal, listener);
  }
  try {
    const exitCode = await runProductionReplayCli(argv, deps);
    return termination === undefined ? exitCode : terminationExitCode(termination);
  } finally {
    for (const [signal, listener] of listeners) signals.off(signal, listener);
  }
}

async function readText(path: string): Promise<Result<string, ProductionReplayCliIoError>> {
  // The local operator explicitly selects controller input paths through validated CLI flags.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const result = await fromPromise(readFile(path, "utf8"));
  if (!result.ok) return err({ kind: "io", message: "Unable to read controller input file" });
  return ok(result.value);
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  const exitCode = await runProductionReplayProcess(
    process.argv.slice(2),
    {
      readText,
      executor: createProductionSshExecutor(),
      runtimeVault: () =>
        createProductionRuntimeVaultController({
          stateRoot: DEFAULT_CONTROLLER_STATE_ROOT,
        }),
      writeOutput: (line) => process.stdout.write(`${line}\n`),
    },
    process,
  );
  process.exitCode = exitCode;
}
