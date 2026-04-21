// SPDX-License-Identifier: Apache-2.0
/**
 * Config validation check unit tests.
 *
 * Verifies that configValidationCheck detects unparseable config content,
 * schema validation failures, and produces info findings for valid configs.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { configValidationCheck } from "./config-validation.js";
import type { AuditContext } from "../types.js";
import type { AppConfig } from "@comis/core";

/** Base audit context with no config and no raw content. */
const baseContext: AuditContext = {
  configPaths: [],
  dataDir: "/tmp/test-data",
  skillsPaths: [],
};

describe("configValidationCheck", () => {
  it("returns empty findings when no config and no rawConfigContent", async () => {
    const findings = await configValidationCheck.run(baseContext);

    expect(findings).toHaveLength(0);
  });

  it("produces info SEC-CFG-PASS when config already exists (pre-parsed)", async () => {
    const findings = await configValidationCheck.run({
      ...baseContext,
      config: {} as unknown as AppConfig,
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("SEC-CFG-PASS");
    expect(findings[0].severity).toBe("info");
    expect(findings[0].message).toContain("validates successfully");
  });

  it("produces critical finding for unparseable rawConfigContent", async () => {
    const findings = await configValidationCheck.run({
      ...baseContext,
      rawConfigContent: "not json {{{",
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("SEC-CFG-001");
    expect(findings[0].severity).toBe("critical");
    expect(findings[0].message).toContain("could not be parsed");
  });

  it("produces critical finding for valid JSON that fails schema validation", async () => {
    const findings = await configValidationCheck.run({
      ...baseContext,
      rawConfigContent: JSON.stringify({ gateway: { port: "not-a-number" } }),
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("SEC-CFG-001");
    expect(findings[0].severity).toBe("critical");
    expect(findings[0].message).toContain("validation failed");
  });

  it("produces info SEC-CFG-PASS for valid JSON that passes schema validation", async () => {
    const findings = await configValidationCheck.run({
      ...baseContext,
      rawConfigContent: JSON.stringify({}),
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("SEC-CFG-PASS");
    expect(findings[0].severity).toBe("info");
    expect(findings[0].message).toContain("validates successfully");
  });
});
