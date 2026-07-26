// SPDX-License-Identifier: Apache-2.0
/**
 * The durable security-audit sink — `secret_access` correlation + trail purity.
 */
import { describe, it, expect } from "vitest";
import { TypedEventBus } from "@comis/core";
import { wireAuditSink } from "./obs-audit-sink.js";
import type { AuditEventRow } from "./obs-audit-sink.js";

/** Wire the sink over a real bus with a capturing buffer (sqlite-only, no fs). */
function makeSinkHarness() {
  const bus = new TypedEventBus();
  const rows: AuditEventRow[] = [];
  wireAuditSink({
    eventBus: bus,
    auditBuffer: { push: (row: AuditEventRow) => rows.push(row) } as never,
    auditConfig: { persist: true, sink: "sqlite" },
  });
  return { bus, rows };
}

describe("secret_access correlation + trail purity", () => {
  // Live: every row carried tenantId:"" and traceId:null (boot reads have no
  // ALS context), so an access could never be joined to a session — and PATH
  // was audited as a secret access, diluting the trail.
  function payload(over: Record<string, unknown> = {}) {
    return {
      secretName: "PROVIDER_API_KEY",
      agentId: "default",
      outcome: "success" as const,
      timestamp: 1,
      ...over,
    };
  }

  it("prefers the payload's correlation over AsyncLocalStorage", () => {
    const { bus, rows } = makeSinkHarness();
    bus.emit("secret:accessed", payload({ traceId: "trace-7", sessionKey: "sk-7" }) as never);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.traceId).toBe("trace-7");
    const refs = JSON.parse(String(rows[0]!.refs));
    expect(refs.origin).toBe("request");
    expect(refs.sessionKey).toBe("sk-7");
  });

  it("tags a context-less read as origin:boot — no-context-by-design, not context-lost", () => {
    const { bus, rows } = makeSinkHarness();
    bus.emit("secret:accessed", payload() as never);
    expect(rows).toHaveLength(1);
    const refs = JSON.parse(String(rows[0]!.refs));
    expect(refs.origin).toBe("boot");
  });

  it("does NOT record routine environment names as secret accesses", () => {
    const { bus, rows } = makeSinkHarness();
    for (const name of ["PATH", "HOME", "LANG", "TERM"]) {
      bus.emit("secret:accessed", payload({ secretName: name }) as never);
    }
    expect(rows).toHaveLength(0);
  });

  it("STILL records a real credential read (the filter must not over-match)", () => {
    const { bus, rows } = makeSinkHarness();
    bus.emit("secret:accessed", payload({ secretName: "AWS_BEARER_TOKEN_BEDROCK" }) as never);
    expect(rows).toHaveLength(1);
  });
});
