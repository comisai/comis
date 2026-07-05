// SPDX-License-Identifier: Apache-2.0
/**
 * orchestrate-sdk-python-self-contained — the generated `comis_tools.py` SDK
 * executes INSIDE the same bwrap jail as the JS SDK: `--unshare-net`, no
 * network, and no `site-packages` beyond the host `/usr` Python stdlib. So it
 * MUST import only the stdlib modules the cap-socket wire uses. Any third-party
 * import (e.g. `requests`) is unreachable from inside the jail — there is no
 * network to `pip install` with, and the import would fail the moment the
 * jailed interpreter runs the script, breaking every `language: "py"` run.
 *
 * This gate pins the GENERATED SDK to stdlib. It is a PARITY / hygiene check
 * that mirrors the JS self-contained gate's role — the authoritative
 * containment control is `--unshare-net`, not this scan. Because it reads from
 * the BUILT dist (the exact bytes copied into the jail), it also doubles as a
 * check that the dist-copy step placed `comis_tools.py` beside its `.js`/`.d.ts`
 * siblings: a forgotten copy entry makes this gate fail loud rather than let a
 * half-wired artifact ship.
 *
 * Reads the BUILT dist, so it requires a prior `pnpm build` — which the
 * `validate` gate always runs before `test:coverage`.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ORCH_DIST = join(HERE, "..", "..", "packages", "skills", "dist", "tools", "builtin", "orchestrate");

/** The stdlib modules the cap-socket wire uses — the only imports the `.py` may carry. */
const PY_STDLIB_ALLOW = new Set(["socket", "json", "os", "sys", "typing"]);

/** Top-level module of every `import X` / `from X import …` statement. */
function pyImports(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/^\s*import\s+([A-Za-z_][\w.]*)/gm)) out.push(m[1]!.split(".")[0]!);
  for (const m of src.matchAll(/^\s*from\s+([A-Za-z_][\w.]*)\s+import/gm)) out.push(m[1]!.split(".")[0]!);
  return out;
}

/**
 * True if a `python3` interpreter is invocable on this host. macOS dev
 * (`/usr/bin/python3`), the Linux CI runner, and the Docker image all ship one,
 * so the compile gate below runs on every normal leg. A genuinely python-less
 * host skips only that single check — the real in-jail parse is still exercised
 * by the Linux jail suite under `pnpm validate:full` — rather than hard-failing.
 */
function python3Available(): boolean {
  try {
    execFileSync("python3", ["--version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}
const PYTHON3_PRESENT = python3Available();

describe("orchestrate SDK python binding is self-contained (stdlib only, no site-packages in the jail)", () => {
  it("comis_tools.py imports only the stdlib the cap-socket wire uses", () => {
    const file = join(ORCH_DIST, "comis_tools.py");
    expect(
      existsSync(file),
      `${file} missing — run \`pnpm build\` first (copy-sandbox-assets copies comis_tools.py into dist beside comis_tools.js)`,
    ).toBe(true);
    const imports = pyImports(readFileSync(file, "utf8"));
    // Non-vacuity: the wire DOES import json/os/socket, so an empty match set
    // would mean the matcher broke, not that the .py is clean.
    expect(imports.length, "comis_tools.py: no imports parsed — the matcher likely broke").toBeGreaterThan(0);
    const foreign = imports.filter((m) => !PY_STDLIB_ALLOW.has(m));
    expect(
      foreign,
      `comis_tools.py imports non-stdlib module(s) ${JSON.stringify(foreign)} — the jail has no site-packages beyond the host /usr stdlib and no network to pip-install, so the jailed run would fail on import. Use only the stdlib the wire needs (${[...PY_STDLIB_ALLOW].join(", ")}).`,
    ).toEqual([]);
  });

  // The drift gate (byte-compare) and the import scan above are TEXT-only —
  // neither parses Python. An emitter regression that renders syntactically
  // invalid Python (a bad indent, a missing `:`, tab/space mixing) regenerates
  // deterministically, so both text gates stay green while EVERY jailed
  // `language: "py"` run fails at interpreter parse — green on the standard
  // legs, broken in the jail. Compiling the BUILT module here closes that blind
  // spot on every python-equipped leg instead of leaving it only to the Linux
  // jail suite under `pnpm validate:full`. Skipped only on a genuinely
  // python-less host (never a hard fail there — the jail suite still covers it).
  it.skipIf(!PYTHON3_PRESENT)("comis_tools.py is syntactically valid Python (py_compile)", () => {
    const file = join(ORCH_DIST, "comis_tools.py");
    expect(
      existsSync(file),
      `${file} missing — run \`pnpm build\` first (copy-sandbox-assets copies comis_tools.py into dist)`,
    ).toBe(true);
    try {
      execFileSync("python3", ["-m", "py_compile", file], { stdio: "pipe" });
    } catch (e) {
      expect.fail(`comis_tools.py failed py_compile — the emitter produced invalid Python: ${String(e)}`);
    }
  });
});
