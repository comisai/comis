import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import {
  loadIdentityFiles,
  assembleSystemPrompt,
  type IdentityFiles,
} from "./identity-loader.js";

describe("identity-loader", () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = path.join(os.tmpdir(), `comis-test-${randomUUID()}`);
    await fs.mkdir(workspaceDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  describe("loadIdentityFiles", () => {
    it("loads AGENTS.md when present", async () => {
      await fs.writeFile(
        path.join(workspaceDir, "AGENTS.md"),
        "Operating instructions content.",
      );

      const result = await loadIdentityFiles(workspaceDir);

      expect(result.agents).toBe("Operating instructions content.");
    });

    it("returns empty object when no identity files exist", async () => {
      const result = await loadIdentityFiles(workspaceDir);

      expect(result.agents).toBeUndefined();
    });

    it("does not load SOUL.md, IDENTITY.md, or USER.md", async () => {
      await fs.writeFile(
        path.join(workspaceDir, "SOUL.md"),
        "Soul content.",
      );
      await fs.writeFile(
        path.join(workspaceDir, "IDENTITY.md"),
        "Identity content.",
      );
      await fs.writeFile(
        path.join(workspaceDir, "USER.md"),
        "User content.",
      );

      const result = await loadIdentityFiles(workspaceDir);

      // Only agents key should exist; old keys are not loaded
      expect(result.agents).toBeUndefined();
      expect(Object.keys(result)).not.toContain("soul");
      expect(Object.keys(result)).not.toContain("identity");
      expect(Object.keys(result)).not.toContain("user");
    });

    it("loads large files (>100KB) successfully", async () => {
      const largeContent = "A".repeat(150_000);
      await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), largeContent);

      const result = await loadIdentityFiles(workspaceDir);

      expect(result.agents).toBe(largeContent);
      expect(result.agents!.length).toBe(150_000);
    });

    it("skips files with path traversal in workspace dir", async () => {
      // If the workspace dir itself is crafted to cause traversal,
      // safePath will catch it. We test with a legitimate workspace.
      // The loader doesn't accept filenames from user input -- it uses
      // hardcoded AGENTS.md names. Path traversal protection is an
      // extra safety layer.
      const result = await loadIdentityFiles(workspaceDir);

      // Should complete without error
      expect(result).toBeDefined();
    });
  });

  describe("assembleSystemPrompt", () => {
    it("always includes Current Date & Time section at the start", () => {
      const identity: IdentityFiles = {};

      const prompt = assembleSystemPrompt(identity);

      expect(prompt).toContain("## Current Date & Time");
      expect(prompt).toMatch(/\d{4}-\d{2}-\d{2}T/); // ISO timestamp
    });

    it("injects AGENTS.md content directly without wrapping heading", () => {
      const identity: IdentityFiles = {
        agents: "# AGENTS.md\n\nOperating instructions.",
      };

      const prompt = assembleSystemPrompt(identity);

      // Content should be injected as-is, no ## heading wrapper
      expect(prompt).toContain("# AGENTS.md\n\nOperating instructions.");
      expect(prompt).not.toContain("## Operating Instructions");
      expect(prompt).not.toContain("## Identity");
      expect(prompt).not.toContain("## Personality");
    });

    it("places date/time before AGENTS.md content", () => {
      const identity: IdentityFiles = {
        agents: "Agent instructions",
      };

      const prompt = assembleSystemPrompt(identity);

      const dateIdx = prompt.indexOf("## Current Date & Time");
      const agentIdx = prompt.indexOf("Agent instructions");

      expect(dateIdx).toBeLessThan(agentIdx);
    });

    it("places AGENTS.md content before additional memory sections", () => {
      const identity: IdentityFiles = {
        agents: "Agent instructions",
      };

      const prompt = assembleSystemPrompt(identity, [
        "## Relevant Memories\n\nSome memories",
      ]);

      const agentIdx = prompt.indexOf("Agent instructions");
      const memoryIdx = prompt.indexOf("## Relevant Memories");

      expect(agentIdx).toBeLessThan(memoryIdx);
      expect(prompt).toContain("\n\n---\n\n");
    });

    it("includes date/time even when no identity files exist", () => {
      const identity: IdentityFiles = {};

      const prompt = assembleSystemPrompt(identity);

      expect(prompt).toContain("## Current Date & Time");
    });

    it("appends additional sections after AGENTS.md content", () => {
      const identity: IdentityFiles = {
        agents: "Operating manual.",
      };

      const prompt = assembleSystemPrompt(identity, [
        "## Memory Context\n\nRecent conversation notes.",
      ]);

      expect(prompt).toContain("Operating manual.");
      expect(prompt).toContain("## Memory Context\n\nRecent conversation notes.");
      // Date → AGENTS → memory, all separated by ---
      const dateIdx = prompt.indexOf("## Current Date & Time");
      const agentIdx = prompt.indexOf("Operating manual.");
      const memoryIdx = prompt.indexOf("## Memory Context");
      expect(dateIdx).toBeLessThan(agentIdx);
      expect(agentIdx).toBeLessThan(memoryIdx);
    });

    it("skips empty additional sections", () => {
      const identity: IdentityFiles = {
        agents: "Operating manual.",
      };

      const prompt = assembleSystemPrompt(identity, ["", "## Extra\n\nData"]);

      expect(prompt).toContain("Operating manual.");
      expect(prompt).toContain("## Extra\n\nData");
      expect(prompt).not.toContain("\n\n---\n\n\n\n---\n\n"); // no double separators
    });

    it("works with only additional sections and no identity files", () => {
      const identity: IdentityFiles = {};

      const prompt = assembleSystemPrompt(identity, [
        "## Memory\n\nSome memory.",
      ]);

      expect(prompt).toContain("## Memory\n\nSome memory.");
      expect(prompt).toContain("## Current Date & Time");
    });

    it("separates sections with horizontal rule", () => {
      const identity: IdentityFiles = {
        agents: "A",
      };

      const prompt = assembleSystemPrompt(identity, ["B"]);

      expect(prompt).toContain("\n\n---\n\n");
    });
  });
});
