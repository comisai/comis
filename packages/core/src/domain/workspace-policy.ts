// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { err, ok, type Result } from "@comis/shared";
import { z } from "zod";

export const InstructionSourceKindSchema = z.enum([
  "engine",
  "operator",
  "agent_state",
  "external",
]);

export const InstructionTrustSchema = z.enum(["kernel", "trusted", "untrusted"]);
export const InstructionStabilitySchema = z.enum(["stable", "turn", "volatile"]);

export const InstructionSectionSchema = z.strictObject({
  id: z.string().trim().min(1).max(128),
  sourceKind: InstructionSourceKindSchema,
  trust: InstructionTrustSchema,
  stability: InstructionStabilitySchema,
  content: z.string().max(100_000),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
  maxChars: z.number().int().positive().max(100_000),
}).superRefine((section, context) => {
  const valid = (
    (section.sourceKind === "engine" && section.trust === "kernel" && section.stability === "stable")
    || (section.sourceKind === "operator" && section.trust === "trusted" && section.stability === "stable")
    || (section.sourceKind === "agent_state" && section.trust === "untrusted" && section.stability === "turn")
    || (section.sourceKind === "external" && section.trust === "untrusted" && section.stability === "volatile")
  );
  if (!valid) {
    context.addIssue({
      code: "custom",
      message: "instruction source, trust, and stability do not form an allowed policy tier",
    });
  }
  if (section.content.length > section.maxChars) {
    context.addIssue({
      code: "too_big",
      maximum: section.maxChars,
      origin: "string",
      inclusive: true,
      message: "instruction content exceeds its declared character limit",
      path: ["content"],
    });
  }
});

export const WorkspacePolicySnapshotSchema = z.strictObject({
  agentId: z.string().trim().min(1).max(128),
  sections: z.array(InstructionSectionSchema).max(64),
  combinedHash: z.string().regex(/^[a-f0-9]{64}$/u),
});

export type InstructionSourceKind = z.infer<typeof InstructionSourceKindSchema>;
export type InstructionTrust = z.infer<typeof InstructionTrustSchema>;
export type InstructionStability = z.infer<typeof InstructionStabilitySchema>;
export type InstructionSection = z.infer<typeof InstructionSectionSchema>;
export type WorkspacePolicySnapshot = z.infer<typeof WorkspacePolicySnapshotSchema>;

export type WorkspacePolicyVerificationError =
  | { readonly code: "duplicate_section"; readonly errorKind: "validation"; readonly sectionId: string }
  | { readonly code: "content_hash_mismatch"; readonly errorKind: "validation"; readonly sectionId: string }
  | { readonly code: "combined_hash_mismatch"; readonly errorKind: "validation" };

/** Canonical SHA-256 used by both workspace loaders and durable snapshot consumers. */
export function hashWorkspacePolicyContent(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

/** Preserve section order while hashing only stable section identity and content hashes. */
export function computeWorkspacePolicyCombinedHash(
  sections: readonly Pick<InstructionSection, "id" | "contentHash">[],
): string {
  return hashWorkspacePolicyContent(JSON.stringify(
    sections.map(({ id, contentHash }) => ({ id, contentHash })),
  ));
}

/** Recompute every hash before a persisted snapshot is trusted. */
export function verifyWorkspacePolicySnapshot(
  snapshot: WorkspacePolicySnapshot,
): Result<void, WorkspacePolicyVerificationError> {
  const sectionIds = new Set<string>();
  for (const section of snapshot.sections) {
    if (sectionIds.has(section.id)) {
      return err({ code: "duplicate_section", errorKind: "validation", sectionId: section.id });
    }
    sectionIds.add(section.id);
    if (hashWorkspacePolicyContent(section.content) !== section.contentHash) {
      return err({ code: "content_hash_mismatch", errorKind: "validation", sectionId: section.id });
    }
  }
  return computeWorkspacePolicyCombinedHash(snapshot.sections) === snapshot.combinedHash
    ? ok(undefined)
    : err({ code: "combined_hash_mismatch", errorKind: "validation" });
}

export function parseWorkspacePolicySnapshot(
  raw: unknown,
): Result<WorkspacePolicySnapshot, z.ZodError> {
  const parsed = WorkspacePolicySnapshotSchema.safeParse(raw);
  return parsed.success ? ok(parsed.data) : err(parsed.error);
}
