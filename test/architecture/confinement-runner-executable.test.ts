import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPORT_CAPTURE = fileURLToPath(new URL("../confinement-runner/wave4-report-capture.sh", import.meta.url));

describe("confinement runner executable fixtures", () => {
  it("keeps the live reporter capture shim executable", () => {
    expect(statSync(REPORT_CAPTURE).mode & 0o111).not.toBe(0);
  });
});
