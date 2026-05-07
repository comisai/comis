// SPDX-License-Identifier: Apache-2.0
//
// JSONL persistence vs. prompt isolation via provider-stream substitution.
//
// The binding gate is the OUTGOING provider payload, captured by
// substituting the provider's stream/fetch function at the lowest
// available test seam. NOT a caller-threaded `onPayload` config (which
// would be a production-config-for-test surface and is forbidden).
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  createCapturingProviderStub,
  runOneTurnWithProvider,
  buildFixtureSessionWithToolResult,
  loadSession,
  getVisibleAssistantText,
} from "./__test-helpers/capturing-provider-stub.js";

describe("details.visibleDelivery JSONL persistence vs prompt isolation", () => {
  it("persists in JSONL but is absent from outgoing provider payload", async () => {
    const longCaption = "X".repeat(5000);
    const sessionPath = await buildFixtureSessionWithToolResult({
      toolName: "message",
      content: [
        {
          type: "text",
          text: JSON.stringify({ messageId: "M", channelId: "C" }),
        },
      ],
      details: {
        messageId: "M",
        channelId: "C",
        visibleDelivery: {
          kind: "attachment",
          channelType: "telegram",
          channelId: "C",
          caption: longCaption,
          deliveredAt: Date.now(),
        },
      },
    });

    // (a) JSONL persistence preserved.
    expect(readFileSync(sessionPath, "utf-8")).toContain(longCaption);

    // (b) Capture via provider-side stream/fetch substitution — same pattern
    // existing executor tests use (e.g. fault-injector.ts:48-). NO caller-threaded
    // onPayload, NO production-config-for-test surface.
    let capturedRequestBody: unknown;
    const providerStub = createCapturingProviderStub({
      onSend: (body) => {
        capturedRequestBody = body;
      },
      respondWith: {
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        stopReason: "stop",
      },
    });

    await runOneTurnWithProvider({ sessionPath, provider: providerStub });

    expect(JSON.stringify(capturedRequestBody)).not.toContain(longCaption);

    // (c) Belt-and-braces: prompt-assembly read path is also clean.
    const session = loadSession(sessionPath);
    expect(getVisibleAssistantText(session)).not.toContain(longCaption);
  });
});
