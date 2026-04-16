import { describe, it, expect, afterEach, vi } from "vitest";
import type { IcAuditRow, AuditEvent } from "./ic-audit-row.js";

// Side-effect import to register custom element
import "./ic-audit-row.js";

const MOCK_EVENT: AuditEvent = {
  timestamp: Date.now() - 60_000,
  agentId: "default",
  action: "tool.exec",
  classification: "high",
  user: "admin",
};

async function createElement(
  props?: Record<string, unknown>,
): Promise<IcAuditRow> {
  const el = document.createElement("ic-audit-row") as IcAuditRow;
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

describe("IcAuditRow", () => {
  it("renders timestamp, agent, action, user", async () => {
    const el = await createElement({ event: MOCK_EVENT });
    const cells = el.shadowRoot?.querySelectorAll("[role='cell']");
    expect(cells?.length).toBeGreaterThanOrEqual(4);

    // Agent cell
    expect(cells![1].textContent).toContain("default");
    // Action cell
    expect(cells![2].textContent).toContain("tool.exec");
    // User cell
    expect(cells![4].textContent).toContain("admin");
  });

  it("low risk shows success tag variant", async () => {
    const ev = { ...MOCK_EVENT, classification: "low" };
    const el = await createElement({ event: ev });
    const tag = el.shadowRoot?.querySelector("ic-tag");
    expect(tag).toBeTruthy();
    expect(tag!.getAttribute("variant")).toBe("success");
    expect(tag!.textContent).toContain("low");
  });

  it("medium risk shows warning tag variant", async () => {
    const ev = { ...MOCK_EVENT, classification: "medium" };
    const el = await createElement({ event: ev });
    const tag = el.shadowRoot?.querySelector("ic-tag");
    expect(tag!.getAttribute("variant")).toBe("warning");
  });

  it("high risk shows error tag variant", async () => {
    const ev = { ...MOCK_EVENT, classification: "high" };
    const el = await createElement({ event: ev });
    const tag = el.shadowRoot?.querySelector("ic-tag");
    expect(tag!.getAttribute("variant")).toBe("error");
  });

  it("critical risk shows error tag variant", async () => {
    const ev = { ...MOCK_EVENT, classification: "critical" };
    const el = await createElement({ event: ev });
    const tag = el.shadowRoot?.querySelector("ic-tag");
    expect(tag!.getAttribute("variant")).toBe("error");
  });

  it("missing event shows fallback text", async () => {
    const el = await createElement({ event: null });
    const cells = el.shadowRoot?.querySelectorAll("[role='cell']");
    expect(cells?.length).toBe(5);
    cells!.forEach((cell) => {
      expect(cell.textContent).toContain("---");
    });
  });

  it("uses ic-tag for risk badge", async () => {
    const el = await createElement({ event: MOCK_EVENT });
    const tag = el.shadowRoot?.querySelector("ic-tag");
    expect(tag).toBeTruthy();
  });

  it("displays details when present", async () => {
    const ev = { ...MOCK_EVENT, details: "Executed bash command" };
    const el = await createElement({ event: ev });
    const detailCell = el.shadowRoot?.querySelector(".cell--details");
    expect(detailCell).toBeTruthy();
    expect(detailCell!.textContent).toContain("Executed bash command");
  });
});
