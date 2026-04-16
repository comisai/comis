/**
 * Tests for tool source profiles: defaults, overrides, clamping, and resolution.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_SOURCE_PROFILES,
  HARD_CEILING_MAX_CHARS,
  HARD_CEILING_MAX_RESPONSE_BYTES,
  resolveAllProfiles,
  resolveSourceProfile,
} from "./tool-source-profiles.js";

// ---------------------------------------------------------------------------
// resolveSourceProfile
// ---------------------------------------------------------------------------

describe("resolveSourceProfile", () => {
  it("returns default profile for known tool", () => {
    const profile = resolveSourceProfile("web_fetch");
    expect(profile).toEqual(DEFAULT_SOURCE_PROFILES.web_fetch);
  });

  it("returns correct defaults for web_search", () => {
    const profile = resolveSourceProfile("web_search");
    expect(profile.maxResponseBytes).toBe(500_000);
    expect(profile.maxChars).toBe(40_000);
    expect(profile.extractionStrategy).toBe("structured");
    expect(profile.stripHidden).toBe(false);
  });

  it("returns correct defaults for bash", () => {
    const profile = resolveSourceProfile("bash");
    expect(profile.maxChars).toBe(50_000);
    expect(profile.extractionStrategy).toBe("tail");
  });

  it("returns correct defaults for file_read", () => {
    const profile = resolveSourceProfile("file_read");
    expect(profile.maxChars).toBe(100_000);
    expect(profile.extractionStrategy).toBe("raw");
  });

  it("merges overrides with defaults", () => {
    const profile = resolveSourceProfile("web_fetch", {
      maxChars: 30_000,
    });
    expect(profile.maxChars).toBe(30_000);
    // Other fields from default
    expect(profile.maxResponseBytes).toBe(2_000_000);
    expect(profile.extractionStrategy).toBe("readability");
    expect(profile.stripHidden).toBe(true);
  });

  it("clamps maxResponseBytes to hard ceiling (6MB -> 5MB)", () => {
    const profile = resolveSourceProfile("web_fetch", {
      maxResponseBytes: 6_000_000,
    });
    expect(profile.maxResponseBytes).toBe(HARD_CEILING_MAX_RESPONSE_BYTES);
  });

  it("clamps maxChars to hard ceiling (600K -> 500K)", () => {
    const profile = resolveSourceProfile("web_fetch", {
      maxChars: 600_000,
    });
    expect(profile.maxChars).toBe(HARD_CEILING_MAX_CHARS);
  });

  it("enforces minimum maxResponseBytes (1000 -> 32000)", () => {
    const profile = resolveSourceProfile("web_fetch", {
      maxResponseBytes: 1_000,
    });
    expect(profile.maxResponseBytes).toBe(32_000);
  });

  it("enforces minimum maxChars (10 -> 100)", () => {
    const profile = resolveSourceProfile("web_fetch", {
      maxChars: 10,
    });
    expect(profile.maxChars).toBe(100);
  });

  it("falls back to web_fetch profile for unknown non-MCP tool", () => {
    const profile = resolveSourceProfile("unknown_tool");
    expect(profile).toEqual(DEFAULT_SOURCE_PROFILES.web_fetch);
  });

  it("falls back to web_fetch and merges overrides for unknown non-MCP tool", () => {
    const profile = resolveSourceProfile("custom_tool", {
      maxChars: 20_000,
      extractionStrategy: "raw",
    });
    expect(profile.maxChars).toBe(20_000);
    expect(profile.extractionStrategy).toBe("raw");
    // Inherited from web_fetch default
    expect(profile.maxResponseBytes).toBe(2_000_000);
  });

  // MCP tool name fallback
  it("falls back to mcp_default for MCP tool names (mcp__ prefix)", () => {
    const profile = resolveSourceProfile("mcp__context7--resolve-library-id");
    expect(profile).toEqual(DEFAULT_SOURCE_PROFILES.mcp_default);
  });

  it("falls back to mcp_default for another MCP tool name", () => {
    const profile = resolveSourceProfile("mcp__tavily--search");
    expect(profile.maxChars).toBe(50_000);
    expect(profile.extractionStrategy).toBe("raw");
    expect(profile.stripHidden).toBe(false);
    // Should NOT fall back to web_fetch (which has readability + stripHidden: true)
    expect(profile.extractionStrategy).not.toBe("readability");
    expect(profile.stripHidden).not.toBe(true);
  });

  it("merges overrides with mcp_default base for MCP tools", () => {
    const profile = resolveSourceProfile("mcp__tavily--search", {
      maxChars: 30_000,
    });
    expect(profile.maxChars).toBe(30_000);
    // Other fields inherited from mcp_default
    expect(profile.maxResponseBytes).toBe(2_000_000);
    expect(profile.extractionStrategy).toBe("raw");
    expect(profile.stripHidden).toBe(false);
  });

  it("clamps mcp_default profile values within hard ceilings", () => {
    const profile = resolveSourceProfile("mcp__big-server--tool", {
      maxChars: 600_000,
      maxResponseBytes: 10_000_000,
    });
    expect(profile.maxChars).toBe(HARD_CEILING_MAX_CHARS);
    expect(profile.maxResponseBytes).toBe(HARD_CEILING_MAX_RESPONSE_BYTES);
  });

  it("exact match takes priority over mcp__ prefix fallback", () => {
    // mcp_default itself is an exact match
    const profile = resolveSourceProfile("mcp_default");
    expect(profile).toEqual(DEFAULT_SOURCE_PROFILES.mcp_default);
  });

  it("some_custom_tool still falls back to web_fetch, not mcp_default", () => {
    const profile = resolveSourceProfile("some_custom_tool");
    expect(profile).toEqual(DEFAULT_SOURCE_PROFILES.web_fetch);
  });
});

// ---------------------------------------------------------------------------
// resolveAllProfiles
// ---------------------------------------------------------------------------

describe("resolveAllProfiles", () => {
  it("returns all defaults when no overrides provided", () => {
    const profiles = resolveAllProfiles();
    expect(Object.keys(profiles)).toEqual(
      expect.arrayContaining(["web_fetch", "web_search", "bash", "file_read", "mcp_default"]),
    );
    expect(profiles.web_fetch).toEqual(DEFAULT_SOURCE_PROFILES.web_fetch);
    expect(profiles.web_search).toEqual(DEFAULT_SOURCE_PROFILES.web_search);
    expect(profiles.bash).toEqual(DEFAULT_SOURCE_PROFILES.bash);
    expect(profiles.file_read).toEqual(DEFAULT_SOURCE_PROFILES.file_read);
    expect(profiles.mcp_default).toEqual(DEFAULT_SOURCE_PROFILES.mcp_default);
  });

  it("merges per-tool overrides", () => {
    const profiles = resolveAllProfiles({
      web_fetch: { maxChars: 25_000 },
      bash: { maxChars: 30_000 },
    });
    expect(profiles.web_fetch.maxChars).toBe(25_000);
    expect(profiles.bash.maxChars).toBe(30_000);
    // Unchanged
    expect(profiles.web_search.maxChars).toBe(40_000);
    expect(profiles.file_read.maxChars).toBe(100_000);
  });

  it("adds custom tool names from overrides", () => {
    const profiles = resolveAllProfiles({
      custom_scraper: { maxChars: 60_000, extractionStrategy: "raw" },
    });
    expect(profiles.custom_scraper).toBeDefined();
    expect(profiles.custom_scraper.maxChars).toBe(60_000);
    expect(profiles.custom_scraper.extractionStrategy).toBe("raw");
    // Inherited from web_fetch fallback
    expect(profiles.custom_scraper.maxResponseBytes).toBe(2_000_000);
  });

  it("does not duplicate profiles when override key matches default key", () => {
    const profiles = resolveAllProfiles({
      web_fetch: { maxChars: 45_000 },
    });
    // Should have exactly the 5 default keys (web_fetch, web_search, bash, file_read, mcp_default)
    expect(Object.keys(profiles)).toHaveLength(5);
    expect(profiles.web_fetch.maxChars).toBe(45_000);
  });
});
