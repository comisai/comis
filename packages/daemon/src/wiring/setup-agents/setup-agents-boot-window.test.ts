import { describe, it, expect, vi, beforeEach } from "vitest";
import { runBootWindowHonestyChecks } from "./setup-agents-boot-window.js";

vi.mock("@comis/agent", () => ({
  compareServedWindowForProvider: vi.fn(),
  collectAgentBootWindowInfo: vi.fn(),
}));

import { compareServedWindowForProvider, collectAgentBootWindowInfo } from "@comis/agent";

const mockedCompare = vi.mocked(compareServedWindowForProvider);
const mockedCollect = vi.mocked(collectAgentBootWindowInfo);

function makeParams(overrides: Record<string, unknown> = {}) {
  const warn = vi.fn();
  const servedWindowComparisons = new Map();
  const agentBootWindowInfo = new Map();
  return {
    warn,
    servedWindowComparisons,
    agentBootWindowInfo,
    params: {
      agentId: "main",
      providerId: "my-ollama",
      modelId: "qwen3:8b",
      container: { config: { providers: { entries: { "my-ollama": { capabilities: { capabilityClass: "small" } } } } } },
      deps: {
        servedWindowByProvider: new Map([["my-ollama", 8192]]),
        servedWindowComparisons,
        agentBootWindowInfo,
      },
      piModelRegistry: { find: vi.fn().mockReturnValue({ contextWindow: 131072 }) },
      providerAliases: new Map<string, string>(),
      agentLogger: { warn },
      effectiveConfig: { model: "qwen3:8b", provider: "my-ollama" },
      convertTools: vi.fn(),
      ...overrides,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  };
}

describe("runBootWindowHonestyChecks (setup-agents-runtime extraction)", () => {
  beforeEach(() => {
    mockedCompare.mockReset();
    mockedCollect.mockReset();
  });

  it("stores the comparison result and boot-window info into the deps maps", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedCompare.mockReturnValue({ providerId: "my-ollama", served: 8192, configured: 131072 } as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedCollect.mockReturnValue({ agentId: "main" } as any);
    const { params, servedWindowComparisons, agentBootWindowInfo } = makeParams();

    runBootWindowHonestyChecks(params);

    expect(servedWindowComparisons.get("my-ollama")).toMatchObject({ served: 8192 });
    expect(agentBootWindowInfo.get("main")).toMatchObject({ agentId: "main" });
    // Corpus pin: the SAME convertTools reference flows into the collector
    expect(mockedCollect).toHaveBeenCalledWith(
      expect.objectContaining({ convertTools: params.convertTools }),
    );
  });

  it("does not store a comparison when the comparator returns undefined (healthy/absent boot)", () => {
    mockedCompare.mockReturnValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedCollect.mockReturnValue({ agentId: "main" } as any);
    const { params, servedWindowComparisons } = makeParams();

    runBootWindowHonestyChecks(params);

    expect(servedWindowComparisons.size).toBe(0);
  });

  it("fails open: a throwing collector is WARN-logged with hint + errorKind and never throws", () => {
    mockedCompare.mockReturnValue(undefined);
    mockedCollect.mockImplementation(() => {
      throw new Error("boom");
    });
    const { params, warn } = makeParams();

    expect(() => runBootWindowHonestyChecks(params)).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        errorKind: "internal",
        hint: expect.stringContaining("fail-open"),
      }),
      "Boot window honesty checks skipped for agent",
    );
  });

  it("resolves models through the provider-alias fallback chain", () => {
    const find = vi.fn().mockReturnValueOnce(undefined).mockReturnValue({ contextWindow: 32768 });
    mockedCompare.mockImplementation(({ findModel }) => {
      findModel("custom-key", "m1");
      return undefined;
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedCollect.mockReturnValue({ agentId: "main" } as any);
    const { params } = makeParams({
      piModelRegistry: { find },
      providerAliases: new Map([["custom-key", "ollama"]]),
    });

    runBootWindowHonestyChecks(params);

    expect(find).toHaveBeenNthCalledWith(1, "custom-key", "m1");
    expect(find).toHaveBeenNthCalledWith(2, "ollama", "m1");
  });
});
