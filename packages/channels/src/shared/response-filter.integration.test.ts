// SPDX-License-Identifier: Apache-2.0
/**
 * Integration tests for response filtering in simulated delivery pipeline.
 *
 * Validates that filterResponse() integrates correctly with a mock channel
 * delivery pipeline matching the pattern used in channel-manager.ts:
 * 1. Receive response text from executor
 * 2. Call filterResponse()
 * 3. If shouldDeliver is false, record suppression event
 * 4. If shouldDeliver is true, record delivered message
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";
import { filterResponse, NO_REPLY_TOKEN, type FilterResult } from "./response-filter.js";

// ---------------------------------------------------------------------------
// Simulated delivery pipeline
// ---------------------------------------------------------------------------

interface SuppressionEvent {
  channelId: string;
  suppressedBy: string;
  timestamp: number;
}

interface DeliveredMessage {
  channelId: string;
  text: string;
  timestamp: number;
}

/**
 * Simulated delivery pipeline that mirrors channel-manager's response handling.
 * Records delivered messages and suppression events for assertion.
 */
function createDeliveryPipeline(channelId = "test-channel") {
  const delivered: DeliveredMessage[] = [];
  const suppressed: SuppressionEvent[] = [];
  const events: Array<{ type: string; payload: unknown }> = [];

  const eventEmitter = {
    emit: vi.fn((type: string, payload: unknown) => {
      events.push({ type, payload });
    }),
  };

  function processResponse(responseText: string): FilterResult {
    const filter = filterResponse(responseText);

    if (!filter.shouldDeliver) {
      // Record suppression (mirrors channel-manager event emission)
      suppressed.push({
        channelId,
        suppressedBy: filter.suppressedBy!,
        timestamp: Date.now(),
      });
      eventEmitter.emit("response:filtered", {
        channelId,
        suppressedBy: filter.suppressedBy,
        timestamp: Date.now(),
      });
    } else {
      // Record delivery
      delivered.push({
        channelId,
        text: filter.cleanedText,
        timestamp: Date.now(),
      });
    }

    return filter;
  }

  return { processResponse, delivered, suppressed, events, eventEmitter };
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe("response filter integration", () => {
  // -------------------------------------------------------------------------
  // 1. NO_REPLY response is suppressed in delivery pipeline
  // -------------------------------------------------------------------------

  it("NO_REPLY response is suppressed in delivery pipeline", () => {
    const pipeline = createDeliveryPipeline("ch-1");

    pipeline.processResponse("NO_REPLY");

    // No message was delivered
    expect(pipeline.delivered).toHaveLength(0);

    // Suppression event recorded
    expect(pipeline.suppressed).toHaveLength(1);
    expect(pipeline.suppressed[0]!.suppressedBy).toBe("NO_REPLY");
    expect(pipeline.suppressed[0]!.channelId).toBe("ch-1");
  });

  // -------------------------------------------------------------------------
  // 2. HEARTBEAT_OK response is suppressed in delivery pipeline
  // -------------------------------------------------------------------------

  it("HEARTBEAT_OK response is suppressed in delivery pipeline", () => {
    const pipeline = createDeliveryPipeline("ch-heartbeat");

    pipeline.processResponse("HEARTBEAT_OK");

    // No message was delivered
    expect(pipeline.delivered).toHaveLength(0);

    // Suppression event recorded
    expect(pipeline.suppressed).toHaveLength(1);
    expect(pipeline.suppressed[0]!.suppressedBy).toBe("HEARTBEAT_OK");
  });

  // -------------------------------------------------------------------------
  // 3. empty response from silent operation is suppressed
  // -------------------------------------------------------------------------

  it("empty response from silent operation is suppressed", () => {
    const pipeline = createDeliveryPipeline();

    pipeline.processResponse("");

    expect(pipeline.delivered).toHaveLength(0);
    expect(pipeline.suppressed).toHaveLength(1);
    expect(pipeline.suppressed[0]!.suppressedBy).toBe("empty");
  });

  // -------------------------------------------------------------------------
  // 4. normal agent response is delivered unchanged
  // -------------------------------------------------------------------------

  it("normal agent response is delivered unchanged", () => {
    const pipeline = createDeliveryPipeline("ch-normal");

    pipeline.processResponse("Here is your answer: the weather is sunny.");

    expect(pipeline.suppressed).toHaveLength(0);
    expect(pipeline.delivered).toHaveLength(1);
    expect(pipeline.delivered[0]!.text).toBe("Here is your answer: the weather is sunny.");
    expect(pipeline.delivered[0]!.channelId).toBe("ch-normal");
  });

  // -------------------------------------------------------------------------
  // 5. response containing NO_REPLY as substring is delivered
  // -------------------------------------------------------------------------

  it("response containing NO_REPLY as substring is delivered", () => {
    const pipeline = createDeliveryPipeline();

    pipeline.processResponse("I'll use NO_REPLY for silent operations");

    expect(pipeline.suppressed).toHaveLength(0);
    expect(pipeline.delivered).toHaveLength(1);
    expect(pipeline.delivered[0]!.text).toBe("I'll use NO_REPLY for silent operations");
  });

  // -------------------------------------------------------------------------
  // 6. response containing HEARTBEAT_OK as substring is delivered
  // -------------------------------------------------------------------------

  it("response containing HEARTBEAT_OK as substring is delivered", () => {
    const pipeline = createDeliveryPipeline();

    pipeline.processResponse("The system returned HEARTBEAT_OK which means all clear");

    expect(pipeline.suppressed).toHaveLength(0);
    expect(pipeline.delivered).toHaveLength(1);
    expect(pipeline.delivered[0]!.text).toBe(
      "The system returned HEARTBEAT_OK which means all clear",
    );
  });

  // -------------------------------------------------------------------------
  // 7. whitespace-padded tokens are still suppressed
  // -------------------------------------------------------------------------

  it("whitespace-padded tokens are still suppressed", () => {
    const pipeline = createDeliveryPipeline();

    pipeline.processResponse("  NO_REPLY  \n");

    expect(pipeline.delivered).toHaveLength(0);
    expect(pipeline.suppressed).toHaveLength(1);
    expect(pipeline.suppressed[0]!.suppressedBy).toBe("NO_REPLY");
  });

  // -------------------------------------------------------------------------
  // 8. multiple sequential responses filter independently
  // -------------------------------------------------------------------------

  it("multiple sequential responses filter independently", () => {
    const pipeline = createDeliveryPipeline();

    const results = [
      pipeline.processResponse("Hello"),
      pipeline.processResponse("NO_REPLY"),
      pipeline.processResponse("HEARTBEAT_OK"),
      pipeline.processResponse("Goodbye"),
    ];

    // Verify individual results
    expect(results[0]!.shouldDeliver).toBe(true);
    expect(results[1]!.shouldDeliver).toBe(false);
    expect(results[2]!.shouldDeliver).toBe(false);
    expect(results[3]!.shouldDeliver).toBe(true);

    // 2 delivered, 2 suppressed
    expect(pipeline.delivered).toHaveLength(2);
    expect(pipeline.delivered[0]!.text).toBe("Hello");
    expect(pipeline.delivered[1]!.text).toBe("Goodbye");

    expect(pipeline.suppressed).toHaveLength(2);
    expect(pipeline.suppressed[0]!.suppressedBy).toBe("NO_REPLY");
    expect(pipeline.suppressed[1]!.suppressedBy).toBe("HEARTBEAT_OK");

    // Verifies no state leakage between filter calls
  });

  // -------------------------------------------------------------------------
  // 9. delivery pipeline emits response:filtered event on suppression
  // -------------------------------------------------------------------------

  it("delivery pipeline emits response:filtered event on suppression", () => {
    const pipeline = createDeliveryPipeline("ch-events");

    pipeline.processResponse("NO_REPLY");

    // Event emitter called with correct event type and payload
    expect(pipeline.eventEmitter.emit).toHaveBeenCalledTimes(1);
    expect(pipeline.eventEmitter.emit).toHaveBeenCalledWith(
      "response:filtered",
      expect.objectContaining({
        channelId: "ch-events",
        suppressedBy: "NO_REPLY",
      }),
    );

    // Normal response does NOT emit filtered event
    pipeline.processResponse("Hello world");
    // Still only 1 call total (from the NO_REPLY)
    expect(pipeline.eventEmitter.emit).toHaveBeenCalledTimes(1);
  });
});
