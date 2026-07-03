// SPDX-License-Identifier: Apache-2.0
/**
 * Leaf-key AST mutator for `comis config tooling-fill`.
 *
 * Updates ONLY `description` and `replacesPackages` under
 * `tooling.<kind>.capabilityHints.<name>` — sibling keys (`cluster`,
 * any future fields), sibling hints, and non-tooling sections are
 * byte-preserved (strict scope; atomic-edit semantics; mcp + skills
 * symmetry).
 *
 * The mutator NEVER creates a new hint — if the path is absent it
 * returns err. Creating new hints is generate.ts's job
 * (`comis config sync-tooling --write` materializes them; tooling-fill
 * populates the stubs after).
 *
 * commentBefore on `replacesPackages` (the
 * `# TODO: list npm/pip packages this MCP replaces` line emitted by
 * generate.ts) and any commentBefore on the hint key itself are
 * preserved automatically because we replace the VALUE node only, not
 * the Pair's key — yaml@2.8.4 setIn at a leaf path replaces just the
 * value Pair's right-hand side.
 *
 * Design notes:
 *  - Pure function: no fs I/O, no Commander wiring. Caller wraps
 *    parseDocument + this module + doc.toString() in a Result shell.
 *  - Result<void, ApplyHintError> over throw — never throws at the public boundary.
 *  - Same yaml@2.8.4 primitives as generate.ts (hasIn, setIn,
 *    createNode); no js-yaml dependency.
 *  - replacesPackages is fully replaced (not merged) — `--force=replace`
 *    overwrite semantics.
 *
 * @module
 */

import { isMap, isPair, isScalar, type Document } from "yaml";
import { ok, err, type Result } from "@comis/shared";

/**
 * generate.ts emits this commentBefore on the `replacesPackages` Pair
 * when materializing a stub. Once tooling-fill populates the field with
 * real packages, the TODO is stale — strip it so the YAML stays clean.
 * Keep operator-authored comments (anything else) intact.
 */
const STUB_TODO_COMMENT = " TODO: list npm/pip packages this MCP replaces";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Which capabilityHints map to target. */
export type FillKind = "mcp" | "skills";

/** Closed union of failure modes the mutator can surface. */
export type ApplyHintErrorKind =
  | "hint-not-found"
  | "invalid-kind"
  | "doc-corrupt";

/** Failure shape — `path` is the dotted hint path or `<root>` for doc-corrupt. */
export interface ApplyHintError {
  readonly kind: ApplyHintErrorKind;
  readonly path: string;
  readonly detail?: string;
}

/** The two leaf fields setHintFields manages. */
export interface HintFields {
  readonly description: string;
  readonly replacesPackages: readonly string[];
}

// ---------------------------------------------------------------------------
// setHintFields — the only export
// ---------------------------------------------------------------------------

/**
 * Update `description` and `replacesPackages` on an existing capability hint.
 *
 * @param doc    - parsed yaml@2.8.4 Document (caller's parseDocument output).
 * @param kind   - "mcp" or "skills" — selects between
 *                 tooling.mcp.capabilityHints and tooling.skills.capabilityHints.
 * @param name   - the bare hint key under that map (e.g. "yfinance").
 * @param fields - the two values to set; replacesPackages is fully replaced
 *                 (never merged).
 * @returns ok(undefined) on success;
 *          err({kind:"hint-not-found"}) if the path is absent (caller
 *          decides whether to refuse or to create the hint);
 *          err({kind:"invalid-kind"}) if `kind` is something other than
 *          "mcp"/"skills" after a runtime cast-around;
 *          err({kind:"doc-corrupt"}) if doc.contents is null/undefined.
 *
 * Failure paths leave the doc unmutated.
 */
export function setHintFields(
  doc: Document,
  kind: FillKind,
  name: string,
  fields: HintFields,
): Result<void, ApplyHintError> {
  // Runtime guard for callers that cast around the FillKind type.
  if (kind !== "mcp" && kind !== "skills") {
    return err({
      kind: "invalid-kind",
      path: String(kind),
      detail: `expected "mcp" | "skills"`,
    });
  }

  // parseDocument("") produces a Document with contents === null. setIn on
  // null content would silently bootstrap a root map, but for tooling-fill
  // we want an explicit failure — the caller is operating on an existing
  // config that already has hints.
  if (doc.contents == null) {
    return err({
      kind: "doc-corrupt",
      path: "<root>",
      detail: "empty document",
    });
  }

  const hintPath: string[] = ["tooling", kind, "capabilityHints", name];

  // hasIn returns false if any segment of the path is missing — covers both
  // "the hint name doesn't exist under capabilityHints" and "capabilityHints
  // (or the parent map) doesn't exist at all".
  if (!doc.hasIn(hintPath)) {
    return err({
      kind: "hint-not-found",
      path: hintPath.join("."),
    });
  }

  // Update description (string scalar). yaml@2.8.4's setIn at this leaf path
  // replaces only the Pair's value — the key Scalar (and any commentBefore
  // attached to it) is not rewritten. yaml auto-quotes the value when it
  // contains YAML metacharacters (`: `, `,`, `#` etc.).
  doc.setIn([...hintPath, "description"], fields.description);

  // Update replacesPackages — fully replace the YAMLSeq with a fresh node.
  // createNode wraps the JS array as a YAMLSeq (yaml's default for arrays
  // is block-style for non-empty + flow-style for empty `[]`, matching the
  // existing fixture). We spread into a mutable array because createNode
  // accepts a JS value and `readonly string[]` from the input would
  // otherwise propagate as a frozen value into the AST.
  doc.setIn(
    [...hintPath, "replacesPackages"],
    doc.createNode([...fields.replacesPackages]),
  );

  // Strip the stale `# TODO: list npm/pip packages this MCP replaces`
  // commentBefore that generate.ts emits as a stub prompt. Once the
  // operator (or LLM) has populated replacesPackages with real values, the
  // TODO is misleading and clutters the YAML. We preserve any other
  // commentBefore (operator-authored notes), only matching the literal
  // generated stub.
  if (fields.replacesPackages.length > 0) {
    const hintMapNode = doc.getIn(hintPath, true);
    if (isMap(hintMapNode)) {
      for (const p of hintMapNode.items) {
        if (!isPair(p)) continue;
        if (!isScalar(p.key)) continue;
        if (p.key.value !== "replacesPackages") continue;
        // Strip ONLY the generated stub. Operator-authored commentBefore
        // on the same key is left alone.
        if (p.key.commentBefore === STUB_TODO_COMMENT) {
          delete p.key.commentBefore;
        }
        break;
      }
    }
  }

  return ok(undefined);
}
