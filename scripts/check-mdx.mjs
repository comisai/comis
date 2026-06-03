#!/usr/bin/env node
// Compile every docs/**/*.mdx through the MDX compiler to catch syntax errors
// — unescaped `<` / `{` in prose, malformed JSX — BEFORE they reach the
// Mintlify deploy. This is the ONLY gate that parses the docs: `pnpm validate`
// and CI otherwise cover only the TypeScript packages, so an MDX typo (e.g. a
// bare `<=` in a table cell) sails through every local check and only fails
// server-side at deploy time. Wired into `pnpm validate` and ci.yml. The MDX
// compiler is the same parser family Mintlify uses, so the syntax errors it
// throws match what the deploy would reject.
//
// Build-tooling — exempt from the tests-first rule (see CLAUDE.md). It is
// self-verifying: it exits non-zero the moment any committed doc fails to parse.
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { compile } from "@mdx-js/mdx";
import remarkFrontmatter from "remark-frontmatter";

const ROOT = process.cwd();
const DOCS_DIR = join(ROOT, "docs");

/** Recursively yield every .mdx file under `dir`. */
async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.name.endsWith(".mdx")) yield full;
  }
}

const failures = [];
let checked = 0;

for await (const file of walk(DOCS_DIR)) {
  checked++;
  const value = await readFile(file, "utf8");
  try {
    // `remarkFrontmatter` keeps Mintlify's `---` YAML header from being parsed
    // as MDX (a `{` or `<` in a description would otherwise false-positive).
    await compile(
      { value, path: file },
      { format: "mdx", remarkPlugins: [remarkFrontmatter] },
    );
  } catch (err) {
    const loc = err?.line != null ? `:${err.line}:${err.column ?? 1}` : "";
    const reason = err?.reason ?? err?.message ?? String(err);
    failures.push(`  ✗ ${relative(ROOT, file)}${loc}\n      ${reason}`);
  }
}

if (failures.length > 0) {
  console.error(
    `\n✗ MDX check: ${failures.length} of ${checked} doc(s) failed to parse:\n`,
  );
  console.error(failures.join("\n\n"));
  console.error(
    "\nFix: escape a bare `<` / `{` in prose (e.g. `\\<`), or wrap the" +
      " expression in a `code span`.\n",
  );
  process.exit(1);
}

console.log(`✓ MDX check: ${checked} docs parsed cleanly.`);
