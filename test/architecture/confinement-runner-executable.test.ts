import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPORT_CAPTURE = fileURLToPath(new URL("../confinement-runner/wave4-report-capture.sh", import.meta.url));
const REPORTER_DIAGNOSTIC = fileURLToPath(
  new URL("../confinement-runner/wave4-reporter-client-diagnostic.go", import.meta.url),
);
const RUNNER = fileURLToPath(new URL("../../scripts/run-confinement-runner.sh", import.meta.url));
const LIVE_GATES = [
  fileURLToPath(new URL("../confinement-runner/run-join-gate.sh", import.meta.url)),
  fileURLToPath(new URL("../confinement-runner/run-e0-journey.sh", import.meta.url)),
  fileURLToPath(new URL("../confinement-runner/run-e0-mechanics-gate.sh", import.meta.url)),
];

describe("confinement runner executable fixtures", () => {
  it("keeps the live reporter capture shim executable", () => {
    expect(statSync(REPORT_CAPTURE).mode & 0o111).not.toBe(0);
  });

  it("requires an explicit worktree marker before holding candidate reports", () => {
    const source = readFileSync(REPORT_CAPTURE, "utf8");

    expect(source).toContain('readonly CANDIDATE_BARRIER_FILE="${PWD}/.wave4-candidate-barrier"');
    expect(source).toContain('if [[ "${1:-}" == "candidate-complete" && -f "${CANDIDATE_BARRIER_FILE}" ]]; then');
  });

  it("passes the exact clean companion revision into the confinement container", () => {
    const source = readFileSync(RUNNER, "utf8");

    expect(source).toContain('--env "COMIS_DEV_CREW_COMMIT=${dev_crew_revision}"');
  });

  it("makes every live gate consume the mounted companion revision", () => {
    for (const gate of LIVE_GATES) {
      const source = readFileSync(gate, "utf8");

      expect(source).toContain('readonly DEV_CREW_COMMIT="${COMIS_DEV_CREW_COMMIT:?');
      expect(source).not.toMatch(/readonly DEV_CREW_COMMIT="[0-9a-f]{40}"/u);
    }
  });

  it("binds the reporter diagnostic to the activated relay identity", () => {
    const source = readFileSync(REPORTER_DIAGNOSTIC, "utf8");

    expect(source).toContain('os.Getenv("COMIS_EXECUTION_ATTACHMENT_IDENTITY")');
  });
});
