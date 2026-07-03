// SPDX-License-Identifier: Apache-2.0
/**
 * Deterministic fake `completeSimple`-shaped LLM stub for the UNGATED QA/judge
 * wiring tests — drives the pure answer/judge pipeline (format ->
 * answer-prompt -> judge-prompt -> verdict-parse -> aggregate) WITHOUT a real
 * provider or the `COMIS_BENCH` gate.
 *
 * The repo has no shared fake-`completeSimple` stub — LLM call sites are
 * mocked ad hoc per test — so this fixture provides the one reusable
 * stub. The return shape is dictated by pi-ai's
 * `AssistantMessage.content: (TextContent | ...)[]` with
 * `TextContent = { type: "text"; text: string }`
 * (node_modules/@earendil-works/pi-ai/dist/types.d.ts:143,189-191), so the value
 * round-trips through the standard content-block walk
 * (`extractResponseText`, memory-review-job.ts:225-241): `extractResponseText(
 * await fakeComplete(reply)()) === reply`.
 *
 * TEST-TIER ONLY: lives under `__fixtures__/`. It is exercised by the co-located
 * `qa-answer-prompt.test.ts` (which imports it) so it carries coverage rather
 * than being a 0%-coverage src file under the agent `all:true` floor.
 *
 * Used only through `extractResponseText`'s structural `{ content?: unknown[] }`
 * param, so it need not satisfy the full `AssistantMessage` type. A harness that
 * passes it where pi-ai's `Model`/`AssistantMessage` is required should cast at
 * that boundary.
 *
 * @module
 */

/** One pi-ai text content block (the only block kind this fake emits). */
export interface FakeTextBlock {
  type: "text";
  text: string;
}

/** The minimal `AssistantMessage`-shaped reply the content-block walk reads. */
export interface FakeAssistantReply {
  content: FakeTextBlock[];
}

/**
 * Build a deterministic fake `completeSimple`: a thunk that resolves to a single
 * `{ type: "text", text: reply }` content block, ignoring its arguments. The
 * returned function shape (a zero-arg async producing the reply) lets a test
 * substitute it wherever a `completeSimple(model, ctx, opts)` result is awaited
 * and then run through `extractResponseText`.
 *
 * Pure + stateless: the same `reply` is returned on every call, so the pipeline
 * is exercised deterministically.
 */
export const fakeComplete =
  (reply: string) =>
  async (): Promise<FakeAssistantReply> => ({
    content: [{ type: "text", text: reply }],
  });
