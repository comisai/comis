// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import { createRouter, type RouteMatch } from "./router.js";

type OnChangeFn = (match: RouteMatch) => void;

describe("createRouter", () => {
  let onChange: Mock<OnChangeFn>;

  beforeEach(() => {
    window.location.hash = "";
    onChange = vi.fn<OnChangeFn>();
  });

  afterEach(() => {
    window.location.hash = "";
  });

  describe("parameterized route matching - 21 representative tests over 38 routes", () => {
    it("#/dashboard -> ic-dashboard, route 'dashboard', params {}", () => {
      window.location.hash = "#/dashboard";
      const router = createRouter(onChange);
      const match = router.current();
      expect(match.view).toBe("ic-dashboard");
      expect(match.route).toBe("dashboard");
      expect(match.params).toEqual({});
      expect(match.query).toEqual({});
    });

    it("#/agents -> ic-agent-list, route 'agents', params {}", () => {
      window.location.hash = "#/agents";
      const router = createRouter(onChange);
      expect(router.current()).toEqual({
        view: "ic-agent-list",
        route: "agents",
        params: {},
        query: {},
      });
    });

    it("#/agents/default -> ic-agent-detail, route 'agents/:id', params { id: 'default' }", () => {
      window.location.hash = "#/agents/default";
      const router = createRouter(onChange);
      expect(router.current()).toEqual({
        view: "ic-agent-detail",
        route: "agents/:id",
        params: { id: "default" },
        query: {},
      });
    });

    it("#/agents/default/edit -> ic-agent-editor, route 'agents/:id/edit', params { id: 'default' }", () => {
      window.location.hash = "#/agents/default/edit";
      const router = createRouter(onChange);
      expect(router.current()).toEqual({
        view: "ic-agent-editor",
        route: "agents/:id/edit",
        params: { id: "default" },
        query: {},
      });
    });

    it("#/channels -> ic-channel-list, route 'channels', params {}", () => {
      window.location.hash = "#/channels";
      const router = createRouter(onChange);
      expect(router.current()).toEqual({
        view: "ic-channel-list",
        route: "channels",
        params: {},
        query: {},
      });
    });

    it("routes hash '#/channels/telegram' to ic-channel-detail with params type=telegram", () => {
      window.location.hash = "#/channels/telegram";
      const router = createRouter(onChange);
      expect(router.current()).toEqual({
        view: "ic-channel-detail",
        route: "channels/:type",
        params: { type: "telegram" },
        query: {},
      });
    });

    it("#/skills -> ic-skills-view, route 'skills', params {}", () => {
      window.location.hash = "#/skills";
      const router = createRouter(onChange);
      expect(router.current()).toEqual({
        view: "ic-skills-view",
        route: "skills",
        params: {},
        query: {},
      });
    });

    it("#/chat -> ic-chat-console, route 'chat', params {}", () => {
      window.location.hash = "#/chat";
      const router = createRouter(onChange);
      expect(router.current()).toEqual({
        view: "ic-chat-console",
        route: "chat",
        params: {},
        query: {},
      });
    });

    it("routes hash '#/chat/sess-123' to ic-chat-console with params sessionKey=sess-123", () => {
      window.location.hash = "#/chat/sess-123";
      const router = createRouter(onChange);
      expect(router.current()).toEqual({
        view: "ic-chat-console",
        route: "chat/:sessionKey",
        params: { sessionKey: "sess-123" },
        query: {},
      });
    });

    it("#/memory -> ic-memory-inspector, route 'memory', params {}", () => {
      window.location.hash = "#/memory";
      const router = createRouter(onChange);
      expect(router.current()).toEqual({
        view: "ic-memory-inspector",
        route: "memory",
        params: {},
        query: {},
      });
    });

    it("#/sessions -> ic-session-list-view, route 'sessions', params {}", () => {
      window.location.hash = "#/sessions";
      const router = createRouter(onChange);
      expect(router.current()).toEqual({
        view: "ic-session-list-view",
        route: "sessions",
        params: {},
        query: {},
      });
    });

    it("#/sessions/agent:default:telegram:12345 -> ic-session-detail, params { key: 'agent:default:telegram:12345' }", () => {
      window.location.hash = "#/sessions/agent:default:telegram:12345";
      const router = createRouter(onChange);
      expect(router.current()).toEqual({
        view: "ic-session-detail",
        route: "sessions/:key",
        params: { key: "agent:default:telegram:12345" },
        query: {},
      });
    });

    it("#/scheduler -> ic-scheduler-view, route 'scheduler', params {}", () => {
      window.location.hash = "#/scheduler";
      const router = createRouter(onChange);
      expect(router.current()).toEqual({
        view: "ic-scheduler-view",
        route: "scheduler",
        params: {},
        query: {},
      });
    });

    it("routes hash '#/scheduler/cron-1' to ic-scheduler-view with params jobId=cron-1", () => {
      window.location.hash = "#/scheduler/cron-1";
      const router = createRouter(onChange);
      expect(router.current()).toEqual({
        view: "ic-scheduler-view",
        route: "scheduler/:jobId",
        params: { jobId: "cron-1" },
        query: {},
      });
    });

    it("#/models -> ic-models-view, route 'models', params {}", () => {
      window.location.hash = "#/models";
      const router = createRouter(onChange);
      expect(router.current()).toEqual({
        view: "ic-models-view",
        route: "models",
        params: {},
        query: {},
      });
    });

    it("#/observe/overview -> ic-observe-dashboard, route 'observe/overview', params {}", () => {
      window.location.hash = "#/observe/overview";
      const router = createRouter(onChange);
      expect(router.current()).toEqual({
        view: "ic-observe-dashboard",
        route: "observe/overview",
        params: {},
        query: {},
      });
    });

    it("#/observe/billing -> ic-billing-view, route 'observe/billing', params {}", () => {
      window.location.hash = "#/observe/billing";
      const router = createRouter(onChange);
      expect(router.current()).toEqual({
        view: "ic-billing-view",
        route: "observe/billing",
        params: {},
        query: {},
      });
    });

    it("#/observe/delivery -> ic-delivery-view, route 'observe/delivery', params {}", () => {
      window.location.hash = "#/observe/delivery";
      const router = createRouter(onChange);
      expect(router.current()).toEqual({
        view: "ic-delivery-view",
        route: "observe/delivery",
        params: {},
        query: {},
      });
    });

    it("#/observe/cache -> ic-cache-health-view, route 'observe/cache', params {}", () => {
      window.location.hash = "#/observe/cache";
      const router = createRouter(onChange);
      expect(router.current()).toEqual({
        view: "ic-cache-health-view",
        route: "observe/cache",
        params: {},
        query: {},
      });
    });

    it("#/observe/spend -> ic-spend-governance-view, route 'observe/spend', params {}", () => {
      window.location.hash = "#/observe/spend";
      const router = createRouter(onChange);
      expect(router.current()).toEqual({
        view: "ic-spend-governance-view",
        route: "observe/spend",
        params: {},
        query: {},
      });
    });

    it("#/observe/incident -> ic-incident-view, route 'observe/incident', params {}", () => {
      window.location.hash = "#/observe/incident";
      const router = createRouter(onChange);
      expect(router.current()).toEqual({
        view: "ic-incident-view",
        route: "observe/incident",
        params: {},
        query: {},
      });
    });

    it("#/observe/incident?ref=<key> -> ic-incident-view carrying the obs.explain ref in query", () => {
      window.location.hash = "#/observe/incident?ref=agent:default:telegram:12345";
      const router = createRouter(onChange);
      const match = router.current();
      expect(match.view).toBe("ic-incident-view");
      expect(match.route).toBe("observe/incident");
      // The drill resolves to a valid obs.explain ref carried in the query string.
      expect(match.query).toEqual({ ref: "agent:default:telegram:12345" });
    });

    it("#/security -> ic-security-view, route 'security', params {}", () => {
      window.location.hash = "#/security";
      const router = createRouter(onChange);
      expect(router.current()).toEqual({
        view: "ic-security-view",
        route: "security",
        params: {},
        query: {},
      });
    });

    it("#/config -> ic-config-editor, route 'config', params {}", () => {
      window.location.hash = "#/config";
      const router = createRouter(onChange);
      expect(router.current()).toEqual({
        view: "ic-config-editor",
        route: "config",
        params: {},
        query: {},
      });
    });

    it("returns the dashboard for the unsupported browser setup route", () => {
      window.location.hash = "#/setup";
      const router = createRouter(onChange);
      expect(router.current()).toEqual({
        view: "ic-dashboard",
        route: "dashboard",
        params: {},
        query: {},
      });
    });
  });

  describe("default route and edge cases", () => {
    it("returns dashboard when hash is empty", () => {
      const router = createRouter(onChange);
      const match = router.current();
      expect(match.view).toBe("ic-dashboard");
      expect(match.route).toBe("dashboard");
      expect(match.params).toEqual({});
      expect(match.query).toEqual({});
    });

    it("returns dashboard for unknown route", () => {
      window.location.hash = "#/nonexistent";
      const router = createRouter(onChange);
      expect(router.current().view).toBe("ic-dashboard");
    });

    it("longest match wins: #/observe/billing matches observe/billing not observe with param", () => {
      window.location.hash = "#/observe/billing";
      const router = createRouter(onChange);
      const match = router.current();
      expect(match.route).toBe("observe/billing");
      expect(match.view).toBe("ic-billing-view");
      expect(match.params).toEqual({});
    });
  });

  describe("query parameter parsing", () => {
    it("parses query parameters from hash", () => {
      window.location.hash = "#/sessions?filter=active&sort=recent";
      const router = createRouter(onChange);
      const match = router.current();
      expect(match.view).toBe("ic-session-list-view");
      expect(match.route).toBe("sessions");
      expect(match.query).toEqual({ filter: "active", sort: "recent" });
    });

    it("RouteMatch.query is empty object when no query string", () => {
      window.location.hash = "#/agents";
      const router = createRouter(onChange);
      const match = router.current();
      expect(match.query).toEqual({});
    });

    it("handles query params with encoded characters", () => {
      window.location.hash = "#/sessions?search=hello%20world&tag=foo%26bar";
      const router = createRouter(onChange);
      const match = router.current();
      expect(match.query).toEqual({ search: "hello world", tag: "foo&bar" });
    });

    it("handles query params without values (flag-style)", () => {
      window.location.hash = "#/sessions?debug";
      const router = createRouter(onChange);
      const match = router.current();
      expect(match.query).toEqual({ debug: "" });
    });

    it("handles empty query string after ?", () => {
      window.location.hash = "#/agents?";
      const router = createRouter(onChange);
      const match = router.current();
      expect(match.view).toBe("ic-agent-list");
      expect(match.query).toEqual({});
    });
  });

  describe("navigation", () => {
    it("navigate() sets window.location.hash", () => {
      const router = createRouter(onChange);
      router.navigate("agents");
      expect(window.location.hash).toBe("#/agents");
    });

    it("start() calls onChange with current route immediately", () => {
      window.location.hash = "#/skills";
      const router = createRouter(onChange);
      router.start();

      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange.mock.calls[0][0]).toEqual({
        view: "ic-skills-view",
        route: "skills",
        params: {},
        query: {},
      });
      router.stop();
    });

    it("start() calls onChange with default route when hash is empty", () => {
      const router = createRouter(onChange);
      router.start();

      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange.mock.calls[0][0].view).toBe("ic-dashboard");
      router.stop();
    });

    it("stop() removes hashchange listener", () => {
      const router = createRouter(onChange);
      router.start();
      onChange.mockClear();

      router.stop();

      window.location.hash = "#/memory";
      window.dispatchEvent(new HashChangeEvent("hashchange"));

      expect(onChange).not.toHaveBeenCalled();
    });

    it("hashchange triggers onChange with new RouteMatch", () => {
      const router = createRouter(onChange);
      router.start();
      onChange.mockClear();

      window.location.hash = "#/agents/test-agent";
      window.dispatchEvent(new HashChangeEvent("hashchange"));

      expect(onChange).toHaveBeenCalled();
      // Find the call that matches our expected route (may be called once or twice
      // depending on happy-dom behavior)
      const matchingCall = onChange.mock.calls.find(
        (args) => args[0].route === "agents/:id",
      );
      expect(matchingCall).toBeTruthy();
      expect(matchingCall![0]).toEqual({
        view: "ic-agent-detail",
        route: "agents/:id",
        params: { id: "test-agent" },
        query: {},
      });
      router.stop();
    });
  });
});
