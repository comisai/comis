// SPDX-License-Identifier: Apache-2.0
import { err, ok, tryCatch, type Result } from "@comis/shared";

const MAX_CAMPAIGN_BYTES = 4 * 1024 * 1024;
const MAX_CASES = 100_000;
const MAX_EVIDENCE_REFS = 64;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const SAFE_LABEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,511}$/u;
const SAFE_TEST_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._@+/-]{1,512}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

export type ProductionCampaignStatus = "ready" | "running" | "completed";
export type ProductionCampaignCaseStatus =
  | "pending"
  | "running"
  | "passed"
  | "passed_after_fix"
  | "coverage_gap"
  | "documented_finding";
export type ProductionCampaignFailureClass =
  | "comis_failure"
  | "false_success"
  | "hard_oracle_failure"
  | "observability_failure"
  | "replay_divergence";
export type ProductionCampaignGapClass =
  | "historical_capture_gap"
  | "provider_unavailable"
  | "unsupported_surface"
  | "non_durable_activity";
export type ProductionCampaignDefectStatus =
  | "observed"
  | "diagnosed"
  | "red"
  | "green"
  | "deployed"
  | "verified"
  | "documented";

export interface ProductionCampaignCase {
  readonly caseId: string;
  readonly status: ProductionCampaignCaseStatus;
  readonly replayRunId: string | null;
  readonly startedAtMs: number | null;
  readonly completedAtMs: number | null;
  readonly observedDigest: string | null;
  readonly expectedDigest: string | null;
  readonly oracleDigests: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly defectId: string | null;
  readonly gapClass: ProductionCampaignGapClass | null;
  readonly reasonDigest: string | null;
}

export interface ProductionCampaignDefect {
  readonly defectId: string;
  readonly caseId: string;
  readonly status: ProductionCampaignDefectStatus;
  readonly failureClass: ProductionCampaignFailureClass;
  readonly observedDigest: string;
  readonly expectedDigest: string;
  readonly rootCauseDigest: string | null;
  readonly authoritativeLayer: string | null;
  readonly evidenceRefs: readonly string[];
  readonly observabilityGap: "none" | "closed" | "open" | null;
  readonly testPath: string | null;
  readonly testCommandDigest: string | null;
  readonly prePatchOutputDigest: string | null;
  readonly failureShapeDigest: string | null;
  readonly greenOutputDigest: string | null;
  readonly patchDigest: string | null;
  readonly deployedRuntimeDigest: string | null;
  readonly deploymentDigest: string | null;
  readonly verificationRunId: string | null;
  readonly verificationOracleDigests: readonly string[];
  readonly forcedFailureDigest: string | null;
  readonly findingDigest: string | null;
  readonly openedAtMs: number;
  readonly updatedAtMs: number;
}

export interface ProductionCampaign {
  readonly schema: "comis-production-replay-campaign";
  readonly schemaVersion: 1;
  readonly campaignId: string;
  readonly captureId: string;
  readonly bundleDigest: string;
  readonly sourceRuntimeDigest: string;
  readonly targetRuntimeDigest: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly status: ProductionCampaignStatus;
  readonly exactEligible: boolean;
  readonly cursor: number;
  readonly openDefectId: string | null;
  readonly cases: readonly ProductionCampaignCase[];
  readonly defects: readonly ProductionCampaignDefect[];
}

export interface CreateProductionCampaignInput {
  readonly campaignId: string;
  readonly captureId: string;
  readonly bundleDigest: string;
  readonly sourceRuntimeDigest: string;
  readonly targetRuntimeDigest: string;
  readonly caseIds: readonly string[];
  readonly createdAtMs: number;
}

export type ProductionCampaignAction =
  | {
      readonly kind: "begin_case";
      readonly caseId: string;
      readonly replayRunId: string;
      readonly startedAtMs: number;
    }
  | {
      readonly kind: "record_pass";
      readonly caseId: string;
      readonly observedDigest: string;
      readonly expectedDigest: string;
      readonly oracleDigests: readonly string[];
      readonly evidenceRefs: readonly string[];
      readonly completedAtMs: number;
    }
  | {
      readonly kind: "record_failure";
      readonly caseId: string;
      readonly defectId: string;
      readonly failureClass: ProductionCampaignFailureClass;
      readonly observedDigest: string;
      readonly expectedDigest: string;
      readonly evidenceRefs: readonly string[];
      readonly recordedAtMs: number;
    }
  | {
      readonly kind: "record_gap";
      readonly caseId: string;
      readonly gapClass: ProductionCampaignGapClass;
      readonly reasonDigest: string;
      readonly evidenceRefs: readonly string[];
      readonly recordedAtMs: number;
    }
  | {
      readonly kind: "record_diagnosis";
      readonly defectId: string;
      readonly rootCauseDigest: string;
      readonly authoritativeLayer: string;
      readonly evidenceRefs: readonly string[];
      readonly observabilityGap: "none" | "open";
      readonly recordedAtMs: number;
    }
  | {
      readonly kind: "record_red";
      readonly defectId: string;
      readonly testPath: string;
      readonly testCommandDigest: string;
      readonly prePatchOutputDigest: string;
      readonly failureShapeDigest: string;
      readonly recordedAtMs: number;
    }
  | {
      readonly kind: "record_green";
      readonly defectId: string;
      readonly testPath: string;
      readonly testCommandDigest: string;
      readonly greenOutputDigest: string;
      readonly patchDigest: string;
      readonly recordedAtMs: number;
    }
  | {
      readonly kind: "record_deployment";
      readonly defectId: string;
      readonly runtimeDigest: string;
      readonly deploymentDigest: string;
      readonly deployedAtMs: number;
    }
  | {
      readonly kind: "verify_fix";
      readonly defectId: string;
      readonly replayRunId: string;
      readonly deployedRuntimeDigest: string;
      readonly observedDigest: string;
      readonly expectedDigest: string;
      readonly oracleDigests: readonly string[];
      readonly forcedFailureDigest: string;
      readonly observabilityVerified: boolean;
      readonly verifiedAtMs: number;
    }
  | {
      readonly kind: "document_finding";
      readonly defectId: string;
      readonly findingDigest: string;
      readonly evidenceRefs: readonly string[];
      readonly recordedAtMs: number;
    };

export type ProductionCampaignError =
  | { readonly kind: "invalid_campaign"; readonly message: string }
  | { readonly kind: "malformed_campaign"; readonly message: string }
  | { readonly kind: "invalid_action"; readonly message: string }
  | { readonly kind: "invalid_transition"; readonly message: string }
  | { readonly kind: "open_defect"; readonly message: string };

const CAMPAIGN_KEYS = [
  "schema",
  "schemaVersion",
  "campaignId",
  "captureId",
  "bundleDigest",
  "sourceRuntimeDigest",
  "targetRuntimeDigest",
  "createdAtMs",
  "updatedAtMs",
  "status",
  "exactEligible",
  "cursor",
  "openDefectId",
  "cases",
  "defects",
] as const;
const CASE_KEYS = [
  "caseId",
  "status",
  "replayRunId",
  "startedAtMs",
  "completedAtMs",
  "observedDigest",
  "expectedDigest",
  "oracleDigests",
  "evidenceRefs",
  "defectId",
  "gapClass",
  "reasonDigest",
] as const;
const DEFECT_KEYS = [
  "defectId",
  "caseId",
  "status",
  "failureClass",
  "observedDigest",
  "expectedDigest",
  "rootCauseDigest",
  "authoritativeLayer",
  "evidenceRefs",
  "observabilityGap",
  "testPath",
  "testCommandDigest",
  "prePatchOutputDigest",
  "failureShapeDigest",
  "greenOutputDigest",
  "patchDigest",
  "deployedRuntimeDigest",
  "deploymentDigest",
  "verificationRunId",
  "verificationOracleDigests",
  "forcedFailureDigest",
  "findingDigest",
  "openedAtMs",
  "updatedAtMs",
] as const;

const CASE_STATUSES = new Set<string>([
  "pending",
  "running",
  "passed",
  "passed_after_fix",
  "coverage_gap",
  "documented_finding",
]);
const DEFECT_STATUSES = new Set<string>([
  "observed",
  "diagnosed",
  "red",
  "green",
  "deployed",
  "verified",
  "documented",
]);
const FAILURE_CLASSES = new Set<string>([
  "comis_failure",
  "false_success",
  "hard_oracle_failure",
  "observability_failure",
  "replay_divergence",
]);
const GAP_CLASSES = new Set<string>([
  "historical_capture_gap",
  "provider_unavailable",
  "unsupported_surface",
  "non_durable_activity",
]);

function invalidCampaign(message: string): Result<never, ProductionCampaignError> {
  return err({ kind: "invalid_campaign", message });
}

function invalidAction(message: string): Result<never, ProductionCampaignError> {
  return err({ kind: "invalid_action", message });
}

function invalidTransition(message: string): Result<never, ProductionCampaignError> {
  return err({ kind: "invalid_transition", message });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isTime(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}

function isNullableDigest(value: unknown): value is string | null {
  return value === null || isDigest(value);
}

function isId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID.test(value);
}

function isNullableId(value: unknown): value is string | null {
  return value === null || isId(value);
}

function validEvidenceRefs(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_EVIDENCE_REFS &&
    value.every((entry) => typeof entry === "string" && SAFE_LABEL.test(entry)) &&
    new Set(value).size === value.length
  );
}

function validDigests(value: unknown, minimum = 0): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length >= minimum &&
    value.length <= MAX_EVIDENCE_REFS &&
    value.every(isDigest) &&
    new Set(value).size === value.length
  );
}

function actionTime(action: ProductionCampaignAction): number {
  switch (action.kind) {
    case "begin_case":
      return action.startedAtMs;
    case "record_pass":
      return action.completedAtMs;
    case "record_deployment":
      return action.deployedAtMs;
    case "verify_fix":
      return action.verifiedAtMs;
    case "record_failure":
    case "record_gap":
    case "record_diagnosis":
    case "record_red":
    case "record_green":
    case "document_finding":
      return action.recordedAtMs;
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

function emptyCase(caseId: string): ProductionCampaignCase {
  return {
    caseId,
    status: "pending",
    replayRunId: null,
    startedAtMs: null,
    completedAtMs: null,
    observedDigest: null,
    expectedDigest: null,
    oracleDigests: [],
    evidenceRefs: [],
    defectId: null,
    gapClass: null,
    reasonDigest: null,
  };
}

export function createProductionCampaign(
  input: CreateProductionCampaignInput,
): Result<ProductionCampaign, ProductionCampaignError> {
  if (
    !isId(input.campaignId) ||
    !isId(input.captureId) ||
    !isDigest(input.bundleDigest) ||
    !isDigest(input.sourceRuntimeDigest) ||
    !isDigest(input.targetRuntimeDigest) ||
    input.sourceRuntimeDigest !== input.targetRuntimeDigest ||
    !isTime(input.createdAtMs) ||
    input.caseIds.length === 0 ||
    input.caseIds.length > MAX_CASES ||
    input.caseIds.some((caseId) => !isId(caseId)) ||
    new Set(input.caseIds).size !== input.caseIds.length
  ) {
    return invalidCampaign("Production campaign input is invalid or runtime artifacts differ");
  }
  return ok({
    schema: "comis-production-replay-campaign",
    schemaVersion: 1,
    campaignId: input.campaignId,
    captureId: input.captureId,
    bundleDigest: input.bundleDigest,
    sourceRuntimeDigest: input.sourceRuntimeDigest,
    targetRuntimeDigest: input.targetRuntimeDigest,
    createdAtMs: input.createdAtMs,
    updatedAtMs: input.createdAtMs,
    status: "ready",
    exactEligible: true,
    cursor: 0,
    openDefectId: null,
    cases: input.caseIds.map(emptyCase),
    defects: [],
  });
}

function replaceCase(
  campaign: ProductionCampaign,
  caseIndex: number,
  replacement: ProductionCampaignCase,
  timestamp: number,
  extra: Partial<Pick<ProductionCampaign, "openDefectId" | "exactEligible">> = {},
): ProductionCampaign {
  const cases = campaign.cases.map((item, index) => (index === caseIndex ? replacement : item));
  const terminal = replacement.status !== "running" && replacement.status !== "pending";
  const cursor = terminal && caseIndex === campaign.cursor ? campaign.cursor + 1 : campaign.cursor;
  return {
    ...campaign,
    ...extra,
    cases,
    cursor,
    updatedAtMs: timestamp,
    status: cursor === cases.length ? "completed" : "running",
  };
}

function replaceDefect(
  campaign: ProductionCampaign,
  defectIndex: number,
  replacement: ProductionCampaignDefect,
  timestamp: number,
): ProductionCampaign {
  return {
    ...campaign,
    defects: campaign.defects.map((item, index) => (index === defectIndex ? replacement : item)),
    updatedAtMs: timestamp,
    status: "running",
  };
}

function currentCaseIndex(campaign: ProductionCampaign, caseId: string): number {
  if (campaign.cursor >= campaign.cases.length) return -1;
  return campaign.cases[campaign.cursor]?.caseId === caseId ? campaign.cursor : -1;
}

function openDefectIndex(campaign: ProductionCampaign, defectId: string): number {
  if (campaign.openDefectId !== defectId) return -1;
  return campaign.defects.findIndex((defect) => defect.defectId === defectId);
}

function validateActionBasics(
  campaign: ProductionCampaign,
  action: ProductionCampaignAction,
): Result<number, ProductionCampaignError> {
  const timestamp = actionTime(action);
  if (!isTime(timestamp) || timestamp < campaign.updatedAtMs) {
    return invalidAction("Campaign action timestamp is invalid or regresses");
  }
  const identifier = "defectId" in action ? action.defectId : action.caseId;
  if (!isId(identifier)) return invalidAction("Campaign action identifier is invalid");
  return ok(timestamp);
}

export function advanceProductionCampaign(
  campaign: ProductionCampaign,
  action: ProductionCampaignAction,
): Result<ProductionCampaign, ProductionCampaignError> {
  const valid = validateCampaign(campaign);
  if (!valid.ok) return valid;
  const basics = validateActionBasics(campaign, action);
  if (!basics.ok) return basics;
  const timestamp = basics.value;

  if (action.kind === "begin_case") {
    if (campaign.openDefectId !== null) {
      return err({
        kind: "open_defect",
        message: "The open defect must be closed before another replay case begins",
      });
    }
    const index = currentCaseIndex(campaign, action.caseId);
    const item = campaign.cases.at(index);
    if (index < 0 || item?.status !== "pending" || !isId(action.replayRunId)) {
      return invalidTransition("Only the next pending replay case may begin");
    }
    return ok(
      replaceCase(
        campaign,
        index,
        { ...item, status: "running", replayRunId: action.replayRunId, startedAtMs: timestamp },
        timestamp,
      ),
    );
  }

  if (action.kind === "record_pass") {
    const index = currentCaseIndex(campaign, action.caseId);
    const item = campaign.cases.at(index);
    if (
      index < 0 ||
      item?.status !== "running" ||
      !isDigest(action.observedDigest) ||
      action.observedDigest !== action.expectedDigest ||
      !validDigests(action.oracleDigests, 2) ||
      !validEvidenceRefs(action.evidenceRefs)
    ) {
      return invalidAction("Passing a replay case requires matching output and two distinct oracles");
    }
    return ok(
      replaceCase(
        campaign,
        index,
        {
          ...item,
          status: "passed",
          completedAtMs: timestamp,
          observedDigest: action.observedDigest,
          expectedDigest: action.expectedDigest,
          oracleDigests: [...action.oracleDigests],
          evidenceRefs: [...action.evidenceRefs],
        },
        timestamp,
      ),
    );
  }

  if (action.kind === "record_gap") {
    const index = currentCaseIndex(campaign, action.caseId);
    const item = campaign.cases.at(index);
    if (
      index < 0 ||
      item?.status !== "running" ||
      !GAP_CLASSES.has(action.gapClass) ||
      !isDigest(action.reasonDigest) ||
      !validEvidenceRefs(action.evidenceRefs) ||
      action.evidenceRefs.length === 0
    ) {
      return invalidAction("Coverage gap evidence is invalid");
    }
    return ok(
      replaceCase(
        campaign,
        index,
        {
          ...item,
          status: "coverage_gap",
          completedAtMs: timestamp,
          gapClass: action.gapClass,
          reasonDigest: action.reasonDigest,
          evidenceRefs: [...action.evidenceRefs],
        },
        timestamp,
        { exactEligible: false },
      ),
    );
  }

  if (action.kind === "record_failure") {
    const index = currentCaseIndex(campaign, action.caseId);
    const item = campaign.cases.at(index);
    if (
      campaign.openDefectId !== null ||
      index < 0 ||
      item?.status !== "running" ||
      !isId(action.defectId) ||
      campaign.defects.some((defect) => defect.defectId === action.defectId) ||
      !FAILURE_CLASSES.has(action.failureClass) ||
      !isDigest(action.observedDigest) ||
      !isDigest(action.expectedDigest) ||
      !validEvidenceRefs(action.evidenceRefs) ||
      action.evidenceRefs.length < 2
    ) {
      return invalidAction("Failure evidence must identify one new defect and at least two oracles");
    }
    const defect: ProductionCampaignDefect = {
      defectId: action.defectId,
      caseId: action.caseId,
      status: "observed",
      failureClass: action.failureClass,
      observedDigest: action.observedDigest,
      expectedDigest: action.expectedDigest,
      rootCauseDigest: null,
      authoritativeLayer: null,
      evidenceRefs: [...action.evidenceRefs],
      observabilityGap: null,
      testPath: null,
      testCommandDigest: null,
      prePatchOutputDigest: null,
      failureShapeDigest: null,
      greenOutputDigest: null,
      patchDigest: null,
      deployedRuntimeDigest: null,
      deploymentDigest: null,
      verificationRunId: null,
      verificationOracleDigests: [],
      forcedFailureDigest: null,
      findingDigest: null,
      openedAtMs: timestamp,
      updatedAtMs: timestamp,
    };
    return ok({
      ...campaign,
      cases: campaign.cases.map((candidate, candidateIndex) =>
        candidateIndex === index
          ? {
              ...candidate,
              defectId: action.defectId,
              observedDigest: action.observedDigest,
              expectedDigest: action.expectedDigest,
              evidenceRefs: [...action.evidenceRefs],
            }
          : candidate,
      ),
      defects: [...campaign.defects, defect],
      openDefectId: action.defectId,
      status: "running",
      updatedAtMs: timestamp,
    });
  }

  const defectIndex = openDefectIndex(campaign, action.defectId);
  const defect = campaign.defects.at(defectIndex);
  if (defectIndex < 0 || defect === undefined) {
    return invalidTransition("Action does not target the single open defect");
  }

  if (action.kind === "record_diagnosis") {
    if (
      defect.status !== "observed" ||
      !isDigest(action.rootCauseDigest) ||
      !SAFE_LABEL.test(action.authoritativeLayer) ||
      !validEvidenceRefs(action.evidenceRefs) ||
      action.evidenceRefs.length < 2 ||
      (action.observabilityGap !== "none" && action.observabilityGap !== "open")
    ) {
      return invalidAction("Diagnosis must name the authoritative layer and evidence-backed root cause");
    }
    return ok(
      replaceDefect(
        campaign,
        defectIndex,
        {
          ...defect,
          status: "diagnosed",
          rootCauseDigest: action.rootCauseDigest,
          authoritativeLayer: action.authoritativeLayer,
          evidenceRefs: [...new Set([...defect.evidenceRefs, ...action.evidenceRefs])],
          observabilityGap: action.observabilityGap,
          updatedAtMs: timestamp,
        },
        timestamp,
      ),
    );
  }

  if (action.kind === "record_red") {
    if (
      defect.status !== "diagnosed" ||
      !SAFE_TEST_PATH.test(action.testPath) ||
      !isDigest(action.testCommandDigest) ||
      !isDigest(action.prePatchOutputDigest) ||
      !isDigest(action.failureShapeDigest)
    ) {
      return invalidAction("RED evidence must be reproducible against the diagnosed failure shape");
    }
    return ok(
      replaceDefect(
        campaign,
        defectIndex,
        {
          ...defect,
          status: "red",
          testPath: action.testPath,
          testCommandDigest: action.testCommandDigest,
          prePatchOutputDigest: action.prePatchOutputDigest,
          failureShapeDigest: action.failureShapeDigest,
          updatedAtMs: timestamp,
        },
        timestamp,
      ),
    );
  }

  if (action.kind === "record_green") {
    if (defect.status !== "red") {
      return invalidTransition("A GREEN result requires a previously demonstrated RED test");
    }
    if (
      action.testPath !== defect.testPath ||
      action.testCommandDigest !== defect.testCommandDigest ||
      !isDigest(action.greenOutputDigest) ||
      !isDigest(action.patchDigest) ||
      action.greenOutputDigest === defect.prePatchOutputDigest
    ) {
      return invalidAction("GREEN must use the same RED test and carry distinct passing evidence");
    }
    return ok(
      replaceDefect(
        campaign,
        defectIndex,
        {
          ...defect,
          status: "green",
          greenOutputDigest: action.greenOutputDigest,
          patchDigest: action.patchDigest,
          updatedAtMs: timestamp,
        },
        timestamp,
      ),
    );
  }

  if (action.kind === "record_deployment") {
    if (
      defect.status !== "green" ||
      !isDigest(action.runtimeDigest) ||
      !isDigest(action.deploymentDigest)
    ) {
      return invalidAction("Deployment must attest the runtime carrying the GREEN patch");
    }
    return ok(
      replaceDefect(
        campaign,
        defectIndex,
        {
          ...defect,
          status: "deployed",
          deployedRuntimeDigest: action.runtimeDigest,
          deploymentDigest: action.deploymentDigest,
          updatedAtMs: timestamp,
        },
        timestamp,
      ),
    );
  }

  if (action.kind === "verify_fix") {
    if (defect.status !== "deployed") {
      return invalidTransition("A fix must be deployed before replay verification");
    }
    if (
      !isId(action.replayRunId) ||
      action.deployedRuntimeDigest !== defect.deployedRuntimeDigest ||
      !isDigest(action.observedDigest) ||
      action.observedDigest !== action.expectedDigest ||
      !validDigests(action.oracleDigests, 2) ||
      !isDigest(action.forcedFailureDigest) ||
      !action.observabilityVerified ||
      defect.observabilityGap === "open"
    ) {
      return invalidAction(
        "Verification requires the deployed runtime, matching result, two oracles, honest failure, and closed observability",
      );
    }
    const caseIndex = campaign.cases.findIndex((item) => item.caseId === defect.caseId);
    const item = campaign.cases.at(caseIndex);
    if (caseIndex < 0 || item === undefined) return invalidCampaign("Defect case is absent");
    const verifiedDefect: ProductionCampaignDefect = {
      ...defect,
      status: "verified",
      verificationRunId: action.replayRunId,
      verificationOracleDigests: [...action.oracleDigests],
      forcedFailureDigest: action.forcedFailureDigest,
      observabilityGap: defect.observabilityGap === "none" ? "none" : "closed",
      updatedAtMs: timestamp,
    };
    const withDefect = replaceDefect(campaign, defectIndex, verifiedDefect, timestamp);
    return ok(
      replaceCase(
        withDefect,
        caseIndex,
        {
          ...item,
          status: "passed_after_fix",
          replayRunId: action.replayRunId,
          completedAtMs: timestamp,
          observedDigest: action.observedDigest,
          expectedDigest: action.expectedDigest,
          oracleDigests: [...action.oracleDigests],
        },
        timestamp,
        { openDefectId: null },
      ),
    );
  }

  if (action.kind === "document_finding") {
    if (
      (defect.status !== "diagnosed" && defect.status !== "red") ||
      !isDigest(action.findingDigest) ||
      !validEvidenceRefs(action.evidenceRefs) ||
      action.evidenceRefs.length < 2
    ) {
      return invalidAction("A documented finding requires diagnosis and durable evidence");
    }
    const caseIndex = campaign.cases.findIndex((item) => item.caseId === defect.caseId);
    const item = campaign.cases.at(caseIndex);
    if (caseIndex < 0 || item === undefined) return invalidCampaign("Defect case is absent");
    const withDefect = replaceDefect(
      campaign,
      defectIndex,
      {
        ...defect,
        status: "documented",
        findingDigest: action.findingDigest,
        evidenceRefs: [...new Set([...defect.evidenceRefs, ...action.evidenceRefs])],
        updatedAtMs: timestamp,
      },
      timestamp,
    );
    return ok(
      replaceCase(
        withDefect,
        caseIndex,
        { ...item, status: "documented_finding", completedAtMs: timestamp },
        timestamp,
        { openDefectId: null, exactEligible: false },
      ),
    );
  }

  const exhaustive: never = action;
  return exhaustive;
}

function validateCase(raw: unknown): raw is ProductionCampaignCase {
  if (!isRecord(raw) || !hasExactKeys(raw, CASE_KEYS)) return false;
  return (
    isId(raw.caseId) &&
    typeof raw.status === "string" &&
    CASE_STATUSES.has(raw.status) &&
    isNullableId(raw.replayRunId) &&
    (raw.startedAtMs === null || isTime(raw.startedAtMs)) &&
    (raw.completedAtMs === null || isTime(raw.completedAtMs)) &&
    isNullableDigest(raw.observedDigest) &&
    isNullableDigest(raw.expectedDigest) &&
    validDigests(raw.oracleDigests) &&
    validEvidenceRefs(raw.evidenceRefs) &&
    isNullableId(raw.defectId) &&
    (raw.gapClass === null || (typeof raw.gapClass === "string" && GAP_CLASSES.has(raw.gapClass))) &&
    isNullableDigest(raw.reasonDigest)
  );
}

function validateDefect(raw: unknown): raw is ProductionCampaignDefect {
  if (!isRecord(raw) || !hasExactKeys(raw, DEFECT_KEYS)) return false;
  return (
    isId(raw.defectId) &&
    isId(raw.caseId) &&
    typeof raw.status === "string" &&
    DEFECT_STATUSES.has(raw.status) &&
    typeof raw.failureClass === "string" &&
    FAILURE_CLASSES.has(raw.failureClass) &&
    isDigest(raw.observedDigest) &&
    isDigest(raw.expectedDigest) &&
    isNullableDigest(raw.rootCauseDigest) &&
    (raw.authoritativeLayer === null ||
      (typeof raw.authoritativeLayer === "string" && SAFE_LABEL.test(raw.authoritativeLayer))) &&
    validEvidenceRefs(raw.evidenceRefs) &&
    (raw.observabilityGap === null ||
      raw.observabilityGap === "none" ||
      raw.observabilityGap === "open" ||
      raw.observabilityGap === "closed") &&
    (raw.testPath === null || (typeof raw.testPath === "string" && SAFE_TEST_PATH.test(raw.testPath))) &&
    isNullableDigest(raw.testCommandDigest) &&
    isNullableDigest(raw.prePatchOutputDigest) &&
    isNullableDigest(raw.failureShapeDigest) &&
    isNullableDigest(raw.greenOutputDigest) &&
    isNullableDigest(raw.patchDigest) &&
    isNullableDigest(raw.deployedRuntimeDigest) &&
    isNullableDigest(raw.deploymentDigest) &&
    isNullableId(raw.verificationRunId) &&
    validDigests(raw.verificationOracleDigests) &&
    isNullableDigest(raw.forcedFailureDigest) &&
    isNullableDigest(raw.findingDigest) &&
    isTime(raw.openedAtMs) &&
    isTime(raw.updatedAtMs) &&
    raw.updatedAtMs >= raw.openedAtMs
  );
}

function validateCampaign(
  raw: unknown,
): Result<ProductionCampaign, ProductionCampaignError> {
  if (!isRecord(raw) || !hasExactKeys(raw, CAMPAIGN_KEYS)) {
    return err({ kind: "malformed_campaign", message: "Campaign shape is not strict" });
  }
  if (
    raw.schema !== "comis-production-replay-campaign" ||
    raw.schemaVersion !== 1 ||
    !isId(raw.campaignId) ||
    !isId(raw.captureId) ||
    !isDigest(raw.bundleDigest) ||
    !isDigest(raw.sourceRuntimeDigest) ||
    !isDigest(raw.targetRuntimeDigest) ||
    raw.sourceRuntimeDigest !== raw.targetRuntimeDigest ||
    !isTime(raw.createdAtMs) ||
    !isTime(raw.updatedAtMs) ||
    raw.updatedAtMs < raw.createdAtMs ||
    (raw.status !== "ready" && raw.status !== "running" && raw.status !== "completed") ||
    typeof raw.exactEligible !== "boolean" ||
    !Number.isSafeInteger(raw.cursor) ||
    (raw.cursor as number) < 0 ||
    !isNullableId(raw.openDefectId) ||
    !Array.isArray(raw.cases) ||
    raw.cases.length === 0 ||
    raw.cases.length > MAX_CASES ||
    !raw.cases.every(validateCase) ||
    !Array.isArray(raw.defects) ||
    raw.defects.length > raw.cases.length ||
    !raw.defects.every(validateDefect)
  ) {
    return err({ kind: "malformed_campaign", message: "Campaign fields are invalid" });
  }
  const campaign = raw as unknown as ProductionCampaign;
  if (
    campaign.cursor > campaign.cases.length ||
    new Set(campaign.cases.map((item) => item.caseId)).size !== campaign.cases.length ||
    new Set(campaign.defects.map((item) => item.defectId)).size !== campaign.defects.length ||
    campaign.cases.slice(0, campaign.cursor).some((item) =>
      item.status === "pending" || item.status === "running") ||
    campaign.cases.slice(campaign.cursor + 1).some((item) => item.status !== "pending") ||
    campaign.defects.some((defect) =>
      !campaign.cases.some((item) => item.caseId === defect.caseId && item.defectId === defect.defectId))
  ) {
    return err({ kind: "malformed_campaign", message: "Campaign ordering invariants are invalid" });
  }
  const openDefects = campaign.defects.filter(
    (defect) => defect.status !== "verified" && defect.status !== "documented",
  );
  if (
    openDefects.length > 1 ||
    (openDefects.length === 0) !== (campaign.openDefectId === null) ||
    (openDefects.length === 1 && openDefects[0]?.defectId !== campaign.openDefectId) ||
    (campaign.status === "completed" && campaign.cursor !== campaign.cases.length) ||
    (campaign.status === "ready" && (campaign.cursor !== 0 || campaign.updatedAtMs !== campaign.createdAtMs))
  ) {
    return err({ kind: "malformed_campaign", message: "Campaign defect invariants are invalid" });
  }
  return ok(campaign);
}

export function serializeProductionCampaign(
  campaign: ProductionCampaign,
): Result<string, ProductionCampaignError> {
  const validated = validateCampaign(campaign);
  if (!validated.ok) return validated;
  return ok(JSON.stringify(validated.value));
}

export function parseProductionCampaign(
  raw: string,
): Result<ProductionCampaign, ProductionCampaignError> {
  if (Buffer.byteLength(raw, "utf8") > MAX_CAMPAIGN_BYTES || raw.includes("\0") || raw.includes("\r")) {
    return err({ kind: "malformed_campaign", message: "Campaign envelope is invalid" });
  }
  const parsed = tryCatch(() => JSON.parse(raw) as unknown);
  if (!parsed.ok) {
    return err({ kind: "malformed_campaign", message: "Campaign is not valid JSON" });
  }
  return validateCampaign(parsed.value);
}
