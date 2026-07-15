#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { err, fromPromise, ok, type Result } from "@comis/shared";

import {
  createProductionBinarySshBridge,
  type ProductionBinarySshBridge,
} from "./production-binary-ssh.js";
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
import { cloneProductionRuntime } from "./production-runtime-clone.js";
import { executeRuntimeArtifactAttestation } from "./production-runtime.js";
import { cloneProductionState } from "./production-state-clone.js";
import { createProductionSshExecutor } from "./production-ssh.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ENV_PATH = resolve(SCRIPT_DIR, ".live-env");
const DEFAULT_INSTALLER_PATH = resolve(SCRIPT_DIR, "../../../../website/public/install.sh");

export interface ProductionReplayCliIoError {
  readonly kind: "io";
  readonly message: string;
}

export interface ProductionReplayCliDeps {
  readonly readText: (
    path: string,
  ) => Promise<Result<string, ProductionReplayCliIoError>>;
  readonly executor: ProductionRemoteExecutor;
  readonly binaryBridge: ProductionBinarySshBridge;
  readonly writeOutput: (line: string) => void;
}

type CliCommand =
  | "profile"
  | "doctor"
  | "prepare-target"
  | "runtime-attest"
  | "clone-runtime"
  | "clone-state"
  | "messages-attest"
  | "evidence-source"
  | "evidence-target"
  | "evidence-parity";

interface ParsedCliArgs {
  readonly command: CliCommand;
  readonly envPath: string;
  readonly installerPath: string;
  readonly runId?: string;
  readonly packageRoot?: string;
  readonly captureMode?: "offline" | "bounded-freeze";
  readonly agentIds: readonly string[];
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
    command !== "clone-runtime" &&
    command !== "clone-state" &&
    command !== "messages-attest" &&
    command !== "evidence-source" &&
    command !== "evidence-target" &&
    command !== "evidence-parity"
  ) {
    return err({
      kind: "unknown_command",
      message:
        "Expected profile, doctor, prepare-target, runtime-attest, clone-runtime, clone-state, messages-attest, evidence-source, evidence-target, or evidence-parity",
    });
  }
  let envPath = DEFAULT_ENV_PATH;
  let installerPath = DEFAULT_INSTALLER_PATH;
  let runId: string | undefined;
  let packageRoot: string | undefined;
  let captureMode: "offline" | "bounded-freeze" | undefined;
  let channel: string | undefined;
  const agentIds: string[] = [];
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv.at(index);
    const value = argv.at(index + 1);
    if (
      (flag !== "--env" &&
        flag !== "--installer" &&
        flag !== "--run-id" &&
        flag !== "--package-root" &&
        flag !== "--capture-mode" &&
        flag !== "--agent-id" &&
        flag !== "--channel") ||
      value === undefined ||
      value === ""
    ) {
      return err({ kind: "invalid_arguments", message: "Invalid controller arguments" });
    }
    if (flag === "--env") envPath = resolve(value);
    if (flag === "--installer") installerPath = resolve(value);
    if (flag === "--run-id") runId = value;
    if (flag === "--package-root") packageRoot = value;
    if (flag === "--capture-mode") {
      if (value !== "offline" && value !== "bounded-freeze") {
        return err({ kind: "invalid_arguments", message: "Invalid capture mode" });
      }
      captureMode = value;
    }
    if (flag === "--agent-id") agentIds.push(value);
    if (flag === "--channel") channel = value;
    index += 1;
  }
  if ((command === "clone-runtime" || command === "clone-state") && runId === undefined) {
    return err({ kind: "invalid_arguments", message: `${command} requires --run-id` });
  }
  if (command !== "clone-runtime" && command !== "clone-state" && runId !== undefined) {
    return err({
      kind: "invalid_arguments",
      message: "--run-id is only valid for clone-runtime or clone-state",
    });
  }
  if (command === "clone-state" && captureMode === undefined) {
    return err({ kind: "invalid_arguments", message: "clone-state requires --capture-mode" });
  }
  if (command !== "clone-state" && (captureMode !== undefined || agentIds.length > 0)) {
    return err({
      kind: "invalid_arguments",
      message: "--capture-mode and --agent-id are only valid for clone-state",
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
    ...(packageRoot !== undefined ? { packageRoot } : {}),
    ...(captureMode !== undefined ? { captureMode } : {}),
    agentIds,
    ...(channel !== undefined ? { channel } : {}),
  });
}

function emit(deps: ProductionReplayCliDeps, value: unknown): void {
  deps.writeOutput(JSON.stringify(value));
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
  if (args.value.command === "clone-runtime") {
    const report = await cloneProductionRuntime({
      runId: args.value.runId as string,
      profile: profile.value,
      executor: deps.executor,
      bridge: deps.binaryBridge,
    });
    if (!report.ok) {
      emit(deps, { ok: false, error: report.error });
      return 1;
    }
    emit(deps, { ok: true, report: report.value });
    return 0;
  }
  if (args.value.command === "clone-state") {
    const report = await cloneProductionState(
      {
        runId: args.value.runId as string,
        profile: profile.value,
        captureMode: args.value.captureMode as "offline" | "bounded-freeze",
        agentIds: args.value.agentIds,
      },
      { executor: deps.executor, bridge: deps.binaryBridge },
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

async function readText(path: string): Promise<Result<string, ProductionReplayCliIoError>> {
  // The local operator explicitly selects controller input paths through validated CLI flags.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const result = await fromPromise(readFile(path, "utf8"));
  if (!result.ok) return err({ kind: "io", message: "Unable to read controller input file" });
  return ok(result.value);
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  const exitCode = await runProductionReplayCli(process.argv.slice(2), {
    readText,
    executor: createProductionSshExecutor(),
    binaryBridge: createProductionBinarySshBridge(),
    writeOutput: (line) => process.stdout.write(`${line}\n`),
  });
  process.exitCode = exitCode;
}
