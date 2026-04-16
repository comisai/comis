import { describe, it, expect, afterEach, vi } from "vitest";
import type { IcSetupWizard, WizardData } from "./setup-wizard.js";
import type { RpcClient } from "../api/rpc-client.js";

// Side-effect import to register custom element
import "./setup-wizard.js";
import { createMockRpcClient } from "../test-support/mock-rpc-client.js";

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
/*  Step 2 - Provider                                                  */
/* ================================================================== */

describe("Step 2 - Provider", () => {
  it("renders 12 provider cards", async () => {
    const el = await createElement();
    await goToStep(el, 1);
    const cards = el.shadowRoot?.querySelectorAll(".provider-card");
    expect(cards?.length).toBe(12);
    const names = Array.from(cards ?? []).map((c) => c.querySelector(".provider-card-name")?.textContent?.trim());
    expect(names).toEqual(["Anthropic", "OpenAI", "Google", "Groq", "Mistral", "DeepSeek", "xAI", "Together AI", "Cerebras", "OpenRouter", "Ollama", "Custom"]);
  });

  it("clicking a provider card selects it", async () => {
    const el = await createElement();
    await goToStep(el, 1);
    const cards = el.shadowRoot?.querySelectorAll<HTMLDivElement>(".provider-card");
    cards?.[0]?.click();
    await (el as any).updateComplete;
    expect(priv(el)._wizardData.providerName).toBe("anthropic");
    const updatedCards = el.shadowRoot?.querySelectorAll(".provider-card");
    expect(updatedCards?.[0]?.classList.contains("active")).toBe(true);
  });

  it("selecting Anthropic shows API key field", async () => {
    const el = await createElement();
    await goToStep(el, 1);
    const cards = el.shadowRoot?.querySelectorAll<HTMLDivElement>(".provider-card");
    cards?.[0]?.click(); // Anthropic
    await (el as any).updateComplete;
    const labels = Array.from(el.shadowRoot?.querySelectorAll(".provider-config .form-label") ?? [])
      .map((l) => l.textContent?.trim());
    expect(labels).toContain("API Key");
  });

  it("selecting Ollama shows base URL field without API key", async () => {
    const el = await createElement();
    await goToStep(el, 1);
    const cards = el.shadowRoot?.querySelectorAll<HTMLDivElement>(".provider-card");
    cards?.[10]?.click(); // Ollama
    await (el as any).updateComplete;
    const labels = Array.from(el.shadowRoot?.querySelectorAll(".provider-config .form-label") ?? [])
      .map((l) => l.textContent?.trim());
    expect(labels).toContain("Base URL");
    expect(labels).not.toContain("API Key");
  });

  it("test connection button calls models.test RPC method", async () => {
    const rpcClient = createMockRpcClient();
    const el = await createElement({ rpcClient });
    await goToStep(el, 1);
    // Select a provider first
    priv(el)._wizardData = { ...priv(el)._wizardData, providerName: "anthropic", providerType: "anthropic" };
    await (el as any).updateComplete;
    const testBtn = el.shadowRoot?.querySelector<HTMLButtonElement>(".test-btn");
    testBtn?.click();
    await flush(el);
    expect(rpcClient.call).toHaveBeenCalledWith("models.test", { provider: "anthropic" });
  });

  it("successful test shows success indicator", async () => {
    const rpcClient = createMockRpcClient();
    const el = await createElement({ rpcClient });
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
      if (method === "models.test") throw new Error("Auth failed");
      return {};
    });
    const el = await createElement({ rpcClient });
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
