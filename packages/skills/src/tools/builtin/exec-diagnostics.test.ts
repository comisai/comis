// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { matchExecRecoveryHint } from "./exec-diagnostics.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uniqDir(prefix: string): string {
  return join(
    tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
}

const MNF = (pkg: string): string =>
  `Traceback (most recent call last):\n  File "<frozen runpy>", line 198, in _run_module_as_main\nModuleNotFoundError: No module named '${pkg}'\n`;

/** Bare runpy CLI form, e.g. `python3 -m missingpkg` when missingpkg is not in sys.path. */
const RUNPY_CLI = (pkg: string): string =>
  `/Library/Frameworks/Python.framework/Versions/3.12/bin/python3: No module named ${pkg}\n`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("matchExecRecoveryHint — Python ModuleNotFoundError matcher", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = uniqDir("comis-diag-test");
    mkdirSync(cwd, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(cwd, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  // -------------------------------------------------------------------------
  // Positive cases
  // -------------------------------------------------------------------------

  it("positive — flat layout: returns RECOVERY HINT when cwd has <pkg>/__init__.py and no pyproject.toml", () => {
    mkdirSync(join(cwd, "news_trading_system"), { recursive: true });
    writeFileSync(join(cwd, "news_trading_system", "__init__.py"), "");

    const result = matchExecRecoveryHint({
      stderr: MNF("news_trading_system"),
      exitCode: 1,
      cwd,
    });

    expect(result).not.toBeNull();
    expect(result!).toMatch(/^RECOVERY HINT:/);
    expect(result!).toContain("pyproject.toml");
    expect(result!).toContain("pip install -e .");
    expect(result!).toContain("news_trading_system");
    // Flat layout — should NOT recommend src layout
    expect(result!).not.toContain('where=["src"]');
    // No trailing newline (wire-in adds the separator)
    expect(result!.endsWith("\n")).toBe(false);
  });

  it("positive — src layout: returns RECOVERY HINT when cwd has src/<pkg>/__init__.py and no pyproject.toml", () => {
    mkdirSync(join(cwd, "src", "news_trading_system"), { recursive: true });
    writeFileSync(join(cwd, "src", "news_trading_system", "__init__.py"), "");

    const result = matchExecRecoveryHint({
      stderr: MNF("news_trading_system"),
      exitCode: 1,
      cwd,
    });

    expect(result).not.toBeNull();
    expect(result!).toMatch(/^RECOVERY HINT:/);
    expect(result!).toContain("pyproject.toml");
    expect(result!).toContain("pip install -e .");
    expect(result!).toContain("news_trading_system");
    // Src layout — should reference src in the example
    expect(result!).toContain("src");
  });

  it("positive — dotted module name: matches on the leading segment when cwd has that segment as a sibling", () => {
    // python -m news_trading_system.cli reports `No module named 'news_trading_system'`
    // when news_trading_system is missing — leading segment match.
    mkdirSync(join(cwd, "news_trading_system"), { recursive: true });
    writeFileSync(join(cwd, "news_trading_system", "__init__.py"), "");

    const result = matchExecRecoveryHint({
      stderr: MNF("news_trading_system"),
      exitCode: 1,
      cwd,
    });

    expect(result).not.toBeNull();
    expect(result!).toContain("news_trading_system");
  });

  it("positive — bare runpy CLI form: matches `<python>: No module named foo` (the most common real-world case)", () => {
    // python3 -m missingpkg with src/missingpkg/ but no pyproject.toml
    // produces this stderr exactly — there is no `ModuleNotFoundError:` prefix
    // because runpy raises the CLI error before any traceback.
    mkdirSync(join(cwd, "src", "missingpkg"), { recursive: true });
    writeFileSync(join(cwd, "src", "missingpkg", "__init__.py"), "");

    const result = matchExecRecoveryHint({
      stderr: RUNPY_CLI("missingpkg"),
      exitCode: 1,
      cwd,
    });

    expect(result).not.toBeNull();
    expect(result!).toMatch(/^RECOVERY HINT:/);
    expect(result!).toContain("pyproject.toml");
    expect(result!).toContain("missingpkg");
  });

  // -------------------------------------------------------------------------
  // Negative cases
  // -------------------------------------------------------------------------

  it("negative — pyproject.toml present: abstains (returns null)", () => {
    mkdirSync(join(cwd, "news_trading_system"), { recursive: true });
    writeFileSync(join(cwd, "news_trading_system", "__init__.py"), "");
    writeFileSync(
      join(cwd, "pyproject.toml"),
      '[project]\nname = "news_trading_system"\nversion = "0.1.0"\n',
    );

    const result = matchExecRecoveryHint({
      stderr: MNF("news_trading_system"),
      exitCode: 1,
      cwd,
    });

    expect(result).toBeNull();
  });

  it("negative — no sibling directory: abstains (returns null)", () => {
    // cwd is empty — no <pkg>/ and no src/<pkg>/.
    const result = matchExecRecoveryHint({
      stderr: MNF("news_trading_system"),
      exitCode: 1,
      cwd,
    });

    expect(result).toBeNull();
  });

  it("negative — exitCode 0: abstains even if stderr happens to contain the phrase", () => {
    mkdirSync(join(cwd, "news_trading_system"), { recursive: true });
    writeFileSync(join(cwd, "news_trading_system", "__init__.py"), "");

    const result = matchExecRecoveryHint({
      stderr: MNF("news_trading_system"),
      exitCode: 0,
      cwd,
    });

    expect(result).toBeNull();
  });

  it("negative — different stderr (ImportError, not ModuleNotFoundError): abstains", () => {
    mkdirSync(join(cwd, "news_trading_system"), { recursive: true });
    writeFileSync(join(cwd, "news_trading_system", "__init__.py"), "");

    const result = matchExecRecoveryHint({
      stderr: "ImportError: cannot import name 'foo' from 'news_trading_system'",
      exitCode: 1,
      cwd,
    });

    expect(result).toBeNull();
  });

  it("negative — hyphenated package name: abstains (sanity regex rejects hyphens)", () => {
    // A hyphenated capture (rare but possible from custom error messages)
    mkdirSync(join(cwd, "news-trading-system"), { recursive: true });
    writeFileSync(join(cwd, "news-trading-system", "__init__.py"), "");

    const result = matchExecRecoveryHint({
      stderr: MNF("news-trading-system"),
      exitCode: 1,
      cwd,
    });

    expect(result).toBeNull();
  });

  it("negative — empty stderr: abstains", () => {
    const result = matchExecRecoveryHint({
      stderr: "",
      exitCode: 1,
      cwd,
    });

    expect(result).toBeNull();
  });

  it("negative — cwd does not exist: abstains without throwing", () => {
    // Pass a cwd that does not exist; matcher must not blow up.
    const phantomCwd = join(cwd, "does-not-exist-subdir");
    expect(() =>
      matchExecRecoveryHint({
        stderr: MNF("news_trading_system"),
        exitCode: 1,
        cwd: phantomCwd,
      }),
    ).not.toThrow();
    const result = matchExecRecoveryHint({
      stderr: MNF("news_trading_system"),
      exitCode: 1,
      cwd: phantomCwd,
    });
    expect(result).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Shape / idempotency
  // -------------------------------------------------------------------------

  it("hint is a single string with no trailing newline (wire-in adds the separator)", () => {
    mkdirSync(join(cwd, "missingpkg"), { recursive: true });
    writeFileSync(join(cwd, "missingpkg", "__init__.py"), "");

    const result = matchExecRecoveryHint({
      stderr: MNF("missingpkg"),
      exitCode: 1,
      cwd,
    });

    expect(typeof result).toBe("string");
    expect(result!.endsWith("\n")).toBe(false);
  });

  it("calling twice with the same input returns the same hint (pure)", () => {
    mkdirSync(join(cwd, "missingpkg"), { recursive: true });
    writeFileSync(join(cwd, "missingpkg", "__init__.py"), "");

    const a = matchExecRecoveryHint({
      stderr: MNF("missingpkg"),
      exitCode: 1,
      cwd,
    });
    const b = matchExecRecoveryHint({
      stderr: MNF("missingpkg"),
      exitCode: 1,
      cwd,
    });
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// matchVenvMissing: workspace-rooted venv binary missing
//
// Covers the 2026-05-19 18:09–18:13 Telegram bug where two sub-agents tried
// `venv/bin/python3` against a workspace whose venv had never been provisioned
// (template promised a "Pre-warmed Python env" the daemon never built). The
// matcher surfaces a `RECOVERY HINT: Virtualenv not found at <root>. Create it
// with: python3 -m venv ...` line so the LLM can self-recover after the
// FIRST failure instead of cascading through five exec attempts.
//
// All `matchVenvMissing` tests go through `matchExecRecoveryHint` (the public
// registry entry point) — mirrors the existing matchPythonModuleNotFound
// pattern, no new export needed. The discriminating substring
// `"Virtualenv not found"` appears only in matchVenvMissing's hint, so we
// assert on it to confirm the registry dispatched to the right matcher.
// ---------------------------------------------------------------------------

describe("matchExecRecoveryHint — workspace-rooted venv missing matcher", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = uniqDir("comis-venv-test");
    mkdirSync(cwd, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(cwd, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  // -------------------------------------------------------------------------
  // Positive cases — matcher fires with a recovery hint
  // -------------------------------------------------------------------------

  it("matchVenvMissing fires when stderr says venv/bin/python3 not found and venv root does not exist", () => {
    const stderr = `${cwd}/venv/bin/python3: No such file or directory\n`;
    const result = matchExecRecoveryHint({ stderr, exitCode: 127, cwd });

    expect(result).not.toBeNull();
    expect(result!).toMatch(/^RECOVERY HINT:/);
    expect(result!).toContain("Virtualenv not found");
    expect(result!).toContain("python3 -m venv");
    // Hint should name the venv ROOT, not the binary path.
    expect(result!).toContain(`${cwd}/venv`);
    expect(result!).not.toContain("/venv/bin/python3");
  });

  it("matchVenvMissing fires for missing pip binary with command-not-found stderr", () => {
    const stderr = `${cwd}/venv/bin/pip: command not found\n`;
    const result = matchExecRecoveryHint({ stderr, exitCode: 127, cwd });

    expect(result).not.toBeNull();
    expect(result!).toContain("Virtualenv not found");
    expect(result!).toContain("python3 -m venv");
    expect(result!).toContain(`${cwd}/venv`);
  });

  it("matchVenvMissing fires for nested workspace subdirectory venv path with absolute reference", () => {
    // Simulate "agent runs from a project subdir but the workspace-root venv
    // is missing". cwd is the workspace root; stderr references the workspace-
    // root venv via absolute path.
    const stderr = `${cwd}/venv/bin/python3: No such file or directory\n`;
    const result = matchExecRecoveryHint({ stderr, exitCode: 127, cwd });

    expect(result).not.toBeNull();
    expect(result!).toContain(`${cwd}/venv`);
  });

  // -------------------------------------------------------------------------
  // Negative cases — matcher abstains (returns null)
  // -------------------------------------------------------------------------

  it("matchVenvMissing abstains when the venv binary actually exists on disk (other failure)", () => {
    // venv DOES exist — the failure is something else (permission, wrong args,
    // etc.). Matcher must abstain so the LLM sees the real error.
    mkdirSync(join(cwd, "venv", "bin"), { recursive: true });
    writeFileSync(join(cwd, "venv", "bin", "python3"), "");

    const stderr = `${cwd}/venv/bin/python3: No such file or directory\n`;
    const result = matchExecRecoveryHint({ stderr, exitCode: 127, cwd });

    expect(result).toBeNull();
  });

  it("matchVenvMissing abstains when exit code is zero even if stderr matches the pattern", () => {
    // Defensive: mirror matchPythonModuleNotFound's exit-0 guard.
    const stderr = `${cwd}/venv/bin/python3: No such file or directory\n`;
    const result = matchExecRecoveryHint({ stderr, exitCode: 0, cwd });

    expect(result).toBeNull();
  });

  it("matchVenvMissing abstains when stderr does not mention a venv binary path at all", () => {
    const stderr = "bash: foobar: command not found\n";
    const result = matchExecRecoveryHint({ stderr, exitCode: 127, cwd });

    expect(result).toBeNull();
  });

  it("matchVenvMissing abstains when matched path is outside cwd (no information disclosure)", () => {
    // /etc/venv/bin/python3 is well outside cwd — scope guard rejects.
    const stderr = "/etc/venv/bin/python3: No such file or directory\n";
    const result = matchExecRecoveryHint({ stderr, exitCode: 127, cwd });

    expect(result).toBeNull();
  });

  it("matchVenvMissing abstains when stderr is empty regardless of exit code", () => {
    const result = matchExecRecoveryHint({ stderr: "", exitCode: 127, cwd });
    expect(result).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Shape / idempotency
  // -------------------------------------------------------------------------

  it("matchVenvMissing hint has no trailing newline and starts with RECOVERY HINT prefix", () => {
    const stderr = `${cwd}/venv/bin/python3: No such file or directory\n`;
    const result = matchExecRecoveryHint({ stderr, exitCode: 127, cwd });

    expect(typeof result).toBe("string");
    expect(result!.startsWith("RECOVERY HINT: ")).toBe(true);
    expect(result!.endsWith("\n")).toBe(false);
  });

  it("matchVenvMissing returns the same hint for the same input on repeat invocation (pure)", () => {
    const stderr = `${cwd}/venv/bin/python3: No such file or directory\n`;
    const a = matchExecRecoveryHint({ stderr, exitCode: 127, cwd });
    const b = matchExecRecoveryHint({ stderr, exitCode: 127, cwd });
    expect(a).toBe(b);
  });

  // -------------------------------------------------------------------------
  // Registry-pipeline integration
  // -------------------------------------------------------------------------

  it("matchExecRecoveryHint dispatches a venv-missing failure to the new matchVenvMissing matcher", () => {
    // The discriminating substring `"Virtualenv not found"` appears ONLY in
    // matchVenvMissing's hint — confirms the registry pipeline wired the new
    // matcher in correctly (and did not regress matchPythonModuleNotFound's
    // first-non-null-wins order).
    const stderr = `${cwd}/venv/bin/python3: No such file or directory\n`;
    const result = matchExecRecoveryHint({ stderr, exitCode: 127, cwd });

    expect(result).not.toBeNull();
    expect(result!).toContain("Virtualenv not found");
    // Must NOT be the Python-module-not-found hint.
    expect(result!).not.toContain("pyproject.toml");
  });
});
