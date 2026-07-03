// SPDX-License-Identifier: Apache-2.0
/**
 * validateLearnedDocBody — the STATIC poison/secret scan that is ALL the validation
 * an advisory Mental Model doc receives before it crosses into durable storage.
 *
 * Each untrusted text field (`name` / `body` / `description`) is run through the
 * {@link validateMemoryWrite} keystone, and a CRITICAL on ANY field rejects the doc
 * (the memory-poison `injection-trajectory` + secret-egress defenses). A
 * `warn` severity is benign — the keystone records it but it NEVER rejects (severity
 * is a classification, never coerced to a boolean). The attacker-influenced `name`
 * (LLM output distilled from an UNTRUSTED transcript) is ALSO length-bounded to
 * reject a megabyte-name DoS before the scan runs over it.
 *
 * STATIC-ONLY by construction: an advisory doc carries no embedded procedure,
 * no parameter schema, no tool policy and no dynamic-replay surface — so this
 * function has none of that. There is no process execution, no sandbox, and no
 * skills-package import; the learned-code-execution attack surface is removed
 * entirely. It depends ONLY on `validateMemoryWrite`, which already lives in
 * @comis/core — a placement that lets the agent reflection job call it
 * directly and keeps the daemon reflect bundle free of a skills-package
 * dependency.
 *
 * Privacy: a finding carries the field name + pattern NAMES /
 * `criticalPatterns` labels (e.g. `secret-egress-guard`) — NEVER the matched secret
 * value or the offending body text. This is the existing `validateMemoryWrite`
 * contract, unchanged.
 *
 * @module validate-learned-doc-body
 */

import { validateMemoryWrite } from "./memory-write-validator.js";

/**
 * The maximum char length allowed for a learned-doc `name`.
 * `name` is attacker-influenced (LLM output distilled from
 * an UNTRUSTED transcript) and flows into durable storage / lookup keys / prompts, so
 * a sane ceiling rejects a megabyte-name DoS at validation. 120 chars matches the
 * prompt's "short, stable, kebab-case" instruction.
 */
export const MAX_DOC_NAME_LENGTH = 120;

/** A single rejected-field finding: the field name + the matched pattern NAMES (never the value). */
export interface LearnedDocFinding {
  readonly field: string;
  readonly patterns: string[];
}

/**
 * The result of the static learned-doc scan. `ok` is true iff there are zero
 * findings; `findings` carries one entry per rejected field (field name + pattern
 * names — never the offending content).
 */
export interface LearnedDocValidation {
  readonly ok: boolean;
  readonly findings: LearnedDocFinding[];
}

/**
 * Run the STATIC poison/secret scan over an advisory doc's `name` / `body` /
 * `description`. A CRITICAL on ANY field (a DANGEROUS_COMMAND_PATTERN or a
 * secret-egress hit) ⇒ reject; an over-cap `name` ⇒ reject. A `warn` is recorded by
 * the keystone but never rejects. No embedded procedure, no parameter schema, no tool
 * policy, no dynamic replay — this is the entire validation an advisory doc receives.
 *
 * @param doc - the candidate advisory doc (untrusted, LLM-distilled).
 * @returns `{ ok, findings }` — `ok:false` with per-field findings on any rejection.
 */
export function validateLearnedDocBody(doc: { name: string; body: string; description: string }): LearnedDocValidation {
  const findings: LearnedDocFinding[] = [];

  // Length bound on the attacker-influenced `name` — an over-cap name is a finding
  // (never silently truncated), so a poisoned oversized name can never enter storage.
  if (doc.name.length > MAX_DOC_NAME_LENGTH) {
    findings.push({ field: "name", patterns: ["name-too-long"] });
  }

  // Per-field validateMemoryWrite scan — a CRITICAL on ANY field rejects. `warn`
  // (e.g. a jailbreak phrase) is benign: the keystone returns severity "warn", we do
  // not push a finding, the doc passes (severity must never be coerced to a boolean).
  const textFields: ReadonlyArray<readonly [string, string]> = [
    ["name", doc.name],
    ["body", doc.body],
    ["description", doc.description],
  ];
  for (const [field, content] of textFields) {
    const r = validateMemoryWrite(content);
    if (r.severity === "critical") {
      findings.push({ field, patterns: r.criticalPatterns });
    }
  }

  return { ok: findings.length === 0, findings };
}
