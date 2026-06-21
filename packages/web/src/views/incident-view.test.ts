// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import type { IcIncidentView } from "./incident-view.js";
import type { RpcClient } from "../api/rpc-client.js";

// Side-effect import to register the custom element under test.
import "./incident-view.js";
import { createMockRpcClient } from "../test-support/mock-rpc-client.js";

/* ------------------------------------------------------------------ */
/*  Fixtures — a deterministic, content-free obs.explain IncidentReport */
/* ------------------------------------------------------------------ */

/** A planted body marker — must NEVER reach the rendered DOM (content-free). */
const PLANTED_MARKER = "SECRET_PROMPT_BODY_DO_NOT_RENDER";

/**
 * A representative obs.explain IncidentReport carrying ALL the sections the
 * Incident view renders, INCLUDING the optional recall?/cacheBreaks?/audit?/
 * spend? sections (presence-conditional). A planted `summary` body marker
 * rides along — the deterministic report is content-free, but the view test
 * pins that it never surfaces a fixture-planted body.
 */
function fixtureReport(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    sessionKey: "agent:default:telegram:12345",
    traceId: "trace-abc-123",
    agentId: "default",
    channel: { type: "telegram", id: "12345" },
    outcome: { endReason: "spend_exceeded", degraded: true, severity: "failed" },
    cost: { costUsd: 4.2, totalTokens: 123456, cacheReadRatio: 0.5 },
    timing: { durationMs: 8200, turnCount: 6 },
    toolStats: {
      web_search: { ok: 3, failed: 1, topErrorKind: "rate_limited" },
    },
    failures: [
      {
        seq: 5,
        toolName: "web_search",
        classifiedFailureBy: "transport",
        transportOk: false,
        httpStatus: 429,
        errorKind: "rate_limited",
        resultDigest: "digest-xyz",
        resultBytes: 4096,
        errorPreview: "429 Too Many Requests",
      },
    ],
    breakerTimeline: [
      { seq: 6, event: "opened", toolName: "web_search", consecutiveFailures: 3 },
    ],
    offloads: [],
    // Optional, presence-conditional sections (each rendered only when present):
    recall: { recalls: 2, zeroHits: 1, lastLanes: 3, lastFinalCount: 5, rerankerAvailable: true },
    cacheBreaks: [
      { reason: "tools_changed", count: 7, estCostUsd: 0.042 },
      { reason: "system_prompt_changed", count: 3, estCostUsd: 0.018 },
    ],
    audit: { total: 4, byKind: { tool_approval: 3, secret_access: 1 } },
    spend: { scope: "agent", totalUsd: 10.5, capUsd: 10 },
    summary: `Spend ceiling breached. ${PLANTED_MARKER}`,
    likelyRootCause: {
      code: "spend_exceeded",
      detail: "The agent's spend ceiling was reached.",
      suggestedNextSteps: ["Raise the ceiling", "Investigate the run"],
    },
    suggestedNextSteps: ["Raise the ceiling"],
    truncations: [],
  };
}

/** An IncidentReport WITHOUT the optional sections — they must be omitted. */
function fixtureReportNoOptionalSections(): Record<string, unknown> {
  const r = fixtureReport();
  delete r.recall;
  delete r.cacheBreaks;
  delete r.audit;
  delete r.spend;
  return r;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

interface IncidentMockResult {
  rpc: RpcClient;
  call: ReturnType<typeof vi.fn>;
}

/**
 * A mock rpcClient routing obs.explain to the supplied report and config.read
 * to the supplied observability config (the Grafana link-out gate reads
 * `observability.prometheus.enabled`).
 */
function createIncidentMock(
  explain: (params?: Record<string, unknown>) => unknown,
  prometheusEnabled = false,
): IncidentMockResult {
  const call = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === "obs.explain") return explain(params);
    if (method === "config.read") {
      return {
        config: { observability: { prometheus: { enabled: prometheusEnabled } } },
        sections: ["observability"],
      };
    }
    return {};
  });
  const rpc = createMockRpcClient(call as unknown as (...args: unknown[]) => unknown);
  return { rpc, call };
}

async function createElement(
  rpc: RpcClient | null,
  props: { sessionKey?: string; traceId?: string } = {},
): Promise<IcIncidentView> {
  const el = document.createElement("ic-incident-view") as IcIncidentView;
  el.rpcClient = rpc;
  if (props.sessionKey !== undefined) el.sessionKey = props.sessionKey;
  if (props.traceId !== undefined) el.traceId = props.traceId;
  document.body.appendChild(el);
  await vi.advanceTimersByTimeAsync(50);
  await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
  return el;
}

function priv(el: IcIncidentView) {
  return el as unknown as {
    _loadState: string;
    _report: Record<string, unknown> | null;
    _prometheusEnabled: boolean;
    _loadData(): Promise<void>;
  };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe("IcIncidentView (first obs.explain SPA consumer)", () => {
  it("calls obs.explain with the sessionKey and renders the outcome + cost + timing header", async () => {
    const { rpc, call } = createIncidentMock(() => fixtureReport());
    const el = await createElement(rpc, { sessionKey: "agent:default:telegram:12345" });

    expect(call).toHaveBeenCalledWith(
      "obs.explain",
      expect.objectContaining({ sessionKey: "agent:default:telegram:12345", depth: "summary" }),
    );
    expect(priv(el)._loadState).toBe("loaded");

    const text = el.shadowRoot?.textContent ?? "";
    // The verdict + likelyRootCause (the header).
    expect(text).toContain("spend_exceeded");
    // The outcome severity is surfaced.
    expect(text.toLowerCase()).toContain("failed");
    // Cost + timing stat cards.
    const cards = el.shadowRoot?.querySelectorAll("ic-stat-card");
    expect((cards?.length ?? 0)).toBeGreaterThan(0);
  });

  it("renders the failures table and the breaker timeline", async () => {
    const { rpc } = createIncidentMock(() => fixtureReport());
    const el = await createElement(rpc, { sessionKey: "agent:default:telegram:12345" });

    // The failures table + the breaker timeline are ic-data-tables; their row
    // content lives in each table's OWN shadow root (the cache-health twin).
    const tables = Array.from(el.shadowRoot?.querySelectorAll("ic-data-table") ?? []);
    expect(tables.length).toBeGreaterThan(0);
    const tableText = tables.map((t) => t.shadowRoot?.textContent ?? "").join(" ");
    expect(tableText).toContain("web_search");
    expect(tableText).toContain("rate_limited");
    // The breaker timeline names the opened breaker.
    expect(tableText.toLowerCase()).toContain("opened");
  });

  it("renders the optional spend? section {scope, totalUsd, capUsd} when present", async () => {
    const { rpc } = createIncidentMock(() => fixtureReport());
    const el = await createElement(rpc, { sessionKey: "agent:default:telegram:12345" });

    const text = el.shadowRoot?.textContent ?? "";
    // The spend section names the breached scope + both dollar numbers.
    expect(text.toLowerCase()).toContain("spend");
    expect(text).toContain("agent");
    expect(text).toContain("10.5"); // totalUsd
    expect(text).toContain("10"); // capUsd
  });

  it("renders the recall?/cacheBreaks?/audit? sections when present", async () => {
    const { rpc } = createIncidentMock(() => fixtureReport());
    const el = await createElement(rpc, { sessionKey: "agent:default:telegram:12345" });

    // Section titles live in the host shadow root; the cacheBreaks rows live in
    // the nested ic-data-table's own shadow root.
    const hostText = (el.shadowRoot?.textContent ?? "").toLowerCase();
    expect(hostText).toContain("recall");
    expect(hostText).toContain("cache"); // the "Cache breaks" section title
    expect(hostText).toContain("audit");
    const tables = Array.from(el.shadowRoot?.querySelectorAll("ic-data-table") ?? []);
    const tableText = tables.map((t) => t.shadowRoot?.textContent ?? "").join(" ");
    expect(tableText).toContain("tools_changed");
  });

  it("OMITS the optional sections when absent (presence-conditional)", async () => {
    const { rpc } = createIncidentMock(() => fixtureReportNoOptionalSections());
    const el = await createElement(rpc, { sessionKey: "agent:default:telegram:12345" });

    expect(priv(el)._loadState).toBe("loaded");
    const hostText = (el.shadowRoot?.textContent ?? "").toLowerCase();
    // The optional section titles are absent.
    expect(hostText).not.toContain("cache breaks");
    expect(hostText).not.toContain("kill-switch breach");
    // And no nested table surfaces the omitted cacheBreaks rows.
    const tables = Array.from(el.shadowRoot?.querySelectorAll("ic-data-table") ?? []);
    const tableText = tables.map((t) => t.shadowRoot?.textContent ?? "").join(" ");
    expect(tableText).not.toContain("tools_changed");
    // The core report still renders (the header carries the verdict code).
    expect(el.shadowRoot?.textContent ?? "").toContain("spend_exceeded");
  });

  it("honest-degradation: NO sessionKey/traceId renders an ic-empty-state 'select an incident', NOT a blank", async () => {
    const { rpc, call } = createIncidentMock(() => fixtureReport());
    const el = await createElement(rpc, {}); // no ref

    // With no ref the view must NOT call obs.explain.
    expect(call).not.toHaveBeenCalledWith("obs.explain", expect.anything());
    const empty = el.shadowRoot?.querySelector("ic-empty-state");
    expect(empty).toBeTruthy();
    expect((empty as unknown as { message: string }).message.toLowerCase()).toContain("incident");
  });

  it("admin-denial: an 'Admin access required' rejection surfaces the error path", async () => {
    const { rpc } = createIncidentMock(() => {
      throw new Error("Admin access required");
    });
    const el = await createElement(rpc, { sessionKey: "agent:default:telegram:12345" });

    expect(priv(el)._loadState).toBe("error");
    expect(el.shadowRoot?.querySelector(".error-container")).toBeTruthy();
    expect(el.shadowRoot?.querySelector(".retry-btn")).toBeTruthy();
  });

  it("content-free: a planted body marker in the report is absent from the rendered DOM", async () => {
    const { rpc } = createIncidentMock(() => fixtureReport());
    const el = await createElement(rpc, { sessionKey: "agent:default:telegram:12345" });

    const text = el.shadowRoot?.textContent ?? "";
    expect(text).not.toContain(PLANTED_MARKER);
  });

  /* -- Grafana link-out: a link, NEVER an embed (locked §14) -------- */

  it("renders an 'Open in Grafana' <a href target=_blank rel=noopener> when prometheus.enabled", async () => {
    const { rpc } = createIncidentMock(() => fixtureReport(), /* prometheusEnabled */ true);
    const el = await createElement(rpc, { sessionKey: "agent:default:telegram:12345" });

    expect(priv(el)._prometheusEnabled).toBe(true);
    const link = Array.from(el.shadowRoot?.querySelectorAll("a") ?? []).find((a) =>
      (a.textContent ?? "").toLowerCase().includes("grafana"),
    );
    expect(link).toBeTruthy();
    expect(link!.getAttribute("href")).toBeTruthy();
    expect(link!.getAttribute("target")).toBe("_blank");
    expect(link!.getAttribute("rel") ?? "").toContain("noopener");
  });

  it("does NOT render the Grafana link when prometheus is disabled (honest)", async () => {
    const { rpc } = createIncidentMock(() => fixtureReport(), /* prometheusEnabled */ false);
    const el = await createElement(rpc, { sessionKey: "agent:default:telegram:12345" });

    expect(priv(el)._prometheusEnabled).toBe(false);
    const link = Array.from(el.shadowRoot?.querySelectorAll("a") ?? []).find((a) =>
      (a.textContent ?? "").toLowerCase().includes("grafana"),
    );
    expect(link).toBeFalsy();
  });

  it("NEVER embeds Grafana — there is NO <iframe> in the DOM even when prometheus.enabled (link, never embed)", async () => {
    const { rpc } = createIncidentMock(() => fixtureReport(), /* prometheusEnabled */ true);
    const el = await createElement(rpc, { sessionKey: "agent:default:telegram:12345" });

    // The locked §14 invariant: zero-dependency SPA — link out, never embed.
    expect(el.shadowRoot?.querySelector("iframe")).toBeNull();
    expect((el.shadowRoot?.innerHTML ?? "").toLowerCase()).not.toContain("<iframe");
  });

  it("loading state: a null rpcClient settles without throwing (no error state)", async () => {
    const el = await createElement(null, { sessionKey: "agent:default:telegram:12345" });
    expect(priv(el)._loadState).not.toBe("error");
  });

  it("accepts a traceId as the drill ref (sessionKey | traceId)", async () => {
    const { rpc, call } = createIncidentMock(() => fixtureReport());
    await createElement(rpc, { traceId: "trace-abc-123" });

    expect(call).toHaveBeenCalledWith(
      "obs.explain",
      expect.objectContaining({ traceId: "trace-abc-123" }),
    );
  });
});
