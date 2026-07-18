// SPDX-License-Identifier: Apache-2.0
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

export function parseWorkspacePolicySnapshot(
  raw: unknown,
): Result<WorkspacePolicySnapshot, z.ZodError> {
  const parsed = WorkspacePolicySnapshotSchema.safeParse(raw);
  return parsed.success ? ok(parsed.data) : err(parsed.error);
}
