// SPDX-License-Identifier: Apache-2.0
/**
 * The LCD context-engine ↮ recall/RAG clean-port lock.
 *
 * Inside `packages/agent/src/`, the Lossless Context DAG (LCD) context engine
 * (`context-engine/`, the `lcd-*` modules) and the recall/RAG layer
 * (`rag/`, `memory/`) share ZERO code. They interact at exactly ONE seam — the
 * budget boundary — and that coupling is DATA, not a code import: the engine
 * reads a recall-token count via the optional `getRecallTokensEstimate` dep
 * (`context-engine/types-core.ts` → consumed in `lcd-assembler.ts`, wired from
 * `executor/executor-context-engine-setup.ts`). No source file in
 * the engine imports the recall/RAG surface, and no recall/RAG source imports
 * the engine — that is what makes it a clean port rather than a shared module.
 *
 * This is a source-grep architecture test mirroring the canonical
 * `shared-no-port-source-imports.test.ts` (recursive `.ts` walk excluding
 * `.test.ts` + an import-regex grep + `expect(offenders).toEqual([])`). It is a
 * LOCK, not a fix: both import directions are ALREADY empty, so the test is
 * green from creation. Its job is to fail any FUTURE refactor that silently
 * couples the layers with an import instead of widening the data-via-dep seam
 * (e.g. someone "wiring recall into the engine" by importing `MemoryPort`, or
 * pulling `computeTokenBudget` straight into the RAG layer).
 *
 * Complementary, not redundant, to `architecture-graph.test.ts:60-128`: that
 * test asserts the PACKAGE-level edge (`@comis/agent` has no `@comis/memory`
 * edge; the memory/context types it uses resolve type-only through
 * `@comis/core`). This test locks the INTRA-package directory cut WITHIN
 * `packages/agent/src/` — a finer seam the package graph cannot see.
 *
 * No allowlist / escape hatch: architecture gates are shrink-only and this cut
 * should never need an exception. A genuine coupling must be re-expressed as a
 * dep at the budget boundary, not added to a skip list.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");

const CONTEXT_ENGINE_SRC = resolve(REPO_ROOT, "packages/agent/src/context-engine");
const RAG_SRC = resolve(REPO_ROOT, "packages/agent/src/rag");
const MEMORY_SRC = resolve(REPO_ROOT, "packages/agent/src/memory");

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

function relPaths(files: string[]): string[] {
  return files.map((f) => relative(REPO_ROOT, f));
}

// Direction A — the LCD engine must not reach into recall/RAG.
//   (1) A path import from a `rag/` or `memory/` directory (relative or
//       package-qualified — the substring `/rag/` or `/memory/` after the
//       quote covers both `../rag/...` and `@comis/agent/.../rag/...`).
const A_PATH_IMPORT = /from\s+["'][^"']*\/(rag|memory)\//;
//   (2) A VALUE import of the recall surface. Scoped to `import` lines so an
//       unrelated identifier in a comment/string never false-positives (the
//       analog grep is likewise scoped to import statements).
const A_VALUE_IMPORT = /\b(MemoryPort|createMemoryRecall|RagConfig|RagService|Rag[A-Z]\w*)\b/;

// Direction B — recall/RAG must not reach into the LCD engine.
//   (1) A path import from `context-engine/` or an `lcd-` module.
const B_PATH_IMPORT = /from\s+["'][^"']*\/(context-engine|lcd-)/;
//   (2) A VALUE import of the budget primitive `computeTokenBudget` — scoped to
//       `import` lines, same rationale as above.
const B_VALUE_IMPORT = /\bcomputeTokenBudget\b/;

function isImportLine(line: string): boolean {
  return /^\s*import\b/.test(line);
}

describe("I2: LCD context engine ↮ recall/RAG clean port (intra-agent boundary)", () => {
  it("packages/agent/src/context-engine/**/*.ts imports nothing from the recall/RAG layer (rag/, memory/)", () => {
    const files = listTsFiles(CONTEXT_ENGINE_SRC);
    const offenders: string[] = [];
    for (const f of files) {
      const content = readFileSync(f, "utf8");
      const pathHit = A_PATH_IMPORT.test(content);
      const valueHit = content
        .split("\n")
        .some((line) => isImportLine(line) && A_VALUE_IMPORT.test(line));
      if (pathHit || valueHit) {
        offenders.push(f);
      }
    }
    expect(
      relPaths(offenders),
      `LCD engine (packages/agent/src/context-engine/) must not import the recall/RAG layer ` +
        `(rag/, memory/, MemoryPort, createMemoryRecall, Rag*). The only sanctioned coupling is ` +
        `DATA via the getRecallTokensEstimate dep (the budget boundary), never a code import. Offenders: ` +
        `${relPaths(offenders).join(", ")}`,
    ).toEqual([]);
  });

  it("packages/agent/src/{rag,memory}/**/*.ts imports nothing from the LCD context engine (context-engine/, lcd-*)", () => {
    const files = [...listTsFiles(RAG_SRC), ...listTsFiles(MEMORY_SRC)];
    const offenders: string[] = [];
    for (const f of files) {
      const content = readFileSync(f, "utf8");
      const pathHit = B_PATH_IMPORT.test(content);
      const valueHit = content
        .split("\n")
        .some((line) => isImportLine(line) && B_VALUE_IMPORT.test(line));
      if (pathHit || valueHit) {
        offenders.push(f);
      }
    }
    expect(
      relPaths(offenders),
      `The recall/RAG layer (packages/agent/src/{rag,memory}/) must not import the LCD context engine ` +
        `(context-engine/, lcd-*, computeTokenBudget). Recall feeds the engine a token count via the ` +
        `getRecallTokensEstimate dep at the budget boundary — it must not reach into engine internals. Offenders: ` +
        `${relPaths(offenders).join(", ")}`,
    ).toEqual([]);
  });
});
