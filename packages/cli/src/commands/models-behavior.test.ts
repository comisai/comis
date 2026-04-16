/**
 * Model command behavior tests.
 *
 * Tests model command behaviors: models list displays from daemon RPC with
 * fallback to local catalog, provider filtering, JSON output, empty catalog
 * messages; models set validates model, modifies YAML config, and handles
 * missing config/agent errors.
 *
 * @module
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { createMockRpcClient } from "../mock-rpc-client.js";
import {
  createTestProgram,
  createConsoleSpy,
  createProcessExitSpy,
  getSpyOutput,
} from "../test-helpers.js";

// Mock withClient from rpc-client at module level for ESM hoisting
vi.mock("../client/rpc-client.js", () => ({
  withClient: vi.fn(),
}));

// Mock withSpinner to pass-through (no actual ora spinner in tests)
vi.mock("../output/spinner.js", () => ({
  withSpinner: vi.fn(async (_text: string, fn: () => Promise<unknown>) => fn()),
}));

// Mock @comis/agent for createModelCatalog used in list fallback and set validation
vi.mock("@comis/agent", () => {
  const mockCatalog = {
    loadStatic: vi.fn(),
    getAll: vi.fn(() => []),
    getByProvider: vi.fn(() => []),
  };
  return {
    createModelCatalog: vi.fn(() => mockCatalog),
  };
});

// Mock node:fs for set command tests (read/write config)
vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  accessSync: vi.fn(),
  mkdirSync: vi.fn(),
  constants: { R_OK: 4 },
}));

// Dynamic imports after mocks
const { registerModelsCommand } = await import("./models.js");
const { withClient } = await import("../client/rpc-client.js");
const { createModelCatalog } = await import("@comis/agent");
const fs = await import("node:fs");

/** Sample model data reused across tests. */
const SAMPLE_MODELS = [
  {
    provider: "anthropic",
    modelId: "claude-sonnet-4-5-20250929",
    displayName: "Claude Sonnet",
    contextWindow: 200000,
    maxTokens: 8192,
    input: ["text", "image"],
    reasoning: false,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    validated: false,
    validatedAt: 0,
  },
  {
    provider: "anthropic",
    modelId: "claude-haiku-35",
    displayName: "Claude Haiku",
    contextWindow: 200000,
    maxTokens: 8192,
    input: ["text", "image"],
    reasoning: false,
    cost: { input: 0.25, output: 1.25, cacheRead: 0.03, cacheWrite: 0.3 },
    validated: false,
    validatedAt: 0,
  },
  {
    provider: "openai",
    modelId: "gpt-4o",
    displayName: "GPT-4o",
    contextWindow: 128000,
    maxTokens: 16384,
    input: ["text", "image"],
    reasoning: false,
    cost: { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 0 },
    validated: false,
    validatedAt: 0,
  },
];

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------

describe("models list displays models from daemon via RPC", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    vi.mocked(withClient).mockImplementation(async (fn) => {
      const mockClient = createMockRpcClient()
        .onCall("models.list", SAMPLE_MODELS)
        .build();
      return fn(mockClient);
    });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("renders table with provider, model, context window, and cost columns", async () => {
    const program = createTestProgram();
    registerModelsCommand(program);

    await program.parseAsync(["node", "test", "models", "list"]);

    const output = getSpyOutput(consoleSpy.log);

    // Table headers
    expect(output).toContain("Provider");
    expect(output).toContain("Model");
    expect(output).toContain("Context Window");
    expect(output).toContain("Input Cost");
    expect(output).toContain("Output Cost");

    // Model data
    expect(output).toContain("anthropic");
    expect(output).toContain("claude-sonnet-4-5-20250929");
    expect(output).toContain("200k");
    expect(output).toContain("openai");
    expect(output).toContain("gpt-4o");
    expect(output).toContain("128k");

    // Cost formatting
    expect(output).toContain("$3.00");
    expect(output).toContain("$15.00");
  });

  it("shows model count info message after table", async () => {
    const program = createTestProgram();
    registerModelsCommand(program);

    await program.parseAsync(["node", "test", "models", "list"]);

    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("3 models listed");
  });
});

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------

describe("models list falls back to local catalog when daemon offline", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    // Daemon offline -- withClient rejects
    vi.mocked(withClient).mockRejectedValue(new Error("Connection refused"));

    // Configure local catalog fallback
    const catalog = vi.mocked(createModelCatalog)();
    vi.mocked(catalog.getAll).mockReturnValue(SAMPLE_MODELS as never);
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("displays models from local catalog when daemon is not running", async () => {
    const program = createTestProgram();
    registerModelsCommand(program);

    await program.parseAsync(["node", "test", "models", "list"]);

    const output = getSpyOutput(consoleSpy.log);

    // Catalog fallback should still display model data
    expect(output).toContain("anthropic");
    expect(output).toContain("claude-sonnet-4-5-20250929");
    expect(output).toContain("openai");
    expect(output).toContain("gpt-4o");

    // createModelCatalog should have been called for fallback
    expect(createModelCatalog).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------

describe("models list --provider filters by provider", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    const anthropicModels = SAMPLE_MODELS.filter((m) => m.provider === "anthropic");

    vi.mocked(withClient).mockImplementation(async (fn) => {
      const mockClient = createMockRpcClient()
        .onCall("models.list", anthropicModels)
        .build();
      return fn(mockClient);
    });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("passes provider param to RPC and shows only matching models", async () => {
    const program = createTestProgram();
    registerModelsCommand(program);

    await program.parseAsync(["node", "test", "models", "list", "--provider", "anthropic"]);

    const output = getSpyOutput(consoleSpy.log);

    // Should contain anthropic models
    expect(output).toContain("anthropic");
    expect(output).toContain("claude-sonnet-4-5-20250929");
    expect(output).toContain("claude-haiku-35");

    // withClient was called (RPC path)
    expect(vi.mocked(withClient)).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------

describe("models list --format json outputs valid JSON", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    vi.mocked(withClient).mockImplementation(async (fn) => {
      const mockClient = createMockRpcClient()
        .onCall("models.list", SAMPLE_MODELS)
        .build();
      return fn(mockClient);
    });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("outputs a valid JSON array of model entries", async () => {
    const program = createTestProgram();
    registerModelsCommand(program);

    await program.parseAsync(["node", "test", "models", "list", "--format", "json"]);

    const output = getSpyOutput(consoleSpy.log);
    const parsed = JSON.parse(output) as Array<{
      provider: string;
      modelId: string;
      contextWindow: number;
      cost: { input: number; output: number };
    }>;

    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(3);
    expect(parsed[0]!.provider).toBe("anthropic");
    expect(parsed[0]!.modelId).toBe("claude-sonnet-4-5-20250929");
    expect(parsed[0]!.contextWindow).toBe(200000);
    expect(parsed[0]!.cost.input).toBe(3);
    expect(parsed[0]!.cost.output).toBe(15);
    expect(parsed[2]!.provider).toBe("openai");
    expect(parsed[2]!.modelId).toBe("gpt-4o");
  });
});

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------

describe("models list shows info when no models found", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    // Return empty array from RPC
    vi.mocked(withClient).mockImplementation(async (fn) => {
      const mockClient = createMockRpcClient()
        .onCall("models.list", [])
        .build();
      return fn(mockClient);
    });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("shows 'No models found' when catalog is empty", async () => {
    const program = createTestProgram();
    registerModelsCommand(program);

    await program.parseAsync(["node", "test", "models", "list"]);

    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("No models found");
  });

  it("shows provider name in message when --provider filter yields no results", async () => {
    const program = createTestProgram();
    registerModelsCommand(program);

    await program.parseAsync(["node", "test", "models", "list", "--provider", "google"]);

    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("google");
    expect(output).toContain("No models found");
  });
});

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------

/** Sample YAML config with an agents section. */
const SAMPLE_CONFIG_YAML = `agents:
  assistant:
    defaultModel: openai/gpt-4o
    defaultProvider: openai
`;

describe("models set validates model exists in catalog", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    vi.mocked(fs.readFileSync).mockReset();
    vi.mocked(fs.writeFileSync).mockReset();
    vi.mocked(fs.accessSync).mockReset();
    vi.mocked(fs.mkdirSync).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    // Configure catalog to return sample models
    const catalog = vi.mocked(createModelCatalog)();
    vi.mocked(catalog.getAll).mockReturnValue(SAMPLE_MODELS as never);

    // Config file exists at default path
    vi.mocked(fs.accessSync).mockImplementation(() => {});
    vi.mocked(fs.readFileSync).mockReturnValue(SAMPLE_CONFIG_YAML as never);
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("updates config YAML when model is found in catalog", async () => {
    const program = createTestProgram();
    registerModelsCommand(program);

    await program.parseAsync(["node", "test", "models", "set", "assistant", "claude-sonnet-4-5-20250929"]);

    // writeFileSync should have been called with updated YAML
    expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalled();

    const writtenYaml = vi.mocked(fs.writeFileSync).mock.calls[0]![1] as string;
    expect(writtenYaml).toContain("anthropic/claude-sonnet-4-5-20250929");

    // Output should contain success message
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("Model updated");
    expect(output).toContain("assistant");
  });
});

describe("models set exits with error for unknown model", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    // Catalog returns sample models (which do NOT include 'nonexistent-model')
    const catalog = vi.mocked(createModelCatalog)();
    vi.mocked(catalog.getAll).mockReturnValue(SAMPLE_MODELS as never);
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("exits with code 1 and 'not found in catalog' message", async () => {
    const program = createTestProgram();
    registerModelsCommand(program);

    try {
      await program.parseAsync(["node", "test", "models", "set", "assistant", "nonexistent-model"]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(1);

    const errOutput = getSpyOutput(consoleSpy.error);
    expect(errOutput).toContain("not found in catalog");

    const logOutput = getSpyOutput(consoleSpy.log);
    expect(logOutput).toContain("comis models list");
  });
});

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------

describe("models set modifies config YAML preserving formatting", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    vi.mocked(fs.readFileSync).mockReset();
    vi.mocked(fs.writeFileSync).mockReset();
    vi.mocked(fs.accessSync).mockReset();
    vi.mocked(fs.mkdirSync).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    // Configure catalog
    const catalog = vi.mocked(createModelCatalog)();
    vi.mocked(catalog.getAll).mockReturnValue(SAMPLE_MODELS as never);

    // Config file exists
    vi.mocked(fs.accessSync).mockImplementation(() => {});
    vi.mocked(fs.readFileSync).mockReturnValue(SAMPLE_CONFIG_YAML as never);
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("writes updated YAML with new model value and shows old -> new transition", async () => {
    const program = createTestProgram();
    registerModelsCommand(program);

    await program.parseAsync(["node", "test", "models", "set", "assistant", "claude-sonnet-4-5-20250929"]);

    // Verify writeFileSync was called
    expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalled();

    // Capture written YAML and verify new model value
    const writtenYaml = vi.mocked(fs.writeFileSync).mock.calls[0]![1] as string;
    expect(writtenYaml).toContain("anthropic/claude-sonnet-4-5-20250929");

    // Output should show old -> new transition
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("openai/gpt-4o");
    expect(output).toContain("->");
    expect(output).toContain("anthropic/claude-sonnet-4-5-20250929");
  });
});

describe("models set exits when no config file found", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    vi.mocked(fs.accessSync).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    // Catalog returns models so validation passes
    const catalog = vi.mocked(createModelCatalog)();
    vi.mocked(catalog.getAll).mockReturnValue(SAMPLE_MODELS as never);

    // No config file exists -- accessSync throws for all paths
    vi.mocked(fs.accessSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("exits with code 1 and 'No config file found' message", async () => {
    const program = createTestProgram();
    registerModelsCommand(program);

    try {
      await program.parseAsync(["node", "test", "models", "set", "assistant", "gpt-4o"]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(1);

    const errOutput = getSpyOutput(consoleSpy.error);
    expect(errOutput).toContain("No config file found");
  });
});

describe("models set exits when agent not in config", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    vi.mocked(fs.readFileSync).mockReset();
    vi.mocked(fs.writeFileSync).mockReset();
    vi.mocked(fs.accessSync).mockReset();
    vi.mocked(fs.mkdirSync).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    // Catalog returns models
    const catalog = vi.mocked(createModelCatalog)();
    vi.mocked(catalog.getAll).mockReturnValue(SAMPLE_MODELS as never);

    // Config file exists with only 'assistant' agent (not 'unknown-agent')
    vi.mocked(fs.accessSync).mockImplementation(() => {});
    vi.mocked(fs.readFileSync).mockReturnValue(SAMPLE_CONFIG_YAML as never);
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("exits with code 1, shows 'not found in config' and lists available agents", async () => {
    const program = createTestProgram();
    registerModelsCommand(program);

    try {
      await program.parseAsync(["node", "test", "models", "set", "unknown-agent", "gpt-4o"]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(1);

    const errOutput = getSpyOutput(consoleSpy.error);
    expect(errOutput).toContain("not found in config");

    const logOutput = getSpyOutput(consoleSpy.log);
    expect(logOutput).toContain("Available agents");
    expect(logOutput).toContain("assistant");
  });
});
