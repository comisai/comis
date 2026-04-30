// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { describe, it, expect, afterEach, vi } from "vitest";
import type { IcSetupWizard, WizardData } from "./setup-wizard.js";
import type { RpcClient } from "../api/rpc-client.js";

// Side-effect import to register custom element
import "./setup-wizard.js";
import { createMockRpcClient } from "../test-support/mock-rpc-client.js";

/**
 * Read a project source file by its package-relative path (e.g.
 * "src/views/setup-wizard.ts"). Walks up from cwd until we find a directory
 * containing the file -- vitest workspace runs may execute from the repo
 * root instead of the package directory. happy-dom (the test environment)
 * stubs the URL constructor so `new URL("./x.ts", import.meta.url)` fails;
 * resolving via filesystem walk avoids that.
 */
function readProjectFile(packageRelativePath: string): string {
  // Try cwd first (vitest --filter ./packages/web), then walk up looking for
  // packages/web/<rel>. The file is always under packages/web/, so we anchor
  // the search there.
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const direct = resolve(dir, packageRelativePath);
    if (existsSync(direct)) return readFileSync(direct, "utf8");
    const candidate = resolve(dir, "packages/web", packageRelativePath);
    if (existsSync(candidate)) return readFileSync(candidate, "utf8");
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`readProjectFile: ${packageRelativePath} not found from cwd ${process.cwd()}`);
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

async function createElement(
  props?: Record<string, unknown>,
): Promise<IcSetupWizard> {
  const el = document.createElement("ic-setup-wizard") as IcSetupWizard;
  if (props) {
    Object.assign(el, props);
  }
  document.body.appendChild(el);
  await (el as any).updateComplete;
  return el;
}

async function flush(el: IcSetupWizard): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await (el as any).updateComplete;
}

function priv(el: IcSetupWizard) {
  return el as unknown as {
    _currentStep: number;
    _wizardData: WizardData;
    _testResult: { status: string; message?: string };
    _expandedChannels: Set<string>;
    _yamlPreview: string;
    _applying: boolean;
    _applyDone: boolean;
    _validationErrors: Record<string, string>;
  };
}

/** Advance to a specific step by setting the step directly (bypassing validation). */
async function goToStep(el: IcSetupWizard, step: number): Promise<void> {
  priv(el)._currentStep = step;
  await (el as any).updateComplete;
}

/** Click the Next button in the nav bar. */
async function clickNext(el: IcSetupWizard): Promise<void> {
  const btns = el.shadowRoot?.querySelectorAll<HTMLButtonElement>(".nav-bar .btn-primary");
  const nextBtn = btns?.[0];
  nextBtn?.click();
  await (el as any).updateComplete;
}

/** Click the Back button in the nav bar. */
async function clickBack(el: IcSetupWizard): Promise<void> {
  const btns = el.shadowRoot?.querySelectorAll<HTMLButtonElement>(".nav-bar .btn-secondary");
  const backBtn = btns?.[0];
  backBtn?.click();
  await (el as any).updateComplete;
}

/* ------------------------------------------------------------------ */
/*  Mock browser APIs                                                  */
/* ------------------------------------------------------------------ */

const clipboardWriteText = vi.fn().mockResolvedValue(undefined);
vi.stubGlobal("navigator", {
  ...globalThis.navigator,
  clipboard: { writeText: clipboardWriteText },
});

const mockCreateObjectURL = vi.fn(() => "blob:mock");
const mockRevokeObjectURL = vi.fn();
vi.stubGlobal("URL", { ...globalThis.URL, createObjectURL: mockCreateObjectURL, revokeObjectURL: mockRevokeObjectURL });

// Mock IcToast.show
vi.mock("../components/feedback/ic-toast.js", () => ({
  IcToast: {
    show: vi.fn(),
  },
}));

/* ------------------------------------------------------------------ */
/*  Teardown                                                           */
/* ------------------------------------------------------------------ */

afterEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

/* ================================================================== */
/*  Step Progress & Navigation                                         */
/* ================================================================== */

describe("Step Progress & Navigation", () => {
  it("renders 5 step indicators with labels", async () => {
    const el = await createElement();
    const items = el.shadowRoot?.querySelectorAll(".step-item");
    expect(items?.length).toBe(5);
    const labels = Array.from(items ?? []).map((item) => item.querySelector(".step-label")?.textContent?.trim());
    expect(labels).toEqual(["Basics", "Provider", "Agent", "Channels", "Review"]);
  });

  it("step 1 is active by default", async () => {
    const el = await createElement();
    expect(priv(el)._currentStep).toBe(0);
    const circles = el.shadowRoot?.querySelectorAll(".step-circle");
    expect(circles?.[0]?.classList.contains("current")).toBe(true);
  });

  it("next button advances to next step", async () => {
    const el = await createElement();
    expect(priv(el)._currentStep).toBe(0);
    await clickNext(el);
    // Step 1 validates tenantId which defaults to "default", so should pass
    expect(priv(el)._currentStep).toBe(1);
  });

  it("back button returns to previous step", async () => {
    const el = await createElement();
    await goToStep(el, 2);
    await clickBack(el);
    expect(priv(el)._currentStep).toBe(1);
  });

  it("back button is hidden on step 1", async () => {
    const el = await createElement();
    const backBtns = el.shadowRoot?.querySelectorAll<HTMLButtonElement>(".nav-bar .btn-secondary");
    expect(backBtns?.length).toBe(0);
  });

  it("step validation prevents advancing with empty required fields", async () => {
    const el = await createElement();
    // Clear tenant ID
    priv(el)._wizardData = { ...priv(el)._wizardData, tenantId: "" };
    await (el as any).updateComplete;
    await clickNext(el);
    expect(priv(el)._currentStep).toBe(0);
    expect(priv(el)._validationErrors["tenantId"]).toBeTruthy();
  });
});

/* ================================================================== */
/*  Step 1 - Basics                                                    */
/* ================================================================== */

describe("Step 1 - Basics", () => {
  it("renders tenant ID, data dir, log level, host, port fields", async () => {
    const el = await createElement();
    const labels = Array.from(el.shadowRoot?.querySelectorAll(".form-label") ?? [])
      .map((l) => l.textContent?.trim());
    expect(labels).toContain("Tenant ID");
    expect(labels).toContain("Data Directory");
    expect(labels).toContain("Log Level");
    expect(labels).toContain("Gateway Host");
    expect(labels).toContain("Gateway Port");
  });

  it("fields have default values", async () => {
    const el = await createElement();
    const d = priv(el)._wizardData;
    expect(d.tenantId).toBe("default");
    expect(d.dataDir).toBe("~/.comis");
    expect(d.logLevel).toBe("info");
    expect(d.gatewayHost).toBe("127.0.0.1");
    expect(d.gatewayPort).toBe(4766);
  });

  it("changing a field updates wizard data", async () => {
    const el = await createElement();
    const inputs = el.shadowRoot?.querySelectorAll<HTMLInputElement>(".form-input");
    // First input is tenant ID
    const tenantInput = inputs?.[0];
    if (tenantInput) {
      // Simulate input event
      Object.defineProperty(tenantInput, "value", { value: "my-tenant", writable: true });
      tenantInput.dispatchEvent(new Event("input", { bubbles: true }));
      await (el as any).updateComplete;
      expect(priv(el)._wizardData.tenantId).toBe("my-tenant");
    }
  });

  it("empty tenant ID shows validation error on Next", async () => {
    const el = await createElement();
    priv(el)._wizardData = { ...priv(el)._wizardData, tenantId: "" };
    await (el as any).updateComplete;
    await clickNext(el);
    const errorEl = el.shadowRoot?.querySelector(".form-error");
    expect(errorEl?.textContent).toContain("Tenant ID is required");
  });
});

/* ================================================================== */
/*  Step 2 - Provider (Layer 3A: live catalog -- 260501-07g)           */
/* ================================================================== */
//
// Phase 3A replaced the static 12-entry PROVIDERS array with a runtime
// fetch via the gateway RPC `models.list_providers`. These tests mock
// the RPC to drive the catalog state and assert behavioral rendering
// (loading / error / dynamic grid / Custom synthetic key / model dropdown).

/**
 * Build a mock RpcClient that answers `models.list_providers` with a fixed
 * provider list and `models.list provider:<x>` with a per-provider model
 * list. Other RPC methods return {} by default.
 */
function rpcWithCatalog(
  providers: string[] = ["anthropic", "openrouter", "ollama"],
  modelsByProvider: Record<string, Array<{ id: string; cost?: { input?: number; output?: number } }>> = {
    anthropic: [
      { id: "claude-haiku-4-5", cost: { input: 1, output: 5 } },
      { id: "claude-sonnet-4-5", cost: { input: 3, output: 15 } },
    ],
    openrouter: [{ id: "qwen/qwen3-coder", cost: { input: 0.5, output: 1.5 } }],
    ollama: [{ id: "llama3" }], // free / no cost
  },
): RpcClient {
  return createMockRpcClient(async (...args: unknown[]) => {
    const method = args[0] as string;
    const params = (args[1] as Record<string, unknown> | undefined) ?? {};
    if (method === "models.list_providers") {
      return { providers, count: providers.length };
    }
    if (method === "models.list") {
      const provider = params["provider"] as string | undefined;
      if (provider && modelsByProvider[provider]) {
        return {
          models: modelsByProvider[provider].map((m) => ({ modelId: m.id, ...(m.cost ? { cost: m.cost } : {}) })),
          total: modelsByProvider[provider].length,
        };
      }
      return { models: [], total: 0 };
    }
    return {};
  });
}

async function withCatalogReady(rpcClient: RpcClient): Promise<IcSetupWizard> {
  const el = await createElement({ rpcClient });
  await flush(el); // give connectedCallback's async fetch a tick to resolve
  await flush(el);
  return el;
}

describe("Step 2 - Provider (live catalog)", () => {
  it("fetches catalog providers via models.list_providers on mount", async () => {
    const rpcClient = rpcWithCatalog();
    await withCatalogReady(rpcClient);
    expect(rpcClient.call).toHaveBeenCalledWith("models.list_providers", {});
  });

  it("renders one card per catalog provider plus a Custom card", async () => {
    const rpcClient = rpcWithCatalog(["anthropic", "openrouter"]);
    const el = await withCatalogReady(rpcClient);
    await goToStep(el, 1);
    await flush(el);
    const cards = el.shadowRoot?.querySelectorAll(".provider-card");
    // 2 catalog + 1 synthetic Custom = 3
    expect(cards?.length).toBe(3);
    const names = Array.from(cards ?? []).map((c) =>
      c.querySelector(".provider-card-name")?.textContent?.trim(),
    );
    expect(names).toEqual(["Anthropic", "OpenRouter", "Custom"]);
  });

  it("renders a fallback card name for catalog providers missing from PROVIDER_UI_HINTS", async () => {
    // "kimi-coding" is in pi-ai's catalog but not in PROVIDER_UI_HINTS;
    // it should render with capitalized fallback display name.
    const rpcClient = rpcWithCatalog(["kimi-coding"]);
    const el = await withCatalogReady(rpcClient);
    await goToStep(el, 1);
    await flush(el);
    const cards = el.shadowRoot?.querySelectorAll(".provider-card");
    const names = Array.from(cards ?? []).map((c) =>
      c.querySelector(".provider-card-name")?.textContent?.trim(),
    );
    // First catalog provider gets fallback display name; "Custom" appended.
    expect(names?.[0]).toBe("Kimi-coding");
    expect(names).toContain("Custom");
  });

  it("shows a loading state while the catalog is being fetched", async () => {
    // Slow RPC: never resolves until we tick
    let resolveCatalog: ((value: unknown) => void) | undefined;
    const slowRpc = createMockRpcClient(async (...args: unknown[]) => {
      const method = args[0] as string;
      if (method === "models.list_providers") {
        return new Promise((resolve) => { resolveCatalog = resolve; });
      }
      return {};
    });
    const el = await createElement({ rpcClient: slowRpc });
    await goToStep(el, 1);
    expect(priv(el)._catalogProvidersLoading).toBe(true);
    const loading = el.shadowRoot?.querySelector(".provider-grid-loading");
    expect(loading?.textContent?.toLowerCase()).toContain("loading");
    // Cleanup
    resolveCatalog?.({ providers: [], count: 0 });
    await flush(el);
  });

  it("shows an error state with retry when models.list_providers fails", async () => {
    const failingRpc = createMockRpcClient(async (...args: unknown[]) => {
      const method = args[0] as string;
      if (method === "models.list_providers") throw new Error("network down");
      return {};
    });
    const el = await createElement({ rpcClient: failingRpc });
    await flush(el);
    await flush(el);
    await goToStep(el, 1);
    expect(priv(el)._catalogProvidersError).toContain("network down");
    const errEl = el.shadowRoot?.querySelector(".provider-grid-error");
    expect(errEl?.textContent).toContain("network down");
    const retryBtn = errEl?.querySelector<HTMLButtonElement>(".test-btn");
    expect(retryBtn?.textContent?.trim()).toBe("Retry");
  });

  it("clicking a catalog provider card selects it and triggers models.list fetch", async () => {
    const rpcClient = rpcWithCatalog();
    const el = await withCatalogReady(rpcClient);
    await goToStep(el, 1);
    await flush(el);
    const cards = el.shadowRoot?.querySelectorAll<HTMLDivElement>(".provider-card");
    cards?.[0]?.click(); // anthropic
    await flush(el);
    expect(priv(el)._wizardData.providerName).toBe("anthropic");
    expect(priv(el)._wizardData.providerType).toBe("anthropic");
    expect(rpcClient.call).toHaveBeenCalledWith("models.list", { provider: "anthropic" });
  });

  it("selecting a native provider shows API Key field but no Base URL field", async () => {
    const rpcClient = rpcWithCatalog(["anthropic"]);
    const el = await withCatalogReady(rpcClient);
    await goToStep(el, 1);
    await flush(el);
    const cards = el.shadowRoot?.querySelectorAll<HTMLDivElement>(".provider-card");
    cards?.[0]?.click(); // anthropic
    await flush(el);
    const labels = Array.from(el.shadowRoot?.querySelectorAll(".provider-config .form-label") ?? [])
      .map((l) => l.textContent?.trim());
    expect(labels).toContain("API Key");
    expect(labels).not.toContain("Base URL");
  });

  it("selecting Custom shows Base URL field, no API key, and a free-text Model ID", async () => {
    const rpcClient = rpcWithCatalog(["anthropic"]);
    const el = await withCatalogReady(rpcClient);
    await goToStep(el, 1);
    await flush(el);
    const cards = el.shadowRoot?.querySelectorAll<HTMLDivElement>(".provider-card");
    // Custom is the last card after the catalog providers
    const lastCard = cards?.[cards.length - 1] as HTMLDivElement | undefined;
    lastCard?.click();
    await flush(el);
    expect(priv(el)._wizardData.providerName).toBe("__custom__");
    // Custom path keeps providerType = "openai" so the existing
    // models.test passthrough remains compatible.
    expect(priv(el)._wizardData.providerType).toBe("openai");
    const labels = Array.from(el.shadowRoot?.querySelectorAll(".provider-config .form-label") ?? [])
      .map((l) => l.textContent?.trim());
    expect(labels).toContain("Base URL");
    expect(labels).not.toContain("API Key");
    expect(labels).toContain("Model ID"); // free-text input for Custom
  });

  it("native provider selection populates the model dropdown sorted by ascending cost", async () => {
    const rpcClient = rpcWithCatalog(["anthropic"], {
      anthropic: [
        { id: "claude-sonnet-4-5", cost: { input: 3, output: 15 } },
        { id: "claude-haiku-4-5", cost: { input: 1, output: 5 } },
      ],
    });
    const el = await withCatalogReady(rpcClient);
    await goToStep(el, 1);
    await flush(el);
    const cards = el.shadowRoot?.querySelectorAll<HTMLDivElement>(".provider-card");
    cards?.[0]?.click();
    await flush(el);
    await flush(el);
    // Cheapest should be first in the dropdown (haiku before sonnet).
    expect(priv(el)._modelOptions.map((m) => m.id)).toEqual([
      "claude-haiku-4-5",
      "claude-sonnet-4-5",
    ]);
    const select = el.shadowRoot?.querySelector<HTMLSelectElement>(".provider-config .form-select");
    expect(select).toBeTruthy();
    const optionValues = Array.from(select?.querySelectorAll("option") ?? [])
      .map((o) => o.value);
    expect(optionValues).toEqual(["", "claude-haiku-4-5", "claude-sonnet-4-5"]);
  });

  it("test connection button calls models.test RPC method", async () => {
    const rpcClient = rpcWithCatalog();
    const el = await withCatalogReady(rpcClient);
    await goToStep(el, 1);
    priv(el)._wizardData = { ...priv(el)._wizardData, providerName: "anthropic", providerType: "anthropic" };
    await (el as any).updateComplete;
    const testBtn = el.shadowRoot?.querySelector<HTMLButtonElement>(".test-btn");
    testBtn?.click();
    await flush(el);
    expect(rpcClient.call).toHaveBeenCalledWith("models.test", { provider: "anthropic" });
  });

  it("successful test shows success indicator", async () => {
    const rpcClient = rpcWithCatalog();
    const el = await withCatalogReady(rpcClient);
    await goToStep(el, 1);
    priv(el)._wizardData = { ...priv(el)._wizardData, providerName: "anthropic", providerType: "anthropic" };
    await (el as any).updateComplete;
    const testBtn = el.shadowRoot?.querySelector<HTMLButtonElement>(".test-btn");
    testBtn?.click();
    await flush(el);
    expect(priv(el)._testResult.status).toBe("success");
    const successEl = el.shadowRoot?.querySelector(".test-success");
    expect(successEl?.textContent).toContain("Connected");
  });

  it("failed test shows error message", async () => {
    const rpcClient = createMockRpcClient(async (...args: unknown[]) => {
      const method = args[0] as string;
      if (method === "models.list_providers") return { providers: ["anthropic"], count: 1 };
      if (method === "models.list") return { models: [], total: 0 };
      if (method === "models.test") throw new Error("Auth failed");
      return {};
    });
    const el = await withCatalogReady(rpcClient);
    await goToStep(el, 1);
    priv(el)._wizardData = { ...priv(el)._wizardData, providerName: "anthropic", providerType: "anthropic" };
    await (el as any).updateComplete;
    const testBtn = el.shadowRoot?.querySelector<HTMLButtonElement>(".test-btn");
    testBtn?.click();
    await flush(el);
    expect(priv(el)._testResult.status).toBe("error");
    const errorEl = el.shadowRoot?.querySelector(".test-error");
    expect(errorEl?.textContent).toContain("Auth failed");
  });

  it("regression: setup-wizard.ts has no hardcoded PROVIDERS: ProviderOption[] array", () => {
    // Hard-coded provider table is the staleness pattern Phase 3A removed.
    // happy-dom doesn't expose the Node URL constructor, so we resolve the
    // source path via process.cwd() (vitest runs from packages/web).
    const source = readProjectFile("src/views/setup-wizard.ts");
    expect(source).not.toMatch(/const\s+PROVIDERS\s*:\s*ProviderOption\s*\[\]/);
    // No hardcoded model literals -- these were the staleness vectors.
    expect(source).not.toMatch(/claude-sonnet-4-5-20250929/);
    expect(source).not.toMatch(/gemini-2\.0-flash/);
    expect(source).not.toMatch(/llama-3\.3-70b-versatile/);
    expect(source).not.toMatch(/mistral-large-latest/);
    expect(source).not.toMatch(/deepseek-chat/);
    expect(source).not.toMatch(/grok-2/);
  });
});

/* ================================================================== */
/*  Step 3 - Agent                                                     */
/* ================================================================== */

describe("Step 3 - Agent", () => {
  it("renders agent ID, name, model, provider, max steps, budget fields", async () => {
    const el = await createElement();
    await goToStep(el, 2);
    const labels = Array.from(el.shadowRoot?.querySelectorAll(".form-label") ?? [])
      .map((l) => l.textContent?.trim());
    expect(labels).toContain("Agent ID");
    expect(labels).toContain("Agent Name");
    expect(labels).toContain("Model");
    expect(labels).toContain("Provider");
    expect(labels).toContain("Max Steps");
    expect(labels).toContain("Budget Per Day (tokens)");
    expect(labels).toContain("Budget Per Hour (tokens)");
  });

  it("model field is pre-filled from provider step", async () => {
    const el = await createElement();
    // Set provider data first
    priv(el)._wizardData = {
      ...priv(el)._wizardData,
      providerName: "anthropic",
      providerType: "anthropic",
      defaultModel: "claude-sonnet-4-5-20250929",
    };
    // Simulate going from step 1 to step 2 (triggers pre-fill)
    priv(el)._currentStep = 1;
    await (el as any).updateComplete;
    await clickNext(el); // Should fail validation since provider needs apiKey
    // Set apiKey to pass validation
    priv(el)._wizardData = { ...priv(el)._wizardData, apiKey: "test-key" };
    await (el as any).updateComplete;
    await clickNext(el); // Step 1 -> Step 2
    expect(priv(el)._wizardData.agentModel).toBe("claude-sonnet-4-5-20250929");
    expect(priv(el)._wizardData.agentProvider).toBe("anthropic");
  });

  it("empty agent ID shows validation error on Next", async () => {
    const el = await createElement();
    await goToStep(el, 2);
    priv(el)._wizardData = { ...priv(el)._wizardData, agentId: "" };
    await (el as any).updateComplete;
    await clickNext(el);
    expect(priv(el)._currentStep).toBe(2);
    expect(priv(el)._validationErrors["agentId"]).toBeTruthy();
  });
});

/* ================================================================== */
/*  Step 4 - Channels                                                  */
/* ================================================================== */

describe("Step 4 - Channels", () => {
  it("renders 8 channel cards with platform icons", async () => {
    const el = await createElement();
    await goToStep(el, 3);
    const cards = el.shadowRoot?.querySelectorAll(".channel-card");
    expect(cards?.length).toBe(8);
    const icons = el.shadowRoot?.querySelectorAll("ic-platform-icon");
    expect(icons?.length).toBe(8);
  });

  it("clicking a card expands it to show credential fields", async () => {
    const el = await createElement();
    await goToStep(el, 3);
    const headers = el.shadowRoot?.querySelectorAll<HTMLDivElement>(".channel-header");
    headers?.[0]?.click(); // Telegram
    await (el as any).updateComplete;
    expect(priv(el)._expandedChannels.has("telegram")).toBe(true);
    const body = el.shadowRoot?.querySelector(".channel-body");
    expect(body).toBeTruthy();
  });

  it("telegram card shows botToken field", async () => {
    const el = await createElement();
    await goToStep(el, 3);
    // Expand telegram
    const expanded = new Set<string>(["telegram"]);
    priv(el)._expandedChannels = expanded;
    await (el as any).updateComplete;
    const body = el.shadowRoot?.querySelector(".channel-body");
    const labels = Array.from(body?.querySelectorAll(".form-label") ?? [])
      .map((l) => l.textContent?.trim());
    expect(labels).toContain("Bot Token");
  });

  it("enabling a channel sets enabled flag in wizard data", async () => {
    const el = await createElement();
    await goToStep(el, 3);
    const toggles = el.shadowRoot?.querySelectorAll<HTMLButtonElement>(".channel-toggle");
    toggles?.[0]?.click(); // Enable Telegram
    await (el as any).updateComplete;
    expect(priv(el)._wizardData.channels["telegram"].enabled).toBe(true);
  });
});

/* ================================================================== */
/*  Step 5 - Review                                                    */
/* ================================================================== */

describe("Step 5 - Review", () => {
  async function setupReviewStep(rpcClient?: RpcClient): Promise<IcSetupWizard> {
    const el = await createElement({ rpcClient: rpcClient ?? createMockRpcClient() });
    // Set up valid wizard data
    priv(el)._wizardData = {
      ...priv(el)._wizardData,
      providerName: "anthropic",
      providerType: "anthropic",
      apiKey: "sk-test",
      defaultModel: "claude-sonnet-4-5-20250929",
      agentModel: "claude-sonnet-4-5-20250929",
      agentProvider: "anthropic",
    };
    // Go to step 4 (channels), then advance to step 5 (generates YAML)
    priv(el)._currentStep = 3;
    await (el as any).updateComplete;
    await clickNext(el); // Channels has no validation, advances to review and generates YAML
    return el;
  }

  it("generates YAML preview containing configured sections", async () => {
    const el = await setupReviewStep();
    const yaml = priv(el)._yamlPreview;
    // tenantId is omitted when set to "default" (the default value)
    expect(yaml).toContain("logLevel");
    expect(yaml).toContain("gateway");
    expect(yaml).toContain("providers");
    expect(yaml).toContain("agents");
  });

  it("copy button copies YAML to clipboard", async () => {
    const el = await setupReviewStep();
    const copyBtn = el.shadowRoot?.querySelectorAll<HTMLButtonElement>(".review-actions .btn-secondary")?.[0];
    expect(copyBtn?.textContent?.trim()).toBe("Copy");
    copyBtn?.click();
    await flush(el);
    expect(clipboardWriteText).toHaveBeenCalledWith(priv(el)._yamlPreview);
  });

  it("download button creates blob download", async () => {
    const el = await setupReviewStep();
    const downloadBtn = el.shadowRoot?.querySelectorAll<HTMLButtonElement>(".review-actions .btn-secondary")?.[1];
    expect(downloadBtn?.textContent?.trim()).toBe("Download");
    downloadBtn?.click();
    await flush(el);
    expect(mockCreateObjectURL).toHaveBeenCalled();
    expect(mockRevokeObjectURL).toHaveBeenCalled();
  });

  it("apply button calls config.apply RPC for mutable sections", async () => {
    const rpcClient = createMockRpcClient();
    const el = await setupReviewStep(rpcClient);
    const applyBtn = el.shadowRoot?.querySelector<HTMLButtonElement>(".review-actions .btn-primary");
    expect(applyBtn?.textContent?.trim()).toBe("Apply");
    applyBtn?.click();
    await flush(el);
    // Only mutable sections (models) are applied via config.apply;
    // immutable sections (agents, gateway, providers) require config file + restart
    const applyCalls = (rpcClient.call as any).mock.calls.filter(
      (c: unknown[]) => c[0] === "config.apply",
    );
    expect(applyCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("successful apply shows info toast with immutable section guidance", async () => {
    const { IcToast } = await import("../components/feedback/ic-toast.js");
    const rpcClient = createMockRpcClient();
    const el = await setupReviewStep(rpcClient);
    const applyBtn = el.shadowRoot?.querySelector<HTMLButtonElement>(".review-actions .btn-primary");
    applyBtn?.click();
    await flush(el);
    // Immutable sections (agents, gateway, providers) trigger an info toast
    // advising to save the config file and restart the daemon
    expect(IcToast.show).toHaveBeenCalledWith(
      expect.stringContaining("Applied"),
      "info",
    );
  });

  it("failed apply shows error toast", async () => {
    const { IcToast } = await import("../components/feedback/ic-toast.js");
    const rpcClient = createMockRpcClient(async (...args: unknown[]) => {
      const method = args[0] as string;
      if (method === "config.apply") throw new Error("Permission denied");
      return {};
    });
    const el = await setupReviewStep(rpcClient);
    const applyBtn = el.shadowRoot?.querySelector<HTMLButtonElement>(".review-actions .btn-primary");
    applyBtn?.click();
    await flush(el);
    // Error toast prefixes the section label (e.g. "models: Permission denied")
    expect(IcToast.show).toHaveBeenCalledWith(
      expect.stringContaining("Permission denied"),
      "error",
    );
  });
});
