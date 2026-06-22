// SPDX-License-Identifier: Apache-2.0
// CREDENTIAL_KEYS membership for proxyUrl / proxy_url — the Pino redact-path
// half of the SEC-04 / D-08 two-layer credential defence. The `sanitizeProxyUrl`
// unit tests moved to packages/core/src/net/sanitize.test.ts alongside the
// implementation; this block stays in @comis/infra because it depends on
// @comis/observability (which @comis/core does not).
import { describe, expect, it } from "vitest";

import { isCredentialFieldName } from "@comis/observability";

describe("CREDENTIAL_KEYS membership — Pino redact-path auto-generation (SEC-04 / RESEARCH 587-606)", () => {
  it("isCredentialFieldName recognises proxyUrl so raw proxy URL log fields are auto-redacted", () => {
    expect(isCredentialFieldName("proxyUrl")).toBe(true);
  });

  it("isCredentialFieldName recognises proxy_url so snake_case log fields are auto-redacted", () => {
    expect(isCredentialFieldName("proxy_url")).toBe(true);
  });

  it("isCredentialFieldName still recognises pre-existing credential keys (regression guard)", () => {
    expect(isCredentialFieldName("apiKey")).toBe(true);
    expect(isCredentialFieldName("botToken")).toBe(true);
    expect(isCredentialFieldName("password")).toBe(true);
  });
});
