// SPDX-License-Identifier: Apache-2.0
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import type { AppContainer } from "./bootstrap.js";
import { bootstrap, INTERACTIVE_CALLBACK_SIGNING_SECRET_NAME } from "./bootstrap.js";
import { err } from "@comis/shared";
import type { WorkspacePolicyPort } from "./ports/workspace-policy.js";

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

  it("wires the workspace policy adapter factory into the application container", () => {
    const dir = makeTmpDir();
    const configPath = writeYaml(dir, "config.yaml", "tenantId: policy-test\n");
    const workspacePolicyPort: WorkspacePolicyPort = {
      load: async (agentId) => err({ kind: "agent_not_found", agentId }),
      get: (policyHash) => err({ kind: "snapshot_not_found", policyHash }),
    };

    const result = bootstrap({
      configPaths: [configPath],
      env: {},
      workspacePolicyPortFactory: () => workspacePolicyPort,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      containers.push(result.value);
      expect(result.value.workspacePolicyPort).toBe(workspacePolicyPort);
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

  it("preserves validated rerank modes in container config", () => {
    const dir = makeTmpDir();
    const configPath = writeYaml(
      dir,
      "config.yaml",
      [
        "tenantId: rerank-test",
        "agents:",
        "  unsetAgent:",
        "    name: Unset",
        "  onAgent:",
        "    name: On",
        "    rag:",
        "      rerank:",
        "        mode: on",
        "  offAgent:",
        "    name: Off",
        "    rag:",
        "      rerank:",
        "        mode: off",
        "",
      ].join("\n"),
    );

    const result = bootstrap({ configPaths: [configPath], env: {} });
    expect(result.ok).toBe(true);
    if (result.ok) {
      containers.push(result.value);
      expect(result.value.config.agents.unsetAgent!.rag.rerank.mode).toBe("auto");
      expect(result.value.config.agents.onAgent!.rag.rerank.mode).toBe("on");
      expect(result.value.config.agents.offAgent!.rag.rerank.mode).toBe("off");
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
      expect(cfg.logLevel).toBe("debug");
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

  it("includes the interactive-callback signing secret name on the platformSecretNames deny surface", () => {
    const dir = makeTmpDir();
    const configPath = writeYaml(dir, "config.yaml", "tenantId: test\n");

    const result = bootstrap({ configPaths: [configPath], env: {} });
    expect(result.ok).toBe(true);
    if (result.ok) {
      containers.push(result.value);
      // The signing secret backs every signed channel; it must never resolve
      // through user-facing secret-ref tools, so its name is on the deny surface
      // unconditionally (even when no config `${VAR}` references it).
      expect(
        result.value.platformSecretNames.has(INTERACTIVE_CALLBACK_SIGNING_SECRET_NAME),
      ).toBe(true);
      expect(INTERACTIVE_CALLBACK_SIGNING_SECRET_NAME).toBe(
        "activity.interactiveCallbackSigningSecret",
      );
    }
  });

  it("includes custom provider apiKeyName values on the platform secret deny surface", () => {
    const dir = makeTmpDir();
    const configPath = writeYaml(
      dir,
      "config.yaml",
      [
        "providers:",
        "  entries:",
        "    private-gateway:",
        "      type: openai",
        "      apiKeyName: PRIVATE_GATEWAY_API_KEY",
        "",
      ].join("\n"),
    );

    const result = bootstrap({
      configPaths: [configPath],
      env: { PRIVATE_GATEWAY_API_KEY: "test-key" },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      containers.push(result.value);
      expect(result.value.platformSecretNames.has("PRIVATE_GATEWAY_API_KEY")).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// resolveConfigPaths must honor COMIS_DATA_DIR.
// daemon.ts resolves the BOOT data dir as env.COMIS_DATA_DIR ?? ~/.comis
// (so .env loading, secrets.db, the data-dir singleton lock all honor the env
// var). If resolveConfigPaths defaulted an empty config.dataDir straight to
// ~/.comis instead, the system would split-brain: config-derived paths
// (memory.dbPath, workspace, sessions) land in the PRODUCTION ~/.comis while
// boot paths use the override — e.g. a test daemon with an isolated temp
// COMIS_DATA_DIR opening ~/.comis/test-memory-default.db. Precedence (matches
// the CLI and daemon boot): explicit config.dataDir > env COMIS_DATA_DIR >
// ~/.comis.
// ---------------------------------------------------------------------------

describe("bootstrap — dataDir honors COMIS_DATA_DIR (explicit config > env > ~/.comis)", () => {
  const tmpDirs: string[] = [];
  const containers: AppContainer[] = [];

  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "comis-bootstrap-dd-"));
    tmpDirs.push(dir);
    return dir;
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

  it("empty config.dataDir + env COMIS_DATA_DIR → dataDir and memory.dbPath under the env dir", () => {
    const dir = makeTmpDir();
    const envDataDir = makeTmpDir();
    const configPath = path.join(dir, "config.yaml");
    fs.writeFileSync(configPath, 'tenantId: test\ndataDir: ""\n', "utf-8");

    const result = bootstrap({
      configPaths: [configPath],
      env: { COMIS_DATA_DIR: envDataDir },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      containers.push(result.value);
      expect(result.value.config.dataDir).toBe(envDataDir);
      expect(result.value.config.memory.dbPath).toBe(path.join(envDataDir, "memory.db"));
    }
  });

  it("explicit config.dataDir WINS over env COMIS_DATA_DIR", () => {
    const dir = makeTmpDir();
    const cfgDataDir = makeTmpDir();
    const envDataDir = makeTmpDir();
    const configPath = path.join(dir, "config.yaml");
    fs.writeFileSync(configPath, `tenantId: test\ndataDir: "${cfgDataDir}"\n`, "utf-8");

    const result = bootstrap({
      configPaths: [configPath],
      env: { COMIS_DATA_DIR: envDataDir },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      containers.push(result.value);
      expect(result.value.config.dataDir).toBe(cfgDataDir);
      expect(result.value.config.memory.dbPath).toBe(path.join(cfgDataDir, "memory.db"));
    }
  });

  it("no config.dataDir and no env override → ~/.comis default (existing contract)", () => {
    const dir = makeTmpDir();
    const configPath = path.join(dir, "config.yaml");
    fs.writeFileSync(configPath, "tenantId: test\n", "utf-8");

    const result = bootstrap({
      configPaths: [configPath],
      env: {},
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      containers.push(result.value);
      expect(result.value.config.dataDir).toBe(path.join(os.homedir(), ".comis"));
    }
  });
});
