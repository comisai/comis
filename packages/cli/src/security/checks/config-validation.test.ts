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
  it("warns that config-scoped checks were SKIPPED when no config was provided (never a silent all-clear)", async () => {
    // Regression: a bare `comis security audit` (no -c/--config) used to return
    // EMPTY here, so the audit reported "PASSED (no critical findings)" while
    // every config-scoped check silently no-op'd — a false all-clean. It must
    // now surface the skip.
    const findings = await configValidationCheck.run(baseContext);

    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("SEC-CFG-002");
    expect(findings[0].severity).toBe("warning");
    expect(findings[0].message).toContain("SKIPPED");
    expect(findings[0].remediation).toContain("--config");
  });

  it("reports the REAL captured validation error (not a guessed syntax error) and names the ${ENV} caveat", async () => {
    // Regression: a production config whose gateway secret is `${COMIS_GATEWAY_TOKEN}`
    // fails the audit's raw-file length validation; buildAuditContext captures that
    // in configError. The check must report THAT (and that checks were skipped),
    // not the misleading "Config file could not be parsed / check YAML syntax".
    const findings = await configValidationCheck.run({
      ...baseContext,
      configPaths: ["/home/comis/.comis/config.yaml"],
      rawConfigContent: "gateway:\n  tokens:\n    - id: default\n      secret: ${COMIS_GATEWAY_TOKEN}\n",
      configError: "Config validation failed: gateway.tokens.0.secret: Too small: expected string to have >=32 characters",
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("SEC-CFG-001");
    expect(findings[0].severity).toBe("critical");
    expect(findings[0].message).toContain("SKIPPED");
    expect(findings[0].message).toContain(">=32 characters");
    expect(findings[0].message).not.toContain("could not be parsed");
    expect(findings[0].remediation).toContain("${ENV}");
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
