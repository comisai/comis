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
 * Match `python -m foo` failures where stderr is one of:
 *   1. `ModuleNotFoundError: No module named 'foo'`  (Python traceback form,
 *      raised when the import fires inside Python code — e.g. `python -m a.b`
 *      where `a` imports a missing dep, or `python -m a.b.c` where `a` itself
 *      can't be found and Python re-raises through runpy).
 *   2. `<python-binary>: No module named foo`        (runpy CLI form, no quotes,
 *      end-of-line — what `python3 -m <pkg>` emits when `<pkg>` is not findable
 *      in sys.path. This is the most common real-world trigger.)
 *
 * Combined with `cwd/foo/` or `cwd/src/foo/` existing AND `cwd/pyproject.toml`
 * missing, this means the user has a Python project but no installable package
 * metadata. Suggest writing pyproject.toml + `pip install -e .`.
 */
// First alternation captures from the quoted ModuleNotFoundError form;
// second alternation captures from the bare `: No module named foo` runpy form.
// Anchored to end-of-line (m flag) so we don't accidentally swallow trailing
// content on the runpy form.
const PY_MODULE_NOT_FOUND_RE =
  /(?:ModuleNotFoundError:\s*No module named ['"]([^'"]+)['"]|: No module named ([A-Za-z_][A-Za-z0-9_.]*)\s*$)/m;
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

  // Group 1 = quoted ModuleNotFoundError form; Group 2 = bare runpy form.
  // For `python -m a.b.c` ModuleNotFoundError reports the LEADING segment
  // ('a') when 'a' itself can't be found. Take the first dotted segment;
  // anything else (hyphens, empty, leading digit) abstains via SAFE_PKG_NAME_RE.
  const fullName = m[1] ?? m[2];
  if (!fullName) return null;
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
// Matcher: workspace-rooted venv binary missing
// ---------------------------------------------------------------------------

/**
 * Match exec failures where stderr references a missing executable at a path
 * under `<cwd>/.../venv/bin/<binary>` AND the venv root does not exist on disk.
 *
 * Captures two stderr forms:
 *   1. `<path>/venv/bin/python3: No such file or directory`  (exec/spawn ENOENT)
 *   2. `<path>/venv/bin/python3: command not found`           (shell "127: not found")
 *
 * Binary name is restricted to `python[0-9.]*` or `pip[0-9.]*` to keep the
 * false-positive surface tight (other venv binaries like `pydoc` /
 * `python-config` are out of scope).
 *
 * Scope-restricted: the candidate venv root MUST resolve under `cwd` via
 * `safePath(cwd, relPath)`. Paths that escape `cwd` (e.g. attacker-supplied
 * `/etc/venv/bin/python3` or `../../../etc/venv/bin/python3`) are rejected
 * and the matcher abstains — no information disclosure about out-of-workspace
 * paths. Mirrors the safePath pattern already used in matchPythonModuleNotFound.
 */
const VENV_MISSING_RE =
  /(?<path>\/[^\s:]+\/venv\/bin\/(?<binary>python[0-9.]*|pip[0-9.]*))\s*:\s*(?:No such file or directory|command not found)/m;

function pathExistsSafe(p: string): boolean {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}

const matchVenvMissing: Matcher = ({ stderr, exitCode, cwd }) => {
  if (exitCode === 0) return null;
  if (!stderr) return null;
  const m = VENV_MISSING_RE.exec(stderr);
  if (!m?.groups) return null;
  const binaryPath = m.groups.path;
  // Compute the venv root by stripping `/bin/<binary>` from the matched path.
  // e.g. `/Users/.../.comis/workspace/venv/bin/python3` -> `/Users/.../.comis/workspace/venv`
  const venvBinIdx = binaryPath.lastIndexOf("/venv/bin/");
  if (venvBinIdx < 0) return null; // belt-and-suspenders; regex guarantees /venv/bin/
  const venvRoot = binaryPath.slice(0, venvBinIdx) + "/venv";

  // Workspace-root scope: require the venv root to be under cwd. The `+ "/"`
  // boundary prevents the `${cwd}foo` accidental-prefix attack
  // (cwd="/tmp/work" must not match venvRoot="/tmp/workfoo/venv").
  if (!venvRoot.startsWith(cwd + "/") && venvRoot !== cwd) return null;
  const relFromCwd = venvRoot === cwd ? "" : venvRoot.slice(cwd.length + 1);
  try {
    const resolvedVenvRoot =
      relFromCwd === "" ? cwd : safePath(cwd, relFromCwd);
    // Defensive: confirm round-trip matches (paranoia against weird path inputs).
    if (resolvedVenvRoot !== venvRoot) return null;
    // If the venv root DOES exist, the failure is something other than a
    // missing venv (wrong pip args, permission, network) — abstain so the
    // LLM sees the real error.
    if (pathExistsSafe(resolvedVenvRoot)) return null;
    return (
      `RECOVERY HINT: Virtualenv not found at ${resolvedVenvRoot}. ` +
      `Create it with: python3 -m venv ${resolvedVenvRoot} && ${resolvedVenvRoot}/bin/pip install <pkgs> ` +
      `(replace <pkgs> with the actual packages your task needs — e.g. matplotlib numpy pandas for charting).`
    );
  } catch {
    // safePath threw (traversal segments, null bytes, etc.) — abstain.
    return null;
  }
};

// ---------------------------------------------------------------------------
// Registry + entry point
// ---------------------------------------------------------------------------

const matchers: ReadonlyArray<Matcher> = [
  matchPythonModuleNotFound,
  matchVenvMissing,
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
