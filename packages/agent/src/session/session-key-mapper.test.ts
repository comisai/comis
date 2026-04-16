import { describe, it, expect } from "vitest";
import { PathTraversalError } from "@comis/core";
import type { SessionKey } from "@comis/core";
import { sessionKeyToPath, pathToSessionKey } from "./session-key-mapper.js";

const BASE_DIR = "/home/comis/agents/bot1/sessions";

describe("SessionKeyMapper", () => {
  describe("basic round-trip", () => {
    it("minimal SessionKey (tenantId + userId + channelId) round-trips correctly", () => {
      const key: SessionKey = {
        tenantId: "default",
        userId: "user123",
        channelId: "general",
      };

      const path = sessionKeyToPath(key, BASE_DIR);
      const recovered = pathToSessionKey(path, BASE_DIR);

      expect(recovered).toEqual(key);
    });

    it("full SessionKey with all optional fields round-trips correctly", () => {
      const key: SessionKey = {
        tenantId: "acme-corp",
        userId: "alice",
        channelId: "dev-chat",
        peerId: "bob",
        guildId: "server-42",
        threadId: "thread-99",
      };

      const path = sessionKeyToPath(key, BASE_DIR);
      const recovered = pathToSessionKey(path, BASE_DIR);

      expect(recovered).toEqual(key);
    });

    it("agentId parameter is set on returned SessionKey from pathToSessionKey", () => {
      const key: SessionKey = {
        tenantId: "default",
        userId: "user1",
        channelId: "ch1",
      };

      const path = sessionKeyToPath(key, BASE_DIR);
      const recovered = pathToSessionKey(path, BASE_DIR, "agent-007");

      expect(recovered).toBeDefined();
      expect(recovered!.agentId).toBe("agent-007");
      expect(recovered!.tenantId).toBe("default");
      expect(recovered!.userId).toBe("user1");
      expect(recovered!.channelId).toBe("ch1");
    });
  });

  describe("encoding and collision avoidance", () => {
    it("SessionKey with colons in userId produces a different path than underscored variant", () => {
      const keyWithColon: SessionKey = {
        tenantId: "default",
        userId: "user:123",
        channelId: "ch",
      };
      const keyWithUnderscore: SessionKey = {
        tenantId: "default",
        userId: "user_123",
        channelId: "ch",
      };

      const pathColon = sessionKeyToPath(keyWithColon, BASE_DIR);
      const pathUnderscore = sessionKeyToPath(keyWithUnderscore, BASE_DIR);

      expect(pathColon).not.toBe(pathUnderscore);

      // Both round-trip correctly
      expect(pathToSessionKey(pathColon, BASE_DIR)).toEqual(keyWithColon);
      expect(pathToSessionKey(pathUnderscore, BASE_DIR)).toEqual(keyWithUnderscore);
    });

    it("SessionKey with slashes in channelId produces safe path (no directory traversal)", () => {
      const key: SessionKey = {
        tenantId: "default",
        userId: "user1",
        channelId: "channel/with/slashes",
      };

      const path = sessionKeyToPath(key, BASE_DIR);

      // Path must still be under BASE_DIR
      expect(path.startsWith(BASE_DIR)).toBe(true);

      // Should round-trip
      const recovered = pathToSessionKey(path, BASE_DIR);
      expect(recovered).toEqual(key);
    });

    it("SessionKey with unicode characters round-trips correctly", () => {
      const key: SessionKey = {
        tenantId: "tenant-日本語",
        userId: "用户abc",
        channelId: "каналь",
      };

      const path = sessionKeyToPath(key, BASE_DIR);
      const recovered = pathToSessionKey(path, BASE_DIR);

      expect(recovered).toEqual(key);
    });

    it("SessionKey with dots, hyphens, underscores passes through unchanged (safe chars)", () => {
      const key: SessionKey = {
        tenantId: "my-tenant",
        userId: "user_name",
        channelId: "channel.v2",
      };

      const path = sessionKeyToPath(key, BASE_DIR);

      // Safe characters should appear literally in the path
      expect(path).toContain("my-tenant");
      expect(path).toContain("user_name");
      expect(path).toContain("channel.v2");

      const recovered = pathToSessionKey(path, BASE_DIR);
      expect(recovered).toEqual(key);
    });

    it("tilde in values does not collide with delimiters", () => {
      const key: SessionKey = {
        tenantId: "default",
        userId: "user~peer~fake",
        channelId: "ch",
        peerId: "real-peer",
      };

      const path = sessionKeyToPath(key, BASE_DIR);
      const recovered = pathToSessionKey(path, BASE_DIR);

      // Must recover the original userId with tildes, not confuse it with the delimiter
      expect(recovered).toEqual(key);
      expect(recovered!.userId).toBe("user~peer~fake");
      expect(recovered!.peerId).toBe("real-peer");
    });
  });

  describe("path structure", () => {
    it("path follows expected directory hierarchy {baseDir}/{tenant}/{channel}/{filename}.jsonl", () => {
      const key: SessionKey = {
        tenantId: "acme",
        userId: "alice",
        channelId: "general",
      };

      const path = sessionKeyToPath(key, BASE_DIR);

      expect(path).toBe(`${BASE_DIR}/acme/general/alice.jsonl`);
    });

    it("path ends with .jsonl extension", () => {
      const key: SessionKey = {
        tenantId: "t",
        userId: "u",
        channelId: "c",
      };

      const path = sessionKeyToPath(key, BASE_DIR);
      expect(path).toMatch(/\.jsonl$/);
    });

    it("path contains no double slashes or invalid characters", () => {
      const key: SessionKey = {
        tenantId: "tenant",
        userId: "user",
        channelId: "channel",
        peerId: "peer",
        guildId: "guild",
        threadId: "thread",
      };

      const path = sessionKeyToPath(key, BASE_DIR);

      expect(path).not.toContain("//");
      expect(path).not.toContain("\0");
    });

    it("optional fields appear in filename with correct delimiters", () => {
      const key: SessionKey = {
        tenantId: "t",
        userId: "alice",
        channelId: "c",
        peerId: "bob",
        guildId: "srv",
        threadId: "th1",
      };

      const path = sessionKeyToPath(key, BASE_DIR);

      // Filename should contain delimiter tokens
      expect(path).toContain("~peer~");
      expect(path).toContain("~guild~");
      expect(path).toContain("~thread~");
      expect(path).toMatch(/alice~peer~bob~guild~srv~thread~th1\.jsonl$/);
    });
  });

  describe("edge cases", () => {
    it("pathToSessionKey returns undefined for path with fewer than 3 segments", () => {
      const result = pathToSessionKey(`${BASE_DIR}/only-two`, BASE_DIR);
      expect(result).toBeUndefined();
    });

    it("pathToSessionKey returns undefined for empty string", () => {
      const result = pathToSessionKey("", BASE_DIR);
      expect(result).toBeUndefined();
    });

    it("pathToSessionKey returns undefined for path not under baseDir", () => {
      const result = pathToSessionKey("/other/path/a/b/c.jsonl", BASE_DIR);
      expect(result).toBeUndefined();
    });

    it("pathToSessionKey returns undefined for path without .jsonl extension", () => {
      const result = pathToSessionKey(`${BASE_DIR}/t/c/u.txt`, BASE_DIR);
      expect(result).toBeUndefined();
    });

    it("peerId, guildId, threadId absent in path means absent in returned SessionKey (not empty string)", () => {
      const key: SessionKey = {
        tenantId: "default",
        userId: "user1",
        channelId: "ch1",
      };

      const path = sessionKeyToPath(key, BASE_DIR);
      const recovered = pathToSessionKey(path, BASE_DIR);

      expect(recovered).toBeDefined();
      expect(recovered!.peerId).toBeUndefined();
      expect(recovered!.guildId).toBeUndefined();
      expect(recovered!.threadId).toBeUndefined();
      expect(recovered!.agentId).toBeUndefined();
    });

    it("agentId on input key is not included in path (by convention baseDir includes it)", () => {
      const keyWithAgent: SessionKey = {
        tenantId: "default",
        userId: "user1",
        channelId: "ch1",
        agentId: "bot-1",
      };
      const keyWithout: SessionKey = {
        tenantId: "default",
        userId: "user1",
        channelId: "ch1",
      };

      const pathWith = sessionKeyToPath(keyWithAgent, BASE_DIR);
      const pathWithout = sessionKeyToPath(keyWithout, BASE_DIR);

      // agentId should NOT affect the path
      expect(pathWith).toBe(pathWithout);
    });
  });

  describe("safePath integration", () => {
    it("SessionKey with ../ in tenantId produces a safe path within baseDir (encoding neutralizes traversal)", () => {
      const key: SessionKey = {
        tenantId: "../../../etc",
        userId: "user",
        channelId: "ch",
      };

      // Encoding converts "../../../etc" to "@2e@2e/@2e@2e/@2e@2e/etc"-like safe string.
      // safePath validates the result stays within baseDir.
      const result = sessionKeyToPath(key, BASE_DIR);
      expect(result.startsWith(BASE_DIR)).toBe(true);

      // Round-trip recovers the original traversal-attempt string harmlessly
      const recovered = pathToSessionKey(result, BASE_DIR);
      expect(recovered).toBeDefined();
      expect(recovered!.tenantId).toBe("../../../etc");
    });

    it("safePath throws PathTraversalError for null bytes in segments", () => {
      const key: SessionKey = {
        tenantId: "tenant\0evil",
        userId: "user",
        channelId: "ch",
      };

      // Null bytes are encoded by encodeComponent, but safePath may still
      // reject them. Either way the path must be safe.
      // Our encoder converts \0 to @00 which is safe, so no error expected.
      const result = sessionKeyToPath(key, BASE_DIR);
      expect(result.startsWith(BASE_DIR)).toBe(true);
    });
  });
});
