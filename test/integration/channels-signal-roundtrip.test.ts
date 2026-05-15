// SPDX-License-Identifier: Apache-2.0
/**
 * INTEGRATION: Signal channel — signal-cli HTTP/SSE adapter integration.
 *
 * Phase 40 Plan 40-16 (COV-04 gap closure): lifts coverage on the
 * `@comis/channels` Signal subpackage by spawning the production adapter
 * against the loopback-bound signal-cli mock.
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createMockSignalServer,
  type MockSignalServer,
} from "../e2e/mocks/signal/mock-signal-server.js";
import {
  createSignalPlugin,
  convertIrToSignalTextStyles,
} from "@comis/channels";
import { createMockLogger } from "../support/mock-logger.js";
import type { ChannelPort, NormalizedMessage } from "@comis/core";

describe("INTEGRATION: signal channel — adapter wire roundtrip + format helpers", () => {
  let mock: MockSignalServer;
  let adapter: ChannelPort | undefined;
  let receivedInbound: NormalizedMessage[];

  beforeEach(async () => {
    mock = createMockSignalServer();
    const handle = await mock.start();
    const plugin = createSignalPlugin({
      baseUrl: handle.baseUrl,
      account: "+15555550100",
      logger: createMockLogger(),
    });
    adapter = plugin.adapter;
    receivedInbound = [];
    adapter.onMessage(async (msg) => {
      receivedInbound.push(msg);
    });
    const startRes = await adapter.start();
    if (!startRes.ok) {
      throw startRes.error;
    }
    await new Promise((r) => setTimeout(r, 200));
  });

  afterEach(async () => {
    if (adapter) {
      await adapter.stop();
      adapter = undefined;
    }
    if (mock) {
      await mock.stop();
    }
  });

  it("adapter.start() reaches the signal-cli health-probe surface", () => {
    const probeCount =
      mock.getRequestCount("check") + mock.getRequestCount("sse-connect");
    expect(probeCount).toBeGreaterThanOrEqual(1);
  });

  it("adapter.sendMessage POSTs JSON-RPC 'send' to /api/v1/rpc with recipient + text", async () => {
    const sendRes = await adapter!.sendMessage(
      "+15555550200",
      "Integration test message",
    );
    expect(sendRes.ok).toBe(true);
    expect(mock.getRequestCount("rpc-send")).toBeGreaterThanOrEqual(1);
    const events = mock.getCapturedEvents();
    const sendEvent = events.find((e) => e.type === "rpc-send");
    expect(sendEvent).toBeDefined();
    expect(sendEvent!.payload.text).toContain("Integration test message");
  });

  it("convertIrToSignalTextStyles passes a plain-paragraph MarkdownIR through to a SignalFormattedMessage", () => {
    // convertIrToSignalTextStyles is a production format helper imported
    // by the Signal adapter's outbound path. Calling it directly lifts
    // the signal/signal-format line into the integration tier. The
    // canonical input is a MarkdownIR (blocks[] + sourceLength), not
    // a raw {text, spans} pair — see @comis/core/delivery/markdown-ir.
    const plain = "Plain text without formatting";
    const result = convertIrToSignalTextStyles({
      blocks: [
        {
          type: "paragraph",
          spans: [
            {
              type: "text",
              text: plain,
              offset: 0,
              length: plain.length,
            },
          ],
        },
      ],
      sourceLength: plain.length,
    });
    expect(result).toBeDefined();
    expect(result.text).toContain(plain);
    // textStyles is an array; empty for plain text with no formatting.
    expect(Array.isArray(result.textStyles)).toBe(true);
  });
});
