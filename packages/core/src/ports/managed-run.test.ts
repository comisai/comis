// SPDX-License-Identifier: Apache-2.0
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  MAX_MANAGED_RUN_REPORT_BYTES,
  ManagedRunActivationDescriptorSchema,
  ManagedRunReportBodySchema,
  ManagedRunReportIndexSchema,
} from "../domain/managed-run-content.js";
import type {
  ManagedRunContentPort,
  ManagedRunStorePort,
} from "./managed-run.js";

describe("Managed-run store and private-content port contracts", () => {
  it("keeps the durable store surface narrow scoped and explicit", () => {
    expectTypeOf<keyof ManagedRunStorePort>().toEqualTypeOf<
      | "create"
      | "get"
      | "claimTransition"
      | "bindTerminal"
      | "setWorkspaceLease"
      | "appendReportAndAdvanceAcceptedCursor"
      | "claimContinuation"
      | "commitReducedState"
      | "markContinuationOutcome"
      | "listScoped"
      | "listRecoverable"
      | "revoke"
    >();
  });

  it("keeps private bodies behind a separate scoped content port", () => {
    expectTypeOf<keyof ManagedRunContentPort>().toEqualTypeOf<
      | "putActivationDescriptor"
      | "getActivationDescriptor"
      | "deleteActivationDescriptor"
      | "putReportBody"
      | "getReportBody"
      | "putEvidence"
      | "getEvidence"
      | "putAttentionBody"
      | "getAttentionBody"
      | "purgeExpired"
    >();
  });

  it("validates strict expiring activation descriptors without authority fields", () => {
    expect(ManagedRunActivationDescriptorSchema.safeParse({
      schemaVersion: 1,
      externalRunRef: "external-run_a",
      registrationNonce: "registration-nonce_a",
      expiresAtMs: 1_800_000_060_000,
    }).success).toBe(true);
    expect(ManagedRunActivationDescriptorSchema.safeParse({
      schemaVersion: 1,
      externalRunRef: "external-run_a",
      registrationNonce: "short",
      expiresAtMs: 1_800_000_060_000,
    }).success).toBe(false);
    expect(ManagedRunActivationDescriptorSchema.safeParse({
      schemaVersion: 1,
      externalRunRef: "external-run_a",
      registrationNonce: "registration-nonce_a",
      expiresAtMs: 1_800_000_060_000,
      tenantId: "tenant_from_service",
    }).success).toBe(false);
  });

  it("validates report bodies and their combined UTF-8 byte ceiling", () => {
    const exact = ManagedRunReportBodySchema.safeParse({
      schemaVersion: 1,
      serviceReportId: "service-report_a",
      kind: "progress",
      summary: "x".repeat(MAX_MANAGED_RUN_REPORT_BYTES / 2),
      details: "y".repeat(MAX_MANAGED_RUN_REPORT_BYTES / 2),
      artifactRefs: ["evidence_a"],
      observedAtMs: 1_800_000_000_000,
    });
    const oversizedMultibyte = ManagedRunReportBodySchema.safeParse({
      schemaVersion: 1,
      serviceReportId: "service-report_b",
      kind: "progress",
      summary: "é".repeat(MAX_MANAGED_RUN_REPORT_BYTES / 2 + 1),
    });

    expect(exact.success).toBe(true);
    expect(oversizedMultibyte.success).toBe(false);
  });

  it("keeps report indexes content-free and sequence-positive", () => {
    const index = {
      schemaVersion: 1,
      serviceInstanceId: "service-instance_a",
      managedRunId: "managed-run_a",
      serviceReportId: "service-report_a",
      sequence: 1,
      kind: "progress",
      contentRef: "report-content_a",
      contentHash: "a".repeat(64),
      receivedAtMs: 1_800_000_000_100,
      retainedUntilMs: 1_802_592_000_100,
      observedAtMs: 1_800_000_000_000,
    };

    expect(ManagedRunReportIndexSchema.safeParse(index).success).toBe(true);
    expect(ManagedRunReportIndexSchema.safeParse({ ...index, summary: "must stay private" }).success).toBe(false);
    expect(ManagedRunReportIndexSchema.safeParse({ ...index, sequence: 0 }).success).toBe(false);
    expect(ManagedRunReportIndexSchema.safeParse({ ...index, retainedUntilMs: index.receivedAtMs - 1 }).success).toBe(false);
  });
});
