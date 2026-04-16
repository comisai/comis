import { describe, it, expect } from "vitest";
import * as gateway from "./index.js";

describe("gateway barrel exports smoke test", () => {
  // Server
  it("exports createGatewayServer", () => {
    expect(typeof gateway.createGatewayServer).toBe("function");
  });

  // Auth — Token
  it("exports createTokenStore", () => {
    expect(typeof gateway.createTokenStore).toBe("function");
  });

  it("exports extractBearerToken", () => {
    expect(typeof gateway.extractBearerToken).toBe("function");
  });

  // Rate limiting
  it("exports createRateLimiter", () => {
    expect(typeof gateway.createRateLimiter).toBe("function");
  });

  // RPC — method router
  it("exports createDynamicMethodRouter", () => {
    expect(typeof gateway.createDynamicMethodRouter).toBe("function");
  });

  // RPC — adapters
  it("exports createRpcAdapters", () => {
    expect(typeof gateway.createRpcAdapters).toBe("function");
  });

  // RPC — WebSocket
  it("exports WsConnectionManager", () => {
    expect(typeof gateway.WsConnectionManager).toBe("function");
  });

  // Webhook
  it("exports createMappedWebhookEndpoint", () => {
    expect(typeof gateway.createMappedWebhookEndpoint).toBe("function");
  });

  it("exports getPresetMappings", () => {
    expect(typeof gateway.getPresetMappings).toBe("function");
  });

  // Web — media routes
  it("exports createMediaRoutes", () => {
    expect(typeof gateway.createMediaRoutes).toBe("function");
  });

  // OpenAI compatibility
  it("exports createOpenaiCompletionsRoute", () => {
    expect(typeof gateway.createOpenaiCompletionsRoute).toBe("function");
  });

  it("exports createOpenaiModelsRoute", () => {
    expect(typeof gateway.createOpenaiModelsRoute).toBe("function");
  });

  it("exports createOpenaiEmbeddingsRoute", () => {
    expect(typeof gateway.createOpenaiEmbeddingsRoute).toBe("function");
  });

  // OpenResponses
  it("exports createResponsesRoute", () => {
    expect(typeof gateway.createResponsesRoute).toBe("function");
  });

  // ACP
  it("exports createAcpAgent", () => {
    expect(typeof gateway.createAcpAgent).toBe("function");
  });

  // mDNS
  it("exports createMdnsAdvertiser", () => {
    expect(typeof gateway.createMdnsAdvertiser).toBe("function");
  });

  // Total count check (20 exports: 16 values + 4 types, types not visible at runtime)
  it("exports at least 16 named value exports", () => {
    const exportNames = Object.keys(gateway);
    expect(exportNames.length).toBeGreaterThanOrEqual(16);
  });
});
