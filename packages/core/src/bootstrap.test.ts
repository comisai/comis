// SPDX-License-Identifier: Apache-2.0
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import type { AppContainer } from "./bootstrap.js";
import { bootstrap } from "./bootstrap.js";

describe("bootstrap", () => {
  const tmpDirs: string[] = [];
  const containers: AppContainer[] = [];

  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "comis-bootstrap-"));
    tmpDirs.push(dir);
    return dir;
  }

  function writeYaml(dir: string, name: string, content: string): string {
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, content, "utf-8");
    return filePath;
  }

  afterEach(async () => {
    for (const container of containers) {
      await container.shutdown();
    }
    containers.length = 0;
    for (const dir of tmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  it("returns ok with AppContainer for valid config", () => {
    const dir = makeTmpDir();
    const configPath = writeYaml(dir, "config.yaml", "tenantId: test\nlogLevel: debug\n");

    const result = bootstrap({
      configPaths: [configPath],
      env: { API_KEY: "secret123" },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      containers.push(result.value);
      expect(result.value.config).toBeDefined();
      expect(result.value.config.tenantId).toBe("test");
      expect(result.value.config.logLevel).toBe("debug");
    }
  });

  it("returns err for invalid config", () => {
    const dir = makeTmpDir();
    const configPath = writeYaml(dir, "bad.yaml", "logLevel: invalid_level\n");

    const result = bootstrap({
      configPaths: [configPath],
      env: {},
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
    }
  });

  it("returns err for missing config file", () => {
    const result = bootstrap({
      configPaths: ["/does/not/exist.yaml"],
      env: {},
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("FILE_NOT_FOUND");
    }
  });

  it("container.config returns loaded config", () => {
    const dir = makeTmpDir();
    const configPath = writeYaml(dir, "config.yaml", "tenantId: my-tenant\n");

    const result = bootstrap({ configPaths: [configPath], env: {} });
    expect(result.ok).toBe(true);
    if (result.ok) {
      containers.push(result.value);
      expect(result.value.config.tenantId).toBe("my-tenant");
      expect(result.value.config.agents.default.name).toBe("Comis");
    }
  });

  it("container.eventBus is a TypedEventBus", () => {
    const dir = makeTmpDir();
    const configPath = writeYaml(dir, "config.yaml", "tenantId: evtest\n");

    const result = bootstrap({ configPaths: [configPath], env: {} });
    expect(result.ok).toBe(true);
    if (result.ok) {
      containers.push(result.value);
      // Verify it has TypedEventBus methods
      expect(typeof result.value.eventBus.on).toBe("function");
      expect(typeof result.value.eventBus.emit).toBe("function");
      expect(typeof result.value.eventBus.off).toBe("function");
    }
  });

  it("container.secretManager works with provided env", () => {
    const dir = makeTmpDir();
    const configPath = writeYaml(dir, "config.yaml", "tenantId: sectest\n");

    const result = bootstrap({
      configPaths: [configPath],
      env: { MY_SECRET: "s3cr3t", OTHER: "val" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      containers.push(result.value);
      expect(result.value.secretManager.get("MY_SECRET")).toBe("s3cr3t");
      expect(result.value.secretManager.has("OTHER")).toBe(true);
      expect(result.value.secretManager.get("MISSING")).toBeUndefined();
    }
  });

  it("container.shutdown cleans up without errors", async () => {
    const dir = makeTmpDir();
    const configPath = writeYaml(dir, "config.yaml", "tenantId: shuttest\n");

    const result = bootstrap({
      configPaths: [configPath],
      env: {},
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Shutdown should not throw
      await expect(result.value.shutdown()).resolves.toBeUndefined();
      // Double shutdown should also be safe
      await expect(result.value.shutdown()).resolves.toBeUndefined();
    }
  });

  it("applies defaults from minimal config content", () => {
    const dir = makeTmpDir();
    // Minimal config: empty object
    const configPath = writeYaml(dir, "minimal.yaml", "{}\n");

    const result = bootstrap({ configPaths: [configPath], env: {} });
    expect(result.ok).toBe(true);
    if (result.ok) {
      containers.push(result.value);
      const cfg = result.value.config;
      expect(cfg.tenantId).toBe("default");
      expect(cfg.logLevel).toBe("info");
      expect(cfg.dataDir).toBe(path.join(os.homedir(), ".comis"));
      expect(cfg.agents.default.name).toBe("Comis");
      expect(cfg.agents.default.maxSteps).toBe(150);
      expect(cfg.memory.walMode).toBe(true);
      expect(cfg.security.logRedaction).toBe(true);
    }
  });

  it("merges layered config files", () => {
    const dir = makeTmpDir();
    const base = writeYaml(dir, "base.yaml", "tenantId: base\nagents:\n  default:\n    name: BaseBot\n");
    const local = writeYaml(dir, "local.yaml", "tenantId: local\n");

    const result = bootstrap({ configPaths: [base, local], env: {} });
    expect(result.ok).toBe(true);
    if (result.ok) {
      containers.push(result.value);
      expect(result.value.config.tenantId).toBe("local");
      expect(result.value.config.agents.default.name).toBe("BaseBot");
    }
  });
});
