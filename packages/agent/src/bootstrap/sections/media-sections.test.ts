import { describe, it, expect } from "vitest";
import {
  buildReactionGuidanceSection,
  buildMediaFilesSection,
  buildAutonomousMediaSection,
} from "./media-sections.js";

// ---------------------------------------------------------------------------
// buildReactionGuidanceSection
// ---------------------------------------------------------------------------

describe("buildReactionGuidanceSection", () => {
  it("returns empty for minimal mode", () => {
    expect(buildReactionGuidanceSection("minimal", "telegram", true)).toEqual([]);
  });

  it("returns empty for undefined reaction level", () => {
    expect(buildReactionGuidanceSection(undefined, "telegram", false)).toEqual([]);
  });

  it("returns minimal mode content with guideline about 1 reaction per 5-10 exchanges", () => {
    const result = buildReactionGuidanceSection("minimal", "telegram", false);
    const joined = result.join("\n");
    expect(joined).toContain("## Reactions");
    expect(joined).toContain("at most 1 reaction per 5-10 exchanges");
    expect(joined).toContain("minimal mode");
  });

  it("returns extensive mode content with react whenever it feels natural", () => {
    const result = buildReactionGuidanceSection("extensive", "discord", false);
    const joined = result.join("\n");
    expect(joined).toContain("## Reactions");
    expect(joined).toContain("react whenever it feels natural");
    expect(joined).toContain("extensive mode");
  });

  it("includes channelType in output when provided", () => {
    const result = buildReactionGuidanceSection("minimal", "telegram", false);
    const joined = result.join("\n");
    expect(joined).toContain("telegram");
  });

  it("uses 'this channel' when channelType is undefined", () => {
    const result = buildReactionGuidanceSection("minimal", undefined, false);
    const joined = result.join("\n");
    expect(joined).toContain("this channel");
  });
});

// ---------------------------------------------------------------------------
// buildMediaFilesSection
// ---------------------------------------------------------------------------

describe("buildMediaFilesSection", () => {
  it("returns empty when isMinimal is true", () => {
    expect(buildMediaFilesSection(true, true, "/workspace", true, true)).toEqual([]);
  });

  it("returns empty when mediaPersistenceEnabled is false", () => {
    expect(buildMediaFilesSection(true, true, "/workspace", false, false)).toEqual([]);
  });

  it("returns empty when hasMemoryTools is false", () => {
    expect(buildMediaFilesSection(false, true, "/workspace", true, false)).toEqual([]);
  });

  it("returns empty when hasMessageTool is false", () => {
    expect(buildMediaFilesSection(true, false, "/workspace", true, false)).toEqual([]);
  });

  it("returns empty when workspaceDir is undefined", () => {
    expect(buildMediaFilesSection(true, true, undefined, true, false)).toEqual([]);
  });

  it("returns Persisted Media Files section with workspace path when all gates pass", () => {
    const result = buildMediaFilesSection(true, true, "/home/agent/workspace", true, false);
    const joined = result.join("\n");
    expect(joined).toContain("## Persisted Media Files");
    expect(joined).toContain("/home/agent/workspace");
  });
});

// ---------------------------------------------------------------------------
// buildAutonomousMediaSection
// ---------------------------------------------------------------------------

describe("buildAutonomousMediaSection", () => {
  it("returns empty for minimal mode", () => {
    expect(buildAutonomousMediaSection(true, true)).toEqual([]);
  });

  it("returns empty when disabled", () => {
    expect(buildAutonomousMediaSection(false, false)).toEqual([]);
  });

  it("returns Processing Attachment Hints section with tool reference when enabled", () => {
    const result = buildAutonomousMediaSection(true, false);
    const joined = result.join("\n");
    expect(joined).toContain("## Processing Attachment Hints");
    expect(joined).toContain("transcribe_audio");
    expect(joined).toContain("image_analyze");
  });
});
