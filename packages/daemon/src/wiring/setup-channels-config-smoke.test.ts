import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { loadConfigFile, validateConfig } from "@comis/core";

describe("daemon config parse smoke test", () => {
  const tmpDirs: string[] = [];

  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "comis-516-smoke-"));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  it("parses config with enforceFinalTag, fastMode, storeCompletions on agent", () => {
    const dir = makeTmpDir();
    const filePath = path.join(dir, "config.yaml");
    fs.writeFileSync(filePath, `
tenantId: smoke-test
agents:
  default:
    name: SmokeBot
    maxSteps: 5
    enforceFinalTag: true
    fastMode: true
    storeCompletions: false
`, "utf-8");

    const loaded = loadConfigFile(filePath);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const validated = validateConfig(loaded.value);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    const agentConfig = validated.value.agents.default;
    expect(agentConfig.enforceFinalTag).toBe(true);
    expect(agentConfig.fastMode).toBe(true);
    expect(agentConfig.storeCompletions).toBe(false);
  });

  it("defaults enforceFinalTag/fastMode/storeCompletions to false when omitted", () => {
    const dir = makeTmpDir();
    const filePath = path.join(dir, "config.yaml");
    fs.writeFileSync(filePath, `
tenantId: smoke-defaults
agents:
  default:
    name: DefaultBot
    maxSteps: 5
`, "utf-8");

    const loaded = loadConfigFile(filePath);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const validated = validateConfig(loaded.value);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    const agentConfig = validated.value.agents.default;
    expect(agentConfig.enforceFinalTag).toBe(false);
    expect(agentConfig.fastMode).toBe(false);
    expect(agentConfig.storeCompletions).toBe(false);
  });

  it("parses provider capabilities and models from config YAML", () => {
    const dir = makeTmpDir();
    const filePath = path.join(dir, "config.yaml");
    fs.writeFileSync(filePath, `
tenantId: smoke-providers
providers:
  entries:
    deepseek:
      type: openai
      baseUrl: https://api.deepseek.com/v1
      capabilities:
        providerFamily: default
        dropThinkingBlockModelHints:
          - deepseek-r1
        transcriptToolCallIdMode: strict9
      models:
        - id: deepseek-chat
          reasoning: false
          contextWindow: 64000
          comisCompat:
            supportsTools: true
            toolSchemaProfile: default
        - id: deepseek-reasoner
          reasoning: true
          contextWindow: 64000
          comisCompat:
            supportsTools: false
agents:
  default:
    name: SmokeBot
    maxSteps: 5
`, "utf-8");

    const loaded = loadConfigFile(filePath);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const validated = validateConfig(loaded.value);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    const deepseek = validated.value.providers.entries.deepseek;
    expect(deepseek).toBeDefined();
    expect(deepseek.capabilities.providerFamily).toBe("default");
    expect(deepseek.capabilities.dropThinkingBlockModelHints).toEqual(["deepseek-r1"]);
    expect(deepseek.capabilities.transcriptToolCallIdMode).toBe("strict9");
    expect(deepseek.models).toHaveLength(2);
    expect(deepseek.models[0].id).toBe("deepseek-chat");
    expect(deepseek.models[0].comisCompat?.supportsTools).toBe(true);
    expect(deepseek.models[1].comisCompat?.supportsTools).toBe(false);
  });

  it("parses cacheRetention defaulting to 'long'", () => {
    const dir = makeTmpDir();
    const filePath = path.join(dir, "config.yaml");
    fs.writeFileSync(filePath, `
tenantId: smoke-cache
agents:
  default:
    name: CacheBot
    maxSteps: 5
`, "utf-8");

    const loaded = loadConfigFile(filePath);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const validated = validateConfig(loaded.value);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    expect(validated.value.agents.default.cacheRetention).toBe("long");
  });
});
