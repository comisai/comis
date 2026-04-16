/**
 * Channel security check unit tests.
 *
 * Verifies that channelSecurityCheck detects missing credentials,
 * missing allowFrom restrictions, skips disabled channels, and
 * returns no findings for secure config.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { channelSecurityCheck } from "./channel-security.js";
import type { AuditContext } from "../types.js";
import type { AppConfig } from "@comis/core";

/** Base audit context with no config. */
const baseContext: AuditContext = {
  configPaths: [],
  dataDir: "/tmp/test-data",
  skillsPaths: [],
};

/** Create a minimal context with channels config. */
function contextWithChannels(channels: Record<string, unknown>): AuditContext {
  return {
    ...baseContext,
    config: { channels } as unknown as AppConfig,
  };
}

describe("channelSecurityCheck", () => {
  it("returns empty findings when no channels config", async () => {
    const findings = await channelSecurityCheck.run(baseContext);

    expect(findings).toHaveLength(0);
  });

  it("produces critical finding for enabled channel without credentials", async () => {
    const findings = await channelSecurityCheck.run(
      contextWithChannels({
        telegram: { enabled: true, allowFrom: ["user1"] },
      }),
    );

    const finding = findings.find((f) => f.code === "SEC-CHAN-001");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("critical");
    expect(finding!.message).toContain("telegram");
    expect(finding!.message).toContain("no credentials");
  });

  it("produces warning for enabled channel without allowFrom", async () => {
    const findings = await channelSecurityCheck.run(
      contextWithChannels({
        discord: { enabled: true, botToken: "tok-123" },
      }),
    );

    const finding = findings.find((f) => f.code === "SEC-CHAN-002");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("warning");
    expect(finding!.message).toContain("discord");
    expect(finding!.message).toContain("allowFrom");
  });

  it("produces both findings for channel missing credentials AND allowFrom", async () => {
    const findings = await channelSecurityCheck.run(
      contextWithChannels({
        slack: { enabled: true },
      }),
    );

    expect(findings).toHaveLength(2);
    expect(findings.some((f) => f.code === "SEC-CHAN-001")).toBe(true);
    expect(findings.some((f) => f.code === "SEC-CHAN-002")).toBe(true);
  });

  it("skips disabled channels", async () => {
    const findings = await channelSecurityCheck.run(
      contextWithChannels({
        telegram: { enabled: false },
      }),
    );

    expect(findings).toHaveLength(0);
  });

  it("returns empty findings for channel with credentials and allowFrom", async () => {
    const findings = await channelSecurityCheck.run(
      contextWithChannels({
        telegram: {
          enabled: true,
          botToken: "123456:ABCDEF",
          allowFrom: ["user1", "user2"],
        },
      }),
    );

    expect(findings).toHaveLength(0);
  });
});
