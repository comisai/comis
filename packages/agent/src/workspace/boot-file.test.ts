// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { isBootContentEffectivelyEmpty, BOOT_FILE_NAME } from "./boot-file.js";

describe("BOOT_FILE_NAME", () => {
  it("equals 'BOOT.md'", () => {
    expect(BOOT_FILE_NAME).toBe("BOOT.md");
  });
});

describe("isBootContentEffectivelyEmpty", () => {
  it("returns true for empty string", () => {
    expect(isBootContentEffectivelyEmpty("")).toBe(true);
  });

  it("returns true for whitespace-only string", () => {
    expect(isBootContentEffectivelyEmpty("   \n  \n\t  ")).toBe(true);
  });

  it("returns true for comment-only lines (headers and empty list items)", () => {
    const content = [
      "# BOOT.md - Session Startup Instructions",
      "",
      "## Section",
      "- ",
      "* ",
      "+ ",
    ].join("\n");
    expect(isBootContentEffectivelyEmpty(content)).toBe(true);
  });

  it("returns true for default template content", () => {
    const defaultTemplate = `# BOOT.md - Session Startup Instructions

# Add instructions that run on the first message of each new session.
# These execute ONCE per session start, not on every message.

# Examples:
# - Check HEARTBEAT.md for pending tasks
# - Send a "back online" message to a channel
# - Resume interrupted workflows

# Leave empty or comment-only to skip (zero API cost).
`;
    expect(isBootContentEffectivelyEmpty(defaultTemplate)).toBe(true);
  });

  it("returns false for content with actual instruction text", () => {
    const content = [
      "# BOOT.md",
      "",
      "Check HEARTBEAT.md and send a status update to #general",
    ].join("\n");
    expect(isBootContentEffectivelyEmpty(content)).toBe(false);
  });

  it("returns false for mixed headers + real content", () => {
    const content = [
      "# BOOT.md - Session Startup Instructions",
      "",
      "## Tasks",
      "- Send 'I am back online' to Discord #general",
      "- Check for pending scheduled tasks",
    ].join("\n");
    expect(isBootContentEffectivelyEmpty(content)).toBe(false);
  });
});
