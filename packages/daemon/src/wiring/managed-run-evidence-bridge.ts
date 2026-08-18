// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ManagedEvidencePrivateBodySchema,
  MAX_MANAGED_EVIDENCE_BYTES,
  emitObservationalEventSafely,
  type CapabilityServiceEvidencePolicy,
  type ComisLogger,
  type ManagedEvidenceDelivery,
  type ManagedEvidenceIndex,
  type ManagedEvidenceVerificationLevel,
  type ManagedRunContentPort,
  type ManagedRunContentScope,
  type ManagedRunOwnerScope,
  type ManagedRunStorePort,
  type TypedEventBus,
} from "@comis/core";
import { err, fromPromise, ok, tryCatch, type Result } from "@comis/shared";

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,255}$/u;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;

const EvidenceIngressSchema = z.strictObject({
  operationId: z.string().min(1).max(128).regex(OPAQUE_ID_PATTERN),
  serviceInstanceId: z.string().regex(OPAQUE_ID_PATTERN),
  managedRunId: z.string().regex(OPAQUE_ID_PATTERN),
  evidenceRef: z.string().regex(OPAQUE_ID_PATTERN),
  kind: z.string().regex(OPAQUE_ID_PATTERN),
  subjectDigest: z.string().regex(DIGEST_PATTERN),
  observedAtMs: z.number().int().nonnegative(),
  expiresAtMs: z.number().int().nonnegative().optional(),
  contentHash: z.string().regex(DIGEST_PATTERN),
  verificationLevel: z.enum(["reported", "adapter_verified", "host_verified"]),
  bodyBase64: z.string(),
  delivery: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("reference") }),
    z.strictObject({
      kind: z.literal("attachment"),
      // eslint-disable-next-line no-control-regex -- ingress validation must reject NUL before private evidence persistence
      fileName: z.string().min(1).max(256).regex(/^[^/\\\u0000\r\n]+$/u),
      mediaType: z.string().regex(/^[a-z0-9][a-z0-9.+-]{0,63}\/[a-z0-9][a-z0-9.+-]{0,63}$/u),
    }),
  ]).optional(),
});

export interface ManagedRunEvidenceIngressInput {
  readonly operationId: string;
  readonly serviceInstanceId: string;
  readonly managedRunId: string;
  readonly evidenceRef: string;
  readonly kind: string;
  readonly subjectDigest: string;
  readonly observedAtMs: number;
  readonly expiresAtMs?: number;
  readonly contentHash: string;
  readonly verificationLevel: ManagedEvidenceVerificationLevel;
  readonly bodyBase64: string;
  readonly delivery?: ManagedEvidenceDelivery;
}

export type ManagedRunEvidenceRejectionReason =
  | "invalid_evidence"
  | "managed_run_not_found"
  | "verification_not_allowed"
  | "delivery_policy_mismatch"
  | "evidence_stale"
  | "replay_conflict"
  | "state_mismatch";

export type ManagedRunEvidenceIngressOutcome =
  | { readonly kind: "accepted"; readonly evidence: ManagedEvidenceIndex }
  | { readonly kind: "identical_replay"; readonly evidence: ManagedEvidenceIndex }
  | { readonly kind: "rejected"; readonly reasonCode: ManagedRunEvidenceRejectionReason };

export interface ManagedRunEvidenceBridge {
  putEvidence(
    input: ManagedRunEvidenceIngressInput,
  ): Promise<Result<ManagedRunEvidenceIngressOutcome, Error>>;
}

export interface ManagedRunEvidenceBridgeDeps {
  readonly store: ManagedRunStorePort;
  readonly contentStore: ManagedRunContentPort;
  readonly nowMs: () => number;
  readonly maxObservedClockSkewMs?: number;
  readonly resolveEvidencePolicies: (
    serviceInstanceId: string,
  ) => readonly CapabilityServiceEvidencePolicy[] | undefined;
  /** The service's self-declared max evidence bytes (tighter than the protocol
   *  ceiling), or undefined to fall back to that ceiling. */
  readonly resolveMaxEvidenceBytes?: (serviceInstanceId: string) => number | undefined;
  readonly eventBus: TypedEventBus;
  readonly logger: ComisLogger;
}

async function invoke<T>(operation: () => Promise<Result<T, Error>>): Promise<Result<T, Error>> {
  const invoked = tryCatch(operation);
  if (!invoked.ok) return err(invoked.error);
  const settled = await fromPromise(invoked.value);
  return settled.ok ? settled.value : err(settled.error);
}

function contentScope(
  record: { readonly tenantId: string; readonly agentId: string; readonly managedRunId: string },
): ManagedRunContentScope {
  return {
    tenantId: record.tenantId,
    agentId: record.agentId,
    managedRunId: record.managedRunId,
  };
}

function ownerScope(record: {
  readonly tenantId: string;
  readonly agentId: string;
  readonly principalId: string;
  readonly conversationRef: ManagedRunOwnerScope["conversationRef"];
}): ManagedRunOwnerScope {
  return {
    kind: "owner",
    tenantId: record.tenantId,
    agentId: record.agentId,
    principalId: record.principalId,
    conversationRef: record.conversationRef,
  };
}

function samePrivateBody(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}

function deliveryMatches(
  policy: CapabilityServiceEvidencePolicy,
  delivery: ManagedEvidenceDelivery | undefined,
): boolean {
  switch (policy.use) {
    case "outcome":
      return delivery === undefined;
    case "delivery_reference":
      return delivery?.kind === "reference";
    case "delivery_attachment":
      return delivery?.kind === "attachment";
    default: {
      const _exhaustive: never = policy.use;
      return _exhaustive;
    }
  }
}

/** Persist service evidence only after exact verifier and run authority checks. */
export function createManagedRunEvidenceBridge(
  deps: ManagedRunEvidenceBridgeDeps,
): ManagedRunEvidenceBridge {
  function rejectEvidence(
    reasonCode: ManagedRunEvidenceRejectionReason,
    identity?: { readonly serviceInstanceId: string; readonly managedRunId: string },
  ): Result<ManagedRunEvidenceIngressOutcome, Error> {
    deps.logger.audit({
      decision: "deny",
      reasonCode,
      ...(identity === undefined ? {} : identity),
    }, "Managed-run evidence rejected");
    emitObservationalEventSafely(
      { eventBus: deps.eventBus, logger: deps.logger },
      "managed_run:evidence_rejected",
      { ...(identity === undefined ? {} : identity), reasonCode, timestamp: deps.nowMs() },
    );
    return ok({ kind: "rejected", reasonCode });
  }

  async function removeUnindexedBody(
    scope: ManagedRunContentScope,
    owner: ManagedRunOwnerScope,
    evidenceRef: string,
    identity: { readonly serviceInstanceId: string; readonly managedRunId: string },
  ): Promise<void> {
    const indexed = await invoke(() => deps.store.listEvidenceByRefs(owner, {
      managedRunId: identity.managedRunId,
      evidenceRefs: [evidenceRef],
    }));
    if (!indexed.ok) {
      deps.logger.error({
        ...identity,
        step: "evidence-index-compensation-check",
        errorKind: "internal" as const,
        hint: "Run managed-run private-content recovery after checking the evidence index",
      }, "Managed-run evidence compensation ownership check failed");
      return;
    }
    if (indexed.value.length > 0) return;
    const removed = await invoke(() => deps.contentStore.deleteEvidence(scope, evidenceRef));
    if (removed.ok) return;
    deps.logger.error({
      ...identity,
      step: "evidence-body-compensation",
      errorKind: "internal" as const,
      hint: "Run managed-run private-content recovery and inspect the owner-only evidence body",
    }, "Managed-run evidence body compensation failed");
  }

  return Object.freeze({
    putEvidence: async (input: ManagedRunEvidenceIngressInput) => {
      const startedAtMs = deps.nowMs();
      const parsed = EvidenceIngressSchema.safeParse(input);
      if (!parsed.success) return rejectEvidence("invalid_evidence");
      const identity = {
        serviceInstanceId: parsed.data.serviceInstanceId,
        managedRunId: parsed.data.managedRunId,
      };
      // The service's self-declared cap tightens the protocol ceiling; an absent
      // declaration falls back to it. A cap larger than the ceiling can never be
      // configured (the config schema bounds it), so min() is defence-in-depth.
      const maxEvidenceBytes = Math.min(
        deps.resolveMaxEvidenceBytes?.(identity.serviceInstanceId) ?? MAX_MANAGED_EVIDENCE_BYTES,
        MAX_MANAGED_EVIDENCE_BYTES,
      );
      const decoded = tryCatch(() => Buffer.from(parsed.data.bodyBase64, "base64"));
      if (
        !decoded.ok
        || decoded.value.byteLength === 0
        || decoded.value.byteLength > maxEvidenceBytes
        || decoded.value.toString("base64") !== parsed.data.bodyBase64
        || createHash("sha256").update(decoded.value).digest("hex") !== parsed.data.contentHash
      ) return rejectEvidence("invalid_evidence", identity);
      const nowMs = deps.nowMs();
      const clockSkewMs = deps.maxObservedClockSkewMs ?? 60_000;
      if (
        parsed.data.observedAtMs > nowMs + clockSkewMs
        || (parsed.data.expiresAtMs !== undefined && parsed.data.expiresAtMs <= nowMs)
      ) return rejectEvidence("evidence_stale", identity);

      const policies = deps.resolveEvidencePolicies(identity.serviceInstanceId);
      if (policies === undefined) return rejectEvidence("verification_not_allowed", identity);
      if (parsed.data.verificationLevel === "host_verified") {
        return rejectEvidence("verification_not_allowed", identity);
      }
      if (parsed.data.verificationLevel === "reported") {
        if (parsed.data.delivery !== undefined) {
          return rejectEvidence("delivery_policy_mismatch", identity);
        }
      } else {
        const policy = policies.find((candidate) => candidate.kind === parsed.data.kind);
        if (policy === undefined) return rejectEvidence("verification_not_allowed", identity);
        if (!deliveryMatches(policy, parsed.data.delivery)) {
          return rejectEvidence("delivery_policy_mismatch", identity);
        }
      }

      const record = await invoke(() => deps.store.get(
        { kind: "service", serviceInstanceId: identity.serviceInstanceId },
        identity.managedRunId,
      ));
      if (!record.ok) return record;
      if (record.value === undefined) return rejectEvidence("managed_run_not_found", identity);
      const scope = contentScope(record.value);
      const privateBody = ManagedEvidencePrivateBodySchema.safeParse({
        schemaVersion: 1,
        bodyBase64: parsed.data.bodyBase64,
        ...(parsed.data.delivery === undefined ? {} : { delivery: parsed.data.delivery }),
      });
      if (!privateBody.success) return rejectEvidence("invalid_evidence", identity);
      const privateBytes = Buffer.from(JSON.stringify(privateBody.data), "utf8");
      const existing = await invoke(() => deps.contentStore.getEvidence(scope, parsed.data.evidenceRef));
      if (!existing.ok) return existing;
      if (existing.value !== undefined && !samePrivateBody(existing.value, privateBytes)) {
        return rejectEvidence("replay_conflict", identity);
      }
      const published = await invoke(() => deps.contentStore.putEvidence(
        scope,
        parsed.data.evidenceRef,
        {
          body: privateBytes,
          ...(parsed.data.expiresAtMs === undefined ? {} : { expiresAtMs: parsed.data.expiresAtMs }),
        },
      ));
      if (!published.ok) {
        const raced = await invoke(() => deps.contentStore.getEvidence(scope, parsed.data.evidenceRef));
        if (raced.ok && raced.value !== undefined && !samePrivateBody(raced.value, privateBytes)) {
          return rejectEvidence("replay_conflict", identity);
        }
        deps.logger.error({
          ...identity,
          step: "evidence-private-body-write",
          errorKind: "internal" as const,
          hint: "Retry the evidence operation after checking the managed-run private-content store",
        }, "Managed-run evidence private body write failed");
        return published;
      }

      const appended = await invoke(() => deps.store.appendEvidence(
        { kind: "service", serviceInstanceId: identity.serviceInstanceId },
        {
          managedRunId: identity.managedRunId,
          evidenceRef: parsed.data.evidenceRef,
          kind: parsed.data.kind,
          subjectDigest: parsed.data.subjectDigest,
          observedAtMs: parsed.data.observedAtMs,
          ...(parsed.data.expiresAtMs === undefined ? {} : { expiresAtMs: parsed.data.expiresAtMs }),
          contentRef: published.value.contentRef,
          contentHash: parsed.data.contentHash,
          privateContentHash: published.value.contentHash,
          verificationLevel: parsed.data.verificationLevel,
          deliveryKind: parsed.data.delivery?.kind ?? "none",
          receivedAtMs: nowMs,
        },
      ));
      if (!appended.ok) {
        if (existing.value === undefined) {
          await removeUnindexedBody(scope, ownerScope(record.value), parsed.data.evidenceRef, identity);
        }
        return appended;
      }
      if (appended.value.kind !== "accepted" && appended.value.kind !== "identical_replay") {
        if (existing.value === undefined) {
          await removeUnindexedBody(scope, ownerScope(record.value), parsed.data.evidenceRef, identity);
        }
        if (appended.value.kind === "replay_conflict") return rejectEvidence("replay_conflict", identity);
        if (appended.value.kind === "state_mismatch") return rejectEvidence("state_mismatch", identity);
        return rejectEvidence("managed_run_not_found", identity);
      }
      deps.logger.info({
        ...identity,
        evidenceRef: appended.value.evidence.evidenceRef,
        verificationLevel: appended.value.evidence.verificationLevel,
        durationMs: Math.max(0, deps.nowMs() - startedAtMs),
      }, appended.value.kind === "accepted"
        ? "Managed-run evidence accepted"
        : "Managed-run evidence replay accepted");
      if (appended.value.kind === "accepted") {
        emitObservationalEventSafely(
          { eventBus: deps.eventBus, logger: deps.logger },
          "managed_run:evidence_accepted",
          {
            ...identity,
            evidenceRef: appended.value.evidence.evidenceRef,
            verificationLevel: appended.value.evidence.verificationLevel,
            deliveryKind: appended.value.evidence.deliveryKind,
            timestamp: deps.nowMs(),
          },
        );
      }
      return ok(appended.value);
    },
  });
}
