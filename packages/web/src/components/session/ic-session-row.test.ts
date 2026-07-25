// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach, vi } from "vitest";
import type { IcSessionRow } from "./ic-session-row.js";
import type { SessionListItem } from "../../api/types/index.js";

// Side-effect import to register custom element
import "./ic-session-row.js";

function makeSession(overrides: Partial<SessionListItem> = {}): SessionListItem {
  return {
    conversationRef: "cv-user123-telegram",
    agentId: "default",
    kind: "dm",
    messageCount: 47,
    totalTokens: 23400,
    createdAt: Date.now() - 7200000,
    updatedAt: Date.now() - 60000, // 1 min ago -> active
    ...overrides,
  };
}

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
  vi.useRealTimers();
});

describe("IcSessionRow", () => {
  it("renders a bounded conversation reference as display name", async () => {
    const el = await createElement<IcSessionRow>("ic-session-row", {
      session: makeSession(),
    });
    const displayName = el.shadowRoot?.querySelector(".display-name");
    expect(displayName?.textContent).toBe("cv-user123-t...");
  });

  it("truncates long conversation references", async () => {
    const el = await createElement<IcSessionRow>("ic-session-row", {
      session: makeSession({
        conversationRef: "some-unparseable-raw-key-string",
      }),
    });
    const displayName = el.shadowRoot?.querySelector(".display-name");
    expect(displayName?.textContent).toBe("some-unparse...");
  });

  it("shows short conversation references without truncation", async () => {
    const el = await createElement<IcSessionRow>("ic-session-row", {
      session: makeSession({ conversationRef: "short" }),
    });
    const displayName = el.shadowRoot?.querySelector(".display-name");
    expect(displayName?.textContent).toBe("short");
  });

  it("shows kind tag element inside the session row", async () => {
    const el = await createElement<IcSessionRow>("ic-session-row", {
      session: makeSession(),
    });
    const tags = el.shadowRoot?.querySelectorAll("ic-tag");
    expect(tags?.length).toBeGreaterThanOrEqual(1);
    expect(tags?.[0]?.textContent).toContain("dm");
  });

  it("shows agent tag when agentId is present", async () => {
    const el = await createElement<IcSessionRow>("ic-session-row", {
      session: makeSession(),
    });
    const tags = el.shadowRoot?.querySelectorAll("ic-tag");
    expect(tags?.length).toBe(2);
    expect(tags?.[1]?.textContent).toContain("default");
  });

  it("shows correct status indicator for active session", async () => {
    const el = await createElement<IcSessionRow>("ic-session-row", {
      session: makeSession({ updatedAt: Date.now() - 60000 }), // 1 min ago
    });
    const dot = el.shadowRoot?.querySelector(".status-dot") as HTMLElement;
    expect(dot?.title).toBe("active");
    // Verify the style attribute contains the success color variable
    expect(dot?.getAttribute("style")).toContain("--ic-success");
  });

  it("shows correct status indicator for idle session", async () => {
    const el = await createElement<IcSessionRow>("ic-session-row", {
      session: makeSession({ updatedAt: Date.now() - 30 * 60 * 1000 }), // 30 min ago
    });
    const dot = el.shadowRoot?.querySelector(".status-dot") as HTMLElement;
    expect(dot?.title).toBe("idle");
    expect(dot?.getAttribute("style")).toContain("--ic-warning");
  });

  it("shows correct status indicator for expired session", async () => {
    const el = await createElement<IcSessionRow>("ic-session-row", {
      session: makeSession({ updatedAt: Date.now() - 2 * 60 * 60 * 1000 }), // 2 hours ago
    });
    const dot = el.shadowRoot?.querySelector(".status-dot") as HTMLElement;
    expect(dot?.title).toBe("expired");
    expect(dot?.getAttribute("style")).toContain("--ic-text-dim");
  });

  it("fires session-click event on row click", async () => {
    const session = makeSession();
    const el = await createElement<IcSessionRow>("ic-session-row", { session });
    const handler = vi.fn();
    el.addEventListener("session-click", handler);

    const row = el.shadowRoot?.querySelector(".row") as HTMLElement;
    row?.click();

    expect(handler).toHaveBeenCalledOnce();
    const detail = (handler.mock.calls[0][0] as CustomEvent<SessionListItem>).detail;
    expect(detail.conversationRef).toBe(session.conversationRef);
  });

  it("fires composed event that crosses shadow DOM boundary", async () => {
    const session = makeSession();
    const el = await createElement<IcSessionRow>("ic-session-row", { session });
    const handler = vi.fn();
    // Listen on the document to verify composed: true
    document.addEventListener("session-click", handler);

    const row = el.shadowRoot?.querySelector(".row") as HTMLElement;
    row?.click();

    expect(handler).toHaveBeenCalledOnce();
    document.removeEventListener("session-click", handler);
  });

  it("renders nothing when session is null", async () => {
    const el = await createElement<IcSessionRow>("ic-session-row");
    const row = el.shadowRoot?.querySelector(".row");
    expect(row).toBeFalsy();
  });

  it("displays message count", async () => {
    const el = await createElement<IcSessionRow>("ic-session-row", {
      session: makeSession({ messageCount: 42 }),
    });
    const msgCount = el.shadowRoot?.querySelector(".msg-count");
    expect(msgCount?.textContent).toContain("42");
  });

  it("displays relative time component", async () => {
    const el = await createElement<IcSessionRow>("ic-session-row", {
      session: makeSession(),
    });
    const relTime = el.shadowRoot?.querySelector("ic-relative-time");
    expect(relTime).toBeTruthy();
  });
});
