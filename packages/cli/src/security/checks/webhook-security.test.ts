/**
 * Webhook security check unit tests.
 *
 * Verifies that webhookSecurityCheck detects webhooks enabled without
 * authentication token, endpoints without HMAC verification, and returns
 * no findings for secure or disabled webhook configurations.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { webhookSecurityCheck } from "./webhook-security.js";
import type { AuditContext } from "../types.js";
import type { AppConfig } from "@comis/core";

/** Base audit context with no config. */
const baseContext: AuditContext = {
  configPaths: [],
  dataDir: "/tmp/test-data",
  skillsPaths: [],
};

/** Create a minimal context with webhooks config. */
function contextWithWebhooks(webhooks: Record<string, unknown>): AuditContext {
  return {
    ...baseContext,
    config: { webhooks } as unknown as AppConfig,
  };
}

describe("webhookSecurityCheck", () => {
  it("returns empty findings when no config", async () => {
    const findings = await webhookSecurityCheck.run(baseContext);

    expect(findings).toHaveLength(0);
  });

  it("returns empty findings when webhooks not enabled", async () => {
    const findings = await webhookSecurityCheck.run(
      contextWithWebhooks({ enabled: false }),
    );

    expect(findings).toHaveLength(0);
  });

  it("produces critical finding for enabled webhooks without token", async () => {
    const findings = await webhookSecurityCheck.run(
      contextWithWebhooks({ enabled: true }),
    );

    const finding = findings.find((f) => f.code === "SEC-WEBHOOK-001");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("critical");
    expect(finding!.message).toContain("without authentication token");
  });

  it("produces warning for mappings without HMAC secret", async () => {
    const findings = await webhookSecurityCheck.run(
      contextWithWebhooks({
        enabled: true,
        token: "bearer-tok-123",
        mappings: [{ url: "https://example.com/hook" }],
      }),
    );

    const finding = findings.find((f) => f.code === "SEC-WEBHOOK-002");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("warning");
    expect(finding!.message).toContain("HMAC");
  });

  it("returns empty findings for webhooks with token and HMAC", async () => {
    const findings = await webhookSecurityCheck.run(
      contextWithWebhooks({
        enabled: true,
        token: "bearer-tok-123",
        mappings: [
          { url: "https://example.com/hook", hmacSecret: "secret-123" },
        ],
      }),
    );

    expect(findings).toHaveLength(0);
  });
});
