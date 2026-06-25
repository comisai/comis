// SPDX-License-Identifier: Apache-2.0
/**
 * RED stub — replaced by the GREEN implementation in the same plan.
 */
import { err, type Result } from "@comis/shared";
import type { DocSection } from "@comis/core";
import type { ReflectionResult } from "./reflection-prompt.js";
import type { CustomCompletionsModelSpec } from "./judge-model-resolver.js";

export interface ReflectionAdapterLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface LlmReflectionAdapterDeps {
  provider: string;
  modelId: string;
  apiKey: string;
  customModel?: CustomCompletionsModelSpec;
  clock: { now: () => number };
  logger: ReflectionAdapterLogger;
}

export interface ReflectInput {
  trajectoryText: string;
  currentSections: DocSection[];
}

export interface ReflectionAdapter {
  reflect(input: ReflectInput): Promise<Result<ReflectionResult, Error>>;
}

export function createLlmReflectionAdapter(_deps: LlmReflectionAdapterDeps): ReflectionAdapter {
  return {
    reflect: async () => err(new Error("not implemented")),
  };
}
