import { describe, it, expect } from "vitest";
import {
  SkillsConfigSchema,
  PromptSkillsConfigSchema,
} from "./schema-skills.js";
import {
  ApprovalsConfigSchema,
  ApprovalRuleSchema,
  checkApprovalsConfig,
} from "./schema-approvals.js";
import {
  AutoReplyEngineConfigSchema,
  GroupActivationModeSchema,
} from "./schema-auto-reply-engine.js";
import { BrowserConfigSchema } from "./schema-browser.js";
import { EmbeddingConfigSchema } from "./schema-embedding.js";
import { EnvelopeConfigSchema } from "./schema-envelope.js";

// ---------------------------------------------------------------------------
// SkillsConfigSchema
// ---------------------------------------------------------------------------

describe("SkillsConfigSchema", () => {
  it("produces valid defaults from empty object", () => {
    const result = SkillsConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.discoveryPaths).toEqual(["./skills"]);
      expect(result.data.watchEnabled).toBe(true);
      expect(result.data.watchDebounceMs).toBe(400);
    }
  });

  it("includes builtinTools defaults", () => {
    const result = SkillsConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      const bt = result.data.builtinTools;
      expect(bt.read).toBe(true);
      expect(bt.write).toBe(true);
      expect(bt.edit).toBe(true);
      expect(bt.grep).toBe(true);
      expect(bt.find).toBe(true);
      expect(bt.ls).toBe(true);
      expect(bt.exec).toBe(true);
      expect(bt.process).toBe(true);
      expect(bt.webSearch).toBe(true);
      expect(bt.webFetch).toBe(true);
      expect(bt.browser).toBe(false);
    }
  });

  it("includes toolPolicy defaults", () => {
    const result = SkillsConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.toolPolicy.profile).toBe("full");
      expect(result.data.toolPolicy.allow).toEqual([]);
      expect(result.data.toolPolicy.deny).toEqual([]);
    }
  });

  it("includes promptSkills defaults", () => {
    const result = SkillsConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.promptSkills.maxBodyLength).toBe(20_000);
      expect(result.data.promptSkills.enableDynamicContext).toBe(false);
      expect(result.data.promptSkills.maxAutoInject).toBe(3);
      expect(result.data.promptSkills.allowedSkills).toEqual([]);
      expect(result.data.promptSkills.deniedSkills).toEqual([]);
    }
  });

  it("includes runtimeEligibility defaults", () => {
    const result = SkillsConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.runtimeEligibility.enabled).toBe(true);
    }
  });

  it("includes contentScanning defaults", () => {
    const result = SkillsConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contentScanning.enabled).toBe(true);
      expect(result.data.contentScanning.blockOnCritical).toBe(true);
    }
  });

  it("includes execSandbox defaults", () => {
    const result = SkillsConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.execSandbox.enabled).toBe("always");
      expect(result.data.execSandbox.readOnlyAllowPaths).toEqual([]);
    }
  });

  it("accepts execSandbox with enabled: 'never'", () => {
    const result = SkillsConfigSchema.safeParse({
      execSandbox: { enabled: "never" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.execSandbox.enabled).toBe("never");
    }
  });

  it("rejects execSandbox with invalid enabled value", () => {
    const result = SkillsConfigSchema.safeParse({
      execSandbox: { enabled: "sometimes" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects execSandbox with unknown keys (strictObject)", () => {
    const result = SkillsConfigSchema.safeParse({
      execSandbox: { enabled: "always", allowNetwork: true },
    });
    expect(result.success).toBe(false);
  });

  it("accepts execSandbox with custom readOnlyAllowPaths", () => {
    const result = SkillsConfigSchema.safeParse({
      execSandbox: { readOnlyAllowPaths: ["/opt/data", "/usr/share/dict"] },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.execSandbox.readOnlyAllowPaths).toEqual(["/opt/data", "/usr/share/dict"]);
    }
  });

  it("rejects watchDebounceMs below 100", () => {
    const result = SkillsConfigSchema.safeParse({ watchDebounceMs: 99 });
    expect(result.success).toBe(false);
  });

  it("rejects watchDebounceMs above 5000", () => {
    const result = SkillsConfigSchema.safeParse({ watchDebounceMs: 5001 });
    expect(result.success).toBe(false);
  });

  it("accepts watchDebounceMs at boundary values", () => {
    const r100 = SkillsConfigSchema.safeParse({ watchDebounceMs: 100 });
    expect(r100.success).toBe(true);
    const r5000 = SkillsConfigSchema.safeParse({ watchDebounceMs: 5000 });
    expect(r5000.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PromptSkillsConfigSchema
// ---------------------------------------------------------------------------

describe("PromptSkillsConfigSchema", () => {
  it("produces valid defaults", () => {
    const result = PromptSkillsConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.maxBodyLength).toBe(20_000);
      expect(result.data.enableDynamicContext).toBe(false);
      expect(result.data.maxAutoInject).toBe(3);
    }
  });
});

// ---------------------------------------------------------------------------
// ApprovalsConfigSchema
// ---------------------------------------------------------------------------

describe("ApprovalsConfigSchema", () => {
  it("produces valid defaults", () => {
    const result = ApprovalsConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(false);
      expect(result.data.defaultMode).toBe("auto");
      expect(result.data.rules).toEqual([]);
      expect(result.data.defaultTimeoutMs).toBe(300_000);
    }
  });

  it("accepts rule with valid actionPattern", () => {
    const result = ApprovalsConfigSchema.safeParse({
      rules: [{ actionPattern: "file:write:*" }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.rules).toHaveLength(1);
      expect(result.data.rules[0].actionPattern).toBe("file:write:*");
    }
  });

  it("rejects rule with empty actionPattern", () => {
    const result = ApprovalRuleSchema.safeParse({ actionPattern: "" });
    expect(result.success).toBe(false);
  });
});

describe("ApprovalRuleSchema", () => {
  it("produces valid defaults for optional fields", () => {
    const result = ApprovalRuleSchema.safeParse({ actionPattern: "exec:*" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mode).toBe("auto");
      expect(result.data.timeoutMs).toBe(300_000);
      expect(result.data.minTrustLevel).toBe("verified");
    }
  });
});

// ---------------------------------------------------------------------------
// checkApprovalsConfig
// ---------------------------------------------------------------------------

describe("checkApprovalsConfig", () => {
  it("returns warning when rules.length > 0 but enabled=false", () => {
    const config = ApprovalsConfigSchema.parse({
      enabled: false,
      rules: [{ actionPattern: "exec:*" }],
    });
    const warning = checkApprovalsConfig(config);
    expect(warning).toBeDefined();
    expect(warning).toContain("1 rule(s) configured");
    expect(warning).toContain("approvals.enabled is false");
  });

  it("returns undefined when enabled=true with rules", () => {
    const config = ApprovalsConfigSchema.parse({
      enabled: true,
      rules: [{ actionPattern: "exec:*" }],
    });
    expect(checkApprovalsConfig(config)).toBeUndefined();
  });

  it("returns undefined when enabled=false with no rules", () => {
    const config = ApprovalsConfigSchema.parse({ enabled: false });
    expect(checkApprovalsConfig(config)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AutoReplyEngineConfigSchema
// ---------------------------------------------------------------------------

describe("AutoReplyEngineConfigSchema", () => {
  it("produces valid defaults", () => {
    const result = AutoReplyEngineConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(true);
      expect(result.data.groupActivation).toBe("mention-gated");
      expect(result.data.customPatterns).toEqual([]);
      expect(result.data.historyInjection).toBe(true);
      expect(result.data.maxHistoryInjections).toBe(50);
      expect(result.data.maxGroupHistoryMessages).toBe(20);
    }
  });

  it("rejects invalid mode string", () => {
    const result = AutoReplyEngineConfigSchema.safeParse({ groupActivation: "auto" });
    expect(result.success).toBe(false);
  });
});

describe("GroupActivationModeSchema", () => {
  it("accepts always, mention-gated, custom", () => {
    for (const mode of ["always", "mention-gated", "custom"] as const) {
      const result = GroupActivationModeSchema.safeParse(mode);
      expect(result.success).toBe(true);
    }
  });

  it("defaults to mention-gated", () => {
    const result = GroupActivationModeSchema.safeParse(undefined);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe("mention-gated");
    }
  });
});

// ---------------------------------------------------------------------------
// BrowserConfigSchema
// ---------------------------------------------------------------------------

describe("BrowserConfigSchema", () => {
  it("produces valid defaults", () => {
    const result = BrowserConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(false);
      expect(result.data.cdpPort).toBe(9222);
      expect(result.data.defaultProfile).toBe("default");
      expect(result.data.headless).toBe(true);
      expect(result.data.noSandbox).toBe(false);
      expect(result.data.screenshotMaxSide).toBe(2000);
      expect(result.data.screenshotQuality).toBe(80);
      expect(result.data.snapshotMaxChars).toBe(120_000);
      expect(result.data.timeoutMs).toBe(30_000);
      expect(result.data.baseCdpPort).toBe(18800);
      expect(result.data.maxProfiles).toBe(10);
      expect(result.data.downloadTimeoutMs).toBe(120_000);
    }
  });

  it("includes viewport defaults", () => {
    const result = BrowserConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.viewport.width).toBe(1280);
      expect(result.data.viewport.height).toBe(720);
    }
  });

  it("leaves optional paths undefined when omitted", () => {
    const result = BrowserConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.chromePath).toBeUndefined();
      expect(result.data.profilesDir).toBeUndefined();
      expect(result.data.downloadsDir).toBeUndefined();
    }
  });

  it("rejects screenshotQuality above 100", () => {
    const result = BrowserConfigSchema.safeParse({ screenshotQuality: 101 });
    expect(result.success).toBe(false);
  });

  it("rejects screenshotQuality below 1", () => {
    const result = BrowserConfigSchema.safeParse({ screenshotQuality: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects cdpPort above 65535", () => {
    const result = BrowserConfigSchema.safeParse({ cdpPort: 65536 });
    expect(result.success).toBe(false);
  });

  it("rejects cdpPort below 1", () => {
    const result = BrowserConfigSchema.safeParse({ cdpPort: 0 });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// EmbeddingConfigSchema
// ---------------------------------------------------------------------------

describe("EmbeddingConfigSchema", () => {
  it("produces valid defaults", () => {
    const result = EmbeddingConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(true);
      expect(result.data.provider).toBe("auto");
      expect(result.data.autoReindex).toBe(true);
    }
  });

  it("includes local defaults", () => {
    const result = EmbeddingConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.local.modelUri).toContain("nomic-embed-text");
      expect(result.data.local.modelsDir).toBe("models");
      expect(result.data.local.gpu).toBe("auto");
    }
  });

  it("includes openai defaults", () => {
    const result = EmbeddingConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.openai.model).toBe("text-embedding-3-small");
      expect(result.data.openai.dimensions).toBe(1536);
    }
  });

  it("includes cache defaults", () => {
    const result = EmbeddingConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cache.maxEntries).toBe(10_000);
    }
  });

  it("includes batch defaults", () => {
    const result = EmbeddingConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.batch.batchSize).toBe(100);
      expect(result.data.batch.indexOnStartup).toBe(true);
    }
  });

  it("accepts all provider values", () => {
    for (const provider of ["auto", "local", "openai"] as const) {
      const result = EmbeddingConfigSchema.safeParse({ provider });
      expect(result.success).toBe(true);
    }
  });

  it("rejects invalid provider", () => {
    const result = EmbeddingConfigSchema.safeParse({ provider: "cohere" });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// EnvelopeConfigSchema
// ---------------------------------------------------------------------------

describe("EnvelopeConfigSchema", () => {
  it("produces valid defaults", () => {
    const result = EnvelopeConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.timezoneMode).toBe("utc");
      expect(result.data.timeFormat).toBe("12h");
      expect(result.data.showElapsed).toBe(true);
      expect(result.data.showProvider).toBe(true);
      expect(result.data.elapsedMaxMs).toBe(86_400_000);
    }
  });

  it("accepts both timeFormat values", () => {
    for (const fmt of ["12h", "24h"] as const) {
      const result = EnvelopeConfigSchema.safeParse({ timeFormat: fmt });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.timeFormat).toBe(fmt);
      }
    }
  });

  it("rejects non-positive elapsedMaxMs", () => {
    const result = EnvelopeConfigSchema.safeParse({ elapsedMaxMs: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects negative elapsedMaxMs", () => {
    const result = EnvelopeConfigSchema.safeParse({ elapsedMaxMs: -1000 });
    expect(result.success).toBe(false);
  });

  it("accepts IANA timezone string for timezoneMode", () => {
    const result = EnvelopeConfigSchema.safeParse({ timezoneMode: "America/New_York" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.timezoneMode).toBe("America/New_York");
    }
  });
});
