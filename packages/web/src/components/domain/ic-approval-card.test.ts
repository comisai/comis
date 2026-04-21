// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach, vi } from "vitest";
import type { IcApprovalCard, ApprovalRequest } from "./ic-approval-card.js";

// Side-effect import to register custom element
import "./ic-approval-card.js";

const MOCK_APPROVAL: ApprovalRequest = {
  id: "appr-1",
  agentId: "agent-1",
  action: "file_write",
  classification: "high",
  context: "Writing to /etc/config",
  requestedAt: Date.now() - 60_000,
  user: "telegram:user1",
};

async function createElement(
  props?: Record<string, unknown>,
): Promise<IcApprovalCard> {
  const el = document.createElement("ic-approval-card") as IcApprovalCard;
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

describe("IcApprovalCard", () => {
  it("renders agent ID and action name", async () => {
    const el = await createElement({ approval: MOCK_APPROVAL });
    const agentId = el.shadowRoot?.querySelector(".agent-id");
    const actionName = el.shadowRoot?.querySelector(".action-name");
    expect(agentId?.textContent).toContain("agent-1");
    expect(actionName?.textContent).toContain("file_write");
  });

  it("renders risk classification badge with correct variant", async () => {
    const el = await createElement({ approval: MOCK_APPROVAL });
    const tag = el.shadowRoot?.querySelector("ic-tag");
    expect(tag).toBeTruthy();
    expect(tag!.getAttribute("variant")).toBe("error");
    expect(tag!.textContent).toContain("high");
  });

  it("low classification shows success tag variant", async () => {
    const approval = { ...MOCK_APPROVAL, classification: "low" };
    const el = await createElement({ approval });
    const tag = el.shadowRoot?.querySelector("ic-tag");
    expect(tag!.getAttribute("variant")).toBe("success");
    expect(tag!.textContent).toContain("low");
  });

  it("medium classification shows warning tag variant", async () => {
    const approval = { ...MOCK_APPROVAL, classification: "medium" };
    const el = await createElement({ approval });
    const tag = el.shadowRoot?.querySelector("ic-tag");
    expect(tag!.getAttribute("variant")).toBe("warning");
  });

  it("shows timestamp via ic-relative-time", async () => {
    const el = await createElement({ approval: MOCK_APPROVAL });
    const relTime = el.shadowRoot?.querySelector("ic-relative-time");
    expect(relTime).toBeTruthy();
  });

  it("context details hidden by default", async () => {
    const el = await createElement({ approval: MOCK_APPROVAL });
    const details = el.shadowRoot?.querySelector(".context-details");
    expect(details).toBeFalsy();
    const toggle = el.shadowRoot?.querySelector(".context-toggle");
    expect(toggle?.textContent).toContain("Show details");
  });

  it("clicking Show details expands context section", async () => {
    const el = await createElement({ approval: MOCK_APPROVAL });
    const toggle = el.shadowRoot?.querySelector(".context-toggle") as HTMLButtonElement;
    toggle.click();
    await (el as any).updateComplete;
    const details = el.shadowRoot?.querySelector(".context-details");
    expect(details).toBeTruthy();
    expect(details!.textContent).toContain("Writing to /etc/config");
    const toggleAfter = el.shadowRoot?.querySelector(".context-toggle");
    expect(toggleAfter?.textContent).toContain("Hide details");
  });

  it("reason input field present", async () => {
    const el = await createElement({ approval: MOCK_APPROVAL });
    const input = el.shadowRoot?.querySelector(".reason-input") as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.getAttribute("aria-label")).toBe("Decision reason");
  });

  it("approve button dispatches approve event with id and reason", async () => {
    const el = await createElement({ approval: MOCK_APPROVAL });
    const handler = vi.fn();
    el.addEventListener("approve", handler);

    // Type a reason
    const input = el.shadowRoot?.querySelector(".reason-input") as HTMLInputElement;
    input.value = "Looks safe";
    input.dispatchEvent(new Event("input"));
    await (el as any).updateComplete;

    const approveBtn = el.shadowRoot?.querySelector(".approve-btn") as HTMLButtonElement;
    approveBtn.click();

    expect(handler).toHaveBeenCalledOnce();
    const detail = (handler.mock.calls[0][0] as CustomEvent).detail;
    expect(detail.id).toBe("appr-1");
    expect(detail.reason).toBe("Looks safe");
  });

  it("deny button dispatches deny event with id and reason", async () => {
    const el = await createElement({ approval: MOCK_APPROVAL });
    const handler = vi.fn();
    el.addEventListener("deny", handler);

    // Type a reason
    const input = el.shadowRoot?.querySelector(".reason-input") as HTMLInputElement;
    input.value = "Too risky";
    input.dispatchEvent(new Event("input"));
    await (el as any).updateComplete;

    const denyBtn = el.shadowRoot?.querySelector(".deny-btn") as HTMLButtonElement;
    denyBtn.click();

    expect(handler).toHaveBeenCalledOnce();
    const detail = (handler.mock.calls[0][0] as CustomEvent).detail;
    expect(detail.id).toBe("appr-1");
    expect(detail.reason).toBe("Too risky");
  });

  it("empty reason still dispatches event", async () => {
    const el = await createElement({ approval: MOCK_APPROVAL });
    const handler = vi.fn();
    el.addEventListener("approve", handler);

    const approveBtn = el.shadowRoot?.querySelector(".approve-btn") as HTMLButtonElement;
    approveBtn.click();

    expect(handler).toHaveBeenCalledOnce();
    const detail = (handler.mock.calls[0][0] as CustomEvent).detail;
    expect(detail.id).toBe("appr-1");
    expect(detail.reason).toBe("");
  });

  it("user field displayed when present", async () => {
    const el = await createElement({ approval: MOCK_APPROVAL });
    const userRow = el.shadowRoot?.querySelector(".user-row");
    expect(userRow).toBeTruthy();
    expect(userRow!.textContent).toContain("telegram:user1");
  });

  it("user field hidden when absent", async () => {
    const approval = { ...MOCK_APPROVAL, user: undefined };
    const el = await createElement({ approval });
    const userRow = el.shadowRoot?.querySelector(".user-row");
    expect(userRow).toBeFalsy();
  });

  it("card has role=article", async () => {
    const el = await createElement({ approval: MOCK_APPROVAL });
    const card = el.shadowRoot?.querySelector("[role='article']");
    expect(card).toBeTruthy();
    expect(card!.getAttribute("aria-label")).toContain("agent-1");
    expect(card!.getAttribute("aria-label")).toContain("file_write");
  });

  it("left border color matches classification", async () => {
    const el = await createElement({ approval: MOCK_APPROVAL });
    const card = el.shadowRoot?.querySelector(".card") as HTMLElement;
    expect(card.getAttribute("style")).toContain("border-left-color");
  });

  it("renders nothing when approval is null", async () => {
    const el = await createElement({ approval: null });
    const card = el.shadowRoot?.querySelector(".card");
    expect(card).toBeFalsy();
  });
});
