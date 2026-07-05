// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { liftAuthoredFrontmatter } from "./lift.js";

interface CapturedWarn {
  payload: Record<string, unknown>;
  message: string;
}

function captureLogger(): {
  logger: { warn: (payload: Record<string, unknown>, message: string) => void };
  calls: CapturedWarn[];
} {
  const calls: CapturedWarn[] = [];
  return {
    logger: {
      warn: (payload: Record<string, unknown>, message: string): void => {
        calls.push({ payload, message });
      },
    },
    calls,
  };
}

// The same manifest expressed in both authored carriers, carrying a spare
// metadata key (author) alongside the moved version + extension bag.
const PRE_MIGRATION_WITH_SPARE_KEY = {
  name: "round-trip",
  description: "A round-trip manifest",
  version: "2.0.0",
  userInvocable: false,
  permissions: { net: ["api.example.com"] },
  comis: { requires: { bins: ["node"] } },
  mcpServers: [{ name: "foo", transport: "stdio", command: "npx" }],
  allowedTools: ["read", "write"],
  metadata: { author: "example" },
};

const SPEC_PURE_WITH_SPARE_KEY = {
  name: "round-trip",
  description: "A round-trip manifest",
  "allowed-tools": "read write",
  metadata: {
    version: "2.0.0",
    author: "example",
    comis: JSON.stringify({
      userInvocable: false,
      permissions: { net: ["api.example.com"] },
      comis: { requires: { bins: ["node"] } },
      mcpServers: [{ name: "foo", transport: "stdio", command: "npx" }],
    }),
  },
};

// The common case: metadata holds ONLY version + comis, no spare key.
const PRE_MIGRATION_ONLY_VERSION_COMIS = {
  name: "common-case",
  description: "The frequent manifest with no spare metadata",
  version: "3.0.0",
  comis: { requires: { bins: ["node"] } },
};

const SPEC_PURE_ONLY_VERSION_COMIS = {
  name: "common-case",
  description: "The frequent manifest with no spare metadata",
  metadata: {
    version: "3.0.0",
    comis: JSON.stringify({ comis: { requires: { bins: ["node"] } } }),
  },
};

describe("liftAuthoredFrontmatter round-trip equivalence", () => {
  it("normalizes the spec-pure and pre-migration forms to the same object when metadata carries a spare key", () => {
    const specPure = liftAuthoredFrontmatter(SPEC_PURE_WITH_SPARE_KEY, {});
    const preMigration = liftAuthoredFrontmatter(PRE_MIGRATION_WITH_SPARE_KEY, {});
    expect(specPure.ok).toBe(true);
    expect(preMigration.ok).toBe(true);
    if (!specPure.ok || !preMigration.ok) return;
    expect(specPure.value).toEqual(preMigration.value);
    expect(specPure.value["metadata"]).toEqual({ author: "example" });
  });

  it("normalizes an emptied metadata map to undefined so the only-version-and-comis form converges", () => {
    const specPure = liftAuthoredFrontmatter(SPEC_PURE_ONLY_VERSION_COMIS, {});
    const preMigration = liftAuthoredFrontmatter(PRE_MIGRATION_ONLY_VERSION_COMIS, {});
    expect(specPure.ok).toBe(true);
    expect(preMigration.ok).toBe(true);
    if (!specPure.ok || !preMigration.ok) return;
    // The empty residual map MUST become undefined, not {}, or deepEqual fails here.
    expect(specPure.value["metadata"]).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(specPure.value, "metadata")).toBe(false);
    expect(specPure.value).toEqual(preMigration.value);
  });
});

describe("liftAuthoredFrontmatter allowed-tools carrier", () => {
  it("splits a space-separated allowed-tools string into the internal array", () => {
    const result = liftAuthoredFrontmatter(
      { name: "t", description: "d", "allowed-tools": "read write grep" },
      {},
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value["allowedTools"]).toEqual(["read", "write", "grep"]);
  });

  it("maps an empty allowed-tools string to an empty array", () => {
    const result = liftAuthoredFrontmatter({ name: "t", description: "d", "allowed-tools": "   " }, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value["allowedTools"]).toEqual([]);
  });

  it("leaves allowedTools unset when allowed-tools is absent", () => {
    const result = liftAuthoredFrontmatter({ name: "t", description: "d" }, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.prototype.hasOwnProperty.call(result.value, "allowedTools")).toBe(false);
  });
});

describe("liftAuthoredFrontmatter metadata carrier extraction", () => {
  it("moves metadata.version to the internal version and drops it from the residual map", () => {
    const result = liftAuthoredFrontmatter(
      { name: "v", description: "d", metadata: { version: "1.2.3", author: "example" } },
      {},
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value["version"]).toBe("1.2.3");
    expect(result.value["metadata"]).toEqual({ author: "example" });
  });

  it("keeps a residual metadata map when a spare key remains after extraction", () => {
    const result = liftAuthoredFrontmatter(
      { name: "v", description: "d", metadata: { author: "example" } },
      {},
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value["version"]).toBeUndefined();
    expect(result.value["metadata"]).toEqual({ author: "example" });
  });

  it("merges the metadata.comis extension bag onto the internal top level", () => {
    const result = liftAuthoredFrontmatter(
      {
        name: "e",
        description: "d",
        metadata: {
          comis: JSON.stringify({ userInvocable: false, comis: { requires: { bins: ["node"] } } }),
        },
      },
      {},
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value["userInvocable"]).toBe(false);
    expect(result.value["comis"]).toEqual({ requires: { bins: ["node"] } });
    expect(result.value["metadata"]).toBeUndefined();
  });

  it("hands a non-object metadata value to the strict validator unchanged", () => {
    const result = liftAuthoredFrontmatter({ name: "m", description: "d", metadata: "not-a-map" }, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value["metadata"]).toBe("not-a-map");
  });

  it("ignores unrecognized and prototype keys inside the metadata.comis bag", () => {
    const payload = '{"__proto__":{"polluted":true},"unknownExtension":1,"userInvocable":false}';
    const result = liftAuthoredFrontmatter(
      { name: "p", description: "d", metadata: { comis: payload } },
      {},
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value["userInvocable"]).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(result.value, "unknownExtension")).toBe(false);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty("polluted");
  });

  it("skips a prototype key present as an own member of the metadata map", () => {
    const meta: Record<string, unknown> = { version: "1.0.0" };
    Object.defineProperty(meta, "__proto__", {
      value: "evil",
      enumerable: true,
      writable: true,
      configurable: true,
    });
    const result = liftAuthoredFrontmatter({ name: "g", description: "d", metadata: meta }, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value["version"]).toBe("1.0.0");
    expect(result.value["metadata"]).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty("polluted");
  });
});

describe("liftAuthoredFrontmatter honest failure on metadata.comis", () => {
  it("fails naming metadata.comis when its JSON string is malformed", () => {
    const result = liftAuthoredFrontmatter(
      { name: "bad", description: "d", metadata: { comis: "{not json" } },
      {},
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("metadata.comis");
  });

  it("fails naming metadata.comis when the JSON is not an object", () => {
    const result = liftAuthoredFrontmatter(
      { name: "bad", description: "d", metadata: { comis: "123" } },
      {},
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("metadata.comis");
  });

  it("fails naming metadata.comis when it is not a string carrier", () => {
    const result = liftAuthoredFrontmatter(
      { name: "bad", description: "d", metadata: { comis: 42 } },
      {},
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("metadata.comis");
  });
});

describe("liftAuthoredFrontmatter compatibility advisory", () => {
  it("warns once but still succeeds when the compatibility note exceeds 500 characters", () => {
    const { logger, calls } = captureLogger();
    const result = liftAuthoredFrontmatter(
      { name: "c", description: "d", compatibility: "a".repeat(501) },
      { logger, skillName: "c" },
    );
    expect(result.ok).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0]?.payload["errorKind"]).toBe("config");
  });

  it("does not warn when the compatibility note is at or under 500 characters", () => {
    const { logger, calls } = captureLogger();
    const result = liftAuthoredFrontmatter(
      { name: "c", description: "d", compatibility: "a".repeat(500) },
      { logger },
    );
    expect(result.ok).toBe(true);
    expect(calls.length).toBe(0);
  });

  it("does not throw on an over-long compatibility note when no logger is supplied", () => {
    const result = liftAuthoredFrontmatter(
      { name: "c", description: "d", compatibility: "a".repeat(600) },
      {},
    );
    expect(result.ok).toBe(true);
  });
});

describe("liftAuthoredFrontmatter pre-migration read-compatibility", () => {
  it("passes the pre-migration top-level form through unchanged", () => {
    const result = liftAuthoredFrontmatter(PRE_MIGRATION_WITH_SPARE_KEY, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual(PRE_MIGRATION_WITH_SPARE_KEY);
  });

  it("emits one deprecation warning naming each pre-migration key and its authored home", () => {
    const { logger, calls } = captureLogger();
    const result = liftAuthoredFrontmatter(
      {
        name: "m",
        description: "d",
        type: "prompt",
        version: "1.0.0",
        userInvocable: false,
        comis: { requires: { bins: ["node"] } },
      },
      { logger, skillName: "m" },
    );
    expect(result.ok).toBe(true);
    expect(calls.length).toBe(1);
    const moved = calls[0]?.payload["movedKeys"] as Array<{ from: string; to: string }>;
    const froms = moved.map((m) => m.from);
    expect(froms).toContain("type");
    expect(froms).toContain("version");
    expect(froms).toContain("userInvocable");
    expect(froms).toContain("comis");
    expect(moved.find((m) => m.from === "version")?.to).toBe("metadata.version");
    expect(moved.find((m) => m.from === "userInvocable")?.to).toBe("metadata.comis");
    expect(calls[0]?.payload["errorKind"]).toBe("config");
  });

  it("does not warn for the pre-migration form when no logger is supplied", () => {
    const { calls } = captureLogger();
    const result = liftAuthoredFrontmatter(
      { name: "m", description: "d", version: "1.0.0" },
      {},
    );
    expect(result.ok).toBe(true);
    expect(calls.length).toBe(0);
  });

  it("does not warn when a non-spec key is present but no pre-migration field moved", () => {
    const { logger, calls } = captureLogger();
    const result = liftAuthoredFrontmatter(
      { name: "u", description: "d", unknownTopLevel: 1 },
      { logger, skillName: "u" },
    );
    expect(result.ok).toBe(true);
    expect(calls.length).toBe(0);
  });
});
