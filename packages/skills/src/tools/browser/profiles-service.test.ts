// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import { createProfileManager } from "./profiles-service.js";
import type { ProfileManagerDeps } from "./profiles-service.js";
import { safePath } from "@comis/core";

describe("profiles-service", () => {
  let tmpDir: string;
  let deps: ProfileManagerDeps;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(safePath(os.tmpdir(), "comis-profiles-test-"));
    deps = {
      baseCdpPort: 18800,
      maxProfiles: 5,
      profilesDir: tmpDir,
      logger: {
        info: () => {},
        warn: () => {},
      },
    };
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("create", () => {
    it("creates a profile with correct name, port, color, and directory", async () => {
      const manager = createProfileManager(deps);
      const result = await manager.create({ name: "test-profile" });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.name).toBe("test-profile");
      expect(result.value.cdpPort).toBe(18800);
      expect(result.value.color).toBe("#4285F4");
      expect(result.value.index).toBe(0);
      expect(result.value.profileDir).toContain("test-profile");

      // Verify directory was created
      expect(fs.existsSync(result.value.profileDir)).toBe(true);

      // Verify Local State was written
      const localStatePath = safePath(result.value.profileDir, "Local State");
      expect(fs.existsSync(localStatePath)).toBe(true);
      const localState = JSON.parse(fs.readFileSync(localStatePath, "utf-8"));
      expect(localState.profile.info_cache.Default.name).toBe("test-profile");
    });

    it("rejects duplicate names", async () => {
      const manager = createProfileManager(deps);
      await manager.create({ name: "my-profile" });
      const result = await manager.create({ name: "my-profile" });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("already exists");
      }
    });

    it("rejects when maxProfiles reached", async () => {
      const manager = createProfileManager({ ...deps, maxProfiles: 2 });
      await manager.create({ name: "profile-01" });
      await manager.create({ name: "profile-02" });
      const result = await manager.create({ name: "profile-03" });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Maximum profiles");
      }
    });

    it("rejects invalid profile names", async () => {
      const manager = createProfileManager(deps);
      const result = await manager.create({ name: "INVALID" });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Invalid profile name");
      }
    });

    it("allocates sequential indices", async () => {
      const manager = createProfileManager(deps);
      const r1 = await manager.create({ name: "first" + "0" });
      const r2 = await manager.create({ name: "second" });

      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      if (r1.ok && r2.ok) {
        expect(r1.value.index).toBe(0);
        expect(r2.value.index).toBe(1);
        expect(r2.value.cdpPort).toBe(18801);
      }
    });
  });

  describe("list", () => {
    it("returns all created profiles", async () => {
      const manager = createProfileManager(deps);
      await manager.create({ name: "alpha0" });
      await manager.create({ name: "bravo0" });

      const result = await manager.list();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(2);
        expect(result.value.map((p) => p.name)).toEqual(["alpha0", "bravo0"]);
      }
    });

    it("returns empty list when no profiles exist", async () => {
      const manager = createProfileManager(deps);
      const result = await manager.list();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(0);
      }
    });

    it("persists profiles across manager instances", async () => {
      const manager1 = createProfileManager(deps);
      await manager1.create({ name: "persistent" });

      const manager2 = createProfileManager(deps);
      const result = await manager2.list();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(1);
        expect(result.value[0].name).toBe("persistent");
      }
    });
  });

  describe("delete", () => {
    it("removes profile from list", async () => {
      const manager = createProfileManager(deps);
      await manager.create({ name: "to-delete" });
      const delResult = await manager.delete("to-delete");

      expect(delResult.ok).toBe(true);

      const listResult = await manager.list();
      expect(listResult.ok).toBe(true);
      if (listResult.ok) {
        expect(listResult.value).toHaveLength(0);
      }
    });

    it("returns error for unknown name", async () => {
      const manager = createProfileManager(deps);
      const result = await manager.delete("nonexistent");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("not found");
      }
    });

    it("reuses index after deletion", async () => {
      const manager = createProfileManager(deps);
      await manager.create({ name: "first0" });
      await manager.create({ name: "second0" });
      await manager.delete("first0");
      const r3 = await manager.create({ name: "third0" });

      expect(r3.ok).toBe(true);
      if (r3.ok) {
        // Index 0 was freed by deleting "first0"
        expect(r3.value.index).toBe(0);
      }
    });
  });

  describe("resolve", () => {
    it("finds profile by name", async () => {
      const manager = createProfileManager(deps);
      await manager.create({ name: "findme" });

      const result = manager.resolve("findme");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.name).toBe("findme");
        expect(result.value.cdpPort).toBe(18800);
      }
    });

    it("returns err for unknown name", async () => {
      const manager = createProfileManager(deps);
      await manager.list(); // Initialize cache

      const result = manager.resolve("missing");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("not found");
      }
    });

    it("returns err when cache not initialized", () => {
      const manager = createProfileManager(deps);
      const result = manager.resolve("anything");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("not initialized");
      }
    });
  });
});
