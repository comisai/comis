import { describe, it, expect } from "vitest";
import { createAcpSessionMap } from "./acp-session-map.js";

describe("createAcpSessionMap", () => {
  it("create() returns SessionKey with channelId 'acp' and peerId matching acpSessionId", () => {
    const map = createAcpSessionMap();
    const key = map.create("session-abc");

    expect(key.channelId).toBe("acp");
    expect(key.userId).toBe("ide-user");
    expect(key.peerId).toBe("session-abc");
  });

  it("get() returns the mapped key after create()", () => {
    const map = createAcpSessionMap();
    map.create("session-1");

    const result = map.get("session-1");
    expect(result).toEqual({
      userId: "ide-user",
      channelId: "acp",
      peerId: "session-1",
    });
  });

  it("get() returns undefined for unknown IDs", () => {
    const map = createAcpSessionMap();
    expect(map.get("nonexistent")).toBeUndefined();
  });

  it("remove() returns true for existing session", () => {
    const map = createAcpSessionMap();
    map.create("session-to-remove");

    expect(map.remove("session-to-remove")).toBe(true);
    expect(map.get("session-to-remove")).toBeUndefined();
  });

  it("remove() returns false for unknown session", () => {
    const map = createAcpSessionMap();
    expect(map.remove("unknown")).toBe(false);
  });

  it("getAll() returns snapshot that is not affected by subsequent mutations", () => {
    const map = createAcpSessionMap();
    map.create("s1");
    map.create("s2");

    const snapshot = map.getAll();
    expect(snapshot.size).toBe(2);

    // Mutate the original map
    map.create("s3");
    map.remove("s1");

    // Snapshot should be unaffected
    expect(snapshot.size).toBe(2);
    expect(snapshot.has("s1")).toBe(true);
    expect(snapshot.has("s2")).toBe(true);
    expect(snapshot.has("s3")).toBe(false);
  });

  it("clear() empties all mappings", () => {
    const map = createAcpSessionMap();
    map.create("a");
    map.create("b");
    map.create("c");

    map.clear();

    expect(map.getAll().size).toBe(0);
    expect(map.get("a")).toBeUndefined();
    expect(map.get("b")).toBeUndefined();
    expect(map.get("c")).toBeUndefined();
  });

  it("evicts oldest session when maxSessions is exceeded (custom limit)", () => {
    const map = createAcpSessionMap(3);
    map.create("s1");
    map.create("s2");
    map.create("s3");

    // At capacity -- creating s4 should evict s1 (oldest)
    map.create("s4");

    expect(map.get("s1")).toBeUndefined();
    expect(map.get("s2")).toBeDefined();
    expect(map.get("s3")).toBeDefined();
    expect(map.get("s4")).toBeDefined();
    expect(map.getAll().size).toBe(3);
  });

  it("evicts multiple oldest sessions as new ones are created", () => {
    const map = createAcpSessionMap(2);
    map.create("a");
    map.create("b");

    // Creating c evicts a
    map.create("c");
    expect(map.get("a")).toBeUndefined();
    expect(map.get("b")).toBeDefined();
    expect(map.get("c")).toBeDefined();

    // Creating d evicts b
    map.create("d");
    expect(map.get("b")).toBeUndefined();
    expect(map.get("c")).toBeDefined();
    expect(map.get("d")).toBeDefined();
    expect(map.getAll().size).toBe(2);
  });

  it("default maxSessions of 1000 evicts on overflow", () => {
    const map = createAcpSessionMap(); // default 1000
    for (let i = 0; i < 1001; i++) {
      map.create(`session-${i}`);
    }

    // First session should be evicted
    expect(map.get("session-0")).toBeUndefined();
    // Last session should exist
    expect(map.get("session-1000")).toBeDefined();
    expect(map.getAll().size).toBe(1000);
  });

  it("does not evict when under maxSessions", () => {
    const map = createAcpSessionMap(5);
    map.create("a");
    map.create("b");
    map.create("c");

    expect(map.getAll().size).toBe(3);
    expect(map.get("a")).toBeDefined();
    expect(map.get("b")).toBeDefined();
    expect(map.get("c")).toBeDefined();
  });
});
