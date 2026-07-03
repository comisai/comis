// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { classifyError, classifyPromptTimeout } from "./error-classifier.js";
import { PromptTimeoutError } from "./prompt-timeout.js";

describe("classifyError", () => {
  it("classifies Anthropic credit exhaustion as credit_exhausted", () => {
    const error = new Error(
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}'
    );
    const result = classifyError(error);
    expect(result.category).toBe("credit_exhausted");
    expect(result.retryable).toBe(false);
    expect(result.userMessage).toContain("billing");
    expect(result.userMessage).toContain("administrator");
    // Must not leak raw error
    expect(result.userMessage).not.toContain("credit balance is too low");
    expect(result.userMessage).not.toContain("Anthropic");
  });

  it("classifies rate limiting (429) as rate_limited", () => {
    const error = new Error("429 Too Many Requests");
    const result = classifyError(error);
    expect(result.category).toBe("rate_limited");
    expect(result.retryable).toBe(true);
    expect(result.userMessage).toContain("wait");
  });

  it("classifies rate limit by message content", () => {
    const error = new Error("Rate limit exceeded, please retry after 30s");
    const result = classifyError(error);
    expect(result.category).toBe("rate_limited");
    expect(result.retryable).toBe(true);
  });

  it("classifies auth errors as auth_invalid", () => {
    const error = new Error("401 Invalid API key provided");
    const result = classifyError(error);
    expect(result.category).toBe("auth_invalid");
    expect(result.retryable).toBe(false);
    expect(result.userMessage).toContain("administrator");
    // Must not leak API key details
    expect(result.userMessage).not.toContain("API key");
    expect(result.userMessage).not.toContain("401");
  });

  it("classifies overloaded (503) as overloaded", () => {
    const error = new Error("503 Service Unavailable");
    const result = classifyError(error);
    expect(result.category).toBe("overloaded");
    expect(result.retryable).toBe(true);
  });

  it("classifies Anthropic overloaded (529) as overloaded", () => {
    const error = new Error("529 Overloaded");
    const result = classifyError(error);
    expect(result.category).toBe("overloaded");
    expect(result.retryable).toBe(true);
  });

  it("classifies context window exceeded", () => {
    const error = new Error("This request exceeds the maximum context length");
    const result = classifyError(error);
    expect(result.category).toBe("context_too_long");
    expect(result.retryable).toBe(false);
    expect(result.userMessage).toContain("new conversation");
  });

  it("classifies content filtering", () => {
    const error = new Error("Output blocked by content filter");
    const result = classifyError(error);
    expect(result.category).toBe("content_filtered");
    expect(result.retryable).toBe(true);
  });

  it("classifies Anthropic thinking-block JSON-path error (400) as client_request_signed_replay", () => {
    const error = new Error(
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.13.content.5 thinking/redacted_thinking blocks cannot be modified"}}'
    );
    const result = classifyError(error);
    // Signature noun + verb + JSON path all hit, so this is the more-specific
    // signed-replay subcategory. Retryable because the runner scrubs signed
    // state and re-enters the model retry chain.
    expect(result.category).toBe("client_request_signed_replay");
    expect(result.retryable).toBe(true);
    // userMessage must not leak raw provider internals
    expect(result.userMessage).not.toContain("thinking/redacted_thinking");
    expect(result.userMessage).not.toContain("invalid_request_error");
    expect(result.userMessage).not.toContain("messages.13");
    expect(result.userMessage).not.toContain("400");
    // Self-heal messaging emphasizes automatic recovery, not reset.
    expect(result.userMessage.toLowerCase()).toContain("automatically");
  });

  it('classifies bare "cannot be modified" without signature noun as client_request', () => {
    // No signature noun, no Anthropic JSON-path -- falls through to plain
    // client_request and remains non-retryable.
    const error = new Error("assistant.content.2 cannot be modified");
    const result = classifyError(error);
    expect(result.category).toBe("client_request");
    expect(result.retryable).toBe(false);
  });

  it("classifies 422 unprocessable_entity as client_request", () => {
    const error = new Error("422 Unprocessable Entity");
    const result = classifyError(error);
    expect(result.category).toBe("client_request");
    expect(result.retryable).toBe(false);
  });

  it("classifies generic unprocessable_entity string as client_request", () => {
    const error = new Error("provider returned unprocessable_entity");
    const result = classifyError(error);
    expect(result.category).toBe("client_request");
    expect(result.retryable).toBe(false);
  });

  it("classifies malformed request payloads as client_request", () => {
    const error = new Error("malformed request payload at field 'messages'");
    const result = classifyError(error);
    expect(result.category).toBe("client_request");
    expect(result.retryable).toBe(false);
  });

  it("signed_replay userMessage is safe, human-readable, and never leaks internals", () => {
    // Same shape as the production-incident error: signature noun + verb +
    // Anthropic JSON-path all fire, so this classifies as the signed-replay
    // subcategory. Same safety guarantees as plain client_request.
    const error = new Error(
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.0.content.1 thinking/redacted_thinking blocks cannot be modified","api_key":"sk-ant-abc123","host":"api.anthropic.com"}}'
    );
    const result = classifyError(error);
    expect(result.category).toBe("client_request_signed_replay");
    expect(result.userMessage).not.toContain("sk-ant");
    expect(result.userMessage).not.toContain("anthropic.com");
    expect(result.userMessage).not.toContain("api_key");
    expect(result.userMessage).not.toContain("thinking");
    expect(result.userMessage).not.toContain("{");
    // Positive content: reads like a human-facing message
    expect(result.userMessage).toMatch(/request|conversation|formatting|automatically/i);
  });

  // -------------------------------------------------------------------------
  // Provider-agnostic signed-replay
  // -------------------------------------------------------------------------

  it("classifies Gemini-flavored thoughtSignature mismatch as client_request_signed_replay", () => {
    const error = new Error(
      "INVALID_ARGUMENT: thought_signature mismatch on tool_call block at index 2"
    );
    const result = classifyError(error);
    expect(result.category).toBe("client_request_signed_replay");
    expect(result.retryable).toBe(true);
    expect(result.userMessage).not.toContain("thought_signature");
  });

  it("classifies OpenAI Responses reasoning_item not_found as client_request_signed_replay", () => {
    const error = new Error(
      "400 invalid_request_error: reasoning_item rs_abc123 not found in conversation state"
    );
    const result = classifyError(error);
    expect(result.category).toBe("client_request_signed_replay");
    expect(result.retryable).toBe(true);
    expect(result.userMessage).not.toContain("reasoning_item");
    expect(result.userMessage).not.toContain("rs_abc123");
  });

  it("classifies Mistral encrypted_content verification failure as client_request_signed_replay", () => {
    const error = new Error(
      "Mistral API error: encrypted_content verification failed on assistant turn 4"
    );
    const result = classifyError(error);
    expect(result.category).toBe("client_request_signed_replay");
    expect(result.retryable).toBe(true);
  });

  it("classifies OpenAI Completions reasoning_id expired as client_request_signed_replay", () => {
    const error = new Error(
      "400 invalid_request_error: reasoning_id rsn_xyz expired"
    );
    const result = classifyError(error);
    expect(result.category).toBe("client_request_signed_replay");
    expect(result.retryable).toBe(true);
  });

  it("regression: content_filtered still wins over client_request when content-filter keywords present", () => {
    // "blocked" is in content_filtered pattern; must not be stolen by client_request.
    const error = new Error("Output blocked by content filter");
    const result = classifyError(error);
    expect(result.category).toBe("content_filtered");
  });

  it("regression: credit_exhausted still wins over client_request even when invalid_request_error is present", () => {
    // Real Anthropic billing error carries type: invalid_request_error too;
    // credit_exhausted must remain authoritative because it sits earlier in the pattern table.
    const error = new Error(
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low."}}'
    );
    const result = classifyError(error);
    expect(result.category).toBe("credit_exhausted");
  });

  it("classifies Anthropic spend-cap exhaustion as credit_exhausted", () => {
    // Anthropic's self-imposed monthly spend-cap response is shaped as a
    // 400 invalid_request_error.
    const error = new Error(
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"You have reached your specified API usage limits. You will regain access on 2026-06-01 at 00:00 UTC."},"request_id":"req_123"}'
    );
    const result = classifyError(error);
    expect(result.category).toBe("credit_exhausted");
  });

  it("returns unknown for unrecognized errors", () => {
    const error = new Error("Something completely unexpected happened");
    const result = classifyError(error);
    expect(result.category).toBe("unknown");
    expect(result.retryable).toBe(false);
    expect(result.userMessage).toContain("error occurred");
  });

  it("handles string errors", () => {
    const result = classifyError("credit balance is too low");
    expect(result.category).toBe("credit_exhausted");
  });

  it("handles non-Error objects", () => {
    const result = classifyError({ code: 429, message: "rate limit" });
    expect(result.category).toBe("rate_limited");
  });

  it("handles null/undefined gracefully", () => {
    expect(classifyError(null).category).toBe("unknown");
    expect(classifyError(undefined).category).toBe("unknown");
  });

  it("checks error cause chain", () => {
    const inner = new Error("credit balance is too low");
    const outer = new Error("Request failed", { cause: inner });
    const result = classifyError(outer);
    expect(result.category).toBe("credit_exhausted");
  });

  it("never leaks raw error content in any category", () => {
    const testErrors = [
      new Error('400 {"error":"credit balance is too low","key":"sk-ant-abc123"}'),
      new Error("429 rate limit at https://api.anthropic.com/v1/messages"),
      new Error("401 invalid x-api-key sk-ant-secret-key"),
      new Error("503 service unavailable internal-server.anthropic.com"),
    ];
    for (const error of testErrors) {
      const result = classifyError(error);
      expect(result.userMessage).not.toContain("sk-ant");
      expect(result.userMessage).not.toContain("anthropic.com");
      expect(result.userMessage).not.toContain("api.anthropic");
    }
  });
});

// ---------------------------------------------------------------------------
// classifyPromptTimeout — knob-named hints
//
// A generic timeout message tells the operator WHAT (too slow) but not WHICH
// KNOB. The signature consumes the PromptTimeoutError (limit + configured
// numbers) plus the binding provenance plus the elapsed
// time, and renders the exact config key via describeTimeoutKnob.
//
// Security pin: the knob detail rides `hint` (logs/explain ONLY)
// — `userMessage` stays byte-identical to the generic text so no
// config-key names ever reach the user reply.
// ---------------------------------------------------------------------------

describe("classifyPromptTimeout — knob-named hints", () => {
  /** The generic user-facing text — pinned byte-identical (user-safety). */
  const GENERIC_TIMEOUT_USER_MESSAGE =
    "The request took too long to process. Please try again with a simpler message.";

  it("returns prompt_timeout category with the generic user-safe message (user-text contract preserved)", () => {
    const result = classifyPromptTimeout(new PromptTimeoutError(120_000));
    expect(result.category).toBe("prompt_timeout");
    expect(result.retryable).toBe(true);
    expect(result.userMessage).toContain("too long");
  });

  it("agent-primary stall — hint carries the stall budget + elapsed + the agent knob; userMessage byte-identical generic", () => {
    const result = classifyPromptTimeout(
      new PromptTimeoutError(180_000, {
        limit: "stall",
        stallBudgetMs: 180_000,
        makespanMs: 1_800_000,
      }),
      {
        source: "agent_config",
        agentId: "my-agent",
        promptTimeoutMs: 180_000,
        retryPromptTimeoutMs: 60_000,
        stallCeilingMultiplier: 10,
      },
      195_000,
    );
    expect(result.category).toBe("prompt_timeout");
    expect(result.retryable).toBe(true);
    expect(result.hint).toMatch(/stall budget 180000ms/);
    expect(result.hint).toMatch(/195000ms/);
    expect(result.hint).toMatch(/agents\.my-agent\.promptTimeout\.promptTimeoutMs/);
    // User-safety pin: the knob detail NEVER rides the user reply.
    expect(result.userMessage).toBe(GENERIC_TIMEOUT_USER_MESSAGE);
  });

  it("operation-override binding names the operationModels `timeout` key — never the agent knob, never a timeoutMs key tail, never providers.*", () => {
    const result = classifyPromptTimeout(
      new PromptTimeoutError(180_000, {
        limit: "stall",
        stallBudgetMs: 180_000,
        makespanMs: 1_800_000,
      }),
      {
        source: "operation_explicit",
        operationType: "cron",
        agentId: "my-agent",
        promptTimeoutMs: 180_000,
        retryPromptTimeoutMs: 60_000,
        stallCeilingMultiplier: 10,
      },
      195_000,
    );
    expect(result.hint).toContain("agents.my-agent.operationModels.cron.timeout");
    expect(result.hint).not.toContain("promptTimeout.promptTimeoutMs");
    // The REAL operation key is `timeout` — a `.timeoutMs`
    // key tail would be REJECTED by the strictObject config parser.
    expect(result.hint).not.toContain(".timeoutMs");
    // No hint ever names the nonexistent providers.* knob.
    expect(result.hint).not.toMatch(/providers\./);
  });

  it("makespan fire renders the ceiling + the stall budget + stallCeilingMultiplier (both numbers)", () => {
    const result = classifyPromptTimeout(
      new PromptTimeoutError(1_800_000, {
        limit: "makespan",
        stallBudgetMs: 180_000,
        makespanMs: 1_800_000,
      }),
      {
        source: "agent_config",
        agentId: "my-agent",
        promptTimeoutMs: 180_000,
        retryPromptTimeoutMs: 60_000,
        stallCeilingMultiplier: 10,
      },
      1_805_000,
    );
    expect(result.hint).toMatch(/makespan ceiling 1800000ms/);
    expect(result.hint).toMatch(/stallCeilingMultiplier/);
    expect(result.hint).toMatch(/180000/);
  });

  it("graph_constant binding renders honest prose — the 600000ms constant, no agents.* fake knob", () => {
    const result = classifyPromptTimeout(
      new PromptTimeoutError(600_000, { limit: "stall", stallBudgetMs: 600_000 }),
      {
        source: "graph_constant",
        operationType: "subagent",
        agentId: "my-agent",
        promptTimeoutMs: 600_000,
      },
      700_000,
    );
    expect(result.hint).toContain("600000");
    expect(result.hint).not.toContain("agents.");
  });

  it("whole-turn retry timeout (limit undefined) names retryPromptTimeoutMs and is never presented as a stall", () => {
    const result = classifyPromptTimeout(
      new PromptTimeoutError(60_000),
      {
        source: "agent_config",
        agentId: "my-agent",
        promptTimeoutMs: 180_000,
        retryPromptTimeoutMs: 60_000,
      },
      65_000,
    );
    expect(result.hint).toContain("agents.my-agent.promptTimeout.retryPromptTimeoutMs");
    expect(result.hint).toMatch(/whole-turn/);
    // Honest semantics: a retry/fallback prompt uses the non-resettable
    // whole-turn timeout — never call it a stall-budget kill.
    expect(result.hint).not.toMatch(/stall budget \d+ms exceeded/);
  });

  it("binding undefined (a caller passing no provenance) still produces a knob-named hint with the <id> placeholder — graceful, no throw", () => {
    const result = classifyPromptTimeout(
      new PromptTimeoutError(180_000, { limit: "stall", stallBudgetMs: 180_000 }),
    );
    expect(result.hint).toBeDefined();
    expect(result.hint).toContain("agents.<id>.promptTimeout.promptTimeoutMs");
  });
});

// ---------------------------------------------------------------------------
// Silent LLM failure classification
// ---------------------------------------------------------------------------
//
// When a toolResult arrives with empty content, the LLM produces no text
// (finishReason:"stop"). The executor strips empty turns and retries once;
// if that also produces empty, it throws `Silent LLM failure: …`. Without
// an explicit classifier pattern, that error fell through to UNKNOWN_ERROR
// and the user saw "An error occurred while processing your request. Please
// try again." — which was the Telegram reply observed during the xlsx skill
// install (see auto-background-middleware regression).

describe("classifyError — Silent LLM failure", () => {
  it("classifies the exact retry-path error string", () => {
    const error = new Error(
      "Silent LLM failure: 2 LLM call(s) produced empty response after retry (finishReason: stop)",
    );
    const result = classifyError(error);
    expect(result.category).not.toBe("unknown");
    expect(result.retryable).toBe(true);
    expect(result.userMessage).not.toBe(
      "An error occurred while processing your request. Please try again.",
    );
    expect(result.userMessage.toLowerCase()).toContain("tool call");
  });

  it("classifies the first-attempt error string (no retry suffix)", () => {
    const error = new Error(
      "Silent LLM failure: 1 LLM call(s) produced empty response (finishReason: stop)",
    );
    const result = classifyError(error);
    expect(result.category).not.toBe("unknown");
    expect(result.retryable).toBe(true);
    expect(result.userMessage.toLowerCase()).toMatch(/tool call|no output|try again/);
  });

  it("regression: overloaded still wins over silent-failure when both keywords appear", () => {
    // Defensive: a hypothetical combined message must still classify under
    // the more-specific upstream pattern, so operators aren't misled.
    const error = new Error("529 overloaded — silent LLM failure");
    const result = classifyError(error);
    expect(result.category).toBe("overloaded");
  });

  it("silent-failure classification does not leak internals", () => {
    const error = new Error(
      "Silent LLM failure: 2 LLM call(s) produced empty response after retry "
      + "(finishReason: stop) — host api.anthropic.com key sk-ant-secret123",
    );
    const result = classifyError(error);
    expect(result.userMessage).not.toContain("sk-ant");
    expect(result.userMessage).not.toContain("anthropic.com");
    expect(result.userMessage).not.toContain("finishReason");
  });
});

// ---------------------------------------------------------------------------
// Provider error masked as empty_response
// A provider 404 (model gated/unavailable) or a connection failure arrives
// WRAPPED by the silent-failure handler as
//   "Silent LLM failure: N LLM call(s) produced empty response after retry … — <providerError>"
// (silent-failure-handlers.ts appends ` — ${lastLlmErrorMessage}`). The
// empty_response pattern would otherwise steal it and tell the user
// "a tool call returned no output" — false; there was no tool call. The real,
// actionable cause (model unavailable / provider unreachable) must win — the
// same ordering principle the "overloaded wins over silent-failure" test above
// relies on. Live repro: agent model claude-fable-5 → Anthropic 404
// not_found_error "Claude Fable 5 is not available. Please use Opus 4.8."
// ---------------------------------------------------------------------------

describe("classifyError — provider error masked as empty_response", () => {
  it("classifies a wrapped Anthropic 404 model-not-available as model_not_available, not empty_response", () => {
    const error = new Error(
      'Silent LLM failure: 3 LLM call(s) produced empty response after retry (finishReason: stop) — '
      + '404 {"type":"error","error":{"type":"not_found_error","message":"Claude Fable 5 is not available. Please use Opus 4.8. Learn more: https://www.anthropic.com/news/fable-mythos-access"},"request_id":"req_011Cc1TeMsPBGHhGTv5m8M47"}',
    );
    const result = classifyError(error);
    expect(result.category).toBe("model_not_available");
    expect(result.retryable).toBe(false);
    // honest: must NOT claim a tool call returned no output
    expect(result.userMessage.toLowerCase()).not.toContain("tool call");
    // no leak of the raw provider body / request id / error type
    expect(result.userMessage).not.toContain("req_011");
    expect(result.userMessage).not.toContain("not_found_error");
  });

  it("classifies a bare Anthropic not_found_error model body as model_not_available", () => {
    const error = new Error(
      '404 {"type":"error","error":{"type":"not_found_error","message":"model: claude-made-up-9 is not available"}}',
    );
    expect(classifyError(error).category).toBe("model_not_available");
  });

  it("classifies a wrapped provider connection failure as provider_unreachable, not empty_response", () => {
    const error = new Error(
      'Silent LLM failure: 2 LLM call(s) produced empty response after retry (finishReason: stop) — '
      + 'FetchError: request to https://api.anthropic.com/v1/messages failed, reason: connect ECONNREFUSED 127.0.0.1:443',
    );
    const result = classifyError(error);
    expect(result.category).toBe("provider_unreachable");
    expect(result.retryable).toBe(true);
    expect(result.userMessage.toLowerCase()).not.toContain("tool call");
  });

  it("classifies a wrapped OpenAI-SDK 'Connection error.' as provider_unreachable, not empty_response", () => {
    // Provider unreachable (Ollama down / dead port):
    // the pi SDK's OpenAI-compat client throws APIConnectionError whose message
    // is the BARE phrase "Connection error." (no ECONNREFUSED token). The
    // silent-failure handler wraps it as "…produced empty response after retry
    // … — Connection error.". The provider_unreachable regex required
    // "connection refused/reset/timed out", so "Connection error." slipped
    // through to empty_response → the user saw "a tool call returned no output"
    // (false — there was no tool call; the provider was unreachable). The real,
    // actionable cause must win: the daemon log shows
    // `err:"Connection error.", hint:"Check LLM provider status",
    // errorKind:"dependency"` per retry while the user reply was the empty_response msg.
    const error = new Error(
      "Silent LLM failure: 12 LLM call(s) produced empty response after retry (finishReason: stop) — Connection error.",
    );
    const result = classifyError(error);
    expect(result.category).toBe("provider_unreachable");
    expect(result.retryable).toBe(true);
    expect(result.userMessage.toLowerCase()).not.toContain("tool call");
  });

  it("classifies a bare OpenAI-SDK 'Connection error.' as provider_unreachable", () => {
    expect(classifyError(new Error("Connection error.")).category).toBe("provider_unreachable");
  });

  it("regression: a genuine empty response with NO provider error stays empty_response", () => {
    const error = new Error(
      "Silent LLM failure: 2 LLM call(s) produced empty response after retry (finishReason: stop)",
    );
    expect(classifyError(error).category).toBe("empty_response");
  });

  it("regression: OpenAI reasoning_item not found still classifies as signed-replay (ordering lock)", () => {
    const error = new Error(
      "400 invalid_request_error: reasoning_item rs_abc123 not found in conversation state",
    );
    expect(classifyError(error).category).toBe("client_request_signed_replay");
  });
});

// ---------------------------------------------------------------------------
// tool_schema_unsupported classification
// ---------------------------------------------------------------------------
//
// llama.cpp-family local providers (llama-server, LM Studio embeds llama.cpp,
// Ollama) reject tool JSON Schemas at grammar-compile/unmarshal time with 400
// bodies that would otherwise classify client_request (llama-server wraps grammar
// bodies in `"type":"invalid_request_error"`, so the plain client_request
// pattern steals the match) or match nothing (Ollama Go-side unmarshal →
// unknown → the model-retry ladder burns fallback models on a deterministic
// schema problem). These tests pin the first-class category.

describe("classifyError — tool_schema_unsupported", () => {
  // Verbatim grammar-400 bodies from live upstream issues:
  // Source: github.com/ggml-org/llama.cpp/issues/19716 (exact llama-server
  // body, including the `"type":"invalid_request_error"` wrapper).
  const llamaServerBody =
    '{"error":{"code":400,"message":"JSON schema conversion failed:\\nUnrecognized schema: {\\"description\\":\\"Value for add/replace/test operations\\"}","type":"invalid_request_error"}}';
  // Source: github.com/ollama/ollama/issues/10164 (exact Go-side tools
  // unmarshal string — matches NOTHING else in the pattern table).
  const ollamaGoBody =
    "json: cannot unmarshal number into Go struct field .tools.function.parameters.properties.enum of type string";
  // Source: github.com/ggml-org/llama.cpp/issues/22314 (grammar-parse stage,
  // PCRE shorthand surviving conversion).
  const grammarParseBody = 'parse: error parsing grammar: unknown escape at \\d]+ "." [\\d]+)';

  it("classifies the full verbatim llama-server grammar body (invalid_request_error wrapper included) as tool_schema_unsupported, not client_request", () => {
    // Load-bearing: without the grammar subcategory, the wrapper's
    // `invalid_request_error` makes this classify client_request — the
    // more-specific grammar subcategory must win (first-match-wins ordering).
    const result = classifyError(new Error(llamaServerBody));
    expect(result.category).toBe("tool_schema_unsupported");
  });

  it("classifies the Ollama Go-side tools.function.parameters unmarshal error as tool_schema_unsupported", () => {
    // Unmatched, this would fall to unknown → handleSilentRetryDefault
    // re-enters the FULL model-retry ladder (the fallback-burn path).
    const result = classifyError(new Error(ollamaGoBody));
    expect(result.category).toBe("tool_schema_unsupported");
  });

  it("classifies the standard Go struct-type-name prefix form (ChatRequest.tools.function.parameters) as tool_schema_unsupported", () => {
    // Go's encoding/json normally formats these as
    // `Go struct field <StructTypeName>.<path>` — ollama#10164 pinned the
    // empty-type-name variant, but Ollama versions/paths emitting the type
    // name would otherwise fall through to unknown → full fallback-ladder
    // burn. Verbatim shape with the ChatRequest prefix:
    const prefixed =
      "json: cannot unmarshal array into Go struct field ChatRequest.tools.function.parameters.properties.type of type string";
    expect(classifyError(new Error(prefixed)).category).toBe("tool_schema_unsupported");
  });

  it("a type-name-prefixed Go unmarshal error OUTSIDE the tools path stays unmatched (negative control)", () => {
    const offPath =
      "json: cannot unmarshal string into Go struct field ChatRequest.options.temperature of type float64";
    expect(classifyError(new Error(offPath)).category).toBe("unknown");
  });

  it("classifies the llama.cpp grammar-parse failure string as tool_schema_unsupported", () => {
    const result = classifyError(new Error(grammarParseBody));
    expect(result.category).toBe("tool_schema_unsupported");
  });

  it("classifies bare json-schema-to-grammar and unable-to-generate-parser strings case-insensitively as tool_schema_unsupported", () => {
    expect(
      classifyError(new Error("json-schema-to-grammar failure in converter")).category,
    ).toBe("tool_schema_unsupported");
    expect(
      classifyError(new Error("Unable to generate parser for tool template")).category,
    ).toBe("tool_schema_unsupported");
  });

  it("returns retryable:true with a canned userMessage that never embeds schema content", () => {
    const result = classifyError(new Error(llamaServerBody));
    // Retryable because the executor performs exactly one strip-pattern/format
    // retry per session (the schema-repair path keys on this category).
    expect(result.retryable).toBe(true);
    // Canned generic text only — the raw body embeds the offending schema
    // dump and must never reach the user.
    expect(result.userMessage).not.toContain("{");
    expect(result.userMessage).not.toContain("Unrecognized schema");
  });

  // -------------------------------------------------------------------------
  // Negative controls — existing categories must keep their classification
  // -------------------------------------------------------------------------

  it("regression: a plain Anthropic 400 invalid_request_error without grammar keywords stays client_request", () => {
    // Deliberately avoids `max_tokens` in the message (that keyword belongs
    // to the context_too_long pattern).
    const error = new Error(
      '{"type":"error","error":{"type":"invalid_request_error","message":"messages.0.content: unexpected field"}}',
    );
    expect(classifyError(error).category).toBe("client_request");
  });

  it("regression: a billing body containing credit-balance text stays credit_exhausted", () => {
    const error = new Error(
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the API."}}',
    );
    expect(classifyError(error).category).toBe("credit_exhausted");
  });

  it("regression: a 401 invalid x-api-key authentication error stays auth_invalid", () => {
    const error = new Error("401 authentication_error: invalid x-api-key");
    expect(classifyError(error).category).toBe("auth_invalid");
  });

  it("regression: a context-overflow message stays context_too_long", () => {
    const error = new Error(
      "prompt is too long: 210000 tokens > maximum context length",
    );
    expect(classifyError(error).category).toBe("context_too_long");
  });

  it("regression: a Go unmarshal error outside the tools.function.parameters path stays unknown (scope guard holds)", () => {
    // The Go-unmarshal alternation is scoped to `.tools.function.parameters`
    // so unrelated unmarshal errors keep their current classification.
    const error = new Error(
      "json: cannot unmarshal string into Go struct field .options.temperature of type float64",
    );
    expect(classifyError(error).category).toBe("unknown");
  });
});
