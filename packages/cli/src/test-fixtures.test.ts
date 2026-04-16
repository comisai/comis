/**
 * Tests for deterministic test fixture data.
 *
 * Verifies that all fixture domains have the correct shape, expected counts,
 * and are deeply frozen to prevent accidental mutation.
 */

import { describe, it, expect } from "vitest";
import { FIXTURES } from "./test-fixtures.js";

describe("FIXTURES", () => {
  describe("configYaml", () => {
    it("is a non-empty string containing tenantId and gateway", () => {
      expect(typeof FIXTURES.configYaml).toBe("string");
      expect(FIXTURES.configYaml.length).toBeGreaterThan(0);
      expect(FIXTURES.configYaml).toContain("tenantId");
      expect(FIXTURES.configYaml).toContain("gateway");
    });
  });

  describe("agents", () => {
    it("has exactly 2 entries", () => {
      expect(FIXTURES.agents).toHaveLength(2);
    });

    it("each entry has name, provider, and model fields", () => {
      for (const agent of FIXTURES.agents) {
        expect(agent).toHaveProperty("name");
        expect(agent).toHaveProperty("provider");
        expect(agent).toHaveProperty("model");
        expect(typeof agent.name).toBe("string");
        expect(typeof agent.provider).toBe("string");
        expect(typeof agent.model).toBe("string");
      }
    });

    it("each entry has a bindings array", () => {
      for (const agent of FIXTURES.agents) {
        expect(Array.isArray(agent.bindings)).toBe(true);
      }
    });
  });

  describe("sessions", () => {
    it("has exactly 3 entries", () => {
      expect(FIXTURES.sessions).toHaveLength(3);
    });

    it("each entry has key, channelId, and userId fields", () => {
      for (const session of FIXTURES.sessions) {
        expect(session).toHaveProperty("key");
        expect(session).toHaveProperty("channelId");
        expect(session).toHaveProperty("userId");
        expect(typeof session.key).toBe("string");
        expect(typeof session.channelId).toBe("string");
        expect(typeof session.userId).toBe("string");
      }
    });

    it("each entry has messageCount as a number", () => {
      for (const session of FIXTURES.sessions) {
        expect(typeof session.messageCount).toBe("number");
      }
    });
  });

  describe("memoryEntries", () => {
    it("has exactly 3 entries", () => {
      expect(FIXTURES.memoryEntries).toHaveLength(3);
    });

    it("each entry has id, content, and score fields", () => {
      for (const entry of FIXTURES.memoryEntries) {
        expect(entry).toHaveProperty("id");
        expect(entry).toHaveProperty("content");
        expect(entry).toHaveProperty("score");
        expect(typeof entry.id).toBe("string");
        expect(typeof entry.content).toBe("string");
        expect(typeof entry.score).toBe("number");
      }
    });

    it("scores are between 0 and 1", () => {
      for (const entry of FIXTURES.memoryEntries) {
        expect(entry.score).toBeGreaterThanOrEqual(0);
        expect(entry.score).toBeLessThanOrEqual(1);
      }
    });
  });

  describe("channelStatus", () => {
    it("has exactly 3 entries", () => {
      expect(FIXTURES.channelStatus).toHaveLength(3);
    });

    it("covers connected, disconnected, and error states", () => {
      const statuses = FIXTURES.channelStatus.map((c) => c.status);
      expect(statuses).toContain("connected");
      expect(statuses).toContain("disconnected");
      expect(statuses).toContain("error");
    });

    it("each entry has id, type, and status fields", () => {
      for (const channel of FIXTURES.channelStatus) {
        expect(channel).toHaveProperty("id");
        expect(channel).toHaveProperty("type");
        expect(channel).toHaveProperty("status");
        expect(typeof channel.id).toBe("string");
        expect(typeof channel.type).toBe("string");
        expect(typeof channel.status).toBe("string");
      }
    });
  });

  describe("healthChecks", () => {
    it("has exactly 3 entries", () => {
      expect(FIXTURES.healthChecks).toHaveLength(3);
    });

    it("covers pass, fail, and warn statuses", () => {
      const statuses = FIXTURES.healthChecks.map((h) => h.status);
      expect(statuses).toContain("pass");
      expect(statuses).toContain("fail");
      expect(statuses).toContain("warn");
    });

    it("each entry has category, name, status, and message fields", () => {
      for (const check of FIXTURES.healthChecks) {
        expect(check).toHaveProperty("category");
        expect(check).toHaveProperty("name");
        expect(check).toHaveProperty("status");
        expect(check).toHaveProperty("message");
        expect(typeof check.category).toBe("string");
        expect(typeof check.name).toBe("string");
        expect(typeof check.status).toBe("string");
        expect(typeof check.message).toBe("string");
      }
    });
  });

  describe("immutability", () => {
    it("FIXTURES object is frozen", () => {
      expect(Object.isFrozen(FIXTURES)).toBe(true);
    });

    it("nested arrays are frozen", () => {
      expect(Object.isFrozen(FIXTURES.agents)).toBe(true);
      expect(Object.isFrozen(FIXTURES.sessions)).toBe(true);
      expect(Object.isFrozen(FIXTURES.memoryEntries)).toBe(true);
      expect(Object.isFrozen(FIXTURES.channelStatus)).toBe(true);
      expect(Object.isFrozen(FIXTURES.healthChecks)).toBe(true);
    });

    it("nested objects are frozen", () => {
      expect(Object.isFrozen(FIXTURES.agents[0])).toBe(true);
      expect(Object.isFrozen(FIXTURES.sessions[0])).toBe(true);
      expect(Object.isFrozen(FIXTURES.memoryEntries[0])).toBe(true);
      expect(Object.isFrozen(FIXTURES.memoryEntries[0]!.metadata)).toBe(true);
      expect(Object.isFrozen(FIXTURES.channelStatus[0])).toBe(true);
      expect(Object.isFrozen(FIXTURES.healthChecks[0])).toBe(true);
    });

    it("pushing to frozen arrays throws TypeError", () => {
      expect(() => {
        (FIXTURES.agents as unknown[]).push({});
      }).toThrow(TypeError);
    });

    it("modifying frozen object properties throws TypeError", () => {
      expect(() => {
        (FIXTURES.agents[0] as { name: string }).name = "hacked";
      }).toThrow(TypeError);
    });
  });
});
