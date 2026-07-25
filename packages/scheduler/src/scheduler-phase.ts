// SPDX-License-Identifier: Apache-2.0
/** Canonical deterministic phase resolution shared by proactive scheduler lanes. */
import { createHash } from "node:crypto";
import { err, ok, type Result } from "@comis/shared";

export type SchedulerPhaseScopeKind = "agent" | "job";

export type SchedulerPhaseError = {
  readonly code: "invalid_modulus" | "invalid_phase" | "invalid_epoch" | "epoch_overflow";
  readonly errorKind: "validation" | "precondition";
  readonly message: string;
};

const PHASE_DOMAIN = "scheduler-phase-v1";

export function resolveSchedulerPhaseMs(
  seed: string,
  scopeKind: SchedulerPhaseScopeKind,
  scopeId: string,
  modulusMs: number,
): Result<number, SchedulerPhaseError> {
  if (!isPositiveSafeInteger(modulusMs)) {
    return err(phaseError(
      "invalid_modulus",
      "validation",
      "Scheduler phase modulus must be a positive safe integer",
    ));
  }
  const encoded = [PHASE_DOMAIN, scopeKind, seed, scopeId]
    .map(lengthDelimitedUtf8)
    .join("");
  const digest = createHash("sha256").update(Buffer.from(encoded, "utf8")).digest();
  let digestInteger = 0n;
  for (const byte of digest) digestInteger = (digestInteger << 8n) | BigInt(byte);
  return ok(Number(digestInteger % BigInt(modulusMs)));
}

/** Return the first epoch on `phaseMs` strictly after `exclusiveLowerBoundMs`. */
export function resolveNextSchedulerPhaseAtMs(
  phaseMs: number,
  modulusMs: number,
  exclusiveLowerBoundMs: number,
): Result<number, SchedulerPhaseError> {
  if (!isPositiveSafeInteger(modulusMs)) {
    return err(phaseError(
      "invalid_modulus",
      "validation",
      "Scheduler phase modulus must be a positive safe integer",
    ));
  }
  if (!Number.isSafeInteger(phaseMs) || phaseMs < 0 || phaseMs >= modulusMs) {
    return err(phaseError(
      "invalid_phase",
      "validation",
      "Scheduler phase must be a safe integer inside the modulus",
    ));
  }
  if (!Number.isSafeInteger(exclusiveLowerBoundMs) || exclusiveLowerBoundMs < 0) {
    return err(phaseError(
      "invalid_epoch",
      "validation",
      "Scheduler phase lower bound must be a nonnegative safe integer",
    ));
  }

  const lowerBound = BigInt(exclusiveLowerBoundMs);
  const modulus = BigInt(modulusMs);
  const phase = BigInt(phaseMs);
  const currentRemainder = lowerBound % modulus;
  let delta = phase - currentRemainder;
  if (delta <= 0n) delta += modulus;
  const next = lowerBound + delta;
  if (next > BigInt(Number.MAX_SAFE_INTEGER)) {
    return err(phaseError(
      "epoch_overflow",
      "precondition",
      "Next scheduler phase epoch exceeds the safe integer range",
    ));
  }
  return ok(Number(next));
}

function lengthDelimitedUtf8(value: string): string {
  return `${Buffer.byteLength(value, "utf8")}:${value}`;
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function phaseError(
  code: SchedulerPhaseError["code"],
  errorKind: SchedulerPhaseError["errorKind"],
  message: string,
): SchedulerPhaseError {
  return { code, errorKind, message };
}
