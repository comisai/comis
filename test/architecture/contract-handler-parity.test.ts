// SPDX-License-Identifier: Apache-2.0
/**
 * CI-01 — contract↔handler-body field parity AST gate.
 *
 * Per Phase 62 D-04: every REQUIRED (non-optional, non-`_X`-internal)
 * request field of every `defineContract(...)` MUST appear by literal name
 * in the matching handler body. This walker exists to prevent the exact
 * class of bug Phase 62 is recovering from: `de12e97d chore: sync
 * accumulated local commits` merged the contract scaffolding
 * (`McpConnectContract.response` with a new `persistence` field) but NOT
 * the matching handler-body persistence path — so `mcp.connect` silently
 * dropped the persistence call. With this gate in place, any future PR
 * that adds a new required request field but forgets to wire the handler
 * body fails the build with the contract name + missing field name.
 *
 * Per Phase 62 D-05: legitimate parse-then-spread handlers
 * (e.g., handlers that do `const params = Contract.request.parse(...)`
 * and then `manager.connect({ ...params })`) can whitelist deferred
 * fields via a `// @contract-deferred-fields: <field1>,<field2>`
 * annotation comment on the same handler-factory line (or in the
 * leading trivia immediately before the `[Contract.method]:` key).
 * Annotations are CI-visible in PR diffs and easy to grep.
 *
 * Per Phase 62 D-06: walked AST: contracts under
 * `packages/core/src/api-contracts/**\/*.ts`; handlers under
 * `packages/daemon/src/api/**\/*.ts`. Failure message surfaces the
 * contract name + the missing field name.
 *
 * Design notes:
 *
 * Required-set construction:
 *   - For every `export const <Name>Contract = defineContract({ method,
 *     request, ... })`, walk the `request` schema initializer.
 *   - Unwrap leading method calls (`.partial()`, `.strict()`,
 *     `.extend()`) until we reach the inner `z.object({...})`.
 *   - For each top-level property assignment:
 *     - Skip if the field name is in `INTERNAL_FIELD_NAMES` (dispatcher-
 *       injected `_X` keys are never required of the contract — the
 *       paired `contract-internal-fields.test.ts` already forbids
 *       modeling them).
 *     - Skip if the field's initializer chain ends in `.optional()`,
 *       `.nullable()`, or `.nullish()`.
 *   - The remaining fields form the required-set for this contract.
 *
 * Handler-info construction:
 *   - For every `[<Contract>.method]:` computed-name property
 *     assignment in a handler factory file (this is the bidirectional
 *     test's "migrated handler" idiom), collect:
 *     - `refs`: every `Identifier.text` referenced inside the handler
 *       body. Property-access chains like `params.server_name` produce
 *       both `params` and `server_name` identifiers (the latter is
 *       what the gate matches).
 *     - `deferred`: every comma-separated field name from
 *       `// @contract-deferred-fields: a,b,c` in the leading trivia
 *       immediately before the property-assignment node. The
 *       walker reads `node.getFullStart()` → `node.getStart()` so the
 *       annotation is scoped to THIS handler only, not a sibling.
 *
 * Comparison:
 *   - For each contract: every required field MUST be in `refs` OR
 *     `deferred`. Missing → violation.
 *   - If no migrated handler exists for a contract, also a violation
 *     (`<name>: no migrated handler found`).
 *
 * Reused / duplicated helpers per CONTEXT.md D-06 + PATTERNS.md
 * §contract-handler-parity.test.ts Option B: `listContractFiles`,
 * `listHandlerFiles` mirror the implementation in
 * `api-contracts-bidirectional.test.ts:45-108`. The two helpers are
 * duplicated here rather than extracted to a shared module so this
 * test file is self-contained and the shared-helper extraction can
 * be revisited under AGENTS.md §2.3 rule-of-three when a third
 * architecture test wants them.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { INTERNAL_FIELD_NAMES } from "@comis/core";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const CONTRACT_DIR = resolve(REPO_ROOT, "packages/core/src/api-contracts");
const HANDLER_DIR = resolve(REPO_ROOT, "packages/daemon/src/api");
const INTERNAL_SET: ReadonlySet<string> = new Set<string>(INTERNAL_FIELD_NAMES);

/**
 * Annotation tag used for D-05 escape-hatch comments. The walker greps
 * the leading trivia of each `[Contract.method]:` property-assignment
 * node for this tag; comma-separated field names following the tag are
 * subtracted from the required-set for that handler.
 *
 * Example (legitimate parse-then-spread):
 *
 *     // @contract-deferred-fields: foo,bar
 *     [FooContract.method]: async (rawParams) => {
 *       const params = FooContract.request.parse(rawParams);
 *       return manager.doIt({ ...params });
 *     },
 */
const DEFERRED_TAG = "@contract-deferred-fields:";

// ---------------------------------------------------------------------------
// Helpers — duplicated verbatim from api-contracts-bidirectional.test.ts
// (Option B per CONTEXT.md / PATTERNS.md).
// ---------------------------------------------------------------------------

/**
 * Recursively enumerate every `.ts` file under `dir`, skipping
 * `*.test.ts` files and `__snapshots__/` directories. Supports the
 * subdirectory split (workspace/, orchestrator/ under api-contracts/).
 */
function listContractFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    const full = resolve(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === "__snapshots__") continue;
      out.push(...listContractFiles(full));
    } else if (
      ent.isFile() &&
      ent.name.endsWith(".ts") &&
      !ent.name.endsWith(".test.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Recursively enumerate handler files. Top level: only `*-handlers.ts`
 * (preserves the original semantics of the bidirectional test).
 * Inside `*-handlers/` subdirectories (`graph-handlers/`,
 * `obs-handlers/`, `session-handlers/`, `config-handlers/`): any
 * non-test `.ts` file. Returns absolute paths.
 */
function listHandlerFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    const relPath = prefix ? `${prefix}/${ent.name}` : ent.name;
    const full = resolve(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === "__snapshots__" || ent.name === "shared") continue;
      if (ent.name.endsWith("-handlers")) {
        out.push(...listHandlerFiles(full, relPath));
      }
    } else if (
      ent.isFile() &&
      ent.name.endsWith(".ts") &&
      !ent.name.endsWith(".test.ts") &&
      !ent.name.endsWith(".parity.test.ts")
    ) {
      if (prefix) {
        out.push(full);
      } else if (ent.name.endsWith("-handlers.ts")) {
        out.push(full);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Contract-side AST walker.
// ---------------------------------------------------------------------------

/**
 * Returns true when the Zod field initializer chain ends in
 * `.optional()`, `.nullable()`, or `.nullish()`. The walker traverses
 * outer `CallExpression(PropertyAccessExpression)` nodes until it
 * either finds one of the three marker method names or runs out of
 * call chains.
 *
 * Note: `.optional()` may appear at ANY position in the chain (e.g.
 * `z.string().min(1).optional().describe("...")`). The chain walk
 * inspects every method name on the way down, not just the outermost
 * one.
 */
function isZodOptionalOrNullable(expr: ts.Expression): boolean {
  let cur: ts.Expression = expr;
  while (ts.isCallExpression(cur)) {
    if (ts.isPropertyAccessExpression(cur.expression)) {
      const methodName = cur.expression.name.text;
      if (
        methodName === "optional" ||
        methodName === "nullable" ||
        methodName === "nullish"
      ) {
        return true;
      }
      cur = cur.expression.expression;
    } else {
      break;
    }
  }
  return false;
}

/**
 * Walk a `z.object({ ... })` expression (possibly wrapped in
 * `.partial()` / `.strict()` / `.extend()` / etc.) and return the
 * required field names: non-optional, non-INTERNAL.
 *
 * Outer-call unwrap is intentional: an `extend({})` or `strict()`
 * around a `z.object(...)` does not change the required-set of the
 * inner object's own declared fields.
 *
 * Computed property names (`[someVar]: z.string()`) are un-checkable
 * statically; they are skipped silently.
 */
function collectRequiredFieldsFromZodObject(expr: ts.Expression): string[] {
  // Unwrap leading method calls (`.partial()` / `.strict()` /
  // `.extend()` / etc.) until we reach the underlying `z.object(...)`.
  let cur: ts.Expression = expr;
  while (
    ts.isCallExpression(cur) &&
    ts.isPropertyAccessExpression(cur.expression)
  ) {
    // Stop unwrapping once we see `z.object(...)` (the inner-call form).
    const left = cur.expression.expression;
    if (
      ts.isIdentifier(left) &&
      left.text === "z" &&
      cur.expression.name.text === "object"
    ) {
      break;
    }
    cur = cur.expression.expression;
  }
  if (!ts.isCallExpression(cur)) return [];

  const arg0 = cur.arguments[0];
  if (!arg0 || !ts.isObjectLiteralExpression(arg0)) return [];

  const out: string[] = [];
  for (const prop of arg0.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    // Accept Identifier or StringLiteral keys; reject ComputedPropertyName.
    let fieldName: string | undefined;
    if (ts.isIdentifier(prop.name)) {
      fieldName = prop.name.text;
    } else if (ts.isStringLiteral(prop.name)) {
      fieldName = prop.name.text;
    }
    if (!fieldName) continue;
    if (INTERNAL_SET.has(fieldName)) continue;
    if (isZodOptionalOrNullable(prop.initializer)) continue;
    out.push(fieldName);
  }
  return out;
}

/**
 * Extract `<ContractName> → required-field-names` for one contract
 * file. Walks every `export const <Name> = defineContract({ method,
 * request: z.object({...}), ... })` declaration.
 *
 * Returns the LOCAL declaration name (`McpConnectContract`), not the
 * method-string (`"mcp.connect"`) — the handler-side walker matches by
 * the same local name via the `[Contract.method]:` computed-name idiom.
 */
function extractContractRequiredFields(file: string): Map<string, string[]> {
  const src = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.ES2023, true);
  const out = new Map<string, string[]>();

  ts.forEachChild(sf, (node) => {
    if (!ts.isVariableStatement(node)) return;
    for (const decl of node.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name)) continue;
      if (!decl.initializer || !ts.isCallExpression(decl.initializer)) continue;
      if (
        !ts.isIdentifier(decl.initializer.expression) ||
        decl.initializer.expression.text !== "defineContract"
      ) {
        continue;
      }
      const arg0 = decl.initializer.arguments[0];
      if (!arg0 || !ts.isObjectLiteralExpression(arg0)) continue;

      const requestProp = arg0.properties.find(
        (p) =>
          ts.isPropertyAssignment(p) &&
          ts.isIdentifier(p.name) &&
          p.name.text === "request",
      );
      if (!requestProp || !ts.isPropertyAssignment(requestProp)) continue;

      const fields = collectRequiredFieldsFromZodObject(requestProp.initializer);
      // Record EVERY contract — even those with zero required fields —
      // so the handler-side scan can match by name (zero-field
      // contracts trivially pass since their for-loop is empty).
      out.set(decl.name.text, fields);
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// Handler-side AST walker.
// ---------------------------------------------------------------------------

/** Per-handler analysis result. */
interface HandlerInfo {
  readonly refs: ReadonlySet<string>;
  readonly deferred: ReadonlySet<string>;
}

/**
 * For one handler factory file, walk every `[Contract.method]:`
 * computed-name property assignment and collect:
 *   - `refs`: every `Identifier.text` referenced anywhere inside the
 *     property-assignment node (including the arrow-function body).
 *   - `deferred`: comma-separated field names from any
 *     `// @contract-deferred-fields: a,b` annotation in the leading
 *     trivia (between `node.getFullStart()` and `node.getStart()`).
 *
 * Returns map keyed by the CONTRACT'S LOCAL DECLARATION NAME
 * (`McpConnectContract`) so the parity check can look up the
 * required-set produced by `extractContractRequiredFields`.
 */
function collectHandlerReferencesAndAnnotations(
  file: string,
): Map<string, HandlerInfo> {
  const src = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.ES2023, true);
  const out = new Map<string, HandlerInfo>();

  function visit(node: ts.Node): void {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isComputedPropertyName(node.name) &&
      ts.isPropertyAccessExpression(node.name.expression) &&
      ts.isIdentifier(node.name.expression.expression) &&
      node.name.expression.name.text === "method"
    ) {
      const contractName = node.name.expression.expression.text;

      // Parse `// @contract-deferred-fields: a,b` from leading trivia.
      // The trivia window is bounded by `node.getFullStart()` (which
      // INCLUDES preceding whitespace + comments) and `node.getStart()`
      // (which is the first non-trivia character — typically the `[`
      // of the computed property name). This naturally scopes the
      // annotation to THIS handler: trivia between the previous
      // PropertyAssignment's end and this one's start.
      const triviaStart = node.getFullStart();
      const triviaEnd = node.getStart();
      const trivia = src.substring(Math.max(0, triviaStart), triviaEnd);
      const deferredSet = new Set<string>();
      // Match every occurrence of the tag — a single annotation line
      // is the documented shape, but if a future handler stacks two
      // (e.g., one per logical reason) all stated fields are
      // honored. Regex captures the field-list payload up to end of
      // line; subsequent comma-split + trim filters blanks.
      const tagRe = new RegExp(
        `${DEFERRED_TAG.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\s*([^\\n]*)`,
        "g",
      );
      let m: RegExpExecArray | null;
      while ((m = tagRe.exec(trivia)) !== null) {
        const payload = (m[1] ?? "").trim();
        if (!payload) continue;
        for (const raw of payload.split(",")) {
          const field = raw.trim();
          // Stop at first non-identifier-ish char so trailing prose
          // ("foo,bar — because spread") doesn't leak words into the
          // set. Conservative: keep only [\w]+ prefix of each token.
          const m2 = field.match(/^[A-Za-z_$][\w$]*/);
          if (m2) deferredSet.add(m2[0]);
        }
      }

      // Collect every Identifier referenced inside the
      // PropertyAssignment node (NOT including the property name
      // itself, which would otherwise add `method` to the set —
      // harmless, but `refs` is cleaner without it). Walking via
      // `ts.forEachChild` from the initializer (the arrow function)
      // skips the LHS computed name automatically.
      const refs = new Set<string>();
      const init = node.initializer;
      function gather(n: ts.Node): void {
        if (ts.isIdentifier(n)) {
          refs.add(n.text);
        }
        ts.forEachChild(n, gather);
      }
      ts.forEachChild(init, gather);

      out.set(contractName, { refs, deferred: deferredSet });
    }
    ts.forEachChild(node, visit);
  }
  ts.forEachChild(sf, visit);
  return out;
}

// ---------------------------------------------------------------------------
// Test.
// ---------------------------------------------------------------------------

describe("CI-01 — contract↔handler-body field parity", () => {
  it("every required contract request field is referenced (or annotated) in its handler body", () => {
    // 1. Aggregate `ContractName -> required-field-names` across all
    //    contract files.
    const contractFields = new Map<string, string[]>();
    for (const file of listContractFiles(CONTRACT_DIR)) {
      for (const [name, fields] of extractContractRequiredFields(file)) {
        contractFields.set(name, fields);
      }
    }

    // 2. Aggregate `ContractName -> { refs, deferred }` across all
    //    handler factory files.
    const handlerInfo = new Map<string, HandlerInfo>();
    for (const file of listHandlerFiles(HANDLER_DIR)) {
      for (const [name, info] of collectHandlerReferencesAndAnnotations(file)) {
        handlerInfo.set(name, info);
      }
    }

    // 3. Compare. Every required field of every contract must appear
    //    in the matching handler's identifier-set OR in its
    //    deferred-fields annotation.
    const violations: string[] = [];
    for (const [contractName, fields] of contractFields) {
      const info = handlerInfo.get(contractName);
      if (!info) {
        // A contract with no migrated handler is a violation
        // distinct from a missing field: surfaces author drift
        // where a contract was added without a matching computed-key
        // handler. The bidirectional test enforces the same shape
        // from the opposite direction; reasserting here keeps CI-01
        // self-contained.
        violations.push(`${contractName}: no migrated handler found`);
        continue;
      }
      for (const f of fields) {
        if (!info.refs.has(f) && !info.deferred.has(f)) {
          violations.push(
            `${contractName}: handler body does not reference required field "${f}" (and not in @contract-deferred-fields)`,
          );
        }
      }
    }

    expect(violations, violations.join("\n")).toEqual([]);
  });
});
