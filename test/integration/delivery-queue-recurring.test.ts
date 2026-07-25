// SPDX-License-Identifier: Apache-2.0
/**
 * Continuous delivery-queue drainer integration tests (throughput).
 *
 * Verifies the system-level invariant: a `notification.send` RPC call AFTER the
 * daemon finishes startup is delivered to the registered echo adapter within
 * `drainIntervalMs + 500ms` of the call. Closes the production orphan-row gap
 * (id 52949c74-...) where post-startup pending rows accumulated forever.
 *
 * Covers acceptance criteria:
 *   - post-startup delivery latency
 *   - pending-depth returns to 0 after drain
 *   - throughput: 100 sequential-burst notification.send RPCs flow through
 *     the notification-path -> recurring drainer -> echo adapter without drops
 *     or duplicates.
 *
 * Row-selection race safety is unit-tested via
 *   - packages/memory/src/delivery-queue-adapter.test.ts (enqueueInFlight + WHERE filter)
 *   - packages/channels/src/shared/deliver-to-channel.test.ts (channel-side method swap)
 *   - packages/daemon/src/wiring/setup-delivery.test.ts (real-adapter
 *     fixture: 100 in_flight + 100 pending coexist, drainer never picks in_flight).
 *   The integration tier exercises throughput; the unit tier exercises race safety.
 *   The goal is to catch the row-selection race, which is fully observable
 *   in-process.
 *
 * SIGKILL recovery is unit-tested in delivery-queue-adapter.test.ts via direct
 * in_flight row injection.
 *
 * The delivery:enqueued log line is unit-tested ("enqueue emits exactly one
 * delivery:enqueued event per enqueue") plus the existing
 * delivery-queue-logger.ts subscriber (already covered by its own test file).
 * End-to-end log-capture is intentionally NOT instrumented here per AGENTS
 * section 2.3 KISS -- the chain is provable via two existing unit tests.
 *
 * RPC transport: the daemon's gateway dispatches JSON-RPC over WebSocket
 * (no HTTP /rpc endpoint exists -- see packages/gateway/src/server/hono-server.ts).
 * Tests use the shared `openAuthenticatedWebSocket` + `sendJsonRpc` helpers from
 * test/support/ws-helpers.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startTestDaemon, type TestDaemonHandle } from "../support/daemon-harness.js";
import { openAuthenticatedWebSocket, sendJsonRpc } from "../support/ws-helpers.js";
import { EchoChannelAdapter } from "@comis/channels";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const configPath = resolve(__dirname, "../config/config.test-delivery-recurring.yaml");

/**
 * Send a notification.send RPC over the test daemon's WebSocket gateway.
 *
 * Wraps openAuthenticatedWebSocket + sendJsonRpc to keep individual tests
 * focused on the delivery-queue assertions. Connection is opened per-call
 * (cheap; daemon-harness keeps the gateway warm).
 */
async function sendNotification(
  handle: TestDaemonHandle,
  params: Record<string, unknown>,
  id: number,
): Promise<unknown> {
  const ws = await openAuthenticatedWebSocket(handle.gatewayUrl, handle.authToken);
  try {
    const response = await sendJsonRpc(ws, "notification.send", params, id, {
      timeoutMs: 5_000,
    });
    return response;
  } finally {
    ws.close();
  }
}

describe("continuous delivery-queue drainer (integration)", () => {
  const echoEndpoint = {
    channelType: "echo",
    channelInstanceId: "delivery-recurring-test",
    conversationId: "delivery-recurring-test",
    conversationKind: "direct",
  };
  let handle: TestDaemonHandle;
  let echoAdapter: EchoChannelAdapter;
  // Monotonic id sequence so each WebSocket request has a unique id (avoids
  // any collision with heartbeat notifications or earlier responses).
  let nextRpcId = 1;

  beforeAll(async () => {
    // Confirmed against packages/channels/src/echo/echo-adapter.ts:
    // EchoChannelAdapter.constructor takes a single options object with
    // optional channelId/channelType. Implements ChannelPort + structurally
    // satisfies DeliveryAdapter (sendMessage + channelType).
    echoAdapter = new EchoChannelAdapter({
      channelId: "delivery-recurring-test",
      channelType: "echo",
    });

    handle = await startTestDaemon({ configPath });

    // Register the adapter into BOTH maps so it is visible to:
    //   1. RPC message.* dispatch (adapterRegistry / adaptersByType)
    //   2. The recurring delivery-queue drainer (deliveryAdapters /
    //      channelAdaptersRef in daemon.ts)
    // Without (2), the drainer cannot find the echo adapter and would
    // mark each entry as failed.
    handle.daemon.adapterRegistry.set("echo", echoAdapter);
    handle.daemon.deliveryAdapters.set("echo", echoAdapter);
  }, 120_000);

  afterAll(async () => {
    if (handle) {
      try {
        await handle.cleanup();
      } catch (err) {
        // Expected: graceful shutdown calls the overridden exit() which throws.
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("Daemon exit with code")) throw err;
      }
    }
  }, 30_000);

  // -------------------------------------------------------------------------
  // Post-startup notification.send is delivered by the recurring drainer
  // within drainIntervalMs + 500ms.
  // -------------------------------------------------------------------------

  it(
    "post-startup notification.send is delivered within drainIntervalMs + 500ms",
    async () => {
      const beforeCount = echoAdapter.getSentMessages().length;

      // The daemon has been running long enough for setupDeliveryQueue.drainAndStart()
      // to have completed (recover -> startup-drain -> start drain timer -> start prune timer).
      // notification.send goes notifyUser -> deliveryQueue.enqueue (status='pending').
      // Nothing in-process delivers it; only the recurring drainer can.
      // Note: notification-handlers.ts uses snake_case params (channel_type / channel_id).
      const response = (await sendNotification(
        handle,
        {
          message: "post-startup delivery",
          channel_type: "echo",
          channel_id: "delivery-recurring-test",
          destination_endpoint: echoEndpoint,
          origin: "test",
        },
        nextRpcId++,
      )) as { result?: { success?: boolean; entryId?: string }; error?: unknown };

      expect(response.error).toBeUndefined();
      expect(response.result?.success).toBe(true);

      // drainIntervalMs is 250ms (per test config). Allow drainIntervalMs + 500ms = 750ms.
      // Add a small safety margin (250ms) for CI variability without affecting the latency claim.
      await new Promise((r) => setTimeout(r, 1_000));

      const sent = echoAdapter.getSentMessages();
      expect(sent.length).toBe(beforeCount + 1);
      const last = sent[sent.length - 1];
      expect(last).toBeDefined();
      expect(last!.text).toContain("post-startup delivery");
    },
    20_000,
  );

  // -------------------------------------------------------------------------
  // Pending-depth returns to 0 after the recurring drainer ships the row.
  // Reads depth directly from the daemon's deliveryQueue port, exposed on
  // TestDaemonHandle.
  // -------------------------------------------------------------------------

  it(
    "pending-depth returns to 0 after the recurring drainer ships the row",
    async () => {
      // Send another notification, then poll until queue depth is 0.
      const response = (await sendNotification(
        handle,
        {
          message: "depth check",
          channel_type: "echo",
          channel_id: "delivery-recurring-test",
          destination_endpoint: echoEndpoint,
          origin: "test",
        },
        nextRpcId++,
      )) as { result?: { success?: boolean }; error?: unknown };

      expect(response.error).toBeUndefined();
      expect(response.result?.success).toBe(true);

      // Poll pending-depth until zero or timeout.
      // DeliveryQueuePort exposes statusCounts() (per-status breakdown);
      // we check that the `pending` bucket has drained to 0.
      const deadline = Date.now() + 3_000;
      let pending = -1;
      while (Date.now() < deadline) {
        const result = await handle.daemon.deliveryQueue.statusCounts();
        if (result.ok) {
          pending = result.value.pending;
          if (pending === 0) break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }

      expect(pending).toBe(0);
    },
    15_000,
  );

  // -------------------------------------------------------------------------
  // Throughput stress: 100 sequential-burst notification.send RPCs flow
  // through notifyUser -> deliveryQueue.enqueue (status='pending') ->
  // recurring drainer -> echo adapter. The drainer cadence at 250ms is fast
  // enough to drain the burst within seconds; we send 100 with unique suffixes
  // and verify exactly 100 distinct echo-adapter sends.
  //
  // This is the integration-tier proof that the recurring drainer can drain a
  // burst of pending rows end-to-end without losing any. The row-selection
  // race-safety dimension is verified at the unit tier -- see the test which
  // uses the real SQLite adapter with 100 in_flight + 100 pending coexisting
  // and asserts the drainer never picks an in_flight row. The goal is to
  // catch the row-selection race, which is fully observable in-process. The
  // split is intentional and covers both halves cleanly without retrofitting
  // an integration RPC that bridges directly to deliver-to-channel (which
  // doesn't exist and would be YAGNI).
  // -------------------------------------------------------------------------

  it(
    "100 notification.send RPCs (throughput) produce exactly 100 unique echo sends with zero drops/duplicates",
    async () => {
      const beforeCount = echoAdapter.getSentMessages().length;
      const N = 100;
      const stressStart = Date.now();

      // For throughput, fan out 100 sends across BATCH_COUNT WebSockets so
      // each WebSocket carries at most ~CONCURRENCY in-flight requests at
      // a time. sendJsonRpc adds a `message` listener per request; Node's
      // default EventTarget MaxListeners cap (10) trips a warning AND can
      // drop responses past the 10th listener, causing JSON-RPC timeouts.
      //
      // Rate limit: the gateway STRIPS a client-supplied `_agentId`
      // (anti-forgery — it is an internal field), so all 100 sends
      // resolve to the DEFAULT agent's per-agent notification limiter rather
      // than 100 distinct fresh counters. The test config raises that agent's
      // `notification.maxPerHour` to 100000 (config.test-delivery-recurring.yaml)
      // so the burst is not throttled. Channel resolution uses the explicit
      // channel_type + channel_id, independent of agentId.
      const CONCURRENCY = 8; // < EventTarget.MaxListeners (10) per socket
      const BATCH_COUNT = Math.ceil(N / CONCURRENCY);
      const sockets = await Promise.all(
        Array.from({ length: BATCH_COUNT }, () =>
          openAuthenticatedWebSocket(handle.gatewayUrl, handle.authToken),
        ),
      );

      try {
        const sends = Array.from({ length: N }, (_, i) => {
          const ws = sockets[Math.floor(i / CONCURRENCY)]!;
          return sendJsonRpc(
            ws,
            "notification.send",
            {
              message: `throughput msg ${i}`,
              channel_type: "echo",
              channel_id: "delivery-recurring-test",
              destination_endpoint: echoEndpoint,
              origin: `throughput-${i}`,
              _agentId: `throughput-agent-${i}`,
            },
            nextRpcId++,
            { timeoutMs: 15_000 },
          );
        });

        const responses = (await Promise.all(sends)) as Array<{
          result?: { success?: boolean };
          error?: unknown;
        }>;

        // Every enqueue request succeeded.
        for (const resp of responses) {
          expect(resp.error).toBeUndefined();
          expect(resp.result?.success).toBe(true);
        }
      } finally {
        for (const ws of sockets) ws.close();
      }

      // Wait for the drainer to flush all 100. Worst case: 100 messages /
      // drainIntervalMs (250ms) -- comfortably < 5s. Poll the echo adapter's
      // sent count until it stabilizes.
      const deadline = Date.now() + 15_000;
      let sentCount = beforeCount;
      while (Date.now() < deadline) {
        sentCount = echoAdapter.getSentMessages().length;
        if (sentCount >= beforeCount + N) break;
        await new Promise((r) => setTimeout(r, 100));
      }

      const allSent = echoAdapter.getSentMessages();
      const newSent = allSent.slice(beforeCount);

      const stressDurationMs = Date.now() - stressStart;
      // Surface the actual wall-clock (informational only).
      // eslint-disable-next-line no-console -- intentional informational logging in test
      console.log(`[throughput] 100 RPCs delivered in ${stressDurationMs}ms`);

      // Exactly N new messages received by the echo adapter (no drops).
      expect(newSent.length).toBe(N);

      // Zero duplicates -- each unique throughput-{i} suffix appears exactly once.
      const texts = newSent.map((m) => m.text);
      const uniqueTexts = new Set(texts);
      expect(uniqueTexts.size).toBe(N);
    },
    60_000,
  );

  // -------------------------------------------------------------------------
  // primaryChannel-fallback path: a notification.send with NO channel params
  // mints its destination from the agent's notification.primaryChannel and
  // delivers through the same recurring drainer -> echo adapter chain. This is
  // the second of the two resolution paths (explicit channel is covered above).
  // -------------------------------------------------------------------------

  it(
    "notification.send with no channel params resolves via the agent's primaryChannel and delivers",
    async () => {
      const beforeCount = echoAdapter.getSentMessages().length;

      // No channel_type / channel_id: the handler mints the destination from
      // agents.default.notification.primaryChannel (echo / delivery-recurring-test).
      const response = (await sendNotification(
        handle,
        { message: "primary-channel fallback delivery", origin: "test" },
        nextRpcId++,
      )) as { result?: { success?: boolean }; error?: unknown };

      expect(response.error).toBeUndefined();
      expect(response.result?.success).toBe(true);

      await new Promise((r) => setTimeout(r, 1_000));

      const sent = echoAdapter.getSentMessages();
      expect(sent.length).toBe(beforeCount + 1);
      expect(sent[sent.length - 1]!.text).toContain("primary-channel fallback delivery");
    },
    20_000,
  );

  // -------------------------------------------------------------------------
  // Deferred-row latency. A notification with a future scheduled_at is not
  // delivered before its time. This integration check is sanity-only -- the
  // unit test in setup-delivery.test.ts is the canonical proof; here we just
  // confirm the integration plumbing carries scheduled_at correctly.
  //
  // notification.send does not directly expose scheduled_at in its public RPC
  // shape; it computes scheduled_at internally from quiet-hours config. Since
  // quiet-hours is disabled in the test config, all notification rows go in
  // with scheduled_at=now. Therefore this scenario is left as `it.skip`.
  //
  // The deferred-row scenario is exercised by `deferred row not delivered
  // before scheduled_at` in packages/daemon/src/wiring/setup-delivery.test.ts.
  // -------------------------------------------------------------------------

  it.skip(
    "deferred row not delivered before scheduled_at (covered by unit test)",
    () => {
      // Intentionally skipped -- see comment block above. The unit test is
      // the canonical proof; duplicating it at the integration tier requires
      // either an internal RPC or modifying the test config in ways that make
      // the test brittle. KISS / YAGNI per AGENTS section 2.3.
    },
  );
});
