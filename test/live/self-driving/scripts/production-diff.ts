// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";

import { err, ok, type Result } from "@comis/shared";

import type {
  CanonicalProductionEvent,
  CanonicalProductionTranscript,
} from "./production-transcript.js";

export const REPLAY_OBSERVED_SURFACES = [
  "wire",
  "sqlite",
  "file",
  "security",
  "durable",
  "delivery",
  "memory",
  "scheduler",
  "workspace",
  "config",
] as const;

export type ReplayObservedSurface = (typeof REPLAY_OBSERVED_SURFACES)[number];

export interface ReplayObservedRecord {
  readonly surface: ReplayObservedSurface;
  readonly recordId: string;
  readonly valueDigest: string;
  readonly causalEventId: string | null;
}

export interface ProductionReplayDiffInput {
  readonly expectedTranscript: CanonicalProductionTranscript;
  readonly actualTranscript: CanonicalProductionTranscript;
  readonly expectedRecords: readonly ReplayObservedRecord[];
  readonly actualRecords: readonly ReplayObservedRecord[];
}

export type ProductionReplayDivergenceKind =
  | "event_missing"
  | "event_unexpected"
  | "event_changed"
  | "state_missing"
  | "state_unexpected"
  | "state_changed";

export interface ProductionReplayDivergence {
  readonly kind: ProductionReplayDivergenceKind;
  readonly causalSeq: number | null;
  readonly expectedEventId: string | null;
  readonly actualEventId: string | null;
  readonly surface: "activity" | ReplayObservedSurface;
  readonly recordId: string | null;
}

export interface ProductionReplayDiffReport {
  readonly matched: boolean;
  readonly expectedTranscriptDigest: string;
  readonly actualTranscriptDigest: string;
  readonly expectedStateDigest: string;
  readonly actualStateDigest: string;
  readonly divergence: ProductionReplayDivergence | null;
}

export type ProductionReplayDiffError = {
  readonly kind: "invalid_diff_input";
  readonly message: string;
};

interface DivergenceCandidate {
  readonly divergence: ProductionReplayDivergence;
  readonly causalOrder: number;
  readonly priority: number;
  readonly tieBreak: string;
}

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+/-]{0,511}$/u;
const SURFACES = new Set<string>(REPLAY_OBSERVED_SURFACES);

function invalidInput(): Result<never, ProductionReplayDiffError> {
  return err({
    kind: "invalid_diff_input",
    message: "Replay diff records are invalid or duplicated",
  });
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

function digestCanonical(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function eventFingerprint(event: CanonicalProductionEvent): string {
  return digestCanonical(event);
}

function validateTranscript(transcript: CanonicalProductionTranscript): boolean {
  if (
    transcript.schema !== "comis-canonical-production-transcript" ||
    transcript.schemaVersion !== 1 ||
    !SAFE_ID.test(transcript.captureId) ||
    !Number.isSafeInteger(transcript.createdAtMs) ||
    transcript.createdAtMs < 0
  ) {
    return false;
  }
  const ids = new Set<string>();
  for (let index = 0; index < transcript.events.length; index += 1) {
    const event = transcript.events.at(index);
    if (
      event === undefined ||
      event.seq !== index + 1 ||
      !SAFE_ID.test(event.eventId) ||
      ids.has(event.eventId) ||
      !SHA256.test(event.replay.idempotencyKey) ||
      !SHA256.test(event.replay.payloadDigest) ||
      (event.replay.blobDigest !== null && !SHA256.test(event.replay.blobDigest)) ||
      (event.causalParentEventId !== null && !ids.has(event.causalParentEventId))
    ) {
      return false;
    }
    ids.add(event.eventId);
  }
  return true;
}

function recordKey(record: ReplayObservedRecord): string {
  return `${record.surface}\0${record.recordId}`;
}

function validateRecords(
  records: readonly ReplayObservedRecord[],
): Result<readonly ReplayObservedRecord[], ProductionReplayDiffError> {
  const keys = new Set<string>();
  for (const record of records) {
    if (
      !SURFACES.has(record.surface) ||
      !SAFE_ID.test(record.recordId) ||
      !SHA256.test(record.valueDigest) ||
      (record.causalEventId !== null && !SAFE_ID.test(record.causalEventId))
    ) {
      return invalidInput();
    }
    const key = recordKey(record);
    if (keys.has(key)) return invalidInput();
    keys.add(key);
  }
  return ok(records);
}

function transcriptSequenceMap(
  transcript: CanonicalProductionTranscript,
): Map<string, number> {
  return new Map(transcript.events.map((event) => [event.eventId, event.seq]));
}

function activityCandidate(
  expected: CanonicalProductionEvent | undefined,
  actual: CanonicalProductionEvent | undefined,
  index: number,
): DivergenceCandidate | null {
  if (expected !== undefined && actual !== undefined) {
    if (eventFingerprint(expected) === eventFingerprint(actual)) return null;
    return {
      divergence: {
        kind: "event_changed",
        causalSeq: Math.min(expected.seq, actual.seq),
        expectedEventId: expected.eventId,
        actualEventId: actual.eventId,
        surface: "activity",
        recordId: null,
      },
      causalOrder: Math.min(expected.seq, actual.seq),
      priority: 0,
      tieBreak: `activity\0${String(index).padStart(12, "0")}`,
    };
  }
  if (expected !== undefined) {
    return {
      divergence: {
        kind: "event_missing",
        causalSeq: expected.seq,
        expectedEventId: expected.eventId,
        actualEventId: null,
        surface: "activity",
        recordId: null,
      },
      causalOrder: expected.seq,
      priority: 0,
      tieBreak: `activity\0${String(index).padStart(12, "0")}`,
    };
  }
  if (actual !== undefined) {
    return {
      divergence: {
        kind: "event_unexpected",
        causalSeq: actual.seq,
        expectedEventId: null,
        actualEventId: actual.eventId,
        surface: "activity",
        recordId: null,
      },
      causalOrder: actual.seq,
      priority: 0,
      tieBreak: `activity\0${String(index).padStart(12, "0")}`,
    };
  }
  return null;
}

function stateCandidate(
  expected: ReplayObservedRecord | undefined,
  actual: ReplayObservedRecord | undefined,
  expectedSeq: ReadonlyMap<string, number>,
  actualSeq: ReadonlyMap<string, number>,
): DivergenceCandidate | null {
  if (expected !== undefined && actual !== undefined && expected.valueDigest === actual.valueDigest) {
    return null;
  }
  const causalEventId = expected?.causalEventId ?? actual?.causalEventId ?? null;
  const expectedCausalSeq = causalEventId === null ? undefined : expectedSeq.get(causalEventId);
  const actualCausalSeq = causalEventId === null ? undefined : actualSeq.get(causalEventId);
  const availableSequences = [expectedCausalSeq, actualCausalSeq].filter(
    (value): value is number => value !== undefined,
  );
  const causalSeq = availableSequences.length === 0 ? null : Math.min(...availableSequences);
  const surface = (expected?.surface ?? actual?.surface) as ReplayObservedSurface;
  const recordId = (expected?.recordId ?? actual?.recordId) as string;
  const kind: ProductionReplayDivergenceKind =
    expected === undefined
      ? "state_unexpected"
      : actual === undefined
        ? "state_missing"
        : "state_changed";
  return {
    divergence: {
      kind,
      causalSeq,
      expectedEventId:
        causalEventId !== null && expectedSeq.has(causalEventId) ? causalEventId : null,
      actualEventId: causalEventId !== null && actualSeq.has(causalEventId) ? causalEventId : null,
      surface,
      recordId,
    },
    causalOrder: causalSeq ?? Number.MAX_SAFE_INTEGER,
    priority: 1,
    tieBreak: `${surface}\0${recordId}`,
  };
}

function sortRecords(records: readonly ReplayObservedRecord[]): readonly ReplayObservedRecord[] {
  return [...records].sort((left, right) => recordKey(left).localeCompare(recordKey(right), "en"));
}

function compareCandidates(left: DivergenceCandidate, right: DivergenceCandidate): number {
  if (left.causalOrder !== right.causalOrder) return left.causalOrder - right.causalOrder;
  if (left.priority !== right.priority) return left.priority - right.priority;
  return left.tieBreak.localeCompare(right.tieBreak, "en");
}

export function diffProductionReplay(
  input: ProductionReplayDiffInput,
): Result<ProductionReplayDiffReport, ProductionReplayDiffError> {
  if (!validateTranscript(input.expectedTranscript) || !validateTranscript(input.actualTranscript)) {
    return invalidInput();
  }
  const expectedRecords = validateRecords(input.expectedRecords);
  if (!expectedRecords.ok) return expectedRecords;
  const actualRecords = validateRecords(input.actualRecords);
  if (!actualRecords.ok) return actualRecords;

  const candidates: DivergenceCandidate[] = [];
  const maximumEvents = Math.max(
    input.expectedTranscript.events.length,
    input.actualTranscript.events.length,
  );
  for (let index = 0; index < maximumEvents; index += 1) {
    const candidate = activityCandidate(
      input.expectedTranscript.events.at(index),
      input.actualTranscript.events.at(index),
      index,
    );
    if (candidate !== null) candidates.push(candidate);
  }

  const expectedRecordMap = new Map(
    expectedRecords.value.map((record) => [recordKey(record), record] as const),
  );
  const actualRecordMap = new Map(
    actualRecords.value.map((record) => [recordKey(record), record] as const),
  );
  const recordKeys = [...new Set([...expectedRecordMap.keys(), ...actualRecordMap.keys()])].sort();
  const expectedSeq = transcriptSequenceMap(input.expectedTranscript);
  const actualSeq = transcriptSequenceMap(input.actualTranscript);
  for (const key of recordKeys) {
    const candidate = stateCandidate(
      expectedRecordMap.get(key),
      actualRecordMap.get(key),
      expectedSeq,
      actualSeq,
    );
    if (candidate !== null) candidates.push(candidate);
  }
  candidates.sort(compareCandidates);

  const expectedTranscriptDigest = digestCanonical(input.expectedTranscript);
  const actualTranscriptDigest = digestCanonical(input.actualTranscript);
  const expectedStateDigest = digestCanonical(sortRecords(expectedRecords.value));
  const actualStateDigest = digestCanonical(sortRecords(actualRecords.value));
  return ok({
    matched:
      expectedTranscriptDigest === actualTranscriptDigest &&
      expectedStateDigest === actualStateDigest,
    expectedTranscriptDigest,
    actualTranscriptDigest,
    expectedStateDigest,
    actualStateDigest,
    divergence: candidates.at(0)?.divergence ?? null,
  });
}
