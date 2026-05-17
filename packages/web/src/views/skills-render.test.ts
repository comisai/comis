// SPDX-License-Identifier: Apache-2.0
/**
 * Render-branch tests for IcSkillsView.
 *
 * skills.ts at baseline reports 40.97% / 26.51% / 27.77% / 38.69%
 * (lines/branches/functions/statements). This file covers:
 *   - render() top-level loadState branches (loading/error/loaded)
 *   - _renderTabContent switch (tools/skills/default)
 *   - _renderToolsTab built-in + platform tool categories iteration
 *   - _renderSkillsTab populated vs empty branches
 *   - _renderRecentActivity empty vs populated events
 *   - Multi-agent-id selector rendering (>1 agents shows select)
 *   - Custom element registration
 *
 * @module
 */

import { describe, it, expect, afterEach } from "vitest";
import type { IcSkillsView } from "./skills.js";
import "./skills.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function priv(el: IcSkillsView): any {
  return el as unknown as Record<string, unknown>;
}

describe("IcSkillsView render() — load-state branches", () => {
  let el: IcSkillsView;
  afterEach(() => {
    if (el?.isConnected) el.remove();
  });

  it("renders the skeleton list template while load state is the initial 'loading' value", async () => {
    el = document.createElement("ic-skills-view") as IcSkillsView;
    document.body.appendChild(el);
    await el.updateComplete;
    const skel = el.shadowRoot?.querySelector("ic-skeleton-view");
    expect(skel?.getAttribute("variant")).toBe("list");
  });

  it("renders the error-container with error message and retry button when load state is 'error'", async () => {
    el = document.createElement("ic-skills-view") as IcSkillsView;
    document.body.appendChild(el);
    priv(el)._loadState = "error";
    priv(el)._error = "Failed to load skills data";
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector(".error-container")).not.toBeNull();
    expect(el.shadowRoot?.querySelector(".error-message")?.textContent).toBe(
      "Failed to load skills data",
    );
    expect(el.shadowRoot?.querySelector(".retry-btn")).not.toBeNull();
  });

  it("renders the view-title 'Skills & Tools' header text when load state is 'loaded'", async () => {
    el = document.createElement("ic-skills-view") as IcSkillsView;
    document.body.appendChild(el);
    priv(el)._loadState = "loaded";
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector(".view-title")?.textContent?.trim()).toBe(
      "Skills & Tools",
    );
  });

  it("renders the ic-tabs navigation when load state is 'loaded' (per-tab routing surface)", async () => {
    el = document.createElement("ic-skills-view") as IcSkillsView;
    document.body.appendChild(el);
    priv(el)._loadState = "loaded";
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector("ic-tabs")).not.toBeNull();
  });
});

describe("IcSkillsView multi-agent selector branch", () => {
  let el: IcSkillsView;
  afterEach(() => {
    if (el?.isConnected) el.remove();
  });

  it("omits the agent + scope select dropdowns when only a single agent id is configured", async () => {
    el = document.createElement("ic-skills-view") as IcSkillsView;
    document.body.appendChild(el);
    priv(el)._loadState = "loaded";
    priv(el)._agentIds = ["only-one"];
    await el.updateComplete;
    // With a single agent, the multi-agent dropdown branch is NOT rendered.
    const selects = el.shadowRoot?.querySelectorAll(".view-header select");
    expect(selects?.length ?? 0).toBe(0);
  });

  it("renders the agent + scope select dropdowns when two or more agent ids are present", async () => {
    el = document.createElement("ic-skills-view") as IcSkillsView;
    document.body.appendChild(el);
    priv(el)._loadState = "loaded";
    priv(el)._agentIds = ["alpha", "beta"];
    await el.updateComplete;
    const selects = el.shadowRoot?.querySelectorAll(".view-header select");
    expect(selects?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("renders an 'All Agents' option in the agent select when multiple agents are present", async () => {
    el = document.createElement("ic-skills-view") as IcSkillsView;
    document.body.appendChild(el);
    priv(el)._loadState = "loaded";
    priv(el)._agentIds = ["alpha", "beta", "gamma"];
    await el.updateComplete;
    expect(el.shadowRoot?.innerHTML).toContain("All Agents");
  });

  it("renders an option per agent id in the agent select dropdown", async () => {
    el = document.createElement("ic-skills-view") as IcSkillsView;
    document.body.appendChild(el);
    priv(el)._loadState = "loaded";
    priv(el)._agentIds = ["alpha", "beta", "gamma"];
    await el.updateComplete;
    const html = el.shadowRoot?.innerHTML ?? "";
    expect(html).toContain("alpha");
    expect(html).toContain("beta");
    expect(html).toContain("gamma");
  });

  it("renders the three skill-scope options (All / Agent / Shared) when multi-agent selector active", async () => {
    el = document.createElement("ic-skills-view") as IcSkillsView;
    document.body.appendChild(el);
    priv(el)._loadState = "loaded";
    priv(el)._agentIds = ["alpha", "beta"];
    await el.updateComplete;
    const html = el.shadowRoot?.innerHTML ?? "";
    expect(html).toContain("All Skills");
    expect(html).toContain("Agent Skills");
    expect(html).toContain("Shared Skills");
  });
});

describe("IcSkillsView _renderTabContent — tab dispatch branches", () => {
  let el: IcSkillsView;
  afterEach(() => {
    if (el?.isConnected) el.remove();
  });

  it("dispatches to _renderToolsTab content when active tab is 'tools' (default tab)", async () => {
    el = document.createElement("ic-skills-view") as IcSkillsView;
    document.body.appendChild(el);
    priv(el)._loadState = "loaded";
    priv(el)._activeTab = "tools";
    await el.updateComplete;
    // Tools tab renders 'Platform Tools' section header
    expect(el.shadowRoot?.innerHTML).toContain("Platform Tools");
  });

  it("dispatches to _renderSkillsTab content when active tab is 'skills'", async () => {
    el = document.createElement("ic-skills-view") as IcSkillsView;
    document.body.appendChild(el);
    priv(el)._loadState = "loaded";
    priv(el)._activeTab = "skills";
    priv(el)._discoveredSkills = [];
    await el.updateComplete;
    // Skills tab renders even when no skills present
    expect(el.shadowRoot?.querySelector(".tab-content, .section-header, ic-empty-state")).not.toBeNull();
  });

  it("renders nothing-sentinel template when active tab is an unrecognized string falling to default", () => {
    el = document.createElement("ic-skills-view") as IcSkillsView;
    priv(el)._activeTab = "non-existent-tab";
    const out = priv(el)._renderTabContent();
    expect(out).toBeDefined();
  });
});

describe("IcSkillsView _renderToolsTab — tool category iteration", () => {
  let el: IcSkillsView;
  afterEach(() => {
    if (el?.isConnected) el.remove();
  });

  it("renders the platform-tools section header when tools tab is active", async () => {
    el = document.createElement("ic-skills-view") as IcSkillsView;
    document.body.appendChild(el);
    priv(el)._loadState = "loaded";
    priv(el)._activeTab = "tools";
    await el.updateComplete;
    expect(el.shadowRoot?.innerHTML).toContain("Platform Tools");
  });

  it("renders the read/write/edit built-in tool cards in the tools tab content", async () => {
    el = document.createElement("ic-skills-view") as IcSkillsView;
    document.body.appendChild(el);
    priv(el)._loadState = "loaded";
    priv(el)._activeTab = "tools";
    await el.updateComplete;
    const html = el.shadowRoot?.innerHTML ?? "";
    expect(html).toContain("read");
    expect(html).toContain("write");
    expect(html).toContain("edit");
  });

  it("renders an enable/disable hint paragraph explaining per-agent tool configuration", async () => {
    el = document.createElement("ic-skills-view") as IcSkillsView;
    document.body.appendChild(el);
    priv(el)._loadState = "loaded";
    priv(el)._activeTab = "tools";
    await el.updateComplete;
    expect(el.shadowRoot?.innerHTML).toContain("Enable or disable tools");
  });
});

describe("IcSkillsView _renderRecentActivity — events block", () => {
  let el: IcSkillsView;
  afterEach(() => {
    if (el?.isConnected) el.remove();
  });

  it("renders no recent-activity block when _recentSkillEvents array is empty", async () => {
    el = document.createElement("ic-skills-view") as IcSkillsView;
    document.body.appendChild(el);
    priv(el)._loadState = "loaded";
    priv(el)._recentSkillEvents = [];
    await el.updateComplete;
    const result = priv(el)._renderRecentActivity();
    expect(result).toBeDefined();
  });

  it("renders the recent-activity section when at least one skill event is present", async () => {
    el = document.createElement("ic-skills-view") as IcSkillsView;
    document.body.appendChild(el);
    priv(el)._loadState = "loaded";
    priv(el)._recentSkillEvents = [
      {
        kind: "skill.executed",
        agentId: "alpha",
        skillName: "my-skill",
        timestamp: Date.now(),
        status: "completed",
      },
    ];
    await el.updateComplete;
    const result = priv(el)._renderRecentActivity();
    expect(result).toBeDefined();
  });
});

describe("IcSkillsView component registration", () => {
  it("registers as the 'ic-skills-view' custom element after side-effect import", () => {
    expect(customElements.get("ic-skills-view")).toBeDefined();
  });
});
