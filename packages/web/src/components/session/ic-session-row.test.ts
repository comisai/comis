// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach, vi } from "vitest";
import type { IcSessionRow } from "./ic-session-row.js";
import type { SessionInfo } from "../../api/types/index.js";

// Side-effect import to register custom element
import "./ic-session-row.js";

/** Create a session with a parseable key (agent prefix format). */
function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    key: "agent:default:myTenant:user123:telegram",
    agentId: "default",
    channelType: "telegram",
    messageCount: 47,
    totalTokens: 23400,
    inputTokens: 15234,
    outputTokens: 8166,
    toolCalls: 12,
    compactions: 1,
    resetCount: 0,
    createdAt: Date.now() - 7200000,
    lastActiveAt: Date.now() - 60000, // 1 min ago -> active
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
  it("renders parsed session key as display name", async () => {
    const el = await createElement<IcSessionRow>("ic-session-row", {
      session: makeSession(),
    });
    const displayName = el.shadowRoot?.querySelector(".display-name");
    expect(displayName?.textContent).toBe("user123");
  });

  it("falls back to truncated key on parse failure", async () => {
    const el = await createElement<IcSessionRow>("ic-session-row", {
      session: makeSession({
        key: "some-unparseable-raw-key-string",
      }),
    });
    const displayName = el.shadowRoot?.querySelector(".display-name");
    // Key is > 15 chars, so it should be truncated to 12 + "..."
    expect(displayName?.textContent).toBe("some-unparse...");
  });

  it("shows short unparseable key without truncation", async () => {
    const el = await createElement<IcSessionRow>("ic-session-row", {
      session: makeSession({ key: "short" }),
    });
    const displayName = el.shadowRoot?.querySelector(".display-name");
    expect(displayName?.textContent).toBe("short");
  });

  it("shows channel tag", async () => {
    const el = await createElement<IcSessionRow>("ic-session-row", {
      session: makeSession(),
    });
    const tags = el.shadowRoot?.querySelectorAll("ic-tag");
    expect(tags?.length).toBeGreaterThanOrEqual(1);
    // First tag should be the channel
    expect(tags?.[0]?.textContent).toContain("telegram");
  });

  it("shows agent tag when agentId is present", async () => {
    const el = await createElement<IcSessionRow>("ic-session-row", {
      session: makeSession(),
    });
    const tags = el.shadowRoot?.querySelectorAll("ic-tag");
    // Should have both channel and agent tags
    expect(tags?.length).toBe(2);
    expect(tags?.[1]?.textContent).toContain("default");
  });

  it("shows correct status indicator for active session", async () => {
    const el = await createElement<IcSessionRow>("ic-session-row", {
      session: makeSession({ lastActiveAt: Date.now() - 60000 }), // 1 min ago
    });
    const dot = el.shadowRoot?.querySelector(".status-dot") as HTMLElement;
    expect(dot?.title).toBe("active");
    // Verify the style attribute contains the success color variable
    expect(dot?.getAttribute("style")).toContain("--ic-success");
  });

  it("shows correct status indicator for idle session", async () => {
    const el = await createElement<IcSessionRow>("ic-session-row", {
      session: makeSession({ lastActiveAt: Date.now() - 30 * 60 * 1000 }), // 30 min ago
    });
    const dot = el.shadowRoot?.querySelector(".status-dot") as HTMLElement;
    expect(dot?.title).toBe("idle");
    expect(dot?.getAttribute("style")).toContain("--ic-warning");
  });

  it("shows correct status indicator for expired session", async () => {
    const el = await createElement<IcSessionRow>("ic-session-row", {
      session: makeSession({ lastActiveAt: Date.now() - 2 * 60 * 60 * 1000 }), // 2 hours ago
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
    const detail = (handler.mock.calls[0][0] as CustomEvent<SessionInfo>).detail;
    expect(detail.key).toBe(session.key);
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
