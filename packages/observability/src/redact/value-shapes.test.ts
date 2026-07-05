// SPDX-License-Identifier: Apache-2.0
/**
 * Value-shape redactor tests.
 *
 * Per-pattern positive + negative fixtures; walker tests; per-event redactor tests.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import {
  redactString,
  redactEventForExport,
  walkAndRedactStrings,
  getValueShapePatterns,
  substitutePathsInString,
  type ValueShapePattern,
} from "./value-shapes.js";
import type { TrajectoryEvent } from "../trajectory/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function patternById(id: string): ValueShapePattern {
  const patterns = getValueShapePatterns();
  const p = patterns.find((x) => x.id === id);
  if (!p) throw new Error(`pattern id "${id}" missing from value-shape set`);
  return p;
}

/** Recompile fresh RegExp so /g lastIndex doesn't leak. */
function patternMatches(p: ValueShapePattern, sample: string): boolean {
  const re = new RegExp(p.regex.source, p.regex.flags);
  return re.test(sample);
}

function makeEvent(data?: Record<string, unknown>): TrajectoryEvent {
  return {
    traceSchema: "comis-trajectory",
    schemaVersion: 1,
    source: "runtime",
    type: "session.started",
    ts: "2026-05-25T00:00:00.000Z",
    seq: 1,
    agentId: "agent-1",
    sessionId: "sess-abc",
    traceId: "trace-xyz",
    entryId: "entry-001",
    data,
  };
}

// ---------------------------------------------------------------------------
// Pattern set surface (13 patterns)
// ---------------------------------------------------------------------------

describe("value-shape pattern set — surface", () => {
  it("returns exactly 13 patterns", () => {
    expect(getValueShapePatterns().length).toBe(13);
  });

  it("every pattern has id, regex, and sentinel fields", () => {
    for (const p of getValueShapePatterns()) {
      expect(typeof p.id).toBe("string");
      expect(p.regex).toBeInstanceOf(RegExp);
      expect(typeof p.sentinel).toBe("string");
    }
  });

  it("every sentinel is exactly `<REDACTED:${id}>`", () => {
    for (const p of getValueShapePatterns()) {
      expect(p.sentinel).toBe(`<REDACTED:${p.id}>`);
    }
  });

  it("pattern ids are unique", () => {
    const ids = getValueShapePatterns().map((p) => p.id);
    expect(new Set(ids).size).toBe(13);
  });

  it("every pattern has the global flag (g) for replace semantics", () => {
    for (const p of getValueShapePatterns()) {
      expect(p.regex.flags).toContain("g");
    }
  });

  it("the pattern array is frozen (immutable)", () => {
    const patterns = getValueShapePatterns();
    expect(Object.isFrozen(patterns)).toBe(true);
  });

  it("expected ids present: all 13 known ids", () => {
    const ids = new Set(getValueShapePatterns().map((p) => p.id));
    const expected = [
      "secret-field",
      "payload-field",
      "identifier-field",
      "aws-access-key-id",
      "jwt",
      "url-userinfo",
      "url-param",
      "email",
      "long-decimal-id",
      "basic-auth",
      "cookie-header",
      "openai-key",
      "bearer-token",
    ];
    for (const id of expected) {
      expect(ids.has(id), `expected id "${id}" to be present`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// redactString — per-pattern positive cases (must redact)
// ---------------------------------------------------------------------------

describe("redactString — per-pattern positive cases", () => {
  it("secret-field: redacts 'authorization' substring in body text", () => {
    const result = redactString("the authorization header was leaked");
    expect(result).toContain("<REDACTED:secret-field>");
    expect(result).not.toContain("authorization");
  });

  it("payload-field: redacts 'message' substring in body text", () => {
    const result = redactString("the message body was received");
    expect(result).toContain("<REDACTED:payload-field>");
  });

  it("identifier-field: redacts 'user_id' substring in body text", () => {
    // "user_id" matches the identifier-field pattern (user[-_]?id)
    // Use a context where no other field-name pattern fires on the same word
    const result = redactString("the user_id was provided");
    expect(result).toContain("<REDACTED:identifier-field>");
  });

  it("aws-access-key-id: redacts AKIA + 16 uppercase alphanumeric chars", () => {
    // "key" in "key: AKIA..." is also matched by secret-field (substring "key")
    // Just assert the aws-access-key-id sentinel is present
    const result = redactString("AKIAIOSFODNN7EXAMPLE was leaked");
    expect(result).toContain("<REDACTED:aws-access-key-id>");
    expect(result).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("jwt: redacts a three-segment base64url JWT token", () => {
    // A real-shaped JWT: 3 segments separated by dots, each ≥10 chars
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const result = redactString(`token=${jwt}`);
    expect(result).toContain("<REDACTED:jwt>");
    expect(result).not.toContain("eyJhbGci");
  });

  it("url-userinfo: redacts credentials in https://user:pass@host URLs", () => {
    const result = redactString("connect to https://user:pass@example.com/path");
    expect(result).toContain("<REDACTED:url-userinfo>");
    expect(result).not.toContain("user:pass@");
  });

  it("url-param: redacts query parameter values", () => {
    const result = redactString("GET /api?api_key=s3cr3t&foo=bar");
    expect(result).toContain("<REDACTED:url-param>");
    expect(result).not.toContain("s3cr3t");
  });

  it("email: redacts a standard email address", () => {
    const result = redactString("contact alice@example.com for help");
    expect(result).toBe("contact <REDACTED:email> for help");
  });

  it("long-decimal-id: redacts a 9+ digit string of digits (chat ID)", () => {
    // "chat" in "chat id" matches payload-field (substring); use a context
    // where no field-name pattern fires on the surrounding words
    const result = redactString("id=123456789 connected");
    expect(result).toContain("<REDACTED:long-decimal-id>");
    expect(result).not.toContain("123456789");
  });

  it("basic-auth: redacts a Base64-encoded Basic auth credential", () => {
    const result = redactString("Authorization: Basic dXNlcjpwYXNz");
    expect(result).toContain("<REDACTED:basic-auth>");
    expect(result).not.toContain("dXNlcjpwYXNz");
  });

  it("cookie-header: redacts a Cookie header line", () => {
    const result = redactString("Cookie: session=abc123; auth=xyz");
    expect(result).toBe("<REDACTED:cookie-header>");
  });

  it("openai-key: redacts an sk- key of 16+ token chars", () => {
    const result = redactString("apiKey=sk-test00000000000000000000000000000000000000abcd done");
    expect(result).toContain("<REDACTED:openai-key>");
    expect(result).not.toContain("sk-test00000000000000000000000000000000000000abcd");
  });

  it("bearer-token: redacts a `Bearer <token>` authorization value", () => {
    const result = redactString("hdr Bearer aXbYcZ0123456789abcdefghij tail");
    expect(result).toContain("<REDACTED:bearer-token>");
    expect(result).not.toContain("aXbYcZ0123456789abcdefghij");
  });
});

// ---------------------------------------------------------------------------
// redactString — per-pattern negative cases (must NOT redact)
// ---------------------------------------------------------------------------

describe("redactString — per-pattern negative cases", () => {
  it("secret-field: a sentence with no matching field-name substring is unchanged", () => {
    const input = "the file was loaded successfully";
    expect(redactString(input)).toBe(input);
  });

  it("payload-field: a sentence with no payload field substrings is unchanged", () => {
    const input = "the operation completed in 12ms";
    expect(redactString(input)).toBe(input);
  });

  it("identifier-field: a sentence with no identifier field substrings is unchanged", () => {
    // 'the', 'file', 'loaded' contain no chatId/userId/email/username substring
    const input = "the file was loaded";
    expect(redactString(input)).toBe(input);
  });

  it("aws-access-key-id: AKIA123 (too short body — only 3 chars) is NOT redacted", () => {
    const p = patternById("aws-access-key-id");
    expect(patternMatches(p, "AKIA123")).toBe(false);
  });

  it("jwt: eyJ123 (too short — body < 10 chars) is NOT redacted", () => {
    const p = patternById("jwt");
    expect(patternMatches(p, "eyJ123.short.abc")).toBe(false);
  });

  it("url-userinfo: plain https://example.com/path (no credentials) is NOT redacted", () => {
    const input = "connect to https://example.com/path";
    // url-userinfo pattern requires @; plain URL has none
    expect(redactString(input)).toBe(input);
  });

  it("url-param: plain body text with no query-string syntax is NOT redacted by url-param", () => {
    // The url-param pattern requires ?key=value or &key=value syntax.
    // Note: "text" in the input will be caught by payload-field (it's a keyword);
    // choose input that has no field-name keywords and no url-param syntax.
    const input = "a plain sentence with no params";
    expect(redactString(input)).toBe(input);
  });

  it("email: 'tool@v1' (no TLD dot after single char) is NOT redacted by email pattern", () => {
    // email regex requires \.[A-Z]{2,}\b — 'v1' has no dot at all
    const p = patternById("email");
    expect(patternMatches(p, "tool@v1")).toBe(false);
  });

  it("long-decimal-id: '12345678' (8 digits, below threshold) is NOT redacted", () => {
    const input = "count 12345678";
    expect(redactString(input)).toBe(input);
  });

  it("basic-auth: 'BasicAuthDocs' (no whitespace between Basic and rest) is NOT redacted", () => {
    // Regex requires \bBasic\s+ — no space between 'Basic' and 'Auth' in 'BasicAuthDocs'
    const p = patternById("basic-auth");
    expect(patternMatches(p, "BasicAuthDocs")).toBe(false);
  });

  it("cookie-header: 'Cookies are tasty' (no colon after Cookie) is NOT redacted", () => {
    // Regex requires Cookie\s*: with colon — 'Cookies are' has no colon
    const p = patternById("cookie-header");
    expect(patternMatches(p, "Cookies are tasty")).toBe(false);
  });

  it("openai-key: bare 'sk-' and a short 'sk-short' variant are NOT redacted", () => {
    // Requires sk- + 16+ token chars — short labels and benign mentions pass.
    const p = patternById("openai-key");
    expect(patternMatches(p, "sk-")).toBe(false);
    expect(patternMatches(p, "sk-short")).toBe(false);
  });

  it("bearer-token: lowercase 'bearer' prose (no long token) is NOT redacted", () => {
    // Case-sensitive on `Bearer` + an 18+ char token, so English prose is spared.
    const p = patternById("bearer-token");
    expect(patternMatches(p, "the bearer of the news")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// walkAndRedactStrings
// ---------------------------------------------------------------------------

describe("walkAndRedactStrings", () => {
  it("redacts a JWT in a top-level string", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const result = walkAndRedactStrings(jwt);
    expect(result).toContain("<REDACTED:jwt>");
  });

  it("leaves a number unchanged (no string coercion — Unix ms timestamp landmine)", () => {
    const result = walkAndRedactStrings(1735689600000);
    expect(result).toBe(1735689600000);
    expect(typeof result).toBe("number");
  });

  it("redacts 9+ digit chatId string value, leaves ISO ts string alone", () => {
    const input = {
      ts: "2026-05-25T00:00:00.000Z",
      chatId: "1234567890",
    };
    const result = walkAndRedactStrings(input) as Record<string, unknown>;
    // ISO timestamp: \b breaks on - and :, no 9+ consecutive digits
    expect(result["ts"]).toBe("2026-05-25T00:00:00.000Z");
    // 10-digit string is redacted
    expect(result["chatId"]).toBe("<REDACTED:long-decimal-id>");
  });

  it("recurses deeply into nested objects and redacts email at depth N", () => {
    const input = { nested: { deep: { email: "alice@example.com" } } };
    const result = walkAndRedactStrings(input) as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    expect(result["nested"]["deep"]["email"]).toContain("<REDACTED:email>");
  });

  it("redacts email in arrays but passes numbers through", () => {
    const input = { list: ["regular", "alice@example.com", 123] };
    const result = walkAndRedactStrings(input) as Record<string, unknown[]>;
    expect(result["list"][0]).toBe("regular");
    expect((result["list"][1] as string)).toContain("<REDACTED:email>");
    expect(result["list"][2]).toBe(123);
  });

  it("handles circular references without throwing (returns { __cycle: true })", () => {
    const obj: Record<string, unknown> = { a: "hello" };
    obj["self"] = obj; // circular reference
    expect(() => walkAndRedactStrings(obj)).not.toThrow();
    const result = walkAndRedactStrings(obj) as Record<string, unknown>;
    expect(result["self"]).toEqual({ __cycle: true });
  });
});

// ---------------------------------------------------------------------------
// redactEventForExport
// ---------------------------------------------------------------------------

describe("redactEventForExport", () => {
  it("returns the same event reference when data is undefined", () => {
    const event = makeEvent(undefined);
    const result = redactEventForExport(event);
    expect(result).toBe(event);
  });

  it("returns a NEW event object (not the same reference) when data is defined", () => {
    const event = makeEvent({ note: "hello" });
    const result = redactEventForExport(event);
    expect(result).not.toBe(event);
  });

  it("does NOT mutate the original event's data", () => {
    const data = { email: "alice@example.com" };
    const event = makeEvent(data);
    redactEventForExport(event);
    // Original data must remain untouched
    expect(data["email"]).toBe("alice@example.com");
  });

  it("preserves all envelope fields verbatim", () => {
    const event = makeEvent({ chatId: "987654321" });
    const result = redactEventForExport(event);
    expect(result.traceSchema).toBe(event.traceSchema);
    expect(result.schemaVersion).toBe(event.schemaVersion);
    expect(result.source).toBe(event.source);
    expect(result.type).toBe(event.type);
    expect(result.ts).toBe(event.ts);
    expect(result.seq).toBe(event.seq);
    expect(result.agentId).toBe(event.agentId);
    expect(result.sessionId).toBe(event.sessionId);
    expect(result.traceId).toBe(event.traceId);
    expect(result.entryId).toBe(event.entryId);
  });

  it("leaves number-typed data values untouched (no false positives on seq/counts)", () => {
    const event = makeEvent({ seq: 1234, durationMs: 567, count: 99 });
    const result = redactEventForExport(event);
    expect(result.data?.["seq"]).toBe(1234);
    expect(result.data?.["durationMs"]).toBe(567);
    expect(result.data?.["count"]).toBe(99);
  });

  it("redacts string-typed data values with matching patterns", () => {
    const event = makeEvent({
      chatId: "1234567890",
      email: "alice@example.com",
      // "plain text": "text" is a payload-field keyword, so it will be redacted.
      // Use a note with no field-name keywords.
      note: "a benign note",
    });
    const result = redactEventForExport(event);
    expect((result.data?.["chatId"] as string)).toBe("<REDACTED:long-decimal-id>");
    expect((result.data?.["email"] as string)).toContain("<REDACTED:email>");
    expect(result.data?.["note"]).toBe("a benign note");
  });

  it("opts.workspaceDir path substitution applied to string data fields", () => {
    const event = makeEvent({
      sessionPath: "/Users/alice/.comis/workspace/sessions/x",
    });
    const opts = { workspaceDir: "/Users/alice/.comis/workspace" };
    const result = redactEventForExport(event, opts);
    expect(result.data?.["sessionPath"]).toBe("$WORKSPACE_DIR/sessions/x");
  });
});

// ---------------------------------------------------------------------------
// substitutePathsInString
// ---------------------------------------------------------------------------

describe("substitutePathsInString", () => {
  it("replaces homeDir with $HOME placeholder", () => {
    const result = substitutePathsInString("/Users/alice/foo", { homeDir: "/Users/alice" });
    expect(result).toBe("$HOME/foo");
  });

  it("longest-first: workspaceDir wins over homeDir and stateDir when all nest", () => {
    const result = substitutePathsInString(
      "/Users/alice/.comis/workspace/sessions/abc/file.jsonl",
      {
        homeDir: "/Users/alice",
        stateDir: "/Users/alice/.comis",
        workspaceDir: "/Users/alice/.comis/workspace",
      },
    );
    // workspaceDir is the longest match — must win, NOT $HOME/.comis/workspace/...
    expect(result).toBe("$WORKSPACE_DIR/sessions/abc/file.jsonl");
    expect(result).not.toContain("/Users/alice");
  });

  it("returns unchanged string when no path matches", () => {
    const result = substitutePathsInString("/var/log/foo", { homeDir: "/Users/alice" });
    expect(result).toBe("/var/log/foo");
  });

  it("returns unchanged string when opts is empty", () => {
    const result = substitutePathsInString("text without paths", {});
    expect(result).toBe("text without paths");
  });

  it("substitutes only the literal path occurrences (not pre-existing $HOME)", () => {
    // The string contains a literal $HOME and the real path — only the real path is substituted.
    const result = substitutePathsInString("$HOME is /Users/alice", { homeDir: "/Users/alice" });
    // The "$HOME" substring is left alone; the literal "/Users/alice" is substituted.
    expect(result).toBe("$HOME is $HOME");
  });

  it("handles paths with regex meta chars (brackets) correctly (literal match, not regex)", () => {
    const result = substitutePathsInString(
      "/Users/alice/[brackets].txt",
      { homeDir: "/Users/alice" },
    );
    expect(result).toBe("$HOME/[brackets].txt");
  });
});

// ---------------------------------------------------------------------------
// walkAndRedactStrings with opts
// ---------------------------------------------------------------------------

describe("walkAndRedactStrings with RedactionOpts", () => {
  it("substitutes homeDir path in string leaves", () => {
    const result = walkAndRedactStrings(
      { path: "/Users/alice/file" },
      { homeDir: "/Users/alice" },
    ) as Record<string, unknown>;
    expect(result["path"]).toBe("$HOME/file");
  });

  it("combines value-shape redaction and path substitution on the same string", () => {
    // Long decimal ID in a path-containing value: first redact the ID, then sub the path.
    // chatId is a 10-digit string that gets redacted; workspacePath is a path that gets substituted.
    const result = walkAndRedactStrings(
      {
        workspacePath: "/Users/alice/.comis/workspace/x",
        chatId: "1234567890",
      },
      {
        workspaceDir: "/Users/alice/.comis/workspace",
        homeDir: "/Users/alice",
      },
    ) as Record<string, unknown>;
    expect(result["workspacePath"]).toBe("$WORKSPACE_DIR/x");
    expect(result["chatId"]).toBe("<REDACTED:long-decimal-id>");
  });

  it("walkAndRedactStrings without opts still works (backward-compat)", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const result = walkAndRedactStrings(jwt);
    expect(result).toContain("<REDACTED:jwt>");
  });
});
