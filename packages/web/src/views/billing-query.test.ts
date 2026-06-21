// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the typed-query DSL (`parseBillingQuery` + `applyBillingFilter`).
 *
 * RED-first: the module is greenfield. These assert the closed-key grammar,
 * number coercion, unknown-key tolerance, the filter predicate, and the two
 * cross-cutting invariants — injection-safety (a typed object, never SQL) and
 * content-free filtering (ids/enums/numbers only, never a free-text body).
 */

import { describe, it, expect } from "vitest";
import {
  parseBillingQuery,
  applyBillingFilter,
  type BillingFilter,
  type BillingFilterableRow,
} from "./billing-query.js";

describe("parseBillingQuery", () => {
  it("parses the full 7-key example into a typed filter", () => {
    const filter = parseBillingQuery(
      "agent:foo provider:openai minTokens:100 maxCost:0.5 has:errors tool:bash model:gpt-4o",
    );
    expect(filter).toEqual({
      agent: "foo",
      provider: "openai",
      model: "gpt-4o",
      tool: "bash",
      minTokens: 100,
      maxCost: 0.5,
      hasErrors: true,
    });
  });

  it("ignores unknown keys without throwing (never executed)", () => {
    const filter = parseBillingQuery("agent:foo bogus:value DROP:table provider:openai");
    expect(filter).toEqual({ agent: "foo", provider: "openai" });
    expect(filter).not.toHaveProperty("bogus");
    expect(filter).not.toHaveProperty("DROP");
  });

  it("coerces minTokens/maxCost to numbers and drops non-numeric values (no NaN)", () => {
    const filter = parseBillingQuery("minTokens:abc maxCost:1.25 agent:bar");
    // minTokens:abc is non-numeric -> dropped (NOT NaN-propagated)
    expect(filter.minTokens).toBeUndefined();
    expect(filter.maxCost).toBe(1.25);
    expect(filter.agent).toBe("bar");
    // sanity: no NaN anywhere
    expect(Number.isNaN(filter.maxCost)).toBe(false);
  });

  it("maps has:errors to hasErrors:true and ignores other has: values", () => {
    expect(parseBillingQuery("has:errors").hasErrors).toBe(true);
    expect(parseBillingQuery("has:whatever").hasErrors).toBeUndefined();
  });

  it("tokenizes on whitespace and splits each token on the FIRST colon", () => {
    // a model id can itself contain a colon (e.g. ollama-style) -> only the
    // first colon delimits key/value
    const filter = parseBillingQuery("model:registry:qwen3:8b");
    expect(filter.model).toBe("registry:qwen3:8b");
  });

  it("returns an empty filter for empty / whitespace / malformed input (degrades gracefully)", () => {
    expect(parseBillingQuery("")).toEqual({});
    expect(parseBillingQuery("   ")).toEqual({});
    // tokens with no colon at all are ignored, not thrown on
    expect(parseBillingQuery("just some words")).toEqual({});
    // a dangling key with no value is dropped
    expect(parseBillingQuery("agent:")).toEqual({});
  });

  it("is injection-safe by construction — produces a plain typed object, never SQL", () => {
    // A single-token SQL fragment is captured VERBATIM as data (whitespace
    // would tokenize it; a value with no spaces stays intact). It is only ever
    // compared with === inside applyBillingFilter — never interpreted.
    const malicious = parseBillingQuery("agent:'OR'1'='1';DROP--");
    expect(malicious.agent).toBe("'OR'1'='1';DROP--");
    expect(typeof malicious).toBe("object");
    // and a whitespace-bearing SQL fragment is harmlessly SHREDDED into tokens
    // (the rest are unknown/no-colon and dropped) — proving the parser cannot
    // be steered into a query string.
    const shredded = parseBillingQuery("agent:x'; DROP TABLE obs_token_usage; --");
    expect(shredded).toEqual({ agent: "x';" });
  });
});

describe("applyBillingFilter", () => {
  const ROWS: BillingFilterableRow[] = [
    { agent: "alpha", provider: "openai", model: "gpt-4o", tool: "bash", tokens: 500, cost: 0.2, hasErrors: false },
    { agent: "beta", provider: "anthropic", model: "claude-sonnet-4", tool: "read", tokens: 50, cost: 1.0, hasErrors: true },
    { agent: "alpha", provider: "anthropic", model: "claude-haiku", tool: "bash", tokens: 200, cost: 0.4, hasErrors: false },
  ];

  it("filters rows by the agent axis", () => {
    const out = applyBillingFilter(ROWS, parseBillingQuery("agent:alpha"));
    expect(out).toHaveLength(2);
    expect(out.every((r) => r.agent === "alpha")).toBe(true);
  });

  it("filters by provider + tool together (AND)", () => {
    const out = applyBillingFilter(ROWS, parseBillingQuery("provider:anthropic tool:bash"));
    expect(out).toHaveLength(1);
    expect(out[0]!.model).toBe("claude-haiku");
  });

  it("filters by minTokens (>=) and maxCost (<=)", () => {
    expect(applyBillingFilter(ROWS, parseBillingQuery("minTokens:200"))).toHaveLength(2);
    expect(applyBillingFilter(ROWS, parseBillingQuery("maxCost:0.4"))).toHaveLength(2);
    expect(applyBillingFilter(ROWS, parseBillingQuery("minTokens:200 maxCost:0.3"))).toHaveLength(1);
  });

  it("filters by has:errors", () => {
    const out = applyBillingFilter(ROWS, parseBillingQuery("has:errors"));
    expect(out).toHaveLength(1);
    expect(out[0]!.agent).toBe("beta");
  });

  it("returns all rows for an empty filter", () => {
    expect(applyBillingFilter(ROWS, {})).toHaveLength(3);
  });

  it("returns all rows when an unknown-key-only query degrades to an empty filter", () => {
    const filter: BillingFilter = parseBillingQuery("bogus:x");
    expect(applyBillingFilter(ROWS, filter)).toHaveLength(3);
  });

  it("is content-free — has no body/message field to filter on", () => {
    // a planted body marker on a row is irrelevant: the filter keys are a
    // closed enum of ids/numbers, so a body cannot become a filter axis
    const withBody = [
      { ...ROWS[0]!, message: "SECRET_BODY_MARKER" } as BillingFilterableRow & { message: string },
    ];
    const out = applyBillingFilter(withBody, parseBillingQuery("agent:alpha"));
    expect(out).toHaveLength(1);
    // the filter never reads .message
  });
});
