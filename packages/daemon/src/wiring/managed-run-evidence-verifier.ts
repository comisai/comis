// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import {
  ManagedEvidencePrivateBodySchema,
  type CapabilityServiceEvidencePolicy,
  type ManagedEvidenceDelivery,
  type ManagedEvidenceIndex,
  type ManagedRunContentPort,
  type ManagedRunContentScope,
  type ManagedRunEvidenceHealth,
  type ManagedRunOwnerScope,
  type ManagedRunStorePort,
} from "@comis/core";
import { fromPromise, tryCatch } from "@comis/shared";

export type ManagedRunVerifiedDelivery =
  | {
    readonly kind: "reference";
    readonly evidenceRef: string;
    readonly subjectDigest: string;
    readonly contentHash: string;
    readonly url: string;
  }
  | {
    readonly kind: "attachment";
    readonly evidenceRef: string;
    readonly subjectDigest: string;
    readonly contentHash: string;
    readonly body: Uint8Array;
    readonly fileName: string;
    readonly mediaType: string;
  };

export interface ManagedRunEvidenceVerification {
  readonly evidenceHealth: ManagedRunEvidenceHealth;
  readonly verifiedOutcome: "none" | "succeeded";
  readonly deliveryRequired: boolean;
  readonly verifiedDelivery?: ManagedRunVerifiedDelivery;
}

export interface ManagedRunEvidenceVerifierDeps {
  readonly store: ManagedRunStorePort;
  readonly contentStore: ManagedRunContentPort;
  readonly nowMs: () => number;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function unavailable(deliveryRequired: boolean): ManagedRunEvidenceVerification {
  return { evidenceHealth: "unavailable", verifiedOutcome: "none", deliveryRequired };
}

function invalid(
  evidenceHealth: "conflicting" | "malformed",
  deliveryRequired: boolean,
): ManagedRunEvidenceVerification {
  return { evidenceHealth, verifiedOutcome: "none", deliveryRequired };
}

function pending(deliveryRequired: boolean): ManagedRunEvidenceVerification {
  return { evidenceHealth: "available", verifiedOutcome: "none", deliveryRequired };
}

function deliveryMatchesPolicy(
  policy: CapabilityServiceEvidencePolicy,
  evidence: ManagedEvidenceIndex,
): boolean {
  switch (policy.use) {
    case "outcome":
      return evidence.deliveryKind === "none";
    case "delivery_reference":
      return evidence.deliveryKind === "reference";
    case "delivery_attachment":
      return evidence.deliveryKind === "attachment";
    default: {
      const _exhaustive: never = policy.use;
      return _exhaustive;
    }
  }
}

function referenceUrl(bytes: Uint8Array): string | undefined {
  const decoded = tryCatch(() => new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!decoded.ok) return undefined;
  const parsed = tryCatch(() => new URL(decoded.value));
  if (
    !parsed.ok
    || parsed.value.protocol !== "https:"
    || parsed.value.username.length > 0
    || parsed.value.password.length > 0
    || parsed.value.toString() !== decoded.value
  ) return undefined;
  return decoded.value;
}

/** Resolve configured referenced evidence and re-verify its durable private body. */
export async function verifyManagedRunEvidence(input: {
  readonly ownerScope: ManagedRunOwnerScope;
  readonly contentScope: ManagedRunContentScope;
  readonly serviceInstanceId: string;
  readonly managedRunId: string;
  readonly evidenceRefs: readonly string[];
  readonly policies: readonly CapabilityServiceEvidencePolicy[];
}, deps: ManagedRunEvidenceVerifierDeps): Promise<ManagedRunEvidenceVerification> {
  const outcomePolicies = input.policies.filter((policy) => policy.use === "outcome");
  const deliveryPolicies = input.policies.filter((policy) => policy.use !== "outcome");
  const deliveryRequired = deliveryPolicies.length > 0;
  if (outcomePolicies.length === 0 || input.evidenceRefs.length === 0) {
    return pending(deliveryRequired);
  }
  const listed = await fromPromise(deps.store.listEvidenceByRefs(input.ownerScope, {
    managedRunId: input.managedRunId,
    evidenceRefs: input.evidenceRefs,
  }));
  if (!listed.ok || !listed.value.ok) return unavailable(deliveryRequired);
  const evidence = listed.value.value;
  const byKind = new Map<string, Array<{
    index: ManagedEvidenceIndex;
    body: Uint8Array;
    delivery?: ManagedEvidenceDelivery;
  }>>();
  for (const index of evidence) {
    if (
      index.serviceInstanceId !== input.serviceInstanceId
      || index.managedRunId !== input.managedRunId
      || !input.evidenceRefs.includes(index.evidenceRef)
    ) return invalid("conflicting", deliveryRequired);
    const policy = input.policies.find((candidate) => candidate.kind === index.kind);
    if (policy === undefined || index.verificationLevel !== policy.verificationLevel) {
      return invalid("conflicting", deliveryRequired);
    }
    if (!deliveryMatchesPolicy(policy, index)) return invalid("malformed", deliveryRequired);
    if (index.expiresAtMs !== undefined && index.expiresAtMs <= deps.nowMs()) continue;
    const loaded = await fromPromise(deps.contentStore.getEvidence(input.contentScope, index.contentRef));
    if (!loaded.ok || !loaded.value.ok || loaded.value.value === undefined) {
      return unavailable(deliveryRequired);
    }
    const privateBytes = loaded.value.value;
    if (digest(privateBytes) !== index.privateContentHash) return invalid("malformed", deliveryRequired);
    const decodedEnvelope = tryCatch(() => JSON.parse(Buffer.from(privateBytes).toString("utf8")) as unknown);
    if (!decodedEnvelope.ok) return invalid("malformed", deliveryRequired);
    const envelope = ManagedEvidencePrivateBodySchema.safeParse(decodedEnvelope.value);
    if (!envelope.success) return invalid("malformed", deliveryRequired);
    const body = Buffer.from(envelope.data.bodyBase64, "base64");
    if (
      body.byteLength === 0
      || body.toString("base64") !== envelope.data.bodyBase64
      || digest(body) !== index.contentHash
      || envelope.data.delivery?.kind !== (index.deliveryKind === "none" ? undefined : index.deliveryKind)
    ) return invalid("malformed", deliveryRequired);
    const matches = byKind.get(index.kind) ?? [];
    matches.push({
      index,
      body,
      ...(envelope.data.delivery === undefined ? {} : { delivery: envelope.data.delivery }),
    });
    byKind.set(index.kind, matches);
  }

  const outcomes = outcomePolicies.map((policy) => byKind.get(policy.kind) ?? []);
  if (outcomes.some((matches) => matches.length > 1)) return invalid("conflicting", deliveryRequired);
  if (outcomes.some((matches) => matches.length === 0)) return pending(deliveryRequired);
  const subjectDigest = outcomes[0]?.[0]?.index.subjectDigest;
  if (subjectDigest === undefined || outcomes.some((matches) => matches[0]?.index.subjectDigest !== subjectDigest)) {
    return invalid("conflicting", deliveryRequired);
  }

  const deliveries = deliveryPolicies.flatMap((policy) => byKind.get(policy.kind) ?? []);
  if (deliveries.length > 1) return invalid("conflicting", deliveryRequired);
  const delivery = deliveries[0];
  if (deliveryRequired && delivery === undefined) return pending(deliveryRequired);
  if (delivery !== undefined && delivery.index.subjectDigest !== subjectDigest) {
    return invalid("conflicting", deliveryRequired);
  }
  if (delivery === undefined) {
    return { evidenceHealth: "available", verifiedOutcome: "succeeded", deliveryRequired };
  }
  if (delivery.delivery?.kind === "reference") {
    const url = referenceUrl(delivery.body);
    return url === undefined
      ? invalid("malformed", deliveryRequired)
      : {
        evidenceHealth: "available",
        verifiedOutcome: "succeeded",
        deliveryRequired,
        verifiedDelivery: {
          kind: "reference",
          evidenceRef: delivery.index.evidenceRef,
          subjectDigest,
          contentHash: delivery.index.contentHash,
          url,
        },
      };
  }
  if (delivery.delivery?.kind === "attachment") {
    return {
      evidenceHealth: "available",
      verifiedOutcome: "succeeded",
      deliveryRequired,
      verifiedDelivery: {
        kind: "attachment",
        evidenceRef: delivery.index.evidenceRef,
        subjectDigest,
        contentHash: delivery.index.contentHash,
        body: delivery.body,
        fileName: delivery.delivery.fileName,
        mediaType: delivery.delivery.mediaType,
      },
    };
  }
  return invalid("malformed", deliveryRequired);
}
