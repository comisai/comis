// SPDX-License-Identifier: Apache-2.0
import { isAbsolute, normalize, parse } from "node:path";
import { z } from "zod";

const CONTRIBUTION_ID_SEGMENT_PATTERN = /^[a-z][a-z0-9]*$/u;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,255}$/u;
const SECRET_REF_PATTERN = /^secret:\/\/[A-Za-z0-9][A-Za-z0-9/._~-]{0,255}$/u;

function isContributionId(value: string): boolean {
  if (value.length > 256) return false;
  const segments = value.split(/[.-]/u);
  return segments.length >= 2
    && segments.every((segment) => CONTRIBUTION_ID_SEGMENT_PATTERN.test(segment));
}

const CapabilityServiceControlConfigSchema = z.strictObject({
  transport: z.literal("unix"),
  socketPath: z.string().min(1).max(4_096).superRefine((path, ctx) => {
    if (!isAbsolute(path) || normalize(path) !== path) {
      ctx.addIssue({
        code: "custom",
        message: "capability-service socketPath must be absolute and normalized",
      });
    }
  }),
  credentialRef: z.string().regex(SECRET_REF_PATTERN),
});

const WorkspaceRootSchema = z.string().min(1).max(4_096).superRefine((path, ctx) => {
  if (!isAbsolute(path) || normalize(path) !== path || parse(path).root === path) {
    ctx.addIssue({
      code: "custom",
      message: "capability-service workspace roots must be absolute, normalized, and narrower than a filesystem root",
    });
  }
});

const RuntimeRootSchema = z.string().min(1).max(4_096).superRefine((path, ctx) => {
  if (!isAbsolute(path) || normalize(path) !== path || parse(path).root === path) {
    ctx.addIssue({
      code: "custom",
      message: "capability-service runtime roots must be absolute, normalized, and narrower than a filesystem root",
    });
  }
});

export const CapabilityServiceInstanceConfigSchema = z.strictObject({
  serviceInstanceId: z.string().regex(OPAQUE_ID_PATTERN),
  serviceDefinitionId: z.string().refine(isContributionId),
  enabled: z.boolean(),
  mcpServerName: z.string().regex(OPAQUE_ID_PATTERN),
  control: CapabilityServiceControlConfigSchema,
  allowedAgents: z.array(z.string().regex(OPAQUE_ID_PATTERN)).min(1).max(256),
  allowedWorkspaceRoots: z.array(WorkspaceRootSchema).max(64),
  allowedRuntimeRoots: z.array(RuntimeRootSchema).max(64),
}).superRefine((value, ctx) => {
  if (new Set(value.allowedAgents).size !== value.allowedAgents.length) {
    ctx.addIssue({
      code: "custom",
      path: ["allowedAgents"],
      message: "capability-service allowedAgents must be unique",
    });
  }
  if (new Set(value.allowedWorkspaceRoots).size !== value.allowedWorkspaceRoots.length) {
    ctx.addIssue({
      code: "custom",
      path: ["allowedWorkspaceRoots"],
      message: "capability-service allowedWorkspaceRoots must be unique",
    });
  }
  if (new Set(value.allowedRuntimeRoots).size !== value.allowedRuntimeRoots.length) {
    ctx.addIssue({
      code: "custom",
      path: ["allowedRuntimeRoots"],
      message: "capability-service allowedRuntimeRoots must be unique",
    });
  }
});

export type CapabilityServiceInstanceConfig = z.infer<
  typeof CapabilityServiceInstanceConfigSchema
>;
