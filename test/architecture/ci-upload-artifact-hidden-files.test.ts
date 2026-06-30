// SPDX-License-Identifier: Apache-2.0
/**
 * upload-artifact hidden-path guard — the local guard for the
 * silently-dropped-artifact class.
 *
 * `actions/upload-artifact@v4+` EXCLUDES hidden files (anything under a
 * `.`-prefixed path segment) by default; you must opt in with
 * `include-hidden-files: true`. When an upload step points at a dotfile path —
 * the canonical case is vitest's blob reporter, which writes
 * `.vitest-reports/blob-<i>-<n>.json` for the sharded `coverage` merge — the
 * blob is silently omitted and the step fails `if-no-files-found: error` with
 * "No files were found with the provided path: .vitest-reports/", EVEN THOUGH
 * the job log shows the blob was written.
 *
 * Live incident: the sharded CI pipeline (new in #260) never went green on
 * `main`. The "Upload coverage blob" step uploaded `path: .vitest-reports/`
 * without `include-hidden-files: true`, so every `unit` shard failed at the
 * upload and `coverage`/`ci-success` never ran. It was invisible to
 * `pnpm validate` and to local sharded runs because neither invokes
 * upload-artifact — the gap only exists in CI.
 *
 * This is a STATIC, cross-platform invariant (no Actions runner, no network):
 * every `actions/upload-artifact` step whose `path` references a hidden
 * (dotfile) path MUST set `include-hidden-files: true`. It runs under the
 * `architecture` project in `pnpm validate` / the CI `unit` shards, so the
 * drift is caught locally instead of by a red CI.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument, isMap, isSeq, isScalar, type Node } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const WORKFLOWS_DIR = resolve(REPO_ROOT, ".github/workflows");

/** Every `.github/workflows/*.{yml,yaml}` file. */
function workflowFiles(): string[] {
  return readdirSync(WORKFLOWS_DIR)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .sort();
}

/**
 * A path string references a hidden location when any of its segments starts
 * with `.` and is not the `.`/`..` relative-dir markers (which upload-artifact
 * does not treat as hidden). `./foo` is NOT hidden; `.vitest-reports/x` is;
 * `coverage/.tmp/x` is. Glob/leading characters (`!`, whitespace) are stripped.
 */
function referencesHiddenPath(pathLine: string): boolean {
  const cleaned = pathLine.trim().replace(/^!/, "").trim();
  if (cleaned === "") return false;
  return cleaned.split("/").some((seg) => seg.startsWith(".") && seg !== "." && seg !== "..");
}

/** Split a `with.path` value (a single scalar, or a `|`/`>` multiline block) into individual path entries. */
function pathEntries(pathValue: unknown): string[] {
  if (typeof pathValue !== "string") return [];
  return pathValue
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

interface UploadStep {
  workflow: string;
  /** The action ref, e.g. `actions/upload-artifact@<sha>`. */
  uses: string;
  paths: string[];
  includeHidden: boolean;
}

/** Walk one workflow document and collect every `actions/upload-artifact` step with its `with` block. */
function uploadStepsIn(workflow: string): UploadStep[] {
  const src = readFileSync(resolve(WORKFLOWS_DIR, workflow), "utf8");
  const doc = parseDocument(src);
  const steps: UploadStep[] = [];

  // `actions/upload-artifact` always appears as a step (an item in a job's
  // `steps:` sequence) with a `uses:` key. Rather than hard-code the
  // jobs.<id>.steps path (composite-action / reusable-workflow shapes differ),
  // walk every map node and treat any map with a `uses:` that names
  // upload-artifact as a step.
  const visit = (node: Node | null): void => {
    if (isMap(node)) {
      const uses = node.get("uses");
      if (typeof uses === "string" && /actions\/upload-artifact(@|$)/.test(uses)) {
        const withBlock = node.get("with");
        const pathVal = isMap(withBlock) ? withBlock.get("path") : undefined;
        const includeHiddenVal = isMap(withBlock) ? withBlock.get("include-hidden-files") : undefined;
        steps.push({
          workflow,
          uses,
          paths: pathEntries(pathVal),
          // YAML `true`/`'true'` both count as opt-in.
          includeHidden: includeHiddenVal === true || includeHiddenVal === "true",
        });
      }
      for (const item of node.items) visit(item.value as Node | null);
    } else if (isSeq(node)) {
      for (const item of node.items) visit(item as Node | null);
    } else if (isScalar(node)) {
      // leaf
    }
    return;
  };
  visit(doc.contents as Node | null);
  return steps;
}

describe("upload-artifact hidden-path guard", () => {
  const workflows = workflowFiles();

  it("has at least one workflow file (sanity: the walker resolved .github/workflows)", () => {
    expect(workflows.length).toBeGreaterThan(0);
  });

  const allUploadSteps = workflows.flatMap(uploadStepsIn);

  it("finds the sharded-coverage blob upload (sanity: the YAML walker found upload-artifact steps)", () => {
    // ci.yml uploads `.vitest-reports/` (the regressed step). If this is empty
    // the walker is broken and the guard below would be vacuously green.
    const hiddenUploads = allUploadSteps.filter((s) => s.paths.some(referencesHiddenPath));
    expect(hiddenUploads.length).toBeGreaterThan(0);
  });

  for (const step of allUploadSteps) {
    const hiddenPaths = step.paths.filter(referencesHiddenPath);
    if (hiddenPaths.length === 0) continue;
    it(`${step.workflow}: upload of hidden path [${hiddenPaths.join(", ")}] sets include-hidden-files: true`, () => {
      expect(
        step.includeHidden,
        `${step.workflow} uploads a hidden (dotfile) path [${hiddenPaths.join(", ")}] via ${step.uses} ` +
          `WITHOUT include-hidden-files: true. upload-artifact@v4+ excludes hidden files by default, so the ` +
          `artifact will be empty and the step fails "No files were found with the provided path". Add ` +
          `"include-hidden-files: true" to the step's "with:" block (this is exactly the regression that kept ` +
          `the sharded CI pipeline red on main after #260).`,
      ).toBe(true);
    });
  }
});
