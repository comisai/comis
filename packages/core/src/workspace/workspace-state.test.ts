// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import {
  STATE_FILENAME,
  readWorkspaceState,
  writeWorkspaceState,
  isIdentityFilled,
  incrementOnboardingCount,
} from "./workspace-state.js";

describe("workspace-state", () => {
  const tempDirs: string[] = [];

  async function makeTempDir(): Promise<string> {
    const dir = path.join(os.tmpdir(), `comis-ws-state-test-${randomUUID()}`);
    await fs.mkdir(dir, { recursive: true });
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    for (const dir of tempDirs) {
      await fs.rm(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  // -------------------------------------------------------------------------
  // readWorkspaceState
  // -------------------------------------------------------------------------

  describe("readWorkspaceState", () => {
    it("returns defaults for non-existent directory", async () => {
      const dir = path.join(os.tmpdir(), `nonexistent-${randomUUID()}`);
      const state = await readWorkspaceState(dir);
      expect(state).toEqual({ version: 1 });
    });

    it("returns defaults for missing state file", async () => {
      const dir = await makeTempDir();
      const state = await readWorkspaceState(dir);
      expect(state).toEqual({ version: 1 });
    });

    it("returns defaults for corrupt JSON", async () => {
      const dir = await makeTempDir();
      await fs.writeFile(path.join(dir, STATE_FILENAME), "not json{{{", "utf-8");
      const state = await readWorkspaceState(dir);
      expect(state).toEqual({ version: 1 });
    });

    it("returns defaults for invalid schema (version: 2)", async () => {
      const dir = await makeTempDir();
      await fs.writeFile(
        path.join(dir, STATE_FILENAME),
        JSON.stringify({ version: 2, bootstrapSeededAt: 1000 }),
        "utf-8",
      );
      const state = await readWorkspaceState(dir);
      expect(state).toEqual({ version: 1 });
    });

    it("reads valid state file with both timestamps", async () => {
      const dir = await makeTempDir();
      const data = { version: 1, bootstrapSeededAt: 1000, onboardingCompletedAt: 2000 };
      await fs.writeFile(path.join(dir, STATE_FILENAME), JSON.stringify(data), "utf-8");
      const state = await readWorkspaceState(dir);
      expect(state).toEqual(data);
    });

    it("reads valid state file with only bootstrapSeededAt", async () => {
      const dir = await makeTempDir();
      const data = { version: 1, bootstrapSeededAt: 1000 };
      await fs.writeFile(path.join(dir, STATE_FILENAME), JSON.stringify(data), "utf-8");
      const state = await readWorkspaceState(dir);
      expect(state).toEqual(data);
    });
  });

  // -------------------------------------------------------------------------
  // writeWorkspaceState
  // -------------------------------------------------------------------------

  describe("writeWorkspaceState", () => {
    it("creates state file when missing", async () => {
      const dir = await makeTempDir();
      await writeWorkspaceState(dir, { bootstrapSeededAt: 1000 });

      const raw = await fs.readFile(path.join(dir, STATE_FILENAME), "utf-8");
      const data = JSON.parse(raw);
      expect(data).toEqual({ version: 1, bootstrapSeededAt: 1000 });
    });

    it("merges with existing state", async () => {
      const dir = await makeTempDir();
      await writeWorkspaceState(dir, { bootstrapSeededAt: 1000 });
      await writeWorkspaceState(dir, { onboardingCompletedAt: 2000 });

      const raw = await fs.readFile(path.join(dir, STATE_FILENAME), "utf-8");
      const data = JSON.parse(raw);
      expect(data).toEqual({
        version: 1,
        bootstrapSeededAt: 1000,
        onboardingCompletedAt: 2000,
      });
    });

    it("does not overwrite existing timestamps when merging", async () => {
      const dir = await makeTempDir();
      await writeWorkspaceState(dir, { bootstrapSeededAt: 1000 });
      // Write onboardingCompletedAt without re-specifying bootstrapSeededAt
      await writeWorkspaceState(dir, { onboardingCompletedAt: 2000 });

      const state = await readWorkspaceState(dir);
      expect(state.bootstrapSeededAt).toBe(1000);
      expect(state.onboardingCompletedAt).toBe(2000);
    });
  });

  // -------------------------------------------------------------------------
  // incrementOnboardingCount
  // -------------------------------------------------------------------------

  describe("incrementOnboardingCount", () => {
    it("returns 1 on fresh workspace and writes state", async () => {
      const dir = await makeTempDir();
      const count = await incrementOnboardingCount(dir);
      expect(count).toBe(1);

      const raw = await fs.readFile(path.join(dir, STATE_FILENAME), "utf-8");
      const data = JSON.parse(raw);
      expect(data).toEqual({ version: 1, onboardingMessageCount: 1 });
    });

    it("increments existing count and preserves other fields", async () => {
      const dir = await makeTempDir();
      await fs.writeFile(
        path.join(dir, STATE_FILENAME),
        JSON.stringify({ version: 1, bootstrapSeededAt: 5000, onboardingMessageCount: 2 }),
        "utf-8",
      );

      const count = await incrementOnboardingCount(dir);
      expect(count).toBe(3);

      const raw = await fs.readFile(path.join(dir, STATE_FILENAME), "utf-8");
      const data = JSON.parse(raw);
      expect(data).toEqual({
        version: 1,
        bootstrapSeededAt: 5000,
        onboardingMessageCount: 3,
      });
    });

    it("returns 1 when existing state has no onboardingMessageCount", async () => {
      const dir = await makeTempDir();
      await fs.writeFile(
        path.join(dir, STATE_FILENAME),
        JSON.stringify({ version: 1, bootstrapSeededAt: 3000 }),
        "utf-8",
      );

      const count = await incrementOnboardingCount(dir);
      expect(count).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // isIdentityFilled
  // -------------------------------------------------------------------------

  describe("isIdentityFilled", () => {
    it("returns false for missing file", async () => {
      const dir = await makeTempDir();
      const result = await isIdentityFilled(path.join(dir, "IDENTITY.md"));
      expect(result).toBe(false);
    });

    it("returns false for template content with placeholder", async () => {
      const dir = await makeTempDir();
      const content = `# IDENTITY.md

- **Name:**
  _(pick something you like)_
- **Creature:**
  _(AI? robot?)_
`;
      await fs.writeFile(path.join(dir, "IDENTITY.md"), content, "utf-8");
      const result = await isIdentityFilled(path.join(dir, "IDENTITY.md"));
      expect(result).toBe(false);
    });

    it("returns false for empty Name field", async () => {
      const dir = await makeTempDir();
      const content = `# IDENTITY.md

- **Name:**

- **Creature:**
  Robot
`;
      await fs.writeFile(path.join(dir, "IDENTITY.md"), content, "utf-8");
      const result = await isIdentityFilled(path.join(dir, "IDENTITY.md"));
      expect(result).toBe(false);
    });

    it("returns true for filled Name field on next line", async () => {
      const dir = await makeTempDir();
      const content = `# IDENTITY.md

- **Name:**
  Aria
- **Creature:**
  AI familiar
`;
      await fs.writeFile(path.join(dir, "IDENTITY.md"), content, "utf-8");
      const result = await isIdentityFilled(path.join(dir, "IDENTITY.md"));
      expect(result).toBe(true);
    });

    it("returns true for Name without markdown bold", async () => {
      const dir = await makeTempDir();
      const content = `# IDENTITY.md

Name: Aria
Creature: AI
`;
      await fs.writeFile(path.join(dir, "IDENTITY.md"), content, "utf-8");
      const result = await isIdentityFilled(path.join(dir, "IDENTITY.md"));
      expect(result).toBe(true);
    });

    it("returns true for Name on same line with bold markers", async () => {
      const dir = await makeTempDir();
      const content = `# IDENTITY.md

- **Name:** Nova
`;
      await fs.writeFile(path.join(dir, "IDENTITY.md"), content, "utf-8");
      const result = await isIdentityFilled(path.join(dir, "IDENTITY.md"));
      expect(result).toBe(true);
    });
  });
});
