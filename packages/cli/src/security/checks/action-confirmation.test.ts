/**
 * Action confirmation check unit tests.
 *
 * Verifies that actionConfirmationCheck detects disabled destructive
 * action confirmation, dangerous auto-approve patterns, and returns
 * no findings for safe configurations.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { actionConfirmationCheck } from "./action-confirmation.js";
import type { AuditContext } from "../types.js";
import type { AppConfig } from "@comis/core";

/** Base audit context with no config. */
const baseContext: AuditContext = {
  configPaths: [],
  dataDir: "/tmp/test-data",
  skillsPaths: [],
};

/** Create a minimal context with action confirmation config. */
function contextWithActionConfirmation(
  actionConfirmation: Record<string, unknown>,
): AuditContext {
  return {
    ...baseContext,
    config: {
      security: { actionConfirmation },
    } as unknown as AppConfig,
  };
}

describe("actionConfirmationCheck", () => {
  it("returns empty findings when no actionConfirmation config", async () => {
    const findings = await actionConfirmationCheck.run(baseContext);

    expect(findings).toHaveLength(0);
  });

  it("produces warning when requireForDestructive is false", async () => {
    const findings = await actionConfirmationCheck.run(
      contextWithActionConfirmation({ requireForDestructive: false }),
    );

    const finding = findings.find((f) => f.code === "SEC-ACTION-001");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("warning");
    expect(finding!.message).toContain("Destructive action confirmation disabled");
  });

  it("produces critical when autoApprove contains 'delete'", async () => {
    const findings = await actionConfirmationCheck.run(
      contextWithActionConfirmation({
        requireForDestructive: true,
        autoApprove: ["delete"],
      }),
    );

    const finding = findings.find((f) => f.code === "SEC-ACTION-002");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("critical");
    expect(finding!.message).toContain("delete");
  });

  it("produces critical when autoApprove contains 'rm' (case-insensitive)", async () => {
    const findings = await actionConfirmationCheck.run(
      contextWithActionConfirmation({
        requireForDestructive: true,
        autoApprove: ["RM_FILE"],
      }),
    );

    const finding = findings.find((f) => f.code === "SEC-ACTION-002");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("critical");
    expect(finding!.message).toContain("RM_FILE");
  });

  it("returns empty findings for safe config", async () => {
    const findings = await actionConfirmationCheck.run(
      contextWithActionConfirmation({
        requireForDestructive: true,
        autoApprove: ["list", "read"],
      }),
    );

    expect(findings).toHaveLength(0);
  });
});
