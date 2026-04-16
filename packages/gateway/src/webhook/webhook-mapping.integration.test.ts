/**
 * Webhook mapping integration tests.
 *
 * End-to-end webhook routing tests using real createMappedWebhookEndpoint
 * instances (not mocks).
 *
 * Tests Gmail/GitHub preset routing with template rendering,
 * wake actions, unmatched paths (404), and first-match-wins ordering.
 */
import { describe, it, expect, vi } from "vitest";
import type { WebhookMappingConfig } from "@comis/core";
import { createMappedWebhookEndpoint } from "./webhook-endpoint.js";
import { getPresetMappings } from "./webhook-presets.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMappedEndpoint(
  mappings: WebhookMappingConfig[],
  overrides: {
    onWake?: (...args: unknown[]) => Promise<void>;
    onAgentAction?: (...args: unknown[]) => Promise<void>;
    secret?: string;
  } = {},
) {
  const onWake = overrides.onWake ?? vi.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined);
  const onAgentAction = overrides.onAgentAction ?? vi.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined);

  const app = createMappedWebhookEndpoint({
    mappings,
    secret: overrides.secret,
    onWake: onWake as any,
    onAgentAction: onAgentAction as any,
  });

  return { app, onWake, onAgentAction };
}

function post(
  app: ReturnType<typeof createMappedWebhookEndpoint>,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return app.request(`/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Integration Tests
// ---------------------------------------------------------------------------

describe("webhook mapping integration", () => {
  describe("Gmail preset routing", () => {
    it("routes Gmail payload to onAgentAction with rendered template", async () => {
      const [gmailMapping] = getPresetMappings(["gmail"]);
      const { app, onAgentAction } = makeMappedEndpoint([gmailMapping!]);

      const payload = {
        messages: [
          {
            id: "msg-123",
            from: "user@example.com",
            subject: "Test",
            snippet: "Hello",
            body: "Full body",
          },
        ],
      };

      const res = await post(app, "gmail", payload);

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.received).toBe(true);
      expect(json.mapping).toBe("gmail");

      expect(onAgentAction).toHaveBeenCalledOnce();
      const [_mapping, renderedMessage, renderedSessionKey] =
        (onAgentAction as ReturnType<typeof vi.fn>).mock.calls[0]!;

      // Template should render email metadata
      expect(renderedMessage).toContain("New email from user@example.com");
      expect(renderedMessage).toContain("Subject: Test");
      expect(renderedMessage).toContain("Hello");
      expect(renderedMessage).toContain("Full body");

      // Session key should contain message ID
      expect(renderedSessionKey).toContain("msg-123");
    });
  });

  describe("GitHub preset routing", () => {
    it("routes GitHub webhook to onAgentAction with event headers", async () => {
      const [githubMapping] = getPresetMappings(["github"]);
      const { app, onAgentAction } = makeMappedEndpoint([githubMapping!]);

      const payload = {
        repository: { full_name: "org/repo" },
        action: "completed",
        sender: { login: "octocat" },
      };

      const res = await post(app, "github", payload, {
        "x-github-event": "push",
        "x-github-delivery": "abc-123",
      });

      expect(res.status).toBe(200);

      expect(onAgentAction).toHaveBeenCalledOnce();
      const [_mapping, renderedMessage, renderedSessionKey] =
        (onAgentAction as ReturnType<typeof vi.fn>).mock.calls[0]!;

      // Template should render GitHub event info
      expect(renderedMessage).toContain("GitHub push");
      expect(renderedMessage).toContain("org/repo");
      expect(renderedMessage).toContain("completed");
      expect(renderedMessage).toContain("octocat");

      // Session key should contain delivery ID
      expect(renderedSessionKey).toContain("abc-123");
    });
  });

  describe("wake action", () => {
    it("calls onWake for wake-action mappings", async () => {
      const wakeMapping: WebhookMappingConfig = {
        id: "wake-test",
        match: { path: "wake" },
        action: "wake",
        wakeMode: "now",
      };

      const { app, onWake, onAgentAction } = makeMappedEndpoint([wakeMapping]);

      const res = await post(app, "wake", { ping: true });

      expect(res.status).toBe(200);
      expect(onWake).toHaveBeenCalledOnce();
      expect(onAgentAction).not.toHaveBeenCalled();
    });
  });

  describe("unmatched path", () => {
    it("returns 404 for unmatched path", async () => {
      const presets = getPresetMappings(["gmail", "github"]);
      const { app } = makeMappedEndpoint(presets);

      const res = await post(app, "unknown", { data: true });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error).toContain("No matching");
    });
  });

  describe("first-match-wins ordering", () => {
    it("first matching mapping wins when paths overlap", async () => {
      const mapping1: WebhookMappingConfig = {
        id: "first-wake",
        match: { path: "deploy" },
        action: "wake",
        wakeMode: "now",
      };
      const mapping2: WebhookMappingConfig = {
        id: "second-agent",
        match: { path: "deploy" },
        action: "agent",
        messageTemplate: "Deploy event",
        sessionKey: "deploy-key",
      };

      const { app, onWake, onAgentAction } = makeMappedEndpoint([
        mapping1,
        mapping2,
      ]);

      const res = await post(app, "deploy", { event: "deploy" });

      expect(res.status).toBe(200);
      // First mapping wins — wake action, not agent action
      expect(onWake).toHaveBeenCalledOnce();
      expect(onAgentAction).not.toHaveBeenCalled();
    });
  });
});
