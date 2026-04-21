// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { ok, err } from "@comis/shared";
import type { ConfigError } from "./types.js";
import { resolveIncludes } from "./include-resolver.js";
import type { IncludeResolverDeps } from "./include-resolver.js";

/**
 * Helper to create mock deps with a virtual filesystem.
 * Files are keyed by absolute path, values are raw YAML/JSON strings.
 */
function createMockDeps(
  files: Record<string, string>,
): IncludeResolverDeps {
  return {
    readFile(absPath: string) {
      if (absPath in files) {
        return ok(files[absPath]);
      }
      return err({
        code: "FILE_NOT_FOUND",
        message: `File not found: ${absPath}`,
        path: absPath,
      });
    },
    parseFn(raw: string, _filePath: string) {
      try {
        // Simple JSON parse for tests (YAML is a superset of JSON)
        const parsed = JSON.parse(raw);
        if (parsed === null || parsed === undefined) {
          return ok({});
        }
        if (typeof parsed !== "object" || Array.isArray(parsed)) {
          return err({
            code: "PARSE_ERROR",
            message: `Expected object, got ${typeof parsed}`,
          });
        }
        return ok(parsed as Record<string, unknown>);
      } catch (e) {
        return err({
          code: "PARSE_ERROR",
          message: `Parse error: ${(e as Error).message}`,
        });
      }
    },
    resolvePath(basePath: string, includePath: string) {
      // Simple path join for tests — in production this uses safePath()
      // Reject traversal attempts in tests too
      if (includePath.includes("..")) {
        return err({
          code: "INCLUDE_ERROR",
          message: `Path traversal blocked: "${includePath}" escapes base "${basePath}"`,
          path: includePath,
        });
      }
      const resolved = basePath + "/" + includePath;
      return ok(resolved);
    },
  };
}

describe("config/include-resolver", () => {
  describe("resolveIncludes", () => {
    it("resolves simple $include and deep-merges included content", () => {
      const deps = createMockDeps({
        "/config/base.json": JSON.stringify({
          logLevel: "debug",
          agents: { default: { name: "BaseBot" } },
        }),
      });

      const obj = {
        $include: "base.json",
        tenantId: "my-tenant",
      };

      const result = resolveIncludes(obj, "/config", deps);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const val = result.value as Record<string, unknown>;
        // Included content is base, sibling keys override
        expect(val.logLevel).toBe("debug");
        expect(val.tenantId).toBe("my-tenant");
        const agents = val.agents as Record<string, Record<string, unknown>>;
        expect(agents.default.name).toBe("BaseBot");
        // $include key should be removed
        expect(val.$include).toBeUndefined();
      }
    });

    it("resolves nested includes (included file includes another file)", () => {
      const deps = createMockDeps({
        "/config/a.json": JSON.stringify({
          $include: "b.json",
          fromA: true,
        }),
        "/config/b.json": JSON.stringify({
          fromB: true,
          shared: "from-b",
        }),
      });

      const obj = {
        $include: "a.json",
        topLevel: "value",
      };

      const result = resolveIncludes(obj, "/config", deps);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const val = result.value as Record<string, unknown>;
        expect(val.fromB).toBe(true);
        expect(val.fromA).toBe(true);
        expect(val.topLevel).toBe("value");
      }
    });

    it("detects circular reference: A includes B includes A", () => {
      const deps = createMockDeps({
        "/config/a.json": JSON.stringify({ $include: "b.json" }),
        "/config/b.json": JSON.stringify({ $include: "a.json" }),
      });

      const obj = { $include: "a.json" };

      const result = resolveIncludes(obj, "/config", deps);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("CIRCULAR_INCLUDE");
        expect(result.error.message).toContain("Circular");
      }
    });

    it("returns INCLUDE_ERROR when depth limit (MAX_INCLUDE_DEPTH = 10) is exceeded", () => {
      // Create a chain of 12 files, each including the next
      const files: Record<string, string> = {};
      for (let i = 0; i < 12; i++) {
        files[`/config/f${i}.json`] = JSON.stringify({
          $include: `f${i + 1}.json`,
          [`key${i}`]: i,
        });
      }
      files["/config/f12.json"] = JSON.stringify({ leaf: true });

      const deps = createMockDeps(files);
      const obj = { $include: "f0.json" };

      const result = resolveIncludes(obj, "/config", deps);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("INCLUDE_ERROR");
        expect(result.error.message).toContain("depth");
      }
    });

    it("rejects include path traversal attempt via resolvePath", () => {
      const deps = createMockDeps({});

      const obj = { $include: "../../../etc/passwd" };

      const result = resolveIncludes(obj, "/config", deps);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("INCLUDE_ERROR");
        expect(result.error.message).toContain("traversal");
      }
    });

    it("returns INCLUDE_ERROR for non-existent included file", () => {
      const deps = createMockDeps({});

      const obj = { $include: "missing.json" };

      const result = resolveIncludes(obj, "/config", deps);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("INCLUDE_ERROR");
        expect(result.error.message).toContain("missing.json");
      }
    });

    it("deep-merges sibling keys alongside $include (siblings override included content)", () => {
      const deps = createMockDeps({
        "/config/base.json": JSON.stringify({
          agents: { default: { name: "Base", model: "gpt-4" } },
          logLevel: "info",
        }),
      });

      const obj = {
        $include: "base.json",
        agents: { default: { name: "Override" } },
      };

      const result = resolveIncludes(obj, "/config", deps);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const val = result.value as Record<string, unknown>;
        const agents = val.agents as Record<string, Record<string, unknown>>;
        // Sibling overrides included
        expect(agents.default.name).toBe("Override");
        // Included fields preserved where not overridden
        expect(agents.default.model).toBe("gpt-4");
        expect(val.logLevel).toBe("info");
      }
    });

    it("resolves $include at nested object levels (not just top-level)", () => {
      const deps = createMockDeps({
        "/config/memory-defaults.json": JSON.stringify({
          walMode: true,
          compaction: { enabled: true, threshold: 500 },
        }),
      });

      const obj = {
        tenantId: "test",
        memory: {
          $include: "memory-defaults.json",
          dbPath: "/custom/path.db",
        },
      };

      const result = resolveIncludes(obj, "/config", deps);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const val = result.value as Record<string, unknown>;
        expect(val.tenantId).toBe("test");
        const memory = val.memory as Record<string, unknown>;
        expect(memory.walMode).toBe(true);
        expect(memory.dbPath).toBe("/custom/path.db");
        const compaction = memory.compaction as Record<string, unknown>;
        expect(compaction.enabled).toBe(true);
        expect(compaction.threshold).toBe(500);
      }
    });

    it("resolves multiple $include directives across different nested paths", () => {
      const deps = createMockDeps({
        "/config/agent-defaults.json": JSON.stringify({
          name: "DefaultAgent",
          model: "gpt-4",
        }),
        "/config/memory-defaults.json": JSON.stringify({
          walMode: true,
          embeddingModel: "text-embedding-3-small",
        }),
      });

      const obj = {
        tenantId: "multi",
        agents: {
          default: {
            $include: "agent-defaults.json",
            maxSteps: 25,
          },
        },
        memory: {
          $include: "memory-defaults.json",
          dbPath: "/var/db.sqlite",
        },
      };

      const result = resolveIncludes(obj, "/config", deps);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const val = result.value as Record<string, unknown>;
        expect(val.tenantId).toBe("multi");

        const agents = val.agents as Record<string, Record<string, unknown>>;
        expect(agents.default.name).toBe("DefaultAgent");
        expect(agents.default.model).toBe("gpt-4");
        expect(agents.default.maxSteps).toBe(25);

        const memory = val.memory as Record<string, unknown>;
        expect(memory.walMode).toBe(true);
        expect(memory.embeddingModel).toBe("text-embedding-3-small");
        expect(memory.dbPath).toBe("/var/db.sqlite");
      }
    });

    it("passes through non-object values unchanged", () => {
      const deps = createMockDeps({});

      // Primitives and arrays should pass through
      const result1 = resolveIncludes("hello", "/config", deps);
      expect(result1.ok).toBe(true);
      if (result1.ok) {
        expect(result1.value).toBe("hello");
      }

      const result2 = resolveIncludes(42, "/config", deps);
      expect(result2.ok).toBe(true);
      if (result2.ok) {
        expect(result2.value).toBe(42);
      }

      const result3 = resolveIncludes([1, 2, 3], "/config", deps);
      expect(result3.ok).toBe(true);
      if (result3.ok) {
        expect(result3.value).toEqual([1, 2, 3]);
      }
    });

    it("resolves $include in array elements that are objects", () => {
      const deps = createMockDeps({
        "/config/item.json": JSON.stringify({
          name: "from-include",
          value: 42,
        }),
      });

      const obj = {
        items: [
          { $include: "item.json", extra: "data" },
          { plain: "object" },
        ],
      };

      const result = resolveIncludes(obj, "/config", deps);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const val = result.value as Record<string, unknown>;
        const items = val.items as Record<string, unknown>[];
        expect(items[0].name).toBe("from-include");
        expect(items[0].value).toBe(42);
        expect(items[0].extra).toBe("data");
        expect(items[1].plain).toBe("object");
      }
    });
  });
});
