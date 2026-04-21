// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import type { WebhookMappingContext } from "./webhook-mapping.js";
import {
  normalizeMatchPath,
  renderTemplate,
  resolveWebhookMapping,
  resolveTemplateExpr,
} from "./webhook-mapping.js";
import { getPresetMappings, GMAIL_PRESET, GITHUB_PRESET } from "./webhook-presets.js";
import type { WebhookMappingConfig } from "@comis/core";

// ---------------------------------------------------------------------------
// normalizeMatchPath
// ---------------------------------------------------------------------------

describe("normalizeMatchPath", () => {
  it("strips leading slashes", () => {
    expect(normalizeMatchPath("/gmail")).toBe("gmail");
  });

  it("strips trailing slashes", () => {
    expect(normalizeMatchPath("gmail/")).toBe("gmail");
  });

  it("strips both leading and trailing slashes", () => {
    expect(normalizeMatchPath("/gmail/")).toBe("gmail");
  });

  it("lowercases the path", () => {
    expect(normalizeMatchPath("GitHub")).toBe("github");
  });

  it("handles empty string", () => {
    expect(normalizeMatchPath("")).toBe("");
  });

  it("handles multiple slashes", () => {
    expect(normalizeMatchPath("///hooks///")).toBe("hooks");
  });

  it("preserves internal path segments", () => {
    expect(normalizeMatchPath("/hooks/gmail/inbox")).toBe("hooks/gmail/inbox");
  });
});

// ---------------------------------------------------------------------------
// resolveTemplateExpr
// ---------------------------------------------------------------------------

describe("resolveTemplateExpr", () => {
  const ctx: WebhookMappingContext = {
    payload: {
      repository: { full_name: "user/repo" },
      action: "opened",
      sender: { login: "octocat" },
      messages: [{ id: "msg-1", from: "alice@example.com", subject: "Hello" }],
    },
    headers: { "x-github-event": "push", "x-github-delivery": "abc-123" },
    query: { token: "xyz", page: "2" },
    path: "github",
    now: "2026-02-12T00:00:00Z",
  };

  it("resolves path", () => {
    expect(resolveTemplateExpr("path", ctx)).toBe("github");
  });

  it("resolves now", () => {
    expect(resolveTemplateExpr("now", ctx)).toBe("2026-02-12T00:00:00Z");
  });

  it("resolves payload dot-path", () => {
    expect(resolveTemplateExpr("payload.repository.full_name", ctx)).toBe("user/repo");
  });

  it("resolves header", () => {
    expect(resolveTemplateExpr("headers.x-github-event", ctx)).toBe("push");
  });

  it("resolves query param", () => {
    expect(resolveTemplateExpr("query.token", ctx)).toBe("xyz");
  });

  it("resolves array index notation", () => {
    expect(resolveTemplateExpr("payload.messages[0].id", ctx)).toBe("msg-1");
  });

  it("returns undefined for missing path", () => {
    expect(resolveTemplateExpr("payload.nonexistent.field", ctx)).toBeUndefined();
  });

  it("resolves top-level fields without payload prefix", () => {
    expect(resolveTemplateExpr("repository.full_name", ctx)).toBe("user/repo");
  });
});

// ---------------------------------------------------------------------------
// renderTemplate
// ---------------------------------------------------------------------------

describe("renderTemplate", () => {
  const ctx: WebhookMappingContext = {
    payload: {
      repository: { full_name: "user/repo" },
      action: "opened",
      sender: { login: "octocat" },
      messages: [{ id: "msg-1", from: "alice@example.com", subject: "Hello" }],
    },
    headers: { "x-github-event": "push", "x-github-delivery": "abc-123" },
    query: { token: "xyz" },
    path: "github",
    now: "2026-02-12T00:00:00Z",
  };

  it("resolves payload fields", () => {
    const result = renderTemplate("Repo: {{payload.repository.full_name}}", ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("Repo: user/repo");
  });

  it("resolves header fields", () => {
    const result = renderTemplate("Event: {{headers.x-github-event}}", ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("Event: push");
  });

  it("resolves query params", () => {
    const result = renderTemplate("Token: {{query.token}}", ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("Token: xyz");
  });

  it("resolves {{now}}", () => {
    const result = renderTemplate("Time: {{now}}", ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("Time: 2026-02-12T00:00:00Z");
  });

  it("resolves {{path}}", () => {
    const result = renderTemplate("Path: {{path}}", ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("Path: github");
  });

  it("resolves nested dot-paths and array indices", () => {
    const result = renderTemplate("From: {{payload.messages[0].from}}", ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("From: alice@example.com");
  });

  it("replaces unresolved expressions with empty string", () => {
    const result = renderTemplate("Missing: {{payload.unknown.field}}", ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("Missing: ");
  });

  it("handles multiple expressions in one template", () => {
    const result = renderTemplate(
      "{{headers.x-github-event}}: {{payload.repository.full_name}} by {{payload.sender.login}}",
      ctx,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("push: user/repo by octocat");
  });

  it("handles template with no expressions", () => {
    const result = renderTemplate("No placeholders here", ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("No placeholders here");
  });

  it("handles whitespace in expression", () => {
    const result = renderTemplate("{{ payload.action }}", ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("opened");
  });
});

// ---------------------------------------------------------------------------
// resolveWebhookMapping
// ---------------------------------------------------------------------------

describe("resolveWebhookMapping", () => {
  const mappings: WebhookMappingConfig[] = [
    { match: { path: "gmail" }, action: "agent", wakeMode: "now" },
    { match: { path: "github", source: "github-app" }, action: "agent", wakeMode: "now" },
    { match: { source: "monitoring" }, action: "wake", wakeMode: "now" },
    { action: "wake", wakeMode: "next-heartbeat" }, // catch-all (no match)
  ];

  it("matches by path", () => {
    const result = resolveWebhookMapping(mappings, "/gmail/");
    expect(result).toBeDefined();
    expect(result?.match?.path).toBe("gmail");
  });

  it("matches by source when path is not specified", () => {
    const result = resolveWebhookMapping(mappings, "other", "monitoring");
    expect(result).toBeDefined();
    expect(result?.action).toBe("wake");
  });

  it("matches by both path AND source", () => {
    const result = resolveWebhookMapping(mappings, "github", "github-app");
    expect(result).toBeDefined();
    expect(result?.match?.path).toBe("github");
    expect(result?.match?.source).toBe("github-app");
  });

  it("rejects path match when source does not match", () => {
    // "github" mapping requires source "github-app"
    const result = resolveWebhookMapping(mappings, "github", "wrong-source");
    // Should fall through to the source-only mapping or catch-all
    expect(result).toBeDefined();
    expect(result?.match?.source).not.toBe("github-app");
  });

  it("returns undefined on no match", () => {
    // Remove the catch-all for this test
    const strict: WebhookMappingConfig[] = [
      { match: { path: "gmail" }, action: "agent", wakeMode: "now" },
    ];
    const result = resolveWebhookMapping(strict, "unknown");
    expect(result).toBeUndefined();
  });

  it("first-match-wins ordering", () => {
    const ordered: WebhookMappingConfig[] = [
      { id: "first", match: { path: "test" }, action: "wake", wakeMode: "now" },
      { id: "second", match: { path: "test" }, action: "agent", wakeMode: "now" },
    ];
    const result = resolveWebhookMapping(ordered, "test");
    expect(result?.id).toBe("first");
  });

  it("falls through to catch-all when specific mappings do not match", () => {
    const result = resolveWebhookMapping(mappings, "unknown-path");
    expect(result).toBeDefined();
    expect(result?.action).toBe("wake");
    expect(result?.wakeMode).toBe("next-heartbeat");
  });

  it("normalizes request path before comparison", () => {
    const result = resolveWebhookMapping(mappings, "/Gmail/");
    expect(result).toBeDefined();
    expect(result?.match?.path).toBe("gmail");
  });
});

// ---------------------------------------------------------------------------
// webhook-presets
// ---------------------------------------------------------------------------

describe("getPresetMappings", () => {
  it("returns gmail preset", () => {
    const result = getPresetMappings(["gmail"]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(GMAIL_PRESET);
    expect(result[0].id).toBe("gmail");
  });

  it("returns github preset", () => {
    const result = getPresetMappings(["github"]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(GITHUB_PRESET);
    expect(result[0].id).toBe("github");
  });

  it("returns multiple presets in order", () => {
    const result = getPresetMappings(["github", "gmail"]);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("github");
    expect(result[1].id).toBe("gmail");
  });

  it("ignores unknown preset names", () => {
    const result = getPresetMappings(["unknown", "gmail"]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("gmail");
  });

  it("returns empty array for no known presets", () => {
    const result = getPresetMappings(["unknown"]);
    expect(result).toHaveLength(0);
  });

  it("is case-insensitive for preset names", () => {
    const result = getPresetMappings(["Gmail", "GITHUB"]);
    expect(result).toHaveLength(2);
  });
});

describe("preset configurations", () => {
  it("gmail preset has correct match path", () => {
    expect(GMAIL_PRESET.match?.path).toBe("gmail");
  });

  it("gmail preset uses agent action", () => {
    expect(GMAIL_PRESET.action).toBe("agent");
  });

  it("gmail preset has session key template", () => {
    expect(GMAIL_PRESET.sessionKey).toContain("hook:gmail:");
  });

  it("gmail preset has message template with email fields", () => {
    expect(GMAIL_PRESET.messageTemplate).toContain("from");
    expect(GMAIL_PRESET.messageTemplate).toContain("subject");
  });

  it("github preset has correct match path", () => {
    expect(GITHUB_PRESET.match?.path).toBe("github");
  });

  it("github preset uses delivery header for session key", () => {
    expect(GITHUB_PRESET.sessionKey).toContain("x-github-delivery");
  });

  it("github preset message references event type", () => {
    expect(GITHUB_PRESET.messageTemplate).toContain("x-github-event");
  });
});
