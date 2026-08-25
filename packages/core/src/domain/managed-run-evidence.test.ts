// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  ManagedEvidenceIndexSchema,
  ManagedEvidencePrivateBodySchema,
} from "./managed-run-content.js";

const descriptor = {
  schemaVersion: 1,
  serviceInstanceId: "service-instance_a",
  managedRunId: "managed-run_a",
  evidenceRef: "evidence_a",
  kind: "delivery_reference",
  subjectDigest: "a".repeat(64),
  observedAtMs: 1_800_000_000_000,
  expiresAtMs: 1_800_000_060_000,
  contentRef: "evidence-content_a",
  contentHash: "b".repeat(64),
  privateContentHash: "c".repeat(64),
  verificationLevel: "adapter_verified",
  deliveryKind: "reference",
  receivedAtMs: 1_800_000_000_100,
} as const;

describe("managed-run immutable evidence", () => {
  it("accepts a strict verified descriptor with bounded private presentation", () => {
    expect(ManagedEvidenceIndexSchema.safeParse(descriptor).success).toBe(true);
    expect(ManagedEvidencePrivateBodySchema.safeParse({
      schemaVersion: 1,
      bodyBase64: Buffer.from("https://example.com/result/17").toString("base64"),
      delivery: { kind: "reference" },
    }).success).toBe(true);
    expect(ManagedEvidencePrivateBodySchema.safeParse({
      schemaVersion: 1,
      bodyBase64: Buffer.from("report").toString("base64"),
      delivery: {
        kind: "attachment",
        fileName: "report.md",
        mediaType: "text/markdown",
      },
    }).success).toBe(true);
  });

  it("rejects stale lifetimes and incomplete attachment presentations", () => {
    expect(ManagedEvidenceIndexSchema.safeParse({
      ...descriptor,
      expiresAtMs: descriptor.observedAtMs - 1,
    }).success).toBe(false);
    expect(ManagedEvidencePrivateBodySchema.safeParse({
      schemaVersion: 1,
      bodyBase64: "cmVwb3J0",
      delivery: { kind: "attachment", fileName: "report.md" },
    }).success).toBe(false);
  });
});
