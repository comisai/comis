// SPDX-License-Identifier: Apache-2.0
/**
 * Exec failure diagnostics: pattern-based recovery hints for known-recoverable
 * subprocess failures. Pure functions — no throws, no I/O beyond synchronous
 * filesystem existence checks scoped to `cwd` via safePath.
 *
 * Wired into executeForeground's stderr finalization in exec-tool.ts. When a
 * matcher returns non-null, its hint is prepended to finalStderr with a
 * `RECOVERY HINT:` prefix so the LLM sees actionable recovery info at the head
 * of the error stream — same surfacing pattern as the existing
 * breakSystemWarning on stdout.
 *
 * Day 1 ships ONE matcher (Python ModuleNotFoundError + missing pyproject.toml).
 * Future matchers register as additional entries in the matchers array — no
 * edits to exec-tool.ts required.
 *
 * @module
 */

import { existsSync, statSync } from "node:fs";
import { safePath } from "@comis/core";

export interface ExecRecoveryInput {
  /** Final stderr text (post-truncation, post-timeout/abort suffix). */
  stderr: string;
  /** Process exit code. Matchers may early-return on 0. */
  exitCode: number;
  /** Absolute working directory the command ran in. Already workspace-bounded by exec-tool's resolveCwd. */
  cwd: string;
}

type Matcher = (input: ExecRecoveryInput) => string | null;

// ---------------------------------------------------------------------------
// Matcher: Python ModuleNotFoundError + missing pyproject.toml
// ---------------------------------------------------------------------------

/**
 * Match `python -m foo` failures where stderr is `ModuleNotFoundError: No module
 * named 'foo'` AND `cwd/foo/` or `cwd/src/foo/` exists AND `cwd/pyproject.toml`
 * does not. The user has a Python project but no installable package metadata,
 * so `python -m foo` cannot resolve it. Suggest writing pyproject.toml +
 * `pip install -e .`.
 */
const PY_MODULE_NOT_FOUND_RE = /ModuleNotFoundError:\s*No module named ['"]([^'"]+)['"]/;
const SAFE_PKG_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function isDirectorySafe(p: string): boolean {
  try {
    if (!existsSync(p)) return false;
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

const matchPythonModuleNotFound: Matcher = ({ stderr, exitCode, cwd }) => {
  if (exitCode === 0) return null;
  const m = PY_MODULE_NOT_FOUND_RE.exec(stderr);
  if (!m) return null;

  // For `python -m a.b.c` ModuleNotFoundError reports the LEADING segment
  // ('a') when 'a' itself can't be found. Take the first dotted segment;
  // anything else (hyphens, empty, leading digit) abstains via SAFE_PKG_NAME_RE.
  const fullName = m[1];
  const pkg = fullName.split(".")[0];
  if (!SAFE_PKG_NAME_RE.test(pkg)) return null;

  try {
    // Already-installable project — different bug, abstain.
    const pyproject = safePath(cwd, "pyproject.toml");
    if (existsSync(pyproject)) return null;

    // Look for cwd/<pkg>/ or cwd/src/<pkg>/. Both must be directories.
    const directDir = safePath(cwd, pkg);
    let foundLayout: "flat" | "src" | null = null;
    if (isDirectorySafe(directDir)) {
      foundLayout = "flat";
    } else {
      const srcDir = safePath(cwd, "src");
      if (isDirectorySafe(srcDir)) {
        const srcPkgDir = safePath(srcDir, pkg);
        if (isDirectorySafe(srcPkgDir)) {
          foundLayout = "src";
        }
      }
    }
    if (!foundLayout) return null;

    const pkgPathHint = foundLayout === "src" ? `src/${pkg}/` : `${pkg}/`;
    const layoutTable =
      foundLayout === "src"
        ? `[tool.setuptools.packages.find] where=["src"]`
        : `[tool.setuptools] packages=["${pkg}"]`;
    return (
      `RECOVERY HINT: This Python project is missing pyproject.toml. ` +
      `Found ${pkgPathHint} but no installable package metadata, so \`python -m ${pkg}\` cannot resolve it. ` +
      `Fix: write a minimal pyproject.toml at the project root, then \`pip install -e .\`. ` +
      `Example: [build-system] requires=["setuptools>=61"]  [project] name="${pkg}" version="0.1.0"  ` +
      layoutTable
    );
  } catch {
    // safePath/statSync surprise — abstain rather than break exec.
    return null;
  }
};

// ---------------------------------------------------------------------------
// Registry + entry point
// ---------------------------------------------------------------------------

const matchers: ReadonlyArray<Matcher> = [
  matchPythonModuleNotFound,
  // Future: matchNodeModuleNotFound, matchCommandNotFound, matchEnvVarMissing, ...
];

/**
 * Run all registered matchers against the failed exec result. Returns the
 * first non-null hint, or `null` if no matcher applies. Multiple-hint
 * concatenation is intentionally not supported on Day 1 — keep the surface
 * narrow until we have a second matcher to motivate the shape.
 */
export function matchExecRecoveryHint(input: ExecRecoveryInput): string | null {
  for (const m of matchers) {
    const hit = m(input);
    if (hit) return hit;
  }
  return null;
}
