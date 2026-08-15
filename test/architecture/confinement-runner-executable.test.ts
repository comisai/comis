import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPORT_CAPTURE = fileURLToPath(new URL("../confinement-runner/wave4-report-capture.sh", import.meta.url));

describe("confinement runner executable fixtures", () => {
  it("keeps the live reporter capture shim executable", () => {
    expect(statSync(REPORT_CAPTURE).mode & 0o111).not.toBe(0);
  });

  it("requires an explicit worktree marker before holding candidate reports", () => {
    const source = readFileSync(REPORT_CAPTURE, "utf8");

    expect(source).toContain('readonly CANDIDATE_BARRIER_FILE="${PWD}/.wave4-candidate-barrier"');
    expect(source).toContain('if [[ "${1:-}" == "candidate-complete" && -f "${CANDIDATE_BARRIER_FILE}" ]]; then');
  });
});
