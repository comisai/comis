// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach, vi } from "vitest";
import { IcAgentCard } from "./agent-card.js";

// Import side-effect to register custom element
import "./agent-card.js";

async function createElement<T extends HTMLElement>(
  tag: string,
  props?: Record<string, unknown>,
): Promise<T> {
  const el = document.createElement(tag) as T;
  if (props) {
    Object.assign(el, props);
  }
  document.body.appendChild(el);
  await (el as any).updateComplete;
  return el;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("IcAgentCard", () => {
  // --- Existing backward-compat tests (updated for design tokens) ---

  it("renders with default properties", async () => {
    const el = await createElement<IcAgentCard>("ic-agent-card");
    expect(el.name).toBe("");
    expect(el.status).toBe("unknown");
    expect(el.provider).toBe("");
    expect(el.model).toBe("");
    expect(el.agentId).toBe("");
    expect(el.messagesToday).toBe(0);
    expect(el.tokenUsageToday).toBe(0);
    expect(el.costToday).toBe(0);
    expect(el.budgetUtilization).toBe(0);
    expect(el.suspended).toBe(false);
  });

  it("displays agent name from name property", async () => {
    const el = await createElement<IcAgentCard>("ic-agent-card", {
      name: "Test Agent",
    });
    const nameEl = el.shadowRoot?.querySelector(".agent-name");
    expect(nameEl?.textContent?.trim()).toBe("Test Agent");
  });

  it("shows 'Unnamed Agent' when name is empty", async () => {
    const el = await createElement<IcAgentCard>("ic-agent-card");
    const nameEl = el.shadowRoot?.querySelector(".agent-name");
    expect(nameEl?.textContent?.trim()).toBe("Unnamed Agent");
  });

  it("displays provider and model values", async () => {
    const el = await createElement<IcAgentCard>("ic-agent-card", {
      provider: "anthropic",
      model: "claude-sonnet-4",
    });
    const details = el.shadowRoot?.querySelectorAll(".detail-value");
    expect(details?.[0]?.textContent?.trim()).toBe("anthropic");
    expect(details?.[1]?.textContent?.trim()).toBe("claude-sonnet-4");
  });

  it("shows '---' when provider and model are empty", async () => {
    const el = await createElement<IcAgentCard>("ic-agent-card");
    const details = el.shadowRoot?.querySelectorAll(".detail-value");
    expect(details?.[0]?.textContent?.trim()).toBe("---");
    expect(details?.[1]?.textContent?.trim()).toBe("---");
  });

  it("applies correct status color for 'active'", async () => {
    const el = await createElement<IcAgentCard>("ic-agent-card", {
      status: "active",
    });
    const badge = el.shadowRoot?.querySelector(".status-badge") as HTMLElement;
    const style = badge?.getAttribute("style") ?? "";
    expect(style).toContain("var(--ic-success)");
    expect(style).toContain("1a");
  });

  it("applies correct status color for 'idle'", async () => {
    const el = await createElement<IcAgentCard>("ic-agent-card", {
      status: "idle",
    });
    const badge = el.shadowRoot?.querySelector(".status-badge") as HTMLElement;
    const style = badge?.getAttribute("style") ?? "";
    expect(style).toContain("var(--ic-warning)");
  });

  it("applies correct status color for 'error'", async () => {
    const el = await createElement<IcAgentCard>("ic-agent-card", {
      status: "error",
    });
    const badge = el.shadowRoot?.querySelector(".status-badge") as HTMLElement;
    const style = badge?.getAttribute("style") ?? "";
    expect(style).toContain("var(--ic-error)");
  });

  it("applies correct status color for 'unknown'", async () => {
    const el = await createElement<IcAgentCard>("ic-agent-card", {
      status: "unknown",
    });
    const badge = el.shadowRoot?.querySelector(".status-badge") as HTMLElement;
    const style = badge?.getAttribute("style") ?? "";
    expect(style).toContain("var(--ic-text-dim)");
  });

  it("uses '1a' opacity suffix for active and '0d' for others", async () => {
    const elActive = await createElement<IcAgentCard>("ic-agent-card", {
      status: "active",
    });
    const badgeActive = elActive.shadowRoot?.querySelector(".status-badge") as HTMLElement;
    const styleActive = badgeActive?.getAttribute("style") ?? "";
    expect(styleActive).toContain("1a");

    const elIdle = await createElement<IcAgentCard>("ic-agent-card", {
      status: "idle",
    });
    const badgeIdle = elIdle.shadowRoot?.querySelector(".status-badge") as HTMLElement;
    const styleIdle = badgeIdle?.getAttribute("style") ?? "";
    expect(styleIdle).toContain("0d");
  });

  it("displays status text in badge", async () => {
    const el = await createElement<IcAgentCard>("ic-agent-card", {
      status: "active",
    });
    const badge = el.shadowRoot?.querySelector(".status-badge");
    expect(badge?.textContent?.trim()).toContain("active");
  });

  // --- New tests for messagesToday / tokenUsageToday ---

  it("renders messagesToday when provided and > 0", async () => {
    const el = await createElement<IcAgentCard>("ic-agent-card", {
      messagesToday: 42,
    });
    const labels = el.shadowRoot?.querySelectorAll(".detail-label");
    const values = el.shadowRoot?.querySelectorAll(".detail-value");
    const labelTexts = Array.from(labels ?? []).map((l) => l.textContent?.trim());
    expect(labelTexts).toContain("Messages");
    const msgIdx = labelTexts.indexOf("Messages");
    expect(values?.[msgIdx]?.textContent?.trim()).toBe("42");
  });

  it("renders tokenUsageToday with abbreviation (612000 -> '612K')", async () => {
    const el = await createElement<IcAgentCard>("ic-agent-card", {
      tokenUsageToday: 612000,
    });
    const labels = el.shadowRoot?.querySelectorAll(".detail-label");
    const values = el.shadowRoot?.querySelectorAll(".detail-value");
    const labelTexts = Array.from(labels ?? []).map((l) => l.textContent?.trim());
    expect(labelTexts).toContain("Tokens");
    const tokIdx = labelTexts.indexOf("Tokens");
    expect(values?.[tokIdx]?.textContent?.trim()).toBe("612K");
  });

  it("formats tokens with M suffix for millions", async () => {
    const el = await createElement<IcAgentCard>("ic-agent-card", {
      tokenUsageToday: 1200000,
    });
    const labels = el.shadowRoot?.querySelectorAll(".detail-label");
    const values = el.shadowRoot?.querySelectorAll(".detail-value");
    const labelTexts = Array.from(labels ?? []).map((l) => l.textContent?.trim());
    const tokIdx = labelTexts.indexOf("Tokens");
    expect(values?.[tokIdx]?.textContent?.trim()).toBe("1.2M");
  });

  it("does NOT render message/token rows when both are 0 (backward compat)", async () => {
    const el = await createElement<IcAgentCard>("ic-agent-card", {
      messagesToday: 0,
      tokenUsageToday: 0,
    });
    const labels = el.shadowRoot?.querySelectorAll(".detail-label");
    const labelTexts = Array.from(labels ?? []).map((l) => l.textContent?.trim());
    expect(labelTexts).not.toContain("Messages");
    expect(labelTexts).not.toContain("Tokens");
  });

  // --- Navigate event tests ---

  it("dispatches 'navigate' CustomEvent on click with correct path", async () => {
    const el = await createElement<IcAgentCard>("ic-agent-card", {
      agentId: "agent-1",
    });
    const handler = vi.fn();
    el.addEventListener("navigate", handler);
    const card = el.shadowRoot?.querySelector(".card") as HTMLElement;
    card.click();
    expect(handler).toHaveBeenCalledOnce();
    const detail = (handler.mock.calls[0][0] as CustomEvent).detail;
    expect(detail).toBe("agents/agent-1");
  });

  it("navigate event detail contains agentId-based path", async () => {
    const el = await createElement<IcAgentCard>("ic-agent-card", {
      name: "My Agent",
      agentId: "custom-id",
    });
    const handler = vi.fn();
    el.addEventListener("navigate", handler);
    el.shadowRoot?.querySelector<HTMLElement>(".card")?.click();
    expect((handler.mock.calls[0][0] as CustomEvent).detail).toBe(
      "agents/custom-id",
    );
  });

  it("falls back to name for path when agentId is empty", async () => {
    const el = await createElement<IcAgentCard>("ic-agent-card", {
      name: "Fallback Agent",
    });
    const handler = vi.fn();
    el.addEventListener("navigate", handler);
    el.shadowRoot?.querySelector<HTMLElement>(".card")?.click();
    expect((handler.mock.calls[0][0] as CustomEvent).detail).toBe(
      "agents/Fallback Agent",
    );
  });

  // --- Accessibility tests ---

  it("card has role='link' and tabindex='0'", async () => {
    const el = await createElement<IcAgentCard>("ic-agent-card");
    const card = el.shadowRoot?.querySelector(".card");
    expect(card?.getAttribute("role")).toBe("link");
    expect(card?.getAttribute("tabindex")).toBe("0");
  });

  it("Enter key triggers navigate event", async () => {
    const el = await createElement<IcAgentCard>("ic-agent-card", {
      agentId: "key-test",
    });
    const handler = vi.fn();
    el.addEventListener("navigate", handler);
    const card = el.shadowRoot?.querySelector(".card") as HTMLElement;
    card.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(handler).toHaveBeenCalledOnce();
  });

  it("Space key triggers navigate event", async () => {
    const el = await createElement<IcAgentCard>("ic-agent-card", {
      agentId: "space-test",
    });
    const handler = vi.fn();
    el.addEventListener("navigate", handler);
    const card = el.shadowRoot?.querySelector(".card") as HTMLElement;
    card.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    expect(handler).toHaveBeenCalledOnce();
  });

  // --- Design token tests ---

  it("uses design token CSS variables in shadow DOM", async () => {
    const el = await createElement<IcAgentCard>("ic-agent-card");
    const badge = el.shadowRoot?.querySelector(".status-badge") as HTMLElement;
    const badgeStyle = badge?.getAttribute("style") ?? "";
    expect(badgeStyle).toContain("var(--ic-");
  });

  // --- Cost display tests ---

  it("renders cost today when > 0 with currency format", async () => {
    const el = await createElement<IcAgentCard>("ic-agent-card", {
      costToday: 3.5,
    });
    const labels = el.shadowRoot?.querySelectorAll(".detail-label");
    const labelTexts = Array.from(labels ?? []).map((l) => l.textContent?.trim());
    expect(labelTexts).toContain("Cost Today");
    const values = el.shadowRoot?.querySelectorAll(".detail-value");
    const costIdx = labelTexts.indexOf("Cost Today");
    expect(values?.[costIdx]?.textContent?.trim()).toBe("$3.50");
  });

  it("does NOT render cost row when costToday is 0", async () => {
    const el = await createElement<IcAgentCard>("ic-agent-card", {
      costToday: 0,
    });
    const labels = el.shadowRoot?.querySelectorAll(".detail-label");
    const labelTexts = Array.from(labels ?? []).map((l) => l.textContent?.trim());
    expect(labelTexts).not.toContain("Cost Today");
  });

  // --- Budget utilization tests ---

  it("renders budget bar when budgetUtilization > 0", async () => {
    const el = await createElement<IcAgentCard>("ic-agent-card", {
      budgetUtilization: 45,
    });
    const budgetBar = el.shadowRoot?.querySelector(".budget-bar");
    expect(budgetBar).toBeTruthy();
    const fill = el.shadowRoot?.querySelector(".budget-fill") as HTMLElement;
    const fillStyle = fill?.getAttribute("style") ?? "";
    expect(fillStyle).toContain("45%");
    const pct = el.shadowRoot?.querySelector(".budget-pct");
    expect(pct?.textContent?.trim()).toBe("45%");
  });

  it("does NOT render budget when budgetUtilization is 0", async () => {
    const el = await createElement<IcAgentCard>("ic-agent-card", {
      budgetUtilization: 0,
    });
    const budgetBar = el.shadowRoot?.querySelector(".budget-bar");
    expect(budgetBar).toBeNull();
  });

  it("budget bar uses warning color at 70%+", async () => {
    const el = await createElement<IcAgentCard>("ic-agent-card", {
      budgetUtilization: 75,
    });
    const fill = el.shadowRoot?.querySelector(".budget-fill") as HTMLElement;
    const fillStyle = fill?.getAttribute("style") ?? "";
    expect(fillStyle).toContain("var(--ic-warning)");
  });

  it("budget bar uses error color at 90%+", async () => {
    const el = await createElement<IcAgentCard>("ic-agent-card", {
      budgetUtilization: 95,
    });
    const fill = el.shadowRoot?.querySelector(".budget-fill") as HTMLElement;
    const fillStyle = fill?.getAttribute("style") ?? "";
    expect(fillStyle).toContain("var(--ic-error)");
  });

  it("budget bar clamps at 100%", async () => {
    const el = await createElement<IcAgentCard>("ic-agent-card", {
      budgetUtilization: 150,
    });
    const fill = el.shadowRoot?.querySelector(".budget-fill") as HTMLElement;
    const fillStyle = fill?.getAttribute("style") ?? "";
    expect(fillStyle).toContain("100%");
  });

  // --- Suspended state tests ---

  it("card has suspended class when suspended is true", async () => {
    const el = await createElement<IcAgentCard>("ic-agent-card", {
      suspended: true,
    });
    const card = el.shadowRoot?.querySelector(".card");
    expect(card?.classList.contains("card--suspended")).toBe(true);
  });

  it("status badge shows 'suspended' when suspended is true", async () => {
    const el = await createElement<IcAgentCard>("ic-agent-card", {
      suspended: true,
      status: "active",
    });
    const badge = el.shadowRoot?.querySelector(".status-badge");
    expect(badge?.textContent?.trim()).toContain("suspended");
  });

  it("card does NOT have suspended class when suspended is false", async () => {
    const el = await createElement<IcAgentCard>("ic-agent-card", {
      suspended: false,
    });
    const card = el.shadowRoot?.querySelector(".card");
    expect(card?.classList.contains("card--suspended")).toBe(false);
  });

  // --- Action button tests ---

  it("renders three action buttons (Configure, Suspend, Delete)", async () => {
    const el = await createElement<IcAgentCard>("ic-agent-card", {
      agentId: "test-1",
    });
    const buttons = el.shadowRoot?.querySelectorAll(".action-btn");
    expect(buttons?.length).toBe(3);
    const labels = Array.from(buttons ?? []).map((b) => b.textContent?.trim());
    expect(labels).toContain("Configure");
    expect(labels).toContain("Suspend");
    expect(labels).toContain("Delete");
  });

  it("renders Resume button instead of Suspend when suspended", async () => {
    const el = await createElement<IcAgentCard>("ic-agent-card", {
      agentId: "test-1",
      suspended: true,
    });
    const buttons = el.shadowRoot?.querySelectorAll(".action-btn");
    const labels = Array.from(buttons ?? []).map((b) => b.textContent?.trim());
    expect(labels).toContain("Resume");
    expect(labels).not.toContain("Suspend");
  });

  it("configure button dispatches agent-action with action='configure'", async () => {
    const el = await createElement<IcAgentCard>("ic-agent-card", {
      agentId: "test-1",
    });
    const handler = vi.fn();
    el.addEventListener("agent-action", handler);
    const buttons = el.shadowRoot?.querySelectorAll(".action-btn");
    const configBtn = Array.from(buttons ?? []).find(
      (b) => b.textContent?.trim() === "Configure",
    ) as HTMLElement;
    configBtn?.click();
    expect(handler).toHaveBeenCalledOnce();
    const detail = (handler.mock.calls[0][0] as CustomEvent).detail;
    expect(detail).toEqual({ action: "configure", agentId: "test-1" });
  });

  it("suspend button dispatches agent-action with action='suspend'", async () => {
    const el = await createElement<IcAgentCard>("ic-agent-card", {
      agentId: "test-2",
    });
    const handler = vi.fn();
    el.addEventListener("agent-action", handler);
    const buttons = el.shadowRoot?.querySelectorAll(".action-btn");
    const suspendBtn = Array.from(buttons ?? []).find(
      (b) => b.textContent?.trim() === "Suspend",
    ) as HTMLElement;
    suspendBtn?.click();
    expect(handler).toHaveBeenCalledOnce();
    const detail = (handler.mock.calls[0][0] as CustomEvent).detail;
    expect(detail).toEqual({ action: "suspend", agentId: "test-2" });
  });

  it("resume button dispatches agent-action with action='resume'", async () => {
    const el = await createElement<IcAgentCard>("ic-agent-card", {
      agentId: "test-3",
      suspended: true,
    });
    const handler = vi.fn();
    el.addEventListener("agent-action", handler);
    const buttons = el.shadowRoot?.querySelectorAll(".action-btn");
    const resumeBtn = Array.from(buttons ?? []).find(
      (b) => b.textContent?.trim() === "Resume",
    ) as HTMLElement;
    resumeBtn?.click();
    expect(handler).toHaveBeenCalledOnce();
    const detail = (handler.mock.calls[0][0] as CustomEvent).detail;
    expect(detail).toEqual({ action: "resume", agentId: "test-3" });
  });

  it("delete button dispatches agent-action with action='delete'", async () => {
    const el = await createElement<IcAgentCard>("ic-agent-card", {
      agentId: "test-4",
    });
    const handler = vi.fn();
    el.addEventListener("agent-action", handler);
    const buttons = el.shadowRoot?.querySelectorAll(".action-btn");
    const deleteBtn = Array.from(buttons ?? []).find(
      (b) => b.textContent?.trim() === "Delete",
    ) as HTMLElement;
    deleteBtn?.click();
    expect(handler).toHaveBeenCalledOnce();
    const detail = (handler.mock.calls[0][0] as CustomEvent).detail;
    expect(detail).toEqual({ action: "delete", agentId: "test-4" });
  });

  it("action buttons stop propagation (do not trigger navigate)", async () => {
    const el = await createElement<IcAgentCard>("ic-agent-card", {
      agentId: "test-5",
    });
    const navHandler = vi.fn();
    const actionHandler = vi.fn();
    el.addEventListener("navigate", navHandler);
    el.addEventListener("agent-action", actionHandler);
    const buttons = el.shadowRoot?.querySelectorAll(".action-btn");
    const configBtn = Array.from(buttons ?? []).find(
      (b) => b.textContent?.trim() === "Configure",
    ) as HTMLElement;
    configBtn?.click();
    expect(actionHandler).toHaveBeenCalledOnce();
    // navigate should NOT fire because action btn stops propagation
    expect(navHandler).not.toHaveBeenCalled();
  });
});
