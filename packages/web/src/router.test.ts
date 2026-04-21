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

  describe("parameterized route matching - all 22 routes", () => {
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

    it("#/channels/telegram -> ic-channel-detail, params { type: 'telegram' }", () => {
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

    it("#/chat/sess-123 -> ic-chat-console, params { sessionKey: 'sess-123' }", () => {
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

    it("#/scheduler/cron-1 -> ic-scheduler-view, params { jobId: 'cron-1' }", () => {
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

    it("#/approvals -> ic-approvals-view, route 'approvals', params {}", () => {
      window.location.hash = "#/approvals";
      const router = createRouter(onChange);
      expect(router.current()).toEqual({
        view: "ic-approvals-view",
        route: "approvals",
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

    it("#/setup -> ic-setup-wizard, route 'setup', params {}", () => {
      window.location.hash = "#/setup";
      const router = createRouter(onChange);
      expect(router.current()).toEqual({
        view: "ic-setup-wizard",
        route: "setup",
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

  describe("route aliases", () => {
    it("#/observe alias redirects to #/observe/overview via replaceState", () => {
      window.location.hash = "#/observe";
      const router = createRouter(onChange);
      const match = router.current();
      expect(match.view).toBe("ic-observe-dashboard");
      expect(match.route).toBe("observe/overview");
      expect(match.params).toEqual({});
      expect(match.query).toEqual({});
    });

    it("alias preserves query parameters during redirect", () => {
      window.location.hash = "#/observe?tab=metrics&range=7d";
      const router = createRouter(onChange);
      const match = router.current();
      expect(match.view).toBe("ic-observe-dashboard");
      expect(match.route).toBe("observe/overview");
      expect(match.query).toEqual({ tab: "metrics", range: "7d" });
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

  describe("setQuery", () => {
    it("updates URL without triggering navigation", () => {
      window.location.hash = "#/sessions";
      const router = createRouter(onChange);
      router.start();
      onChange.mockClear();

      router.setQuery({ filter: "active" });

      // setQuery uses replaceState, should NOT trigger hashchange
      expect(onChange).not.toHaveBeenCalled();
      router.stop();
    });

    it("merges new params with existing query params", () => {
      window.location.hash = "#/sessions?filter=active";
      const router = createRouter(onChange);

      router.setQuery({ sort: "recent" });

      // After setQuery, current() should show merged params
      const match = router.current();
      expect(match.query).toEqual({ filter: "active", sort: "recent" });
    });

    it("removes params with empty string values", () => {
      window.location.hash = "#/sessions?filter=active&sort=recent";
      const router = createRouter(onChange);

      router.setQuery({ filter: "" });

      const match = router.current();
      expect(match.query).toEqual({ sort: "recent" });
    });

    it("clears all query params when all set to empty", () => {
      window.location.hash = "#/sessions?filter=active";
      const router = createRouter(onChange);

      router.setQuery({ filter: "" });

      const match = router.current();
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
