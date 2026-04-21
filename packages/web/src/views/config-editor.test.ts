// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach, vi } from "vitest";
import type { IcConfigEditor } from "./config-editor.js";
import type { RpcClient } from "../api/rpc-client.js";
import { serializeToYaml, parseYaml } from "./config-editor.js";

// Side-effect import to register custom element
import "./config-editor.js";
import { createMockRpcClient } from "../test-support/mock-rpc-client.js";

/* ------------------------------------------------------------------ */
/*  Mock data                                                          */
/* ------------------------------------------------------------------ */

const MOCK_SECTIONS = ["agents", "channels", "memory", "security", "daemon"];

const MOCK_CONFIG: Record<string, unknown> = {
  agents: {
    id: "default",
    name: "Main Agent",
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    maxSteps: 10,
    temperature: 0.7,
    enabled: true,
    budgets: {
      perExecution: 50000,
      perHour: 200000,
      perDay: 1000000,
    },
    tags: ["production", "primary"],
  },
  channels: {
    telegram: { enabled: true, botToken: "REDACTED" },
    discord: { enabled: false },
  },
  memory: {
    adapter: "sqlite",
    dbPath: "/data/memory.db",
    maxEntries: 10000,
  },
  security: {
    trustLevel: "medium",
    auditEnabled: true,
  },
  daemon: {
    port: 3000,
    host: "0.0.0.0",
  },
};

const MOCK_SCHEMA: Record<string, unknown> = {
  agents: {
    type: "object",
    properties: {
      id: { type: "string", description: "Unique agent identifier" },
      name: { type: "string", description: "Human-readable agent name", maxLength: 100 },
      provider: {
        type: "string",
        description: "LLM provider",
        enum: ["anthropic", "openai", "groq"],
      },
      model: { type: "string", description: "Model identifier" },
      maxSteps: { type: "integer", description: "Maximum execution steps", minimum: 1, maximum: 100 },
      temperature: { type: "number", description: "Sampling temperature", minimum: 0, maximum: 2 },
      enabled: { type: "boolean", description: "Whether the agent is active" },
      budgets: {
        type: "object",
        description: "Token budget limits",
        properties: {
          perExecution: { type: "integer", description: "Max tokens per execution", minimum: 0 },
          perHour: { type: "integer", description: "Max tokens per hour", minimum: 0 },
          perDay: { type: "integer", description: "Max tokens per day", minimum: 0 },
        },
      },
      tags: {
        type: "array",
        description: "Agent tags",
        items: { type: "string" },
      },
    },
    required: ["id", "provider"],
  },
  channels: {
    type: "object",
    properties: {
      telegram: {
        type: "object",
        properties: {
          enabled: { type: "boolean" },
          botToken: { type: "string" },
        },
      },
      discord: {
        type: "object",
        properties: {
          enabled: { type: "boolean" },
        },
      },
    },
  },
  memory: {
    type: "object",
    properties: {
      adapter: { type: "string", enum: ["sqlite", "postgres"] },
      dbPath: { type: "string" },
      maxEntries: { type: "integer", minimum: 100, maximum: 1000000 },
    },
  },
  security: {
    type: "object",
    properties: {
      trustLevel: { type: "string", enum: ["low", "medium", "high"] },
      auditEnabled: { type: "boolean" },
    },
  },
  daemon: {
    type: "object",
    properties: {
      port: { type: "integer", minimum: 1, maximum: 65535 },
      host: { type: "string" },
    },
  },
};

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Config-editor-specific mock that routes RPC methods to test data. */
function createConfigMockRpcClient(callImpl?: (...args: unknown[]) => unknown): ReturnType<typeof createMockRpcClient> {
  return createMockRpcClient(
    callImpl ??
      (async (method: string) => {
        if (method === "config.read") {
          return structuredClone({ config: MOCK_CONFIG, sections: MOCK_SECTIONS });
        }
        if (method === "config.schema") {
          return structuredClone({ schema: MOCK_SCHEMA, sections: MOCK_SECTIONS });
        }
        if (method === "config.apply") {
          return { ok: true };
        }
        return {};
      }),
  );
}

async function createElement(
  props?: Record<string, unknown>,
): Promise<IcConfigEditor> {
  const el = document.createElement("ic-config-editor") as IcConfigEditor;
  if (props) {
    Object.assign(el, props);
  }
  document.body.appendChild(el);
  await (el as any).updateComplete;
  return el;
}

/** Flush pending microtasks (for RPC promises). */
async function flush(el: IcConfigEditor): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await (el as any).updateComplete;
}

/** Access private fields. */
function priv(el: IcConfigEditor) {
  return el as unknown as {
    _loadState: string;
    _sections: string[];
    _selectedSection: string;
    _mode: string;
    _configData: Record<string, unknown>;
    _schemaData: Record<string, unknown>;
    _yamlText: string;
    _yamlErrors: string[];
    _formState: Record<string, unknown>;
    _formErrors: Record<string, string>;
    _dirty: boolean;
    _applying: boolean;
    _expandedPaths: Set<string>;
    _expandedFormPaths: Set<string>;
  };
}

/** Create a mock toast element to capture IcToast.show calls. */
function setupMockToast(): void {
  // Ensure an ic-toast element exists so static show() works
  const toast = document.createElement("ic-toast");
  document.body.appendChild(toast);
}

/** Query through the schema-form sub-component shadow root. */
function schemaFormQuery(el: IcConfigEditor, selector: string): Element | null {
  const form = el.shadowRoot?.querySelector("ic-schema-form");
  return form?.shadowRoot?.querySelector(selector) ?? null;
}

/** QueryAll through the schema-form sub-component shadow root. */
function schemaFormQueryAll(el: IcConfigEditor, selector: string): NodeListOf<Element> {
  const form = el.shadowRoot?.querySelector("ic-schema-form");
  return form?.shadowRoot?.querySelectorAll(selector) ?? ([] as unknown as NodeListOf<Element>);
}

afterEach(() => {
  document.body.innerHTML = "";
});

/* ------------------------------------------------------------------ */
/*  YAML serializer / parser unit tests                                */
/* ------------------------------------------------------------------ */

describe("serializeToYaml", () => {
  it("serializes flat object", () => {
    const result = serializeToYaml({ name: "test", count: 42, enabled: true });
    expect(result).toContain("name: test");
    expect(result).toContain("count: 42");
    expect(result).toContain("enabled: true");
  });

  it("serializes nested objects", () => {
    const result = serializeToYaml({ parent: { child: "value" } });
    expect(result).toContain("parent:");
    expect(result).toContain("  child: value");
  });

  it("serializes arrays", () => {
    const result = serializeToYaml({ items: ["a", "b", "c"] });
    expect(result).toContain("- a");
    expect(result).toContain("- b");
  });

  it("quotes special strings", () => {
    const result = serializeToYaml({ value: "has: colon" });
    expect(result).toContain('"has: colon"');
  });

  it("serializes null", () => {
    const result = serializeToYaml({ empty: null });
    expect(result).toContain("empty: null");
  });
});

describe("parseYaml", () => {
  it("parses key-value pairs", () => {
    const { data, error } = parseYaml("name: test\ncount: 42\nenabled: true");
    expect(error).toBeNull();
    expect(data).toEqual({ name: "test", count: 42, enabled: true });
  });

  it("parses nested objects", () => {
    const { data, error } = parseYaml("parent:\n  child: value");
    expect(error).toBeNull();
    expect(data).toEqual({ parent: { child: "value" } });
  });

  it("parses arrays", () => {
    const { data, error } = parseYaml("items:\n  - a\n  - b");
    expect(error).toBeNull();
    expect(data).toEqual({ items: ["a", "b"] });
  });

  it("parses quoted strings", () => {
    const { data, error } = parseYaml('name: "hello world"');
    expect(error).toBeNull();
    expect(data).toEqual({ name: "hello world" });
  });

  it("parses null values", () => {
    const { data, error } = parseYaml("empty: null");
    expect(error).toBeNull();
    expect(data).toEqual({ empty: null });
  });

  it("roundtrips simple config", () => {
    const original = { name: "test", port: 3000, enabled: true };
    const yaml = serializeToYaml(original);
    const { data } = parseYaml(yaml);
    expect(data).toEqual(original);
  });
});

/* ------------------------------------------------------------------ */
/*  Section Navigation                                                 */
/* ------------------------------------------------------------------ */

describe("IcConfigEditor - Section Navigation", () => {
  it("renders section sidebar with section names", async () => {
    const rpcClient = createConfigMockRpcClient();
    const el = await createElement({ rpcClient });
    await flush(el);

    const items = el.shadowRoot?.querySelectorAll(".section-item");
    expect(items?.length).toBe(5);
    expect(items?.[0]?.textContent?.trim()).toBe("Agents");
    expect(items?.[1]?.textContent?.trim()).toBe("Channels");
  });

  it("first section is selected by default", async () => {
    const rpcClient = createConfigMockRpcClient();
    const el = await createElement({ rpcClient });
    await flush(el);

    expect(priv(el)._selectedSection).toBe("agents");
    const selected = el.shadowRoot?.querySelector(".section-item[data-selected]");
    expect(selected?.textContent?.trim()).toBe("Agents");
  });

  it("clicking a section updates selected section", async () => {
    const rpcClient = createConfigMockRpcClient();
    const el = await createElement({ rpcClient });
    await flush(el);

    const items = el.shadowRoot?.querySelectorAll(".section-item");
    (items?.[2] as HTMLElement)?.click();
    await (el as any).updateComplete;

    expect(priv(el)._selectedSection).toBe("memory");
  });

  it("selected section has data-selected attribute", async () => {
    const rpcClient = createConfigMockRpcClient();
    const el = await createElement({ rpcClient });
    await flush(el);

    const selectedItems = el.shadowRoot?.querySelectorAll(".section-item[data-selected]");
    expect(selectedItems?.length).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/*  Mode Tabs                                                          */
/* ------------------------------------------------------------------ */

describe("IcConfigEditor - Mode Tabs", () => {
  it("renders 3 mode buttons", async () => {
    const rpcClient = createConfigMockRpcClient();
    const el = await createElement({ rpcClient });
    await flush(el);

    const modeBtns = el.shadowRoot?.querySelectorAll(".mode-btn");
    expect(modeBtns?.length).toBe(3);
    expect(modeBtns?.[0]?.textContent?.trim()).toBe("Form");
    expect(modeBtns?.[1]?.textContent?.trim()).toBe("YAML");
    expect(modeBtns?.[2]?.textContent?.trim()).toBe("Schema");
  });

  it("form mode is active by default", async () => {
    const rpcClient = createConfigMockRpcClient();
    const el = await createElement({ rpcClient });
    await flush(el);

    expect(priv(el)._mode).toBe("form");
    const activeBtns = el.shadowRoot?.querySelectorAll(".mode-btn[data-active]");
    expect(activeBtns?.length).toBe(1);
    expect(activeBtns?.[0]?.textContent?.trim()).toBe("Form");
  });

  it("clicking YAML mode switches to YAML view", async () => {
    const rpcClient = createConfigMockRpcClient();
    const el = await createElement({ rpcClient });
    await flush(el);

    const modeBtns = el.shadowRoot?.querySelectorAll(".mode-btn");
    (modeBtns?.[1] as HTMLElement)?.click();
    await (el as any).updateComplete;

    expect(priv(el)._mode).toBe("yaml");
    const textarea = el.shadowRoot?.querySelector(".yaml-textarea");
    expect(textarea).toBeTruthy();
  });

  it("clicking Schema mode switches to schema tree view", async () => {
    const rpcClient = createConfigMockRpcClient();
    const el = await createElement({ rpcClient });
    await flush(el);

    const modeBtns = el.shadowRoot?.querySelectorAll(".mode-btn");
    (modeBtns?.[2] as HTMLElement)?.click();
    await (el as any).updateComplete;

    expect(priv(el)._mode).toBe("schema");
    const tree = el.shadowRoot?.querySelector(".schema-tree");
    expect(tree).toBeTruthy();
  });
});

/* ------------------------------------------------------------------ */
/*  Form Mode                                                          */
/* ------------------------------------------------------------------ */

describe("IcConfigEditor - Form Mode", () => {
  it("renders text input for string schema properties", async () => {
    const rpcClient = createConfigMockRpcClient();
    const el = await createElement({ rpcClient });
    await flush(el);

    const inputs = schemaFormQueryAll(el, '.form-input[type="text"]');
    expect(inputs!.length).toBeGreaterThan(0);
  });

  it("renders number input for integer properties", async () => {
    const rpcClient = createConfigMockRpcClient();
    const el = await createElement({ rpcClient });
    await flush(el);

    const numInputs = schemaFormQueryAll(el, '.form-input[type="number"]');
    expect(numInputs!.length).toBeGreaterThan(0);
  });

  it("renders ic-toggle for boolean properties", async () => {
    const rpcClient = createConfigMockRpcClient();
    const el = await createElement({ rpcClient });
    await flush(el);

    const toggles = schemaFormQueryAll(el, "ic-toggle");
    expect(toggles!.length).toBeGreaterThan(0);
  });

  it("renders ic-select for enum properties", async () => {
    const rpcClient = createConfigMockRpcClient();
    const el = await createElement({ rpcClient });
    await flush(el);

    const selects = schemaFormQueryAll(el, "ic-select");
    expect(selects!.length).toBeGreaterThan(0);
  });

  it("renders collapsible fieldset for nested object properties", async () => {
    const rpcClient = createConfigMockRpcClient();
    const el = await createElement({ rpcClient });
    await flush(el);

    const fieldsets = schemaFormQueryAll(el, ".form-fieldset");
    expect(fieldsets!.length).toBeGreaterThan(0);
  });

  it("form changes set dirty state to true", async () => {
    const rpcClient = createConfigMockRpcClient();
    const el = await createElement({ rpcClient });
    await flush(el);

    expect(priv(el)._dirty).toBe(false);

    // Simulate form field change (form-input is now in ic-schema-form sub-component)
    const inputs = schemaFormQueryAll(el, '.form-input[type="text"]');
    const input = inputs?.[0] as HTMLInputElement | undefined;
    if (input) {
      input.value = "new-value";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await (el as any).updateComplete;
      expect(priv(el)._dirty).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ */
/*  YAML Mode                                                          */
/* ------------------------------------------------------------------ */

describe("IcConfigEditor - YAML Mode", () => {
  it("renders monospace textarea with YAML content", async () => {
    const rpcClient = createConfigMockRpcClient();
    const el = await createElement({ rpcClient });
    await flush(el);

    // Switch to YAML mode
    priv(el)._mode = "yaml";
    await (el as any).updateComplete;

    const textarea = el.shadowRoot?.querySelector(".yaml-textarea") as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();
    expect(textarea?.value?.length).toBeGreaterThan(0);
  });

  it("textarea contains serialized config for selected section", async () => {
    const rpcClient = createConfigMockRpcClient();
    const el = await createElement({ rpcClient });
    await flush(el);

    priv(el)._mode = "yaml";
    await (el as any).updateComplete;

    const textarea = el.shadowRoot?.querySelector(".yaml-textarea") as HTMLTextAreaElement;
    // Should contain agents section data
    expect(textarea?.value).toContain("id");
    expect(textarea?.value).toContain("default");
  });

  it("invalid YAML shows parse error message", async () => {
    const rpcClient = createConfigMockRpcClient();
    const el = await createElement({ rpcClient });
    await flush(el);

    priv(el)._mode = "yaml";
    priv(el)._yamlText = "invalid: [unclosed";
    priv(el)._yamlErrors = ["Parse error"];
    await (el as any).updateComplete;

    const errorPanel = el.shadowRoot?.querySelector(".yaml-validation--error");
    expect(errorPanel).toBeTruthy();
  });

  it("valid YAML shows success indicator", async () => {
    const rpcClient = createConfigMockRpcClient();
    const el = await createElement({ rpcClient });
    await flush(el);

    priv(el)._mode = "yaml";
    priv(el)._yamlErrors = [];
    await (el as any).updateComplete;

    const successPanel = el.shadowRoot?.querySelector(".yaml-validation--valid");
    expect(successPanel).toBeTruthy();
    expect(successPanel?.textContent).toContain("Valid");
  });
});

/* ------------------------------------------------------------------ */
/*  Schema Mode                                                        */
/* ------------------------------------------------------------------ */

describe("IcConfigEditor - Schema Mode", () => {
  it("renders schema tree with property names and types", async () => {
    const rpcClient = createConfigMockRpcClient();
    const el = await createElement({ rpcClient });
    await flush(el);

    priv(el)._mode = "schema";
    await (el as any).updateComplete;

    const keys = el.shadowRoot?.querySelectorAll(".schema-key");
    expect(keys!.length).toBeGreaterThan(0);

    const tags = el.shadowRoot?.querySelectorAll("ic-tag");
    expect(tags!.length).toBeGreaterThan(0);
  });

  it("nested properties are collapsible", async () => {
    const rpcClient = createConfigMockRpcClient();
    const el = await createElement({ rpcClient });
    await flush(el);

    priv(el)._mode = "schema";
    await (el as any).updateComplete;

    // Should have expand arrows for object properties
    const arrows = el.shadowRoot?.querySelectorAll(".schema-key .arrow");
    expect(arrows!.length).toBeGreaterThan(0);
  });

  it("schema tree shows type badges (ic-tag)", async () => {
    const rpcClient = createConfigMockRpcClient();
    const el = await createElement({ rpcClient });
    await flush(el);

    priv(el)._mode = "schema";
    await (el as any).updateComplete;

    const tags = el.shadowRoot?.querySelectorAll("ic-tag");
    expect(tags!.length).toBeGreaterThan(0);
    // Check some expected types
    const tagTexts = Array.from(tags!).map((t) => t.textContent?.trim());
    expect(tagTexts).toContain("string");
  });
});

/* ------------------------------------------------------------------ */
/*  Apply                                                              */
/* ------------------------------------------------------------------ */

describe("IcConfigEditor - Apply", () => {
  it("apply button is disabled when not dirty", async () => {
    const rpcClient = createConfigMockRpcClient();
    const el = await createElement({ rpcClient });
    await flush(el);

    const applyBtn = el.shadowRoot?.querySelector(".apply-btn") as HTMLButtonElement;
    expect(applyBtn).toBeTruthy();
    expect(applyBtn?.disabled).toBe(true);
  });

  it("apply button calls config.apply RPC with section and value", async () => {
    const rpcClient = createConfigMockRpcClient();
    setupMockToast();
    const el = await createElement({ rpcClient });
    await flush(el);

    // Make dirty
    priv(el)._dirty = true;
    await (el as any).updateComplete;

    const applyBtn = el.shadowRoot?.querySelector(".apply-btn") as HTMLButtonElement;
    applyBtn?.click();
    await flush(el);

    expect(rpcClient.call).toHaveBeenCalledWith("config.apply", {
      section: "agents",
      value: expect.any(Object),
    });
  });

  it("successful apply shows success toast and resets dirty state", async () => {
    const rpcClient = createConfigMockRpcClient();
    setupMockToast();
    const el = await createElement({ rpcClient });
    await flush(el);

    priv(el)._dirty = true;
    await (el as any).updateComplete;

    const applyBtn = el.shadowRoot?.querySelector(".apply-btn") as HTMLButtonElement;
    applyBtn?.click();
    await flush(el);

    expect(priv(el)._dirty).toBe(false);
  });

  it("failed apply shows error toast", async () => {
    const rpcClient = createMockRpcClient(async (...args: unknown[]) => {
      const method = args[0] as string;
      if (method === "config.read") return structuredClone({ config: MOCK_CONFIG, sections: MOCK_SECTIONS });
      if (method === "config.schema") return structuredClone({ schema: MOCK_SCHEMA, sections: MOCK_SECTIONS });
      if (method === "config.apply") throw new Error("Permission denied");
      return {};
    });
    setupMockToast();
    const el = await createElement({ rpcClient });
    await flush(el);

    priv(el)._dirty = true;
    await (el as any).updateComplete;

    const applyBtn = el.shadowRoot?.querySelector(".apply-btn") as HTMLButtonElement;
    applyBtn?.click();
    await flush(el);

    // dirty should remain true on failure
    expect(priv(el)._dirty).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/*  Import / Export                                                    */
/* ------------------------------------------------------------------ */

describe("IcConfigEditor - Import/Export", () => {
  it("export button triggers file download", async () => {
    const rpcClient = createConfigMockRpcClient();
    const el = await createElement({ rpcClient });
    await flush(el);

    // Mock URL.createObjectURL and revokeObjectURL
    const mockUrl = "blob:mock-url";
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => mockUrl);
    URL.revokeObjectURL = vi.fn();

    const exportBtn = el.shadowRoot?.querySelectorAll(".secondary-btn")?.[1] as HTMLButtonElement;
    expect(exportBtn?.textContent?.trim()).toBe("Export");

    // Mock anchor click
    const clickSpy = vi.fn();
    const origCreateElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const el = origCreateElement(tag);
      if (tag === "a") {
        Object.defineProperty(el, "click", { value: clickSpy });
      }
      return el;
    });

    exportBtn?.click();

    expect(URL.createObjectURL).toHaveBeenCalled();
    expect(clickSpy).toHaveBeenCalled();

    // Cleanup
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    vi.restoreAllMocks();
  });

  it("import button triggers file input click", async () => {
    const rpcClient = createConfigMockRpcClient();
    const el = await createElement({ rpcClient });
    await flush(el);

    const hiddenInput = el.shadowRoot?.querySelector(".hidden-input") as HTMLInputElement;
    const clickSpy = vi.fn();
    hiddenInput.click = clickSpy;

    const importBtn = el.shadowRoot?.querySelectorAll(".secondary-btn")?.[0] as HTMLButtonElement;
    expect(importBtn?.textContent?.trim()).toBe("Import");

    importBtn?.click();
    expect(clickSpy).toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/*  Loading states                                                     */
/* ------------------------------------------------------------------ */

describe("IcConfigEditor - Loading States", () => {
  it("shows loading state while fetching config", async () => {
    // Create RPC client that never resolves
    const rpcClient = createMockRpcClient(
      () => new Promise(() => {
        // Never resolves
      }),
    );
    const el = await createElement({ rpcClient });

    const loading = el.shadowRoot?.querySelector("ic-skeleton-view");
    expect(loading).toBeTruthy();
  });

  it("shows error state when RPC fails", async () => {
    const rpcClient = createMockRpcClient(async () => {
      throw new Error("Connection failed");
    });
    const el = await createElement({ rpcClient });
    await flush(el);

    const errorMsg = el.shadowRoot?.querySelector(".error-message");
    expect(errorMsg).toBeTruthy();
    expect(errorMsg?.textContent).toContain("Connection failed");

    const retryBtn = el.shadowRoot?.querySelector(".retry-btn");
    expect(retryBtn).toBeTruthy();
  });

  it("renders view header Settings", async () => {
    const rpcClient = createConfigMockRpcClient();
    const el = await createElement({ rpcClient });
    await flush(el);

    const title = el.shadowRoot?.querySelector(".view-title");
    expect(title?.textContent).toContain("Settings");
  });
});
