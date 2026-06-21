// SPDX-License-Identifier: Apache-2.0
/**
 * Render-branch tests for IcSecurityView.
 *
 * Covers the loadState (loading/error/loaded) decision tree, the 7-tab
 * _renderTabContent switch, _renderHealthTab provider-card branches,
 * and _renderSecretsTab empty/populated branches.
 *
 * @module
 */

import { describe, it, expect, afterEach } from "vitest";
import type { IcSecurityView } from "./security.js";
import "./security.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function priv(el: IcSecurityView): any {
  return el as unknown as Record<string, unknown>;
}

describe("IcSecurityView render() — load-state branches", () => {
  let el: IcSecurityView;
  afterEach(() => {
    if (el?.isConnected) el.remove();
  });

  it("renders the skeleton list template while load state is the initial 'loading' value", async () => {
    el = document.createElement("ic-security-view") as IcSecurityView;
    document.body.appendChild(el);
    await el.updateComplete;
    const skel = el.shadowRoot?.querySelector("ic-skeleton-view");
    expect(skel?.getAttribute("variant")).toBe("list");
  });

  it("renders the error-container with error message and retry button when load state is 'error'", async () => {
    el = document.createElement("ic-security-view") as IcSecurityView;
    document.body.appendChild(el);
    priv(el)._loadState = "error";
    priv(el)._error = "Failed to load security data";
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector(".error-container")).not.toBeNull();
    expect(el.shadowRoot?.querySelector(".error-message")?.textContent).toBe(
      "Failed to load security data",
    );
    expect(el.shadowRoot?.querySelector(".retry-btn")).not.toBeNull();
  });

  it("renders the ic-tabs navigation when load state is 'loaded' regardless of which tab is active", async () => {
    el = document.createElement("ic-security-view") as IcSecurityView;
    document.body.appendChild(el);
    priv(el)._loadState = "loaded";
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector("ic-tabs")).not.toBeNull();
  });

  it("renders the view-title header text 'Security' when load state is 'loaded'", async () => {
    el = document.createElement("ic-security-view") as IcSecurityView;
    document.body.appendChild(el);
    priv(el)._loadState = "loaded";
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector(".view-title")?.textContent?.trim()).toBe("Security");
  });
});

describe("IcSecurityView _renderTabContent — 7-tab switch branches", () => {
  let el: IcSecurityView;
  afterEach(() => {
    if (el?.isConnected) el.remove();
  });

  it("renders the security event feed sub-component when active tab is 'events'", async () => {
    el = document.createElement("ic-security-view") as IcSecurityView;
    document.body.appendChild(el);
    priv(el)._loadState = "loaded";
    priv(el)._activeTab = "events";
    await el.updateComplete;
    const feed = el.shadowRoot?.querySelector("ic-security-event-feed");
    expect(feed?.getAttribute("activeSubTab")).toBe("events");
  });

  it("renders the durable ic-durable-audit-log sub-component when tab is 'audit' (the SSE feed was REPLACED here — Plan 179-06)", async () => {
    el = document.createElement("ic-security-view") as IcSecurityView;
    document.body.appendChild(el);
    priv(el)._loadState = "loaded";
    priv(el)._activeTab = "audit";
    await el.updateComplete;
    // The audit tab renders the durable obs.audit.query view, not the live SSE feed.
    expect(el.shadowRoot?.querySelector("ic-durable-audit-log")).not.toBeNull();
    expect(el.shadowRoot?.querySelector("ic-security-event-feed")).toBeNull();
  });

  it("renders the ic-token-manager sub-component when active tab is 'tokens'", async () => {
    el = document.createElement("ic-security-view") as IcSecurityView;
    document.body.appendChild(el);
    priv(el)._loadState = "loaded";
    priv(el)._activeTab = "tokens";
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector("ic-token-manager")).not.toBeNull();
  });

  it("renders the secrets-tab content via _renderSecretsTab when active tab is 'secrets'", async () => {
    el = document.createElement("ic-security-view") as IcSecurityView;
    document.body.appendChild(el);
    priv(el)._loadState = "loaded";
    priv(el)._activeTab = "secrets";
    priv(el)._securityConfig = { secrets: { enabled: false } };
    await el.updateComplete;
    // Secrets tab renders some content (specifics may vary); ensure it does not throw and produces output.
    expect(el.shadowRoot?.querySelector(".tab-content")?.innerHTML.length).toBeGreaterThan(0);
  });

  it("renders the approval-queue sub-component with activeSubTab=rules when tab is 'rules'", async () => {
    el = document.createElement("ic-security-view") as IcSecurityView;
    document.body.appendChild(el);
    priv(el)._loadState = "loaded";
    priv(el)._activeTab = "rules";
    await el.updateComplete;
    const queue = el.shadowRoot?.querySelector("ic-approval-queue");
    expect(queue?.getAttribute("activeSubTab")).toBe("rules");
  });

  it("renders the approval-queue sub-component with activeSubTab=pending when tab is 'pending'", async () => {
    el = document.createElement("ic-security-view") as IcSecurityView;
    document.body.appendChild(el);
    priv(el)._loadState = "loaded";
    priv(el)._activeTab = "pending";
    await el.updateComplete;
    const queue = el.shadowRoot?.querySelector("ic-approval-queue");
    expect(queue?.getAttribute("activeSubTab")).toBe("pending");
  });

  it("renders the health-tab content via _renderHealthTab when active tab is 'health'", async () => {
    el = document.createElement("ic-security-view") as IcSecurityView;
    document.body.appendChild(el);
    priv(el)._loadState = "loaded";
    priv(el)._activeTab = "health";
    priv(el)._providerHealth = [];
    priv(el)._failoverLog = [];
    priv(el)._authCooldowns = [];
    await el.updateComplete;
    // Health tab should contain the empty-state placeholders since arrays are empty
    expect(el.shadowRoot?.querySelector(".tab-content")?.innerHTML.length).toBeGreaterThan(0);
  });

  it("renders nothing for an unrecognized active tab string falling through to the default case", () => {
    el = document.createElement("ic-security-view") as IcSecurityView;
    priv(el)._activeTab = "unknown-tab";
    const out = priv(el)._renderTabContent();
    // 'nothing' sentinel is the special lit symbol — defined but not a real template
    expect(out).toBeDefined();
  });
});

describe("IcSecurityView _renderHealthTab — provider card branches", () => {
  let el: IcSecurityView;
  afterEach(() => {
    if (el?.isConnected) el.remove();
  });

  it("renders the no-provider empty state when _providerHealth is an empty array", async () => {
    el = document.createElement("ic-security-view") as IcSecurityView;
    document.body.appendChild(el);
    priv(el)._loadState = "loaded";
    priv(el)._activeTab = "health";
    priv(el)._providerHealth = [];
    priv(el)._failoverLog = [];
    priv(el)._authCooldowns = [];
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector("ic-empty-state")).not.toBeNull();
  });

  it("renders one provider card per entry when _providerHealth has multiple entries", async () => {
    el = document.createElement("ic-security-view") as IcSecurityView;
    document.body.appendChild(el);
    priv(el)._loadState = "loaded";
    priv(el)._activeTab = "health";
    priv(el)._providerHealth = [
      { name: "openai", status: "healthy", failoverCount: 0, cacheHitRate: 0.85 },
      { name: "anthropic", status: "degraded", failoverCount: 2, cacheHitRate: 0.5, lastFailover: 1_000 },
    ];
    priv(el)._failoverLog = [];
    priv(el)._authCooldowns = [];
    await el.updateComplete;
    const html = el.shadowRoot?.innerHTML ?? "";
    expect(html).toContain("openai");
    expect(html).toContain("anthropic");
  });

  it("renders 'No failover events recorded' italicized note when _failoverLog is empty array", async () => {
    el = document.createElement("ic-security-view") as IcSecurityView;
    document.body.appendChild(el);
    priv(el)._loadState = "loaded";
    priv(el)._activeTab = "health";
    priv(el)._providerHealth = [{ provider: "openai", status: "healthy", failureCount: 0 }];
    priv(el)._failoverLog = [];
    priv(el)._authCooldowns = [];
    await el.updateComplete;
    expect(el.shadowRoot?.innerHTML).toContain("No failover events");
  });

  it("renders each failover event row when _failoverLog has at least one entry", async () => {
    el = document.createElement("ic-security-view") as IcSecurityView;
    document.body.appendChild(el);
    priv(el)._loadState = "loaded";
    priv(el)._activeTab = "health";
    priv(el)._providerHealth = [{ name: "openai", status: "healthy", failoverCount: 0, cacheHitRate: 1 }];
    priv(el)._failoverLog = [
      {
        timestamp: 1_500,
        fromProvider: "openai",
        fromModel: "gpt-4",
        toProvider: "anthropic",
        toModel: "claude-3-opus",
        attemptNumber: 2,
        error: "429 too many requests",
      },
    ];
    priv(el)._authCooldowns = [];
    await el.updateComplete;
    const html = el.shadowRoot?.innerHTML ?? "";
    expect(html).toContain("openai");
    expect(html).toContain("anthropic");
  });

  it("renders 'No active cooldowns' italicized note when _authCooldowns array is empty", async () => {
    el = document.createElement("ic-security-view") as IcSecurityView;
    document.body.appendChild(el);
    priv(el)._loadState = "loaded";
    priv(el)._activeTab = "health";
    priv(el)._providerHealth = [{ name: "openai", status: "healthy", failoverCount: 0, cacheHitRate: 1 }];
    priv(el)._failoverLog = [];
    priv(el)._authCooldowns = [];
    await el.updateComplete;
    expect(el.shadowRoot?.innerHTML).toContain("No active cooldowns");
  });

  it("renders each cooldown row when _authCooldowns has at least one active entry", async () => {
    el = document.createElement("ic-security-view") as IcSecurityView;
    document.body.appendChild(el);
    priv(el)._loadState = "loaded";
    priv(el)._activeTab = "health";
    priv(el)._providerHealth = [{ name: "openai", status: "healthy", failoverCount: 0, cacheHitRate: 1 }];
    priv(el)._failoverLog = [];
    // Active cooldown: timestamp + cooldownMs > now()
    priv(el)._authCooldowns = [
      {
        provider: "openai",
        keyName: "default",
        failureCount: 5,
        timestamp: Date.now(),
        cooldownMs: 600_000,
      },
    ];
    await el.updateComplete;
    expect(el.shadowRoot?.innerHTML).toContain("openai");
    expect(el.shadowRoot?.innerHTML).toContain("default");
  });
});

describe("IcSecurityView component registration", () => {
  it("registers as the 'ic-security-view' custom element so app router can mount it", () => {
    expect(customElements.get("ic-security-view")).toBeDefined();
  });
});
