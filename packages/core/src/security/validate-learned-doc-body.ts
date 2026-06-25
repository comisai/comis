// SPDX-License-Identifier: Apache-2.0
/**
 * STUB (RED) — implemented GREEN in Task 2.
 * @module
 */

export const MAX_DOC_NAME_LENGTH = 120;

export interface LearnedDocValidation {
  readonly ok: boolean;
  readonly findings: ReadonlyArray<{ readonly field: string; readonly patterns: string[] }>;
}

export function validateLearnedDocBody(_doc: { name: string; body: string; description: string }): LearnedDocValidation {
  return { ok: true, findings: [] };
}
