import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { AppConfigSchema } from "../../../../packages/core/src/config/schema.js";

import { buildReplayQuarantineOverlay } from "./production-quarantine.js";

describe("production replay configuration quarantine", () => {
  it("disables every external ingress and autonomous activity surface", () => {
    const result = buildReplayQuarantineOverlay(["default", "research"]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const overlay = parse(result.value) as Record<string, unknown>;
    expect(AppConfigSchema.safeParse(overlay).success).toBe(true);
    expect(overlay).toMatchObject({
      channels: {
        telegram: { enabled: false },
        discord: { enabled: false },
        slack: { enabled: false },
        whatsapp: { enabled: false },
        signal: { enabled: false },
        imessage: { enabled: false },
        line: { enabled: false },
        irc: { enabled: false },
        email: { enabled: false },
        msteams: { enabled: false },
        healthCheck: { enabled: false, autoRestartOnStale: false },
      },
      scheduler: {
        cron: { enabled: false },
        heartbeat: { enabled: false },
        tasks: { enabled: false },
      },
      gateway: { host: "127.0.0.1" },
      webhooks: { enabled: false },
      autoReplyEngine: { enabled: false },
      lifecycleReactions: { enabled: false },
      deliveryQueue: { drainOnStartup: false },
      deliveryMirror: { enabled: false },
      agents: {
        default: {
          scheduler: { cron: { enabled: false }, heartbeat: { enabled: false } },
          notification: { enabled: false },
          backgroundTasks: { enabled: false },
        },
        research: {
          scheduler: { cron: { enabled: false }, heartbeat: { enabled: false } },
          notification: { enabled: false },
          backgroundTasks: { enabled: false },
        },
      },
    });
    expect(result.value).not.toContain("token");
    expect(result.value).not.toContain("apiKey");
  });

  it("rejects unsafe agent identifiers rather than emitting ambiguous YAML", () => {
    const result = buildReplayQuarantineOverlay(["default", "bad\nagent"]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("unsafe_agent_id");
  });
});
