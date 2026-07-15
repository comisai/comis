// SPDX-License-Identifier: Apache-2.0
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { err, fromPromise, ok, tryCatch, type Result } from "@comis/shared";

import {
  CASSETTE_KINDS,
  DETERMINISTIC_SEQUENCE_KINDS,
  formatProductionReplayBundleManifest,
  type ProductionReplayBundleManifest,
  type ReplayBundleDeterminism,
} from "./production-bundle.js";
import {
  replayProductionTranscript,
  type ProductionReplayBundleAuthorityPort,
  type ProductionReplayEngineError,
  type ProductionReplayEnginePorts,
  type ProductionReplayEngineReport,
  type ProductionReplayPortCallContext,
} from "./production-replay-engine.js";

type MaybePromise<T> = T | Promise<T>;

const SHA256_RE = /^[a-f0-9]{64}$/u;
const SAFE_RUN_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const SAFE_ABSOLUTE_PATH_RE = /^\/[A-Za-z0-9._@+/-]+$/u;
const FIXED_REPLAY_USER = "comis-replay";
const FIXED_NODE_EXECUTABLE = "/usr/bin/node";
const FIXED_RUNTIME_ROOT = "/opt/comis-replay/runtimes";
const MAX_OPERATION_TIMEOUT_MS = 30 * 60 * 1_000;
const INVOCATION_TIMEOUT = Symbol("operational-replay-invocation-timeout");
const PROCESS_PLAN_INPUT_KEYS = [
  "runId",
  "baselinePath",
  "workspaceRoot",
  "workspacePrecondition",
  "expectedBuildDigestSha256",
  "runTimeoutMs",
  "cleanupTimeoutMs",
] as const;
const CONTROLLER_REQUEST_KEYS = [
  ...PROCESS_PLAN_INPUT_KEYS,
  "sealedBundleEnvelope",
  "sourceMachineIdSha256",
  "targetMachineIdSha256",
  "expectedManifestDigestSha256",
  "expectedBaselineDigestSha256",
  "expectedTranscriptBlobDigestSha256",
  "expectedCassetteSetDigestSha256",
  "maxEventLagMs",
  "portCallTimeoutMs",
  "quiescenceTimeoutMs",
] as const;

export const OPERATIONAL_REPLAY_PREREQUISITE_BLOCKERS = [
  "manifest_binding_mismatch",
  "capture_not_prospective",
  "checkpoint_evidence_missing",
  "runtime_evidence_incomplete",
  "baseline_evidence_incomplete",
  "transcript_evidence_incomplete",
  "deterministic_sequence_evidence_incomplete",
  "cassette_evidence_incomplete",
  "bundle_not_deterministic_exact",
] as const;

export type OperationalReplayPrerequisiteBlocker =
  (typeof OPERATIONAL_REPLAY_PREREQUISITE_BLOCKERS)[number];

export const OPERATIONAL_REPLAY_EXACT_BLOCKERS = [
  "generic_contract_is_not_operational_attestation",
  "reproduction_fidelity_mismatched",
  "quiescence_not_verified",
  "baseline_mutated",
  "isolation_boundary_breached",
  "outbound_not_record_only",
] as const;

export type OperationalReplayExactBlocker =
  (typeof OPERATIONAL_REPLAY_EXACT_BLOCKERS)[number];

export interface OperationalReplayProcessPlanInput {
  readonly runId: string;
  readonly baselinePath: string;
  readonly workspaceRoot: string;
  readonly workspacePrecondition: "must_be_absent";
  readonly expectedBuildDigestSha256: string;
  readonly runTimeoutMs: number;
  readonly cleanupTimeoutMs: number;
}

export interface OperationalReplayProcessPlan {
  readonly mode: "isolated_one_shot";
  /** This is a requirements document, not an executable command. */
  readonly executionReadiness: "non_executable_until_concrete_adapter";
  readonly requiredNodeExecutable: "/usr/bin/node";
  readonly requiredRuntimeEntryPoint: string;
  readonly sandboxDirectives: readonly string[];
  readonly unitName: string;
  readonly baselinePath: string;
  readonly workspacePath: string;
  readonly writableClonePath: string;
  readonly network: "closed";
  readonly providers: "cassette_only";
  readonly channels: "injected_only";
  readonly scheduler: "transcript_only";
  readonly outbound: "record_only";
  readonly normalServicePolicy: "never_touch";
  readonly workspacePrecondition: "must_be_absent";
  readonly digestSha256: string;
}

export interface OperationalReplayControllerRequest
  extends OperationalReplayProcessPlanInput {
  readonly sealedBundleEnvelope: string;
  readonly sourceMachineIdSha256: string;
  readonly targetMachineIdSha256: string;
  readonly expectedManifestDigestSha256: string;
  readonly expectedBaselineDigestSha256: string;
  readonly expectedTranscriptBlobDigestSha256: string;
  readonly expectedCassetteSetDigestSha256: string;
  readonly maxEventLagMs: number;
  readonly portCallTimeoutMs: number;
  readonly quiescenceTimeoutMs: number;
}

export interface OperationalReplayWorkerFailure {
  readonly kind: "worker_failure";
  readonly failureDigestSha256: string;
}

export interface OperationalReplayWorkerOpenAttestation {
  /** Worker-reported evidence is never an operational exactness authority. */
  readonly provenance: "injectable_worker_report";
  readonly workerKind: "injectable_contract";
  readonly machineIdSha256: string;
  readonly manifestDigestSha256: string;
  readonly buildDigestSha256: string;
  readonly baselineDigestBeforeSha256: string;
  readonly sourceTranscriptBlobDigestSha256: string;
  readonly cassetteSetDigestSha256: string;
  readonly processPlanDigestSha256: string;
  readonly baselinePath: string;
  readonly writableClonePath: string;
  readonly writableCloneInitialDigestSha256: string;
  readonly cloneIsolation: "independent_or_reflink_cow";
  readonly workspaceCreatedFresh: boolean;
  readonly preexistingWorkspaceDetected: boolean;
  readonly baselineImmutable: boolean;
  readonly writableClone: boolean;
  readonly processStarted: boolean;
  readonly normalServiceTouched: boolean;
  readonly network: "closed";
  readonly providers: "cassette_only";
  readonly channels: "injected_only";
  readonly scheduler: "transcript_only";
  readonly outbound: "record_only";
}

export interface OperationalReplayWorkerSession {
  readonly attestation: OperationalReplayWorkerOpenAttestation;
  readonly replayPorts: Omit<ProductionReplayEnginePorts, "bundleAuthority">;
}

export interface OperationalReplayWorkerCompletionAttestation {
  readonly provenance: "injectable_worker_report";
  readonly machineIdSha256: string;
  readonly processPlanDigestSha256: string;
  readonly baselineDigestAfterSha256: string;
  readonly actualTranscriptDigestSha256: string;
  readonly reproductionOutcomeDigestSha256: string;
  readonly quiescent: boolean;
  readonly processExited: boolean;
  readonly normalServiceTouched: boolean;
  readonly prohibitedBoundaryAttemptCount: number;
  readonly outboundAttemptCount: number;
  readonly recordedOutboundCount: number;
  readonly liveOutboundCount: number;
}

export interface OperationalReplayWorkerCleanupAttestation {
  readonly provenance: "injectable_worker_report";
  readonly processPlanDigestSha256: string;
  readonly processTerminated: boolean;
  readonly unitCollected: boolean;
  readonly writableCloneDetached: boolean;
  readonly normalServiceTouched: boolean;
}

export interface OperationalReplayWorkerPort {
  /**
   * Opens a control session and returns without waiting for replay completion.
   * Implementations of this port cannot authorize an exactness claim.
   */
  open(
    input: {
      readonly runId: string;
      readonly processPlan: OperationalReplayProcessPlan;
      readonly manifest: ProductionReplayBundleManifest;
    },
    context: ProductionReplayPortCallContext,
  ): MaybePromise<Result<OperationalReplayWorkerSession, OperationalReplayWorkerFailure>>;
  awaitQuiescence(
    input: {
      readonly runId: string;
      readonly processPlanDigestSha256: string;
      readonly actualTranscriptDigestSha256: string;
      readonly reproductionOutcomeDigestSha256: string;
    },
    context: ProductionReplayPortCallContext,
  ): MaybePromise<
    Result<OperationalReplayWorkerCompletionAttestation, OperationalReplayWorkerFailure>
  >;
  stop(
    input: {
      readonly runId: string;
      readonly processPlanDigestSha256: string;
      readonly outcome: "completed" | "failed" | "timed_out";
    },
    context: ProductionReplayPortCallContext,
  ): MaybePromise<
    Result<OperationalReplayWorkerCleanupAttestation, OperationalReplayWorkerFailure>
  >;
}

export interface OperationalReplayControllerPorts {
  readonly bundleAuthority: ProductionReplayBundleAuthorityPort;
  readonly worker: OperationalReplayWorkerPort;
}

export interface OperationalReplayResultSeal {
  readonly algorithm: "hmac-sha256";
  readonly canonicalization: "comis-json-c14n-v1";
  readonly keyIdSha256: string;
  readonly payloadDigestSha256: string;
  readonly authenticationTagSha256: string;
}

export interface OperationalReplayEngineOutcome {
  readonly status: ProductionReplayEngineReport["status"];
  readonly correctness: ProductionReplayEngineReport["correctness"];
  readonly fidelity: ProductionReplayEngineReport["fidelity"];
  readonly expectedTranscriptDigestSha256: string;
  readonly actualTranscriptDigestSha256: string;
  readonly expectedStateDigestSha256: string;
  readonly actualStateDigestSha256: string;
  readonly hardOracleDigestSha256: string;
  readonly expectedEventCount: number;
  readonly observedEventCount: number;
  readonly injectedTriggerCount: number;
  readonly outputCount: number;
  readonly finalStateRecordCount: number;
  readonly deterministicConsumptionCount: number;
  readonly hardOracleCheckCount: number;
  readonly hardOracleFailedCount: number;
  readonly reportDigestSha256: string;
}

export interface OperationalReplayReproductionOutcome {
  readonly status: "matched" | "mismatched";
  readonly fidelity: ProductionReplayEngineReport["fidelity"];
  readonly transcriptMatched: boolean;
  readonly stateMatched: boolean;
  readonly eventCountMatched: boolean;
}

export interface OperationalReplayDesiredCorrectnessOutcome {
  readonly status: "passed" | "failed";
  readonly checkCount: number;
  readonly failedCheckCount: number;
  readonly evidenceDigestSha256: string;
}

interface OperationalReplayUnsignedResultBase {
  readonly schema: "comis-operational-replay-result";
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly manifestDigestSha256: string;
  readonly sourceMachineIdSha256: string;
  readonly targetMachineIdSha256: string;
  readonly buildDigestSha256: string;
  readonly baselineDigestBeforeSha256: string;
  readonly baselineDigestAfterSha256: string;
  readonly sourceTranscriptBlobDigestSha256: string;
  readonly actualTranscriptDigestSha256: string;
  readonly cassetteSetDigestSha256: string;
  readonly processPlanDigestSha256: string;
  readonly reproductionOutcomeDigestSha256: string;
  readonly engine: OperationalReplayEngineOutcome;
  readonly reproduction: OperationalReplayReproductionOutcome;
  readonly desiredCorrectness: OperationalReplayDesiredCorrectnessOutcome;
  readonly cleanup: OperationalReplayWorkerCleanupAttestation;
}

export interface OperationalReplayInexactUnsignedResult
  extends OperationalReplayUnsignedResultBase {
  readonly status: "not_exact";
  readonly exact: false;
  readonly exactBlockers: readonly OperationalReplayExactBlocker[];
}

export type OperationalReplayUnsignedResult = OperationalReplayInexactUnsignedResult;

export type OperationalReplayResult = OperationalReplayUnsignedResult & {
  readonly seal: OperationalReplayResultSeal;
};

export type OperationalReplayControllerError =
  | {
      readonly kind: "invalid_request";
      readonly field: string;
      readonly evidenceDigestSha256: string;
    }
  | {
      readonly kind: "bundle_authentication_failed";
      readonly evidenceDigestSha256: string;
    }
  | {
      readonly kind: "prerequisite_blocked";
      readonly blockers: readonly OperationalReplayPrerequisiteBlocker[];
      readonly evidenceDigestSha256: string;
    }
  | {
      readonly kind: "worker_failed";
      readonly phase: "open" | "quiescence";
      readonly failureDigestSha256: string;
    }
  | {
      readonly kind: "worker_timeout";
      readonly phase: "open" | "execution" | "quiescence";
      readonly evidenceDigestSha256: string;
    }
  | {
      readonly kind: "worker_attestation_invalid";
      readonly phase: "open" | "quiescence";
      readonly evidenceDigestSha256: string;
    }
  | {
      readonly kind: "replay_engine_failed";
      readonly engineErrorKind: ProductionReplayEngineError["kind"];
      readonly evidenceDigestSha256: string;
    }
  | {
      readonly kind: "cleanup_failed";
      readonly failureDigestSha256: string;
    };

interface InvocationFailure {
  readonly kind: "thrown" | "timeout";
  readonly evidenceDigestSha256: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return "null";
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function evidenceDigest(code: string): string {
  return sha256(`comis-operational-replay-v1\0${code}`);
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && SHA256_RE.test(value);
}

function isPositiveTimeout(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= MAX_OPERATION_TIMEOUT_MS
  );
}

function isSafeAbsolutePath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value === "/" ||
    value.endsWith("/") ||
    !SAFE_ABSOLUTE_PATH_RE.test(value)
  ) {
    return false;
  }
  return value
    .slice(1)
    .split("/")
    .every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function appendPath(base: string, segment: string): string {
  return `${base}/${segment}`;
}

function pathsOverlap(left: string, right: string): boolean {
  return (
    left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
  );
}

function invalidPlan(
  field: string,
): Result<never, Extract<OperationalReplayControllerError, { kind: "invalid_request" }>> {
  return err({
    kind: "invalid_request",
    field,
    evidenceDigestSha256: evidenceDigest(`invalid-${field}`),
  });
}

export function buildOperationalReplayProcessPlan(
  input: OperationalReplayProcessPlanInput,
): Result<
  OperationalReplayProcessPlan,
  Extract<OperationalReplayControllerError, { kind: "invalid_request" }>
> {
  if (!isRecord(input) || !hasExactKeys(input, PROCESS_PLAN_INPUT_KEYS)) {
    return invalidPlan("shape");
  }
  if (!SAFE_RUN_ID_RE.test(input.runId)) {
    return invalidPlan("runId");
  }
  if (!isSafeAbsolutePath(input.baselinePath)) return invalidPlan("baselinePath");
  if (!isSafeAbsolutePath(input.workspaceRoot)) return invalidPlan("workspaceRoot");
  if (pathsOverlap(input.baselinePath, input.workspaceRoot)) {
    return invalidPlan("workspaceRoot");
  }
  if (input.workspacePrecondition !== "must_be_absent") {
    return invalidPlan("workspacePrecondition");
  }
  if (!isDigest(input.expectedBuildDigestSha256)) {
    return invalidPlan("expectedBuildDigestSha256");
  }
  if (!isPositiveTimeout(input.runTimeoutMs)) return invalidPlan("runTimeoutMs");
  if (!isPositiveTimeout(input.cleanupTimeoutMs)) {
    return invalidPlan("cleanupTimeoutMs");
  }
  const workspacePath = appendPath(input.workspaceRoot, input.runId);
  const writableClonePath = appendPath(workspacePath, "data");
  const unitName = `comis-replay-${input.runId}`;
  const runSeconds = Math.max(1, Math.ceil(input.runTimeoutMs / 1_000));
  const cleanupSeconds = Math.max(1, Math.ceil(input.cleanupTimeoutMs / 1_000));
  const requiredRuntimeEntryPoint = `${FIXED_RUNTIME_ROOT}/${input.expectedBuildDigestSha256}/node_modules/@comis/replay/dist/one-shot-worker.js`;
  const sandboxDirectives = [
    "PrivateNetwork=yes",
    "IPAddressDeny=any",
    "RestrictAddressFamilies=AF_UNIX",
    `User=${FIXED_REPLAY_USER}`,
    `Group=${FIXED_REPLAY_USER}`,
    "UMask=0077",
    "StandardOutput=null",
    "StandardError=null",
    "NoNewPrivileges=yes",
    "ProtectSystem=strict",
    "ProtectHome=yes",
    "PrivateTmp=yes",
    "PrivateDevices=yes",
    "ProtectKernelTunables=yes",
    "ProtectKernelModules=yes",
    "ProtectControlGroups=yes",
    "LockPersonality=yes",
    "RestrictSUIDSGID=yes",
    "InaccessiblePaths=/run/comis /run/dbus/system_bus_socket /run/systemd/private",
    "KillMode=mixed",
    "MemoryMax=2147483648",
    "TasksMax=128",
    "CPUQuota=200%",
    "LimitNOFILE=1024",
    "LimitFSIZE=67108864",
    `RuntimeMaxSec=${runSeconds}s`,
    `TimeoutStopSec=${cleanupSeconds}s`,
    `ReadOnlyPaths=${input.baselinePath}`,
    `ReadWritePaths=${workspacePath}`,
  ] as const;
  const unsigned = {
    mode: "isolated_one_shot",
    executionReadiness: "non_executable_until_concrete_adapter",
    requiredNodeExecutable: FIXED_NODE_EXECUTABLE,
    requiredRuntimeEntryPoint,
    sandboxDirectives,
    unitName,
    baselinePath: input.baselinePath,
    workspacePath,
    writableClonePath,
    network: "closed",
    providers: "cassette_only",
    channels: "injected_only",
    scheduler: "transcript_only",
    outbound: "record_only",
    normalServicePolicy: "never_touch",
    workspacePrecondition: "must_be_absent",
  } as const;
  return ok({ ...unsigned, digestSha256: sha256(canonicalJson(unsigned)) });
}

export function digestOperationalReplayCassetteSet(
  determinism: ReplayBundleDeterminism,
): string {
  return sha256(
    `comis-operational-replay-cassette-set-v1\0${canonicalJson(determinism)}`,
  );
}

function collectPrerequisiteBlockers(
  request: OperationalReplayControllerRequest,
  manifest: ProductionReplayBundleManifest,
): readonly OperationalReplayPrerequisiteBlocker[] {
  const blockers: OperationalReplayPrerequisiteBlocker[] = [];
  const manifestBound =
    manifest.seal.manifestDigestSha256 === request.expectedManifestDigestSha256 &&
    manifest.attestations.source.machineIdSha256 === request.sourceMachineIdSha256 &&
    manifest.attestations.target.machineIdSha256 === request.targetMachineIdSha256 &&
    manifest.attestations.runtime.target.digestSha256 ===
      request.expectedBuildDigestSha256 &&
    manifest.attestations.state.target.treeDigestSha256 ===
      request.expectedBaselineDigestSha256 &&
    manifest.transcript.blobDigestSha256 ===
      request.expectedTranscriptBlobDigestSha256 &&
    digestOperationalReplayCassetteSet(manifest.determinism) ===
      request.expectedCassetteSetDigestSha256;
  if (!manifestBound) blockers.push("manifest_binding_mismatch");
  if (manifest.episode.captureMode !== "prospective_window") {
    blockers.push("capture_not_prospective");
  }
  if (manifest.episode.initialCheckpointSnapshotManifestDigestSha256 === null) {
    blockers.push("checkpoint_evidence_missing");
  }
  if (!manifest.attestations.runtime.exact) {
    blockers.push("runtime_evidence_incomplete");
  }
  if (!manifest.attestations.state.exact) {
    blockers.push("baseline_evidence_incomplete");
  }
  if (
    manifest.transcript.authorities.some(
      (authority) =>
        authority.status !== "available" ||
        authority.authoritativeCount === null ||
        authority.authoritativeCount !== authority.transcriptCount ||
        authority.gapReasons.length > 0,
    )
  ) {
    blockers.push("transcript_evidence_incomplete");
  }
  if (
    DETERMINISTIC_SEQUENCE_KINDS.some((kind) => {
      const sequence = manifest.determinism.sequences.find(
        (candidate) => candidate.kind === kind,
      );
      return (
        sequence === undefined ||
        sequence.status !== "captured" ||
        sequence.blobDigestSha256 === null ||
        sequence.gapReason !== null
      );
    })
  ) {
    blockers.push("deterministic_sequence_evidence_incomplete");
  }
  if (
    CASSETTE_KINDS.some((kind) => {
      const authority = manifest.determinism.cassetteAuthorities.find(
        (candidate) => candidate.kind === kind,
      );
      return (
        authority === undefined ||
        authority.status !== "captured" ||
        authority.authoritativeCount === null ||
        authority.authoritativeCount !== authority.cassetteCount ||
        authority.gapReason !== null
      );
    })
  ) {
    blockers.push("cassette_evidence_incomplete");
  }
  if (
    manifest.episode.target !== "deterministic_cassette" ||
    manifest.episode.classification !== "deterministic_cassette_exact" ||
    !manifest.episode.exactEligible ||
    manifest.fidelity.target !== "deterministic_cassette" ||
    manifest.fidelity.classification !== "deterministic_cassette_exact" ||
    !manifest.fidelity.exactEligible ||
    manifest.fidelity.gaps.length > 0
  ) {
    blockers.push("bundle_not_deterministic_exact");
  }
  return blockers;
}

function safeThrownDigest(value: unknown): string {
  return value instanceof Error
    ? sha256(`comis-operational-replay-thrown-v1\0${value.name}\0${value.message}`)
    : evidenceDigest("non-error-thrown");
}

async function invokeBounded<T>(
  operation: (context: ProductionReplayPortCallContext) => MaybePromise<T>,
  timeoutMs: number,
): Promise<Result<T, InvocationFailure>> {
  const controller = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const deadlineAtMs = Date.now() + timeoutMs;
  const timedOut = new Promise<typeof INVOCATION_TIMEOUT>((resolve) => {
    timeoutHandle = setTimeout(() => {
      controller.abort();
      resolve(INVOCATION_TIMEOUT);
    }, timeoutMs);
  });
  const attempted = await fromPromise(
    Promise.race([
      Promise.resolve().then(() =>
        operation({ signal: controller.signal, deadlineAtMs }),
      ),
      timedOut,
    ]),
  );
  if (timeoutHandle !== null) clearTimeout(timeoutHandle);
  if (!attempted.ok) {
    return err({ kind: "thrown", evidenceDigestSha256: safeThrownDigest(attempted.error) });
  }
  if (attempted.value === INVOCATION_TIMEOUT) {
    return err({ kind: "timeout", evidenceDigestSha256: evidenceDigest("timeout") });
  }
  return ok(attempted.value as T);
}

function isPortResult<T>(value: unknown): value is Result<T, OperationalReplayWorkerFailure> {
  return (
    isRecord(value) &&
    (value.ok === true ||
      (value.ok === false &&
        isRecord(value.error) &&
        value.error.kind === "worker_failure" &&
        isDigest(value.error.failureDigestSha256)))
  );
}

function replayPortsArePresent(
  value: unknown,
): value is Omit<ProductionReplayEnginePorts, "bundleAuthority"> {
  if (!isRecord(value)) return false;
  return (
    isRecord(value.artifacts) &&
    typeof value.artifacts.resolve === "function" &&
    isRecord(value.checkpoint) &&
    typeof value.checkpoint.attest === "function" &&
    isRecord(value.driver) &&
    typeof value.driver.start === "function" &&
    typeof value.driver.injectTrigger === "function" &&
    typeof value.driver.finish === "function" &&
    typeof value.driver.stop === "function" &&
    isRecord(value.observer) &&
    typeof value.observer.start === "function" &&
    typeof value.observer.nextEvent === "function" &&
    typeof value.observer.finish === "function" &&
    typeof value.observer.stop === "function" &&
    isRecord(value.hardOracle) &&
    typeof value.hardOracle.evaluate === "function"
  );
}

function validOpenAttestation(
  session: unknown,
  request: OperationalReplayControllerRequest,
  plan: OperationalReplayProcessPlan,
): session is OperationalReplayWorkerSession {
  if (!isRecord(session) || !isRecord(session.attestation)) return false;
  const value = session.attestation;
  return (
    value.provenance === "injectable_worker_report" &&
    value.workerKind === "injectable_contract" &&
    value.machineIdSha256 === request.targetMachineIdSha256 &&
    value.manifestDigestSha256 === request.expectedManifestDigestSha256 &&
    value.buildDigestSha256 === request.expectedBuildDigestSha256 &&
    value.baselineDigestBeforeSha256 === request.expectedBaselineDigestSha256 &&
    value.sourceTranscriptBlobDigestSha256 ===
      request.expectedTranscriptBlobDigestSha256 &&
    value.cassetteSetDigestSha256 === request.expectedCassetteSetDigestSha256 &&
    value.processPlanDigestSha256 === plan.digestSha256 &&
    value.baselinePath === plan.baselinePath &&
    value.writableClonePath === plan.writableClonePath &&
    value.writableCloneInitialDigestSha256 ===
      request.expectedBaselineDigestSha256 &&
    value.cloneIsolation === "independent_or_reflink_cow" &&
    value.workspaceCreatedFresh === true &&
    value.preexistingWorkspaceDetected === false &&
    value.baselineImmutable === true &&
    value.writableClone === true &&
    typeof value.processStarted === "boolean" &&
    value.normalServiceTouched === false &&
    value.network === "closed" &&
    value.providers === "cassette_only" &&
    value.channels === "injected_only" &&
    value.scheduler === "transcript_only" &&
    value.outbound === "record_only" &&
    replayPortsArePresent(session.replayPorts)
  );
}

function engineOutcome(report: ProductionReplayEngineReport): OperationalReplayEngineOutcome {
  return {
    status: report.status,
    correctness: report.correctness,
    fidelity: report.fidelity,
    expectedTranscriptDigestSha256: report.expectedTranscriptDigestSha256,
    actualTranscriptDigestSha256: report.actualTranscriptDigestSha256,
    expectedStateDigestSha256: report.expectedStateDigestSha256,
    actualStateDigestSha256: report.actualStateDigestSha256,
    hardOracleDigestSha256: report.hardOracleDigestSha256,
    expectedEventCount: report.expectedEventCount,
    observedEventCount: report.observedEventCount,
    injectedTriggerCount: report.injectedTriggerCount,
    outputCount: report.outputCount,
    finalStateRecordCount: report.finalStateRecordCount,
    deterministicConsumptionCount: report.deterministicConsumptionCount,
    hardOracleCheckCount: report.hardOracleCheckCount,
    hardOracleFailedCount: report.hardOracleFailedCount,
    reportDigestSha256: sha256(canonicalJson(report)),
  };
}

function reproductionEvidenceDigest(report: ProductionReplayEngineReport): string {
  return sha256(
    canonicalJson({
      actualTranscriptDigestSha256: report.actualTranscriptDigestSha256,
      actualStateDigestSha256: report.actualStateDigestSha256,
      observedEventCount: report.observedEventCount,
      outputCount: report.outputCount,
      finalStateRecordCount: report.finalStateRecordCount,
    }),
  );
}

function validCompletionAttestation(
  value: unknown,
  request: OperationalReplayControllerRequest,
  plan: OperationalReplayProcessPlan,
  report: ProductionReplayEngineReport,
  outcomeDigestSha256: string,
): value is OperationalReplayWorkerCompletionAttestation {
  return (
    isRecord(value) &&
    value.provenance === "injectable_worker_report" &&
    value.machineIdSha256 === request.targetMachineIdSha256 &&
    value.processPlanDigestSha256 === plan.digestSha256 &&
    isDigest(value.baselineDigestAfterSha256) &&
    value.actualTranscriptDigestSha256 === report.actualTranscriptDigestSha256 &&
    value.reproductionOutcomeDigestSha256 === outcomeDigestSha256 &&
    typeof value.quiescent === "boolean" &&
    typeof value.processExited === "boolean" &&
    typeof value.normalServiceTouched === "boolean" &&
    Number.isSafeInteger(value.prohibitedBoundaryAttemptCount) &&
    (value.prohibitedBoundaryAttemptCount as number) >= 0 &&
    Number.isSafeInteger(value.outboundAttemptCount) &&
    (value.outboundAttemptCount as number) >= 0 &&
    Number.isSafeInteger(value.recordedOutboundCount) &&
    (value.recordedOutboundCount as number) >= 0 &&
    Number.isSafeInteger(value.liveOutboundCount) &&
    (value.liveOutboundCount as number) >= 0
  );
}

function validCleanupAttestation(
  value: unknown,
  plan: OperationalReplayProcessPlan,
): value is OperationalReplayWorkerCleanupAttestation {
  return (
    isRecord(value) &&
    value.provenance === "injectable_worker_report" &&
    value.processPlanDigestSha256 === plan.digestSha256 &&
    value.processTerminated === true &&
    value.unitCollected === true &&
    value.writableCloneDetached === true &&
    value.normalServiceTouched === false
  );
}

async function stopWorker(
  request: OperationalReplayControllerRequest,
  plan: OperationalReplayProcessPlan,
  worker: OperationalReplayWorkerPort,
  outcome: "completed" | "failed" | "timed_out",
): Promise<
  Result<
    OperationalReplayWorkerCleanupAttestation,
    Extract<OperationalReplayControllerError, { kind: "cleanup_failed" }>
  >
> {
  const attempted = await invokeBounded(
    (context) =>
      worker.stop(
        {
          runId: request.runId,
          processPlanDigestSha256: plan.digestSha256,
          outcome,
        },
        context,
      ),
    request.cleanupTimeoutMs,
  );
  if (
    !attempted.ok ||
    !isPortResult<OperationalReplayWorkerCleanupAttestation>(attempted.value) ||
    !attempted.value.ok ||
    !validCleanupAttestation(attempted.value.value, plan)
  ) {
    const failureDigestSha256 = !attempted.ok
      ? attempted.error.evidenceDigestSha256
      : isPortResult<OperationalReplayWorkerCleanupAttestation>(attempted.value) &&
          !attempted.value.ok
        ? attempted.value.error.failureDigestSha256
        : evidenceDigest("cleanup-attestation");
    return err({ kind: "cleanup_failed", failureDigestSha256 });
  }
  return ok(attempted.value.value);
}

function reproductionOutcome(
  report: ProductionReplayEngineReport,
): OperationalReplayReproductionOutcome {
  const transcriptMatched =
    report.expectedTranscriptDigestSha256 === report.actualTranscriptDigestSha256;
  const stateMatched =
    report.expectedStateDigestSha256 === report.actualStateDigestSha256;
  const eventCountMatched = report.expectedEventCount === report.observedEventCount;
  return {
    status:
      transcriptMatched && stateMatched && eventCountMatched
        ? "matched"
        : "mismatched",
    fidelity: report.fidelity,
    transcriptMatched,
    stateMatched,
    eventCountMatched,
  };
}

function desiredCorrectnessOutcome(
  report: ProductionReplayEngineReport,
): OperationalReplayDesiredCorrectnessOutcome {
  return {
    status: report.correctness,
    checkCount: report.hardOracleCheckCount,
    failedCheckCount: report.hardOracleFailedCount,
    evidenceDigestSha256: report.hardOracleDigestSha256,
  };
}

function collectExactBlockers(
  request: OperationalReplayControllerRequest,
  report: ProductionReplayEngineReport,
  completion: OperationalReplayWorkerCompletionAttestation,
): readonly OperationalReplayExactBlocker[] {
  const blockers: OperationalReplayExactBlocker[] = [
    "generic_contract_is_not_operational_attestation",
  ];
  if (reproductionOutcome(report).status !== "matched") {
    blockers.push("reproduction_fidelity_mismatched");
  }
  if (!completion.quiescent || !completion.processExited) {
    blockers.push("quiescence_not_verified");
  }
  if (completion.baselineDigestAfterSha256 !== request.expectedBaselineDigestSha256) {
    blockers.push("baseline_mutated");
  }
  if (
    completion.normalServiceTouched ||
    completion.prohibitedBoundaryAttemptCount !== 0
  ) {
    blockers.push("isolation_boundary_breached");
  }
  if (
    completion.liveOutboundCount !== 0 ||
    completion.outboundAttemptCount !== completion.recordedOutboundCount
  ) {
    blockers.push("outbound_not_record_only");
  }
  return blockers;
}

function sealResult(
  unsigned: OperationalReplayUnsignedResult,
  key: Uint8Array,
): Result<
  OperationalReplayResult,
  Extract<OperationalReplayControllerError, { kind: "invalid_request" }>
> {
  if (!(key instanceof Uint8Array) || key.byteLength < 32 || key.byteLength > 64) {
    return invalidPlan("resultSealKey");
  }
  const canonical = canonicalJson(unsigned);
  const seal: OperationalReplayResultSeal = {
    algorithm: "hmac-sha256",
    canonicalization: "comis-json-c14n-v1",
    keyIdSha256: createHash("sha256")
      .update("comis-operational-replay-result-key-v1\0")
      .update(key)
      .digest("hex"),
    payloadDigestSha256: sha256(canonical),
    authenticationTagSha256: createHmac("sha256", key)
      .update(canonical)
      .digest("hex"),
  };
  return ok({ ...unsigned, seal });
}

export function verifyOperationalReplayResultSeal(
  result: unknown,
  key: Uint8Array,
): boolean {
  if (
    !isRecord(result) ||
    !isRecord(result.seal) ||
    result.status !== "not_exact" ||
    result.exact !== false ||
    !Array.isArray(result.exactBlockers) ||
    !result.exactBlockers.includes(
      "generic_contract_is_not_operational_attestation",
    ) ||
    !(key instanceof Uint8Array) ||
    key.byteLength < 32 ||
    key.byteLength > 64
  ) {
    return false;
  }
  const seal = result.seal;
  if (
    Object.keys(seal).length !== 5 ||
    seal.algorithm !== "hmac-sha256" ||
    seal.canonicalization !== "comis-json-c14n-v1" ||
    !isDigest(seal.keyIdSha256) ||
    !isDigest(seal.payloadDigestSha256) ||
    !isDigest(seal.authenticationTagSha256)
  ) {
    return false;
  }
  const { seal: _seal, ...unsigned } = result;
  const canonical = canonicalJson(unsigned);
  const expectedKeyIdSha256 = createHash("sha256")
    .update("comis-operational-replay-result-key-v1\0")
    .update(key)
    .digest("hex");
  const expectedPayloadDigestSha256 = sha256(canonical);
  const expectedAuthenticationTagSha256 = createHmac("sha256", key)
    .update(canonical)
    .digest("hex");
  return (
    timingSafeEqual(
      Buffer.from(seal.keyIdSha256, "hex"),
      Buffer.from(expectedKeyIdSha256, "hex"),
    ) &&
    timingSafeEqual(
      Buffer.from(seal.payloadDigestSha256, "hex"),
      Buffer.from(expectedPayloadDigestSha256, "hex"),
    ) &&
    timingSafeEqual(
      Buffer.from(seal.authenticationTagSha256, "hex"),
      Buffer.from(expectedAuthenticationTagSha256, "hex"),
    )
  );
}

export async function runOperationalProductionReplay(
  request: OperationalReplayControllerRequest,
  ports: OperationalReplayControllerPorts,
  resultSealKey: Uint8Array,
): Promise<Result<OperationalReplayResult, OperationalReplayControllerError>> {
  if (!isRecord(request) || !hasExactKeys(request, CONTROLLER_REQUEST_KEYS)) {
    return invalidPlan("shape");
  }
  const planResult = buildOperationalReplayProcessPlan({
    runId: request.runId,
    baselinePath: request.baselinePath,
    workspaceRoot: request.workspaceRoot,
    workspacePrecondition: request.workspacePrecondition,
    expectedBuildDigestSha256: request.expectedBuildDigestSha256,
    runTimeoutMs: request.runTimeoutMs,
    cleanupTimeoutMs: request.cleanupTimeoutMs,
  });
  if (!planResult.ok) return planResult;
  if (
    !isDigest(request.sourceMachineIdSha256) ||
    !isDigest(request.targetMachineIdSha256) ||
    !isDigest(request.expectedManifestDigestSha256) ||
    !isDigest(request.expectedBuildDigestSha256) ||
    !isDigest(request.expectedBaselineDigestSha256) ||
    !isDigest(request.expectedTranscriptBlobDigestSha256) ||
    !isDigest(request.expectedCassetteSetDigestSha256) ||
    !isPositiveTimeout(request.maxEventLagMs) ||
    !isPositiveTimeout(request.portCallTimeoutMs) ||
    !isPositiveTimeout(request.quiescenceTimeoutMs)
  ) {
    return invalidPlan("attestation");
  }
  if (!(resultSealKey instanceof Uint8Array) || resultSealKey.byteLength < 32 || resultSealKey.byteLength > 64) {
    return invalidPlan("resultSealKey");
  }
  const plan = planResult.value;
  const verifiedAttempt = await invokeBounded(
    (context) => ports.bundleAuthority.verify(request.sealedBundleEnvelope, context),
    request.portCallTimeoutMs,
  );
  if (
    !verifiedAttempt.ok ||
    !isRecord(verifiedAttempt.value) ||
    verifiedAttempt.value.ok !== true ||
    !isRecord(verifiedAttempt.value.value) ||
    verifiedAttempt.value.value.authentication !== "verified" ||
    !isDigest(verifiedAttempt.value.value.authorityKeyIdSha256) ||
    !isRecord(verifiedAttempt.value.value.manifest) ||
    !isRecord(verifiedAttempt.value.value.manifest.seal) ||
    verifiedAttempt.value.value.manifest.seal.keyIdSha256 !==
      verifiedAttempt.value.value.authorityKeyIdSha256
  ) {
    return err({
      kind: "bundle_authentication_failed",
      evidenceDigestSha256: !verifiedAttempt.ok
        ? verifiedAttempt.error.evidenceDigestSha256
        : evidenceDigest("bundle-authentication"),
    });
  }
  const manifest = verifiedAttempt.value.value
    .manifest as unknown as ProductionReplayBundleManifest;
  const inspectedManifest = tryCatch(() => ({
    envelope: formatProductionReplayBundleManifest(manifest),
    blockers: collectPrerequisiteBlockers(request, manifest),
  }));
  if (
    !inspectedManifest.ok ||
    inspectedManifest.value.envelope !== request.sealedBundleEnvelope
  ) {
    return err({
      kind: "bundle_authentication_failed",
      evidenceDigestSha256: evidenceDigest("bundle-envelope-binding"),
    });
  }
  const prerequisiteBlockers = inspectedManifest.value.blockers;
  if (prerequisiteBlockers.length > 0) {
    return err({
      kind: "prerequisite_blocked",
      blockers: prerequisiteBlockers,
      evidenceDigestSha256: sha256(canonicalJson(prerequisiteBlockers)),
    });
  }

  const openAttempt = await invokeBounded(
    (context) =>
      ports.worker.open({ runId: request.runId, processPlan: plan, manifest }, context),
    request.portCallTimeoutMs,
  );
  if (!openAttempt.ok) {
    const cleanup = await stopWorker(
      request,
      plan,
      ports.worker,
      openAttempt.error.kind === "timeout" ? "timed_out" : "failed",
    );
    if (!cleanup.ok) return cleanup;
    return openAttempt.error.kind === "timeout"
      ? err({
          kind: "worker_timeout",
          phase: "open",
          evidenceDigestSha256: openAttempt.error.evidenceDigestSha256,
        })
      : err({
          kind: "worker_failed",
          phase: "open",
          failureDigestSha256: openAttempt.error.evidenceDigestSha256,
        });
  }
  if (!isPortResult<OperationalReplayWorkerSession>(openAttempt.value)) {
    const cleanup = await stopWorker(request, plan, ports.worker, "failed");
    if (!cleanup.ok) return cleanup;
    return err({
      kind: "worker_attestation_invalid",
      phase: "open",
      evidenceDigestSha256: evidenceDigest("open-result"),
    });
  }
  if (!openAttempt.value.ok) {
    const cleanup = await stopWorker(request, plan, ports.worker, "failed");
    if (!cleanup.ok) return cleanup;
    return err({
      kind: "worker_failed",
      phase: "open",
      failureDigestSha256: openAttempt.value.error.failureDigestSha256,
    });
  }
  const session = openAttempt.value.value;
  if (!validOpenAttestation(session, request, plan)) {
    const cleanup = await stopWorker(request, plan, ports.worker, "failed");
    if (!cleanup.ok) return cleanup;
    return err({
      kind: "worker_attestation_invalid",
      phase: "open",
      evidenceDigestSha256: evidenceDigest("open-attestation"),
    });
  }

  const cachedBundleAuthority: ProductionReplayBundleAuthorityPort = {
    verify: () =>
      ok({
        authentication: "verified",
        authorityKeyIdSha256: manifest.seal.keyIdSha256,
        manifest,
      }),
  };
  const engineAttempt = await invokeBounded(
    () =>
      replayProductionTranscript(
        {
          sealedBundleEnvelope: request.sealedBundleEnvelope,
          maxEventLagMs: request.maxEventLagMs,
          portCallTimeoutMs: request.portCallTimeoutMs,
        },
        { bundleAuthority: cachedBundleAuthority, ...session.replayPorts },
      ),
    request.runTimeoutMs,
  );
  if (!engineAttempt.ok) {
    const cleanup = await stopWorker(request, plan, ports.worker, "timed_out");
    if (!cleanup.ok) return cleanup;
    return err({
      kind: "worker_timeout",
      phase: "execution",
      evidenceDigestSha256: engineAttempt.error.evidenceDigestSha256,
    });
  }
  const engineResult = engineAttempt.value;
  if (!engineResult.ok) {
    const cleanup = await stopWorker(request, plan, ports.worker, "failed");
    if (!cleanup.ok) return cleanup;
    return err({
      kind: "replay_engine_failed",
      engineErrorKind: engineResult.error.kind,
      evidenceDigestSha256: sha256(canonicalJson(engineResult.error)),
    });
  }
  const report = engineResult.value;
  const outcomeDigestSha256 = reproductionEvidenceDigest(report);
  const quiescenceAttempt = await invokeBounded(
    (context) =>
      ports.worker.awaitQuiescence(
        {
          runId: request.runId,
          processPlanDigestSha256: plan.digestSha256,
          actualTranscriptDigestSha256: report.actualTranscriptDigestSha256,
          reproductionOutcomeDigestSha256: outcomeDigestSha256,
        },
        context,
      ),
    request.quiescenceTimeoutMs,
  );
  if (!quiescenceAttempt.ok) {
    const cleanup = await stopWorker(
      request,
      plan,
      ports.worker,
      quiescenceAttempt.error.kind === "timeout" ? "timed_out" : "failed",
    );
    if (!cleanup.ok) return cleanup;
    return quiescenceAttempt.error.kind === "timeout"
      ? err({
          kind: "worker_timeout",
          phase: "quiescence",
          evidenceDigestSha256: quiescenceAttempt.error.evidenceDigestSha256,
        })
      : err({
          kind: "worker_failed",
          phase: "quiescence",
          failureDigestSha256: quiescenceAttempt.error.evidenceDigestSha256,
        });
  }
  if (
    !isPortResult<OperationalReplayWorkerCompletionAttestation>(
      quiescenceAttempt.value,
    ) ||
    !quiescenceAttempt.value.ok ||
    !validCompletionAttestation(
      quiescenceAttempt.value.value,
      request,
      plan,
      report,
      outcomeDigestSha256,
    )
  ) {
    const cleanup = await stopWorker(request, plan, ports.worker, "failed");
    if (!cleanup.ok) return cleanup;
    const failureDigestSha256 =
      isPortResult<OperationalReplayWorkerCompletionAttestation>(
        quiescenceAttempt.value,
      ) && !quiescenceAttempt.value.ok
        ? quiescenceAttempt.value.error.failureDigestSha256
        : evidenceDigest("quiescence-attestation");
    if (
      isPortResult<OperationalReplayWorkerCompletionAttestation>(
        quiescenceAttempt.value,
      ) && !quiescenceAttempt.value.ok
    ) {
      return err({
        kind: "worker_failed",
        phase: "quiescence",
        failureDigestSha256,
      });
    }
    return err({
      kind: "worker_attestation_invalid",
      phase: "quiescence",
      evidenceDigestSha256: failureDigestSha256,
    });
  }
  const completion = quiescenceAttempt.value.value;
  const cleanup = await stopWorker(request, plan, ports.worker, "completed");
  if (!cleanup.ok) return cleanup;
  const exactBlockers = collectExactBlockers(request, report, completion);
  const base = {
    schema: "comis-operational-replay-result",
    schemaVersion: 1,
    runId: request.runId,
    manifestDigestSha256: request.expectedManifestDigestSha256,
    sourceMachineIdSha256: request.sourceMachineIdSha256,
    targetMachineIdSha256: request.targetMachineIdSha256,
    buildDigestSha256: request.expectedBuildDigestSha256,
    baselineDigestBeforeSha256: request.expectedBaselineDigestSha256,
    baselineDigestAfterSha256: completion.baselineDigestAfterSha256,
    sourceTranscriptBlobDigestSha256:
      request.expectedTranscriptBlobDigestSha256,
    actualTranscriptDigestSha256: report.actualTranscriptDigestSha256,
    cassetteSetDigestSha256: request.expectedCassetteSetDigestSha256,
    processPlanDigestSha256: plan.digestSha256,
    reproductionOutcomeDigestSha256: outcomeDigestSha256,
    engine: engineOutcome(report),
    reproduction: reproductionOutcome(report),
    desiredCorrectness: desiredCorrectnessOutcome(report),
    cleanup: cleanup.value,
  } as const;
  const unsigned: OperationalReplayUnsignedResult = {
    ...base,
    status: "not_exact",
    exact: false,
    exactBlockers,
  };
  return sealResult(unsigned, resultSealKey);
}
