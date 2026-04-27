// SPDX-License-Identifier: Apache-2.0
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { deepMerge, mergeLayered, loadLayered } from "./layered.js";

describe("config/layered", () => {
  const tmpDirs: string[] = [];

  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "comis-layered-"));
    tmpDirs.push(dir);
    return dir;
  }

  function writeYaml(dir: string, name: string, content: string): string {
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, content, "utf-8");
    return filePath;
  }

  afterEach(() => {
    for (const dir of tmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  describe("deepMerge", () => {
    it("merges flat objects", () => {
      const result = deepMerge({ a: 1, b: 2 }, { b: 3, c: 4 });
      expect(result).toEqual({ a: 1, b: 3, c: 4 });
    });

    it("deep merges nested objects", () => {
      const result = deepMerge(
        { agent: { name: "Bot", maxSteps: 10 } },
        { agent: { maxSteps: 20 } },
      );
      expect(result).toEqual({ agent: { name: "Bot", maxSteps: 20 } });
    });

    it("replaces arrays entirely (no concatenation)", () => {
      const result = deepMerge(
        { security: { permission: { allowedFsPaths: ["/a", "/b"] } } },
        { security: { permission: { allowedFsPaths: ["/c"] } } },
      );
      expect(
        ((result.security as Record<string, unknown>).permission as Record<string, unknown>)
          .allowedFsPaths,
      ).toEqual(["/c"]);
    });

    it("ignores undefined values in override", () => {
      const result = deepMerge({ a: 1, b: 2 }, { a: undefined, b: 3 });
      expect(result).toEqual({ a: 1, b: 3 });
    });

    it("overrides primitives", () => {
      const result = deepMerge({ logLevel: "info" }, { logLevel: "debug" });
      expect(result).toEqual({ logLevel: "debug" });
    });

    describe("prototype pollution defense", () => {
      it("skips __proto__ keys", () => {
        const base = { a: 1 };
        const override = JSON.parse('{"__proto__": {"polluted": true}, "b": 2}');
        const result = deepMerge(base, override);
        expect(result).toEqual({ a: 1, b: 2 });
        expect((result as any).__proto__).toBe(Object.prototype);
        expect((Object.prototype as any).polluted).toBeUndefined();
      });

      it("skips constructor keys", () => {
        const base = { a: 1 };
        const override = JSON.parse('{"constructor": {"polluted": true}, "b": 2}');
        const result = deepMerge(base, override);
        expect(result).toEqual({ a: 1, b: 2 });
        expect(result.constructor).toBe(Object);
      });

      it("skips prototype keys", () => {
        const base = { a: 1 };
        const override = JSON.parse('{"prototype": {"polluted": true}, "b": 2}');
        const result = deepMerge(base, override);
        expect(result).toEqual({ a: 1, b: 2 });
      });

      it("skips proto keys in nested objects (recursive defense)", () => {
        const base = { nested: { a: 1 } };
        const override = JSON.parse('{"nested": {"__proto__": {"polluted": true}, "b": 2}}');
        const result = deepMerge(base, override);
        expect(result).toEqual({ nested: { a: 1, b: 2 } });
        expect((Object.prototype as any).polluted).toBeUndefined();
      });

      it("filters all three proto keys simultaneously", () => {
        const base = {};
        const override = JSON.parse('{"__proto__": {}, "constructor": {}, "prototype": {}, "safe": 1}');
        const result = deepMerge(base, override);
        expect(Object.keys(result)).toEqual(["safe"]);
        expect(result).toEqual({ safe: 1 });
      });
    });
  });

  describe("mergeLayered", () => {
    it("returns defaults for empty layers", () => {
      const result = mergeLayered([]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.tenantId).toBe("default");
        expect(result.value.logLevel).toBe("info");
      }
    });

    it("validates and returns single layer", () => {
      const result = mergeLayered([{ tenantId: "single" }]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.tenantId).toBe("single");
      }
    });

    it("later layers override earlier layers", () => {
      const result = mergeLayered([
        { tenantId: "first", logLevel: "info" },
        { tenantId: "second" },
      ]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.tenantId).toBe("second");
        expect(result.value.logLevel).toBe("info");
      }
    });

    it("deep merges nested sections across layers", () => {
      const result = mergeLayered([
        { agents: { default: { name: "Base", maxSteps: 10 } } },
        { agents: { default: { maxSteps: 50 } } },
      ]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.agents.default.name).toBe("Base");
        expect(result.value.agents.default.maxSteps).toBe(50);
      }
    });

    it("replaces arrays from later layers", () => {
      const result = mergeLayered([
        { channels: { telegram: { allowFrom: ["user1", "user2"] } } },
        { channels: { telegram: { allowFrom: ["admin"] } } },
      ]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.channels.telegram.allowFrom).toEqual(["admin"]);
      }
    });

    it("returns validation error for invalid merged config", () => {
      const result = mergeLayered([{ logLevel: "invalid" }]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("VALIDATION_ERROR");
      }
    });

    it("migrates legacy streaming keys before validation", () => {
      const result = mergeLayered([{
        streaming: {
          perChannel: {
            test: {
              pacingMinMs: 100,
              pacingMaxMs: 200,
              coalesceMaxChars: 400,
            },
          },
        },
      }]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const testChannel = result.value.streaming.perChannel.test;
        expect(testChannel).toBeDefined();
        // New nested structure should be present
        expect(testChannel.deliveryTiming.minMs).toBe(100);
        expect(testChannel.deliveryTiming.maxMs).toBe(200);
        expect(testChannel.coalescer.maxChars).toBe(400);
        // Old flat keys should NOT be present
        expect((testChannel as any).pacingMinMs).toBeUndefined();
        expect((testChannel as any).pacingMaxMs).toBeUndefined();
        expect((testChannel as any).coalesceMaxChars).toBeUndefined();
      }
    });
  });

  describe("loadLayered", () => {
    it("loads and merges multiple config files", () => {
      const dir = makeTmpDir();
      const base = writeYaml(
        dir,
        "base.yaml",
        `
tenantId: base
logLevel: info
agents:
  default:
    name: BaseBot
    maxSteps: 10
`,
      );
      const override = writeYaml(
        dir,
        "override.yaml",
        `
tenantId: production
agents:
  default:
    maxSteps: 50
`,
      );

      const result = loadLayered([base, override]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.tenantId).toBe("production");
        expect(result.value.agents.default.name).toBe("BaseBot");
        expect(result.value.agents.default.maxSteps).toBe(50);
        expect(result.value.logLevel).toBe("info");
      }
    });

    it("returns error if any file is missing", () => {
      const dir = makeTmpDir();
      const existing = writeYaml(dir, "exists.yaml", "tenantId: ok\n");

      const result = loadLayered([existing, "/does/not/exist.yaml"]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("FILE_NOT_FOUND");
      }
    });

    it("loads single file successfully", () => {
      const dir = makeTmpDir();
      const file = writeYaml(dir, "single.yaml", "tenantId: solo\n");

      const result = loadLayered([file]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.tenantId).toBe("solo");
      }
    });

    it("envLayer fills in fields not set by any file (schema default < env)", () => {
      const dir = makeTmpDir();
      const file = writeYaml(dir, "no-gateway.yaml", "tenantId: docker-bare\n");

      const result = loadLayered([file], { envLayer: { gateway: { host: "0.0.0.0" } } });
      expect(result.ok).toBe(true);
      if (result.ok) {
        // No file set gateway.host → env layer wins over schema default 127.0.0.1
        expect(result.value.gateway.host).toBe("0.0.0.0");
      }
    });

    it("config file wins over envLayer (explicit user config never silently broadened)", () => {
      const dir = makeTmpDir();
      const file = writeYaml(
        dir,
        "explicit.yaml",
        `
tenantId: prod
gateway:
  host: 127.0.0.1
`,
      );

      const result = loadLayered([file], { envLayer: { gateway: { host: "0.0.0.0" } } });
      expect(result.ok).toBe(true);
      if (result.ok) {
        // File explicitly pinned 127.0.0.1 — env's 0.0.0.0 must NOT override.
        // This is the security contract: an inherited COMIS_GATEWAY_HOST can
        // never silently broaden a bind the operator pinned in config.yaml.
        expect(result.value.gateway.host).toBe("127.0.0.1");
      }
    });

    it("empty envLayer is ignored (no spurious layer pushed)", () => {
      const dir = makeTmpDir();
      const file = writeYaml(dir, "single.yaml", "tenantId: solo\n");

      const result = loadLayered([file], { envLayer: {} });
      expect(result.ok).toBe(true);
      if (result.ok) {
        // Schema default still wins when neither env nor file sets it.
        expect(result.value.gateway.host).toBe("127.0.0.1");
      }
    });
  });
});
