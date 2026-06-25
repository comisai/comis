// SPDX-License-Identifier: Apache-2.0
/**
 * RED stub — replaced by the GREEN implementation in the same plan.
 */
import type { DeltaOp, DocSection } from "@comis/core";

export interface ReflectionResult {
  ops?: DeltaOp[];
  sections?: DocSection[];
}

export const REFLECT_PROMPT = "";

export function parseReflectionResult(_text: string): ReflectionResult {
  return {};
}
