// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import type { ReactiveControllerHost } from "lit";
import { createMockRpcClient } from "../test-support/mock-rpc-client.js";
import {
  createSetupWizardController,
  CUSTOM_PROVIDER_KEY,
} from "./setup-wizard-controller.js";

vi.mock("../components/feedback/ic-toast.js", () => ({
  IcToast: { show: vi.fn() },
}));

function makeHost(): ReactiveControllerHost & { _updates: number } {
  return {
    _updates: 0,
    addController: vi.fn(),
    removeController: vi.fn(),
    requestUpdate(): void {
      (this as { _updates: number })._updates += 1;
    },
    updateComplete: Promise.resolve(true),
  } as unknown as ReactiveControllerHost & { _updates: number };
}

describe("SetupWizardController", () => {
  it("load: hostConnected triggers models.list_providers and populates catalog", async () => {
    const host = makeHost();
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      const method = args[0] as string;
      if (method === "models.list_providers") {
        return { providers: ["anthropic", "openai"], count: 2 };
      }
      return {};
    });
    const controller = createSetupWizardController(host, rpc);
    controller.hostConnected();
    await vi.waitFor(() => {
      expect(controller.getSnapshot().catalogProvidersLoading).toBe(false);
    });
    expect(controller.getSnapshot().catalogProviders).toEqual([
      "anthropic",
      "openai",
    ]);
    expect(host._updates).toBeGreaterThan(0);
  });

  it("load: transitions error state on RPC failure with errorMessage set", async () => {
    const host = makeHost();
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      const method = args[0] as string;
      if (method === "models.list_providers") throw new Error("network down");
      return {};
    });
    const controller = createSetupWizardController(host, rpc);
    controller.hostConnected();
    await vi.waitFor(() => {
      expect(controller.getSnapshot().catalogProvidersError).toBe(
        "network down",
      );
    });
    expect(controller.getSnapshot().catalogProviders).toEqual([]);
  });

  it("testConnection: success sets testResult.status to success", async () => {
    const host = makeHost();
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      const method = args[0] as string;
      if (method === "models.list_providers") {
        return { providers: ["anthropic"], count: 1 };
      }
      if (method === "models.test") return {};
      return {};
    });
    const controller = createSetupWizardController(host, rpc);
    controller.selectProvider("anthropic");
    await controller.testConnection();
    expect(controller.getSnapshot().testResult.status).toBe("success");
    expect(controller.getSnapshot().testResult.message).toBe("Connected");
  });

  it("testConnection: failure surfaces error message on snapshot", async () => {
    const host = makeHost();
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      const method = args[0] as string;
      if (method === "models.list_providers") {
        return { providers: ["anthropic"], count: 1 };
      }
      if (method === "models.test") throw new Error("Auth failed");
      return {};
    });
    const controller = createSetupWizardController(host, rpc);
    controller.selectProvider("anthropic");
    await controller.testConnection();
    expect(controller.getSnapshot().testResult.status).toBe("error");
    expect(controller.getSnapshot().testResult.message).toBe("Auth failed");
  });

  it("goNext / goBack: validates current step and advances/regresses currentStep", () => {
    const host = makeHost();
    const rpc = createMockRpcClient();
    const controller = createSetupWizardController(host, rpc);
    // Default tenantId is "default" — passes step 0 validation.
    expect(controller.getSnapshot().currentStep).toBe(0);
    controller.goNext();
    expect(controller.getSnapshot().currentStep).toBe(1);
    controller.goBack();
    expect(controller.getSnapshot().currentStep).toBe(0);
  });

  it("goNext: empty tenantId blocks advance with validation error", () => {
    const host = makeHost();
    const rpc = createMockRpcClient();
    const controller = createSetupWizardController(host, rpc);
    controller.updateWizardData({ tenantId: "" });
    controller.goNext();
    expect(controller.getSnapshot().currentStep).toBe(0);
    expect(controller.getSnapshot().validationErrors["tenantId"]).toBeTruthy();
  });

  it("selectProvider: native key sets providerType to key and triggers model fetch", async () => {
    const host = makeHost();
    const callImpl = vi.fn(async (...args: unknown[]) => {
      const method = args[0] as string;
      const params = (args[1] as Record<string, unknown> | undefined) ?? {};
      if (method === "models.list_providers") {
        return { providers: ["anthropic"], count: 1 };
      }
      if (method === "models.list") {
        return {
          models: [{ modelId: "claude-haiku-4-5", cost: { input: 1, output: 5 } }],
          total: 1,
        };
      }
      return {};
    });
    const rpc = createMockRpcClient(callImpl as unknown as (...args: unknown[]) => unknown);
    const controller = createSetupWizardController(host, rpc);
    controller.selectProvider("anthropic");
    expect(controller.getSnapshot().wizardData.providerName).toBe("anthropic");
    expect(controller.getSnapshot().wizardData.providerType).toBe("anthropic");
    await vi.waitFor(() => {
      expect(controller.getSnapshot().modelOptions.length).toBe(1);
    });
    expect(controller.getSnapshot().modelOptions[0]!.id).toBe(
      "claude-haiku-4-5",
    );
  });

  it("selectProvider: Custom keeps providerType as openai (passthrough)", () => {
    const host = makeHost();
    const rpc = createMockRpcClient();
    const controller = createSetupWizardController(host, rpc);
    controller.selectProvider(CUSTOM_PROVIDER_KEY);
    expect(controller.getSnapshot().wizardData.providerName).toBe(
      CUSTOM_PROVIDER_KEY,
    );
    expect(controller.getSnapshot().wizardData.providerType).toBe("openai");
  });

  it("toggleChannel: enabling auto-expands and sets enabled flag", () => {
    const host = makeHost();
    const rpc = createMockRpcClient();
    const controller = createSetupWizardController(host, rpc);
    controller.toggleChannel("telegram");
    expect(controller.getSnapshot().wizardData.channels["telegram"]!.enabled).toBe(true);
    expect(controller.getSnapshot().expandedChannels.has("telegram")).toBe(true);
  });

  it("applyConfig: invokes config.apply for models when provider+model set", async () => {
    const host = makeHost();
    const calls: Array<{ method: string; params: unknown }> = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      const method = args[0] as string;
      const params = args[1];
      calls.push({ method, params });
      return {};
    });
    const controller = createSetupWizardController(host, rpc);
    controller.updateWizardData({
      providerName: "anthropic",
      defaultModel: "claude-haiku-4-5",
    });
    await controller.applyConfig();
    const applyCalls = calls.filter((c) => c.method === "config.apply");
    expect(applyCalls.length).toBe(1);
    expect(applyCalls[0]!.params).toEqual({
      section: "models",
      value: { defaultProvider: "anthropic", defaultModel: "claude-haiku-4-5" },
    });
    expect(controller.getSnapshot().applyDone).toBe(true);
    expect(controller.getSnapshot().applying).toBe(false);
  });
});
