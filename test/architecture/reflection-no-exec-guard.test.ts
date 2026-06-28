// SPDX-License-Identifier: Apache-2.0
/**
 * SKILL-03 / INV-3 — the PERMANENT no-learned-code-execution guard (Phase 223).
 *
 * The v2.31 reflection engine distils successful trajectories into an ADVISORY
 * markdown doc (a "mental model") that the agent READS — it then acts through its
 * already-permissioned tools. There is NO learned-code execution path: the v2.26
 * dynamic bwrap sandbox (`runDynamicReplay` / `spawn` / the embedded-`scripts`
 * column) was DELETED in Phase 223 (Plans 02/05/06 dropped the sandbox adapter +
 * the `SkillValidationPort`/`ReplayContext` types; Plan 07 deleted the orphaned
 * core ports). The only admission gate that remains is the STATIC scan
 * `validateLearnedDocBody` (@comis/core) — a doc is text, not code.
 *
 * This is the STANDING invariant that pins that absence: a future change CANNOT
 * silently re-introduce a learned-code execution surface (the SYNTH-YIELD /
 * T-223-22 EoP class) without tripping this gate. It runs in the `architecture`
 * vitest project (`pnpm validate`).
 *
 * ## What it asserts (each its own `it`)
 *
 *   1. The reflect/validate path source — `reflection-job.ts`, `reflection-prompt.ts`,
 *      `llm-reflection-adapter.ts` (@comis/agent) + `validate-learned-doc-body.ts`
 *      (@comis/core) — contains, IN CODE, none of: `runDynamicReplay`, `spawn` /
 *      `child_process`, `bwrap`, `ALLOWED_SCRIPT_LANGS` (the dynamic-replay surface).
 *   2. The `mental_models` DDL (`schema-mental-models.ts`) has NO `scripts` column
 *      (the executable column was dropped in the generalization — Phase 222).
 *   3. (Reinforcement) No file under `packages/agent/src/memory/` imports from
 *      `@comis/skills` (the package that owned the sandbox) — the closed-graph
 *      SEC-01 cut, asserted at the import site of the learning code itself.
 *
 * ## Not self-invalidating (the comment-filter discipline)
 *
 * A grep guard that matches its own forbidden words inside a comment or a doc
 * string would either always fail (if the prose names the word) or be impossible
 * to document (the `autonomy-skill-no-drift.test.ts` / §2.10 self-invalidating-grep
 * pitfall). So `stripNonCode()` removes line comments, block comments, and string
 * literals BEFORE the scan — the assertion counts CODE tokens only. A reflect-path
 * file may freely say "no spawn here" in a comment; only an actual `spawn(` call
 * (or import) trips the gate.
 *
 * ## RED-provable
 *
 * `readFileSync` throws at `describe` scope if a scanned file goes missing → the
 * suite fails (the pre-patch failing state for the file-set). Re-introducing
 * `import { spawn } from "node:child_process"` into `reflection-job.ts`, or adding a
 * `scripts TEXT` column back to the `mental_models` DDL, or importing `@comis/skills`
 * into `packages/agent/src/memory/`, each fails its respective `it`.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");

/** The reflect/validate path — the files that could (but must not) hold an exec surface. */
const REFLECT_PATH_FILES = [
  "packages/agent/src/memory/reflection-job.ts",
  "packages/agent/src/memory/reflection-prompt.ts",
  "packages/agent/src/memory/llm-reflection-adapter.ts",
  "packages/core/src/security/validate-learned-doc-body.ts",
] as const;

/** The mental-model store DDL — must carry no executable `scripts` column. */
const MENTAL_MODELS_DDL = "packages/memory/src/schema-mental-models.ts";

/** The learning-code directory whose imports must never reach @comis/skills (the sandbox owner). */
const AGENT_MEMORY_DIR = "packages/agent/src/memory";

/**
 * Strip line comments (`// …`), block comments (slash-star … star-slash), and
 * string literals (`'…'`, `"…"`, and backtick template literals) from TS source
 * so a forbidden token mentioned in PROSE or a doc string cannot self-trip the
 * gate. We replace each with a space (never collapse to nothing) so token
 * boundaries survive. This is a lexical approximation, not a full TS lexer —
 * deliberately conservative: it removes MORE than a real lexer (e.g. a `//` inside
 * a regex), which is safe for an absence-assertion (it can only hide a match, and
 * the things we forbid — `spawn(`, `import … child_process` — never legitimately
 * live inside a string literal in this path).
 */
function stripNonCode(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    // Line comment
    if (c === "/" && next === "/") {
      while (i < n && src[i] !== "\n") i++;
      out += " ";
      continue;
    }
    // Block comment
    if (c === "/" && next === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      out += " ";
      continue;
    }
    // String literals (single / double / template) — skip to the matching unescaped quote.
    if (c === "'" || c === '"' || c === "`") {
      const quote = c;
      i++;
      while (i < n) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      out += " ";
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Strip ONLY comments (line + block), KEEPING string/template literals. Used for
 * the DDL scan: the SQL lives INSIDE a `db.exec(`…`)` template literal, so
 * `stripNonCode` (which removes string literals) would erase the very DDL we scan.
 * Comments are still stripped so a `// no scripts column here` note cannot self-trip.
 */
function stripCommentsOnly(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      while (i < n && src[i] !== "\n") i++;
      out += " ";
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      out += " ";
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Read a repo-relative source file (throws at describe scope if it is gone → RED-provable). */
function readSource(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), "utf8");
}

/**
 * The forbidden learned-code-execution tokens. Each is the signature of a dynamic
 * replay / spawn surface that the advisory-doc reflection model must NEVER hold.
 * `runDynamicReplay` is the deleted sandbox entry point; `spawn` / `child_process`
 * are the Node process-spawn primitives; `bwrap` is the Linux jail; the
 * `ALLOWED_SCRIPT_LANGS` allowlist gated the embedded-script languages.
 */
const FORBIDDEN_EXEC_TOKENS: ReadonlyArray<{ token: string; pattern: RegExp }> = [
  { token: "runDynamicReplay", pattern: /\brunDynamicReplay\b/ },
  { token: "spawn", pattern: /\bspawn(Sync)?\s*\(/ },
  { token: "child_process", pattern: /\bchild_process\b/ },
  { token: "bwrap", pattern: /\bbwrap\b/ },
  { token: "ALLOWED_SCRIPT_LANGS", pattern: /\bALLOWED_SCRIPT_LANGS\b/ },
];

describe("reflection learning path has NO learned-code execution surface (SKILL-03 / INV-3)", () => {
  // RED before the file-set exists: readSource throws here → the whole suite fails.
  const reflectPathCode: ReadonlyArray<{ rel: string; code: string }> =
    REFLECT_PATH_FILES.map((rel) => ({ rel, code: stripNonCode(readSource(rel)) }));
  const ddlSrc = readSource(MENTAL_MODELS_DDL);

  it("the reflect/validate path is non-empty (non-vacuity — a path rename must fail, not silently pass)", () => {
    // Guards against a future move that empties the scanned set (then every
    // absence-assertion below would vacuously pass). Every file must have real code.
    expect(
      reflectPathCode.length,
      "the reflect-path file set is empty — a rename moved the learning code out from under the guard",
    ).toBe(REFLECT_PATH_FILES.length);
    for (const { rel, code } of reflectPathCode) {
      expect(code.trim().length, `${rel} scanned to empty after comment-strip`).toBeGreaterThan(0);
    }
  });

  for (const { token, pattern } of FORBIDDEN_EXEC_TOKENS) {
    it(`contains no \`${token}\` in code (the dynamic-replay surface is deleted — T-223-22)`, () => {
      const offenders = reflectPathCode
        .filter(({ code }) => pattern.test(code))
        .map(({ rel }) => rel);
      expect(
        offenders,
        `${token} reappeared in the reflect/validate path (a learned-code execution surface — forbidden by INV-3): ${offenders.join(", ")}`,
      ).toEqual([]);
    });
  }

  it("the mental_models DDL has NO executable `scripts` column (a learned doc carries no code — Phase 222 dropped it)", () => {
    // Comments-only strip: the DDL lives inside a `db.exec(`…`)` template literal,
    // so we KEEP string literals here (stripNonCode would erase the SQL itself).
    const ddlCode = stripCommentsOnly(ddlSrc);
    // The CREATE TABLE anchor proves this is the real DDL (non-vacuity): if a
    // refactor moved it elsewhere, the anchor vanishes and the test fails rather
    // than passing on an empty scan.
    expect(
      /CREATE TABLE IF NOT EXISTS mental_models/.test(ddlCode),
      "the mental_models CREATE TABLE moved out of schema-mental-models.ts — re-point the guard",
    ).toBe(true);
    // A `scripts` column would appear as a column definition `scripts <TYPE>` inside
    // the DDL string. Forbid the column-definition form (a `scripts` substring inside
    // a comment is already stripped). The `_scripts`/`scripts_` boundary is excluded
    // by \b so an unrelated column never false-positives.
    expect(
      /\bscripts\s+(TEXT|BLOB|INTEGER|REAL|NUMERIC)\b/i.test(ddlCode),
      "the mental_models DDL re-introduced a `scripts` column — a learned doc must not carry executable scripts (INV-3)",
    ).toBe(false);
  });

  it("no file under packages/agent/src/memory/ imports @comis/skills (the sandbox owner — SEC-01 closed-graph cut)", () => {
    const dir = resolve(REPO_ROOT, AGENT_MEMORY_DIR);
    const tsFiles = readdirSync(dir).filter(
      (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
    );
    expect(
      tsFiles.length,
      "packages/agent/src/memory/ has no non-test source — the directory moved",
    ).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const f of tsFiles) {
      // WR-02: scan the COMMENT-ONLY-stripped source (KEEP string literals), mirroring
      // the DDL scan above. `stripNonCode` deletes string literals — and the import
      // specifier `"@comis/skills"` IS a string literal, so it stripped the very token
      // these regexes match (`import … from  ;`) → the assertion was VACUOUS (it passed
      // even on a real violation). Comments are still stripped so a `// no @comis/skills
      // here` note cannot self-trip the gate.
      const code = stripCommentsOnly(readFileSync(join(dir, f), "utf8"));
      // Match the quoted import specifier in either form: a `from "@comis/skills"`
      // clause OR a bare side-effect `import "@comis/skills"`.
      if (/from\s+["']@comis\/skills["']/.test(code) || /import\s+["']@comis\/skills["']/.test(code)) {
        offenders.push(`${AGENT_MEMORY_DIR}/${f}`);
      }
    }
    expect(
      offenders,
      `the learning code imports @comis/skills (the dynamic-sandbox package) — agent↛skills is the closed-graph cut: ${offenders.join(", ")}`,
    ).toEqual([]);
  });
});
