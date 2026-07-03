// SPDX-License-Identifier: Apache-2.0
/**
 * Observability mode-invariants source rule.
 *
 * Strict-literal AST walker over `packages/**\/src/**\/*.ts` flagging any
 * bare `fs.mkdirSync` / `fs.writeFileSync` / `fs.promises.mkdir` /
 * `fs.promises.writeFile` call (and bare imports `mkdirSync` /
 * `writeFileSync` / `mkdir` / `writeFile`) lacking an explicit literal
 * `mode:` option of `0o700` (mkdir context) or `0o600` (writeFile context).
 *
 * Variable references, function calls, ternaries, bitwise expressions
 * all fail. Inline `// fs-safe-allowed: <reason>` opt-out comment on the
 * line immediately above the call is honored.
 * `packages/observability/src/shared/fs-safe.ts` is
 * path-allowlisted (it's the layer the rule defers to).
 *
 * Fixture-pre-flight runs BEFORE the production scan: the classifier
 * must produce ≥ 8 violations on `mode-invariants-positive.ts` and 0
 * violations on `mode-invariants-negative.ts` before we trust its
 * production output.
 *
 * @module
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { describe, it, expect } from "vitest";
import { formatViolations } from "../support/architecture-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const PACKAGES_ROOT = resolve(REPO_ROOT, "packages");
const FIXTURES_DIR = resolve(here, "fixtures");

/**
 * Mode-invariants violation kind. Closed union.
 */
type ViolationKind =
  | "no_mode_arg"
  | "wrong_literal_mode"
  | "non_literal_mode"
  | "bitwise_or_ternary_mode";

interface ModeViolation {
  readonly file: string;
  readonly line: number;
  readonly kind: ViolationKind;
  readonly snippet: string;
}

/**
 * Path-allowlist: files that MAY use bare fs calls (substrate layer).
 *
 * `fs-safe.ts` is the layer the rule defers to — it implements the
 * `ensureContainedDir` / `writeRegularFile` / `appendRegularFile`
 * helpers that every caller migrates onto. By definition the substrate
 * must use the bare `fs.mkdirSync` / `fs.writeFileSync` primitives
 * internally; this is the sole legitimate use.
 *
 * Any non-substrate caller within the scanned packages (see
 * `SCANNED_PACKAGES` below) must either pass an explicit literal
 * `mode: 0o700` / `mode: 0o600` arg OR carry an inline
 * `// fs-safe-allowed: <reason>` opt-out comment on the line
 * immediately above the call.
 *
 * This allowlist is single-entry: the substrate itself. Any additional
 * entry is a regression and must be re-migrated.
 */
const MODE_INVARIANT_ALLOWLIST: ReadonlyArray<string> = [
  "packages/observability/src/shared/fs-safe.ts",
] as const;

/**
 * Production-source scan scope: observability-adjacent packages.
 *
 * The production-source rule covers exactly the packages where the substrate
 * is the canonical write path. Other packages (`packages/cli/`,
 * `packages/skills/`, `packages/scheduler/`, `packages/channels/`,
 * `packages/core/`, `packages/orchestrator/`, `packages/web/`,
 * `packages/memory/`) are out of scope — they
 * write to user-supplied paths, browser-tool download directories,
 * workspace dirs, temp dirs, etc., which are NOT `~/.comis/` artifacts
 * and never participated in the substrate migration. Future work could
 * extend this scope; until then the rule stays focused on its
 * regression-prevention mandate.
 */
const SCANNED_PACKAGES: ReadonlyArray<string> = [
  "agent",
  "daemon",
  "observability",
] as const;

/**
 * Names that count as a mkdir-context call (expected literal mode 0o700).
 */
const MKDIR_NAMES = new Set<string>(["mkdirSync", "mkdir"]);

/**
 * Names that count as a writeFile-context call (expected literal mode 0o600).
 */
const WRITEFILE_NAMES = new Set<string>(["writeFileSync", "writeFile"]);

/**
 * Inline opt-out comment regex. Matches `// fs-safe-allowed: <reason>`
 * with at least one non-whitespace reason character after the colon.
 */
const FS_SAFE_ALLOWED_REGEX = /^\s*\/\/\s*fs-safe-allowed:\s+\S+/;

/**
 * AST classifier — returns the list of violations found in the given files.
 *
 * Recognized call patterns:
 *   - fs.mkdirSync / fs.writeFileSync / fs.promises.mkdir / fs.promises.writeFile
 *   - mkdirSync / writeFileSync / mkdir / writeFile (bare imports / destructured)
 *
 * For each match, the LAST argument that is an ObjectLiteralExpression is
 * considered the options arg. The `mode` property within it MUST be a
 * `NumericLiteral` AST node whose text exactly equals `0o700` (mkdir
 * context) or `0o600` (writeFile context). Anything else fails:
 *   - missing options arg or missing mode prop → no_mode_arg
 *   - mode is a numeric literal with WRONG text → wrong_literal_mode
 *   - mode is a binary / conditional / prefix-unary expression → bitwise_or_ternary_mode
 *   - mode is anything else (Identifier / CallExpression / etc.) → non_literal_mode
 */
export function classifyModeInvariants(
  files: ReadonlyArray<string>,
): ModeViolation[] {
  const violations: ModeViolation[] = [];
  for (const file of files) {
    const content = readFileSync(file, "utf-8");
    const sourceFile = ts.createSourceFile(
      file,
      content,
      ts.ScriptTarget.ES2023,
      /* setParentNodes */ true,
    );
    const fileLines = content.split(/\r?\n/);

    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        let calleeName: string | undefined;
        if (ts.isPropertyAccessExpression(callee)) {
          // e.g. `fs.mkdirSync`, `fs.promises.mkdir`
          calleeName = callee.name.text;
        } else if (ts.isIdentifier(callee)) {
          // e.g. bare `mkdirSync(...)`
          calleeName = callee.text;
        }

        const isMkdir = calleeName !== undefined && MKDIR_NAMES.has(calleeName);
        const isWriteFile =
          calleeName !== undefined && WRITEFILE_NAMES.has(calleeName);

        if (isMkdir || isWriteFile) {
          // Defensive: only treat the call as a target if it is genuinely
          // an fs-style call. Members-of-other-objects (e.g. `stub.mkdirSync`)
          // where the object is clearly not `fs` / `fs.promises` / `node:fs`
          // would also match here — to keep the classifier conservative the
          // fixture-negative pins those carve-outs at the test boundary.
          //
          // For the production scan, every member call we see is genuinely
          // an fs call (we don't import anything else exposing these names).
          const expectedMode = isMkdir ? "0o700" : "0o600";

          // Find the LAST argument that is an ObjectLiteralExpression.
          // (mkdir options is arg 2; writeFile options can be arg 2 or arg 3
          // depending on overload — last-object-literal is the simplest
          // heuristic that handles both shapes.)
          let optionsArg: ts.ObjectLiteralExpression | undefined;
          for (let i = node.arguments.length - 1; i >= 0; i--) {
            const a = node.arguments[i];
            if (a !== undefined && ts.isObjectLiteralExpression(a)) {
              optionsArg = a;
              break;
            }
          }

          let violation: ViolationKind | null = null;

          if (optionsArg === undefined) {
            violation = "no_mode_arg";
          } else {
            const modeProp = optionsArg.properties.find(
              (p) =>
                ts.isPropertyAssignment(p) &&
                ts.isIdentifier(p.name) &&
                p.name.text === "mode",
            );
            if (modeProp === undefined) {
              violation = "no_mode_arg";
            } else if (ts.isPropertyAssignment(modeProp)) {
              const initializer = modeProp.initializer;
              if (ts.isNumericLiteral(initializer)) {
                if (initializer.getText(sourceFile) !== expectedMode) {
                  violation = "wrong_literal_mode";
                }
              } else if (
                ts.isBinaryExpression(initializer) ||
                ts.isConditionalExpression(initializer) ||
                ts.isPrefixUnaryExpression(initializer)
              ) {
                violation = "bitwise_or_ternary_mode";
              } else {
                violation = "non_literal_mode";
              }
            }
          }

          if (violation !== null) {
            const { line } = sourceFile.getLineAndCharacterOfPosition(
              node.getStart(sourceFile),
            );
            const lineNum = line + 1; // 1-based
            // Inline opt-out: read the line IMMEDIATELY above the call.
            // `fileLines[line - 1]` is the 0-based line above the call's
            // 0-based line.
            const previousLine = fileLines[line - 1] ?? "";
            if (FS_SAFE_ALLOWED_REGEX.test(previousLine)) {
              // Opted out — skip.
            } else {
              violations.push({
                file,
                line: lineNum,
                kind: violation,
                snippet: (fileLines[line] ?? "").trim().slice(0, 160),
              });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
  }
  return violations;
}

/**
 * Walk production .ts files under packages/<pkg>/src, excluding test files,
 * fixtures, dist, node_modules, __tests__, __snapshots__, __test-helpers,
 * test-fixtures, test-helpers.
 */
function walkProductionFiles(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = resolve(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (
        [
          "__tests__",
          "__snapshots__",
          "__test-helpers",
          "dist",
          "node_modules",
          "fixtures",
          "test-fixtures",
          "test-helpers",
        ].includes(entry.name)
      ) {
        continue;
      }
      walkProductionFiles(full, out);
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".generated.ts") &&
      !entry.name.endsWith(".d.ts")
    ) {
      out.push(full);
    }
  }
}

function collectScannedProductionFiles(): string[] {
  const out: string[] = [];
  for (const pkg of SCANNED_PACKAGES) {
    const pkgSrc = resolve(PACKAGES_ROOT, pkg, "src");
    walkProductionFiles(pkgSrc, out);
  }
  return out;
}

function repoRelative(absPath: string): string {
  return relative(REPO_ROOT, absPath).replace(/\\/g, "/");
}

function isAllowlisted(file: string): boolean {
  const rel = repoRelative(file);
  return MODE_INVARIANT_ALLOWLIST.some(
    (allowed) => rel === allowed || rel.endsWith(`/${allowed}`),
  );
}

describe("observability-mode-invariants — classifier fixture-positive", () => {
  it("mode-invariants-positive fixture produces ≥ 8 violations (one per pattern)", () => {
    const positive = resolve(FIXTURES_DIR, "mode-invariants-positive.ts");
    const violations = classifyModeInvariants([positive]);
    expect(
      violations.length,
      `Classifier must detect ≥ 8 violations in the positive fixture (got ${violations.length})`,
    ).toBeGreaterThanOrEqual(8);

    // Diversity check: at least 3 distinct violation kinds (no_mode_arg,
    // wrong_literal_mode, and at least one of non_literal_mode /
    // bitwise_or_ternary_mode).
    const kinds = new Set(violations.map((v) => v.kind));
    expect(
      kinds.size,
      `Classifier must detect ≥ 3 distinct ViolationKinds (got ${kinds.size}: ${[...kinds].join(", ")})`,
    ).toBeGreaterThanOrEqual(3);
  });
});

describe("observability-mode-invariants — classifier fixture-negative", () => {
  it("mode-invariants-negative fixture produces 0 violations", () => {
    const negative = resolve(FIXTURES_DIR, "mode-invariants-negative.ts");
    const violations = classifyModeInvariants([negative]);
    expect(
      violations,
      formatViolations({
        description:
          "mode-invariants-negative fixture MUST classify clean. " +
          "Literal 0o700/0o600 modes, JSDoc / line-comment / string-literal " +
          "mentions, and inline `fs-safe-allowed:` opt-out comments must not flag.",
        violations: violations.map((v) => ({
          file: repoRelative(v.file),
          line: v.line,
          snippet: `${v.kind}: ${v.snippet}`,
        })),
        suggestedFix:
          "Adjust the classifier so the named CLEAN case is no longer matched. " +
          "Negative fixtures pin the boundary of classifier correctness.",
        designRef: "the ~/.comis artifact-permission hardening rule (0o700 dirs / 0o600 files)",
      }),
    ).toEqual([]);
  });
});

describe("observability-mode-invariants — production source", () => {
  it("packages_src_does_not_call_fs_mkdir_or_writeFile_without_literal_mode", () => {
    const files = collectScannedProductionFiles();
    const allViolations = classifyModeInvariants(files);
    const offenders = allViolations.filter((v) => !isAllowlisted(v.file));

    expect(
      offenders,
      formatViolations({
        description:
          "Observability-adjacent production source (packages/{agent,daemon,observability}/src) " +
          "must call fs.mkdirSync / fs.writeFileSync / fs.promises.mkdir / " +
          "fs.promises.writeFile (and bare-import equivalents) ONLY with " +
          "an explicit literal mode arg of 0o700 (mkdir) or 0o600 " +
          "(writeFile). Variable " +
          "references, function calls, ternaries, bitwise expressions are " +
          "not allowed.",
        violations: offenders.map((v) => ({
          file: `${repoRelative(v.file)}:${v.line}`,
          line: v.line,
          snippet: `${v.kind}: ${v.snippet}`,
        })),
        suggestedFix:
          "Migrate the call to `@comis/observability/shared/fs-safe.ts` — use " +
          "`ensureContainedDir({dir, mode: 0o700, confinedBaseDir})` for " +
          "directories and `writeRegularFile({path, content, confinedBaseDir})` " +
          "for files. If the call legitimately cannot use the substrate " +
          "(e.g., ephemeral test-fixture state outside ~/.comis/), add an " +
          "inline `// fs-safe-allowed: <reason>` comment on the line above " +
          "the call.",
        designRef: "the ~/.comis artifact-permission hardening rule (0o700 dirs / 0o600 files)",
        allowlistRef:
          "MODE_INVARIANT_ALLOWLIST in test/architecture/observability-mode-invariants.test.ts",
      }),
    ).toEqual([]);

    // Sanity: walker actually scanned production files.
    expect(
      files.length,
      "sanity: collectScannedProductionFiles enumerated at least one file",
    ).toBeGreaterThan(0);
  });

  it("fs_safe_substrate_file_is_path_allowlisted", () => {
    // fs-safe.ts itself implements the helpers; by construction it uses
    // bare fs.mkdirSync / fs.writeFileSync. The allowlist exempts it.
    const fsSafeAbsolute = resolve(
      PACKAGES_ROOT,
      "observability/src/shared/fs-safe.ts",
    );
    expect(isAllowlisted(fsSafeAbsolute)).toBe(true);
  });

  it("inline_fs_safe_allowed_comment_opts_out_a_callsite", () => {
    // The negative fixture's CLEAN 10 case exercises the opt-out path: a
    // bare fs.mkdirSync call with NO mode arg is suppressed because the
    // line immediately above carries `// fs-safe-allowed: <reason>`. If
    // the classifier ever stops honoring the opt-out, the fixture-negative
    // test breaks first, but this assertion confirms the round-trip
    // explicitly.
    const negative = resolve(FIXTURES_DIR, "mode-invariants-negative.ts");
    const violations = classifyModeInvariants([negative]);
    expect(violations).toEqual([]);
  });
});
