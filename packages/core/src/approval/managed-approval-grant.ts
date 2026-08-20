// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { err, ok, type Result } from "@comis/shared";
import type { ApprovalResolution } from "../domain/approval-request.js";
import type { ClockPort, ManagedRunOwnerScope } from "../ports/index.js";
import { snapshotApprovalParams } from "./approval-fingerprint.js";

/** A destructive managed operation may consume its approval for fifteen minutes. */
export const MANAGED_APPROVAL_GRANT_TTL_MS = 15 * 60 * 1_000;

export interface ManagedApprovalGrantBindingInput {
  readonly approval: ApprovalResolution;
  readonly toolName: string;
  readonly action: string;
  readonly fingerprintParams: Readonly<Record<string, unknown>>;
  readonly owner: ManagedRunOwnerScope;
  readonly serviceInstanceId: string;
  readonly managedRunId: string;
  readonly mcpOperationId: string;
}

export interface ManagedApprovalGrantConsumeInput {
  readonly operationId: string;
  readonly approvalRequestId: string;
  readonly serviceInstanceId: string;
  readonly managedRunId: string;
  readonly mcpOperationId: string;
}

export interface ManagedApprovalGrantReceipt {
  readonly state: "consumed" | "identical_replay";
  readonly approvalRequestId: string;
  readonly managedRunId: string;
  readonly mcpOperationId: string;
  readonly resolvingPrincipalId: string;
  readonly operationFingerprint: string;
  readonly approvedAtMs: number;
  readonly expiresAtMs: number;
  readonly consumedAtMs: number;
}

export interface ManagedApprovalGrantRegistry {
  bind(input: ManagedApprovalGrantBindingInput): Result<void, Error>;
  consume(input: ManagedApprovalGrantConsumeInput): Result<ManagedApprovalGrantReceipt, Error>;
  clear(): void;
}

interface GrantRecord {
  readonly approvalRequestId: string;
  readonly serviceInstanceId: string;
  readonly managedRunId: string;
  readonly mcpOperationId: string;
  readonly resolvingPrincipalId: string;
  readonly operationFingerprint: string;
  readonly approvedAtMs: number;
  readonly expiresAtMs: number;
  consumedOperationId?: string;
  consumedAtMs?: number;
}

function bindingKey(input: Pick<
  ManagedApprovalGrantConsumeInput,
  "serviceInstanceId" | "managedRunId" | "mcpOperationId"
>): string {
  return JSON.stringify([input.serviceInstanceId, input.managedRunId, input.mcpOperationId]);
}

function nonEmpty(value: string): boolean {
  return value.length > 0;
}

function sameGrant(left: GrantRecord, right: GrantRecord): boolean {
  return left.approvalRequestId === right.approvalRequestId
    && left.serviceInstanceId === right.serviceInstanceId
    && left.managedRunId === right.managedRunId
    && left.mcpOperationId === right.mcpOperationId
    && left.resolvingPrincipalId === right.resolvingPrincipalId
    && left.operationFingerprint === right.operationFingerprint
    && left.approvedAtMs === right.approvedAtMs
    && left.expiresAtMs === right.expiresAtMs;
}

/**
 * Create the daemon-local one-shot authority ledger for approved managed MCP
 * operations. The ledger intentionally is not persisted: a daemon restart
 * before consumption requires a fresh approval, which fails closed without
 * making a side effect. An exact consume replay remains available until expiry.
 */
export function createManagedApprovalGrantRegistry(deps: {
  readonly clock: ClockPort;
  readonly ttlMs?: number;
}): ManagedApprovalGrantRegistry {
  const ttlMs = deps.ttlMs ?? MANAGED_APPROVAL_GRANT_TTL_MS;
  const grants = new Map<string, GrantRecord>();

  function pruneExpired(): void {
    const now = deps.clock.now();
    for (const [key, grant] of grants) {
      if (grant.expiresAtMs <= now) grants.delete(key);
    }
  }

  function bind(input: ManagedApprovalGrantBindingInput): Result<void, Error> {
    pruneExpired();
    if (
      !input.approval.approved
      || !nonEmpty(input.approval.requestId)
      || !nonEmpty(input.toolName)
      || !nonEmpty(input.action)
      || !nonEmpty(input.owner.principalId)
      || !nonEmpty(input.serviceInstanceId)
      || !nonEmpty(input.managedRunId)
      || !nonEmpty(input.mcpOperationId)
    ) return err(new Error("managed approval grant identity is incomplete"));
    const params = snapshotApprovalParams(input.fingerprintParams);
    if (!params.ok) return err(new Error("managed approval grant parameters are invalid"));
    const expiresAtMs = input.approval.resolvedAt + ttlMs;
    if (
      !Number.isSafeInteger(input.approval.resolvedAt)
      || input.approval.resolvedAt < 0
      || !Number.isSafeInteger(expiresAtMs)
      || expiresAtMs <= deps.clock.now()
    ) return err(new Error("managed approval grant is expired"));
    const candidate: GrantRecord = {
      approvalRequestId: input.approval.requestId,
      serviceInstanceId: input.serviceInstanceId,
      managedRunId: input.managedRunId,
      mcpOperationId: input.mcpOperationId,
      resolvingPrincipalId: input.owner.principalId,
      operationFingerprint: createHash("sha256")
        .update(params.value.canonical, "utf8")
        .digest("hex"),
      approvedAtMs: input.approval.resolvedAt,
      expiresAtMs,
    };
    const key = bindingKey(candidate);
    const previous = grants.get(key);
    if (previous !== undefined && !sameGrant(previous, candidate)) {
      return err(new Error("managed approval grant binding conflicts with an existing operation"));
    }
    if (previous === undefined) grants.set(key, candidate);
    return ok(undefined);
  }

  function consume(
    input: ManagedApprovalGrantConsumeInput,
  ): Result<ManagedApprovalGrantReceipt, Error> {
    pruneExpired();
    const grant = grants.get(bindingKey(input));
    if (
      grant === undefined
      || grant.approvalRequestId !== input.approvalRequestId
      || !nonEmpty(input.operationId)
    ) return err(new Error("managed approval grant is unavailable or does not match"));
    if (grant.consumedOperationId !== undefined) {
      if (
        grant.consumedOperationId !== input.operationId
        || grant.consumedAtMs === undefined
      ) return err(new Error("managed approval grant has already been consumed"));
      return ok(Object.freeze({
        state: "identical_replay",
        approvalRequestId: grant.approvalRequestId,
        managedRunId: grant.managedRunId,
        mcpOperationId: grant.mcpOperationId,
        resolvingPrincipalId: grant.resolvingPrincipalId,
        operationFingerprint: grant.operationFingerprint,
        approvedAtMs: grant.approvedAtMs,
        expiresAtMs: grant.expiresAtMs,
        consumedAtMs: grant.consumedAtMs,
      }));
    }
    const consumedAtMs = deps.clock.now();
    grant.consumedOperationId = input.operationId;
    grant.consumedAtMs = consumedAtMs;
    return ok(Object.freeze({
      state: "consumed",
      approvalRequestId: grant.approvalRequestId,
      managedRunId: grant.managedRunId,
      mcpOperationId: grant.mcpOperationId,
      resolvingPrincipalId: grant.resolvingPrincipalId,
      operationFingerprint: grant.operationFingerprint,
      approvedAtMs: grant.approvedAtMs,
      expiresAtMs: grant.expiresAtMs,
      consumedAtMs,
    }));
  }

  return Object.freeze({ bind, consume, clear: () => grants.clear() });
}
