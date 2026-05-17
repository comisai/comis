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
