// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { ok, type Result } from "@comis/shared";
import type {
  ChannelPort,
  DeliverToChannelOptions,
  DeliveryAttempt,
  DeliveryService,
  OutwardSendLedgerPort,
  SessionKey,
} from "@comis/core";
import { createFakeClock } from "../../../../../test/support/fake-clock.js";
import { createGraphReportRequestHandler } from "./graph-report-delivery.js";

const GRAPH_ID = "11111111-2222-4333-8444-555555555555";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function makeLogger() {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    audit: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
}

function makeAdapter(withAttachment: boolean): ChannelPort {
  const adapter = {
    channelType: "telegram",
    channelId: "bot-1",
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    onMessage: vi.fn(),
    sendMessage: vi.fn(async (): Promise<Result<DeliveryAttempt, Error>> =>
      ok({ kind: "tracked", messageId: "message-1" })),
    ...(withAttachment
      ? {
          sendAttachment: vi.fn(async (): Promise<Result<DeliveryAttempt, Error>> =>
            ok({ kind: "tracked", messageId: "attachment-1" })),
        }
      : {}),
  };
  return adapter as unknown as ChannelPort;
}

function makeDeliveryService(): DeliveryService {
  return {
    deliverToChannel: vi.fn(async () => ok({
      chunks: [{
        status: "accepted" as const,
        messageId: "message-1",
        charCount: 10,
        retried: false,
      }],
      totalChars: 10,
      platform: {
        status: "accepted" as const,
        deliveredChunks: 1,
        settledAtMs: 1,
        lastMessageId: "message-1",
      },
      queueDisposition: "settled" as const,
    })),
    drainInFlight: vi.fn(async () => ({ drained: 0, remaining: 0, durationMs: 0 })),
  };
}

function makeOutwardLedger(): OutwardSendLedgerPort {
  return {
    allocateStep: vi.fn(async () => ok(7)),
    lookup: vi.fn(async () => ok(undefined)),
    begin: vi.fn(async () => ok(undefined)),
    markUnknown: vi.fn(async () => ok(undefined)),
    reclaimPreSend: vi.fn(async () => ok(false)),
    commit: vi.fn(async () => ok(undefined)),
    markFailed: vi.fn(async () => ok(undefined)),
    parkUncertain: vi.fn(async () => ok(true)),
    hasUncertainty: vi.fn(async () => ok(false)),
    listUnreconciled: vi.fn(async () => ok([])),
  };
}

function requestSession(): SessionKey {
  return {
    tenantId: "tenant-a",
    userId: "user_a",
    channelId: "chat-1",
  };
}

function routeOptions(overrides: Partial<DeliverToChannelOptions> = {}): DeliverToChannelOptions {
  return {
    completionMode: "deferred_retry",
    authority: {
      tenantId: "tenant-a",
      agentId: "agent-1",
      conversationRef: `cv_${"a".repeat(43)}` as never,
    },
    destinationEndpoint: {
      channelType: "telegram",
      channelInstanceId: "bot-1",
      conversationId: "chat-1",
      threadId: "topic-1",
      conversationKind: "shared",
    },
    threadId: "topic-1",
    skipChunking: true,
    ...overrides,
  };
}

async function makeReport(outputPath?: string): Promise<{ root: string; graphDir: string }> {
  const root = await mkdtemp(resolve(tmpdir(), "comis-graph-report-"));
  roots.push(root);
  const graphDir = resolve(root, "graph-runs", GRAPH_ID);
  await mkdir(graphDir, { recursive: true });
  if (outputPath === undefined) {
    await writeFile(resolve(graphDir, "final-output.md"), "# Final report\n", { mode: 0o600 });
  } else {
    await symlink(outputPath, resolve(graphDir, "final-output.md"));
  }
  await writeFile(
    resolve(graphDir, "_run-metadata.json"),
    JSON.stringify({ nodes: { final: { status: "completed" } } }),
    { mode: 0o600 },
  );
  return { root, graphDir };
}

describe("graph report delivery", () => {
  it("records the report attachment before calling the platform upload", async () => {
    const { root } = await makeReport();
    const adapter = makeAdapter(true);
    const outwardLedger = makeOutwardLedger();
    const handler = createGraphReportRequestHandler({
      dataDir: root,
      clock: createFakeClock(1),
      logger: makeLogger(),
      deliveryService: makeDeliveryService(),
      durability: {
        outwardLedger,
        resolveRootRunId: vi.fn(() => ok("root-1")),
      },
    });

    await handler(
      GRAPH_ID,
      "telegram",
      "chat-1",
      adapter,
      routeOptions(),
      requestSession(),
    );

    expect(adapter.sendAttachment).toHaveBeenCalledWith(
      "chat-1",
      expect.objectContaining({
        type: "file",
        url: expect.stringContaining(resolve(root, "graph-report-deliveries")),
        mimeType: "text/markdown",
      }),
      { threadId: "topic-1" },
    );
    expect(outwardLedger.allocateStep).toHaveBeenCalledWith(
      "root-1",
      expect.stringContaining("graph-report:"),
    );
    expect(outwardLedger.markUnknown).toHaveBeenCalledWith("root-1", 7);
    expect(outwardLedger.commit).toHaveBeenCalledWith("root-1", 7, "attachment-1");
    expect(vi.mocked(outwardLedger.markUnknown).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(adapter.sendAttachment!).mock.invocationCallOrder[0]!,
    );
  });

  it("never exposes the host file path when the channel cannot upload attachments", async () => {
    const { root, graphDir } = await makeReport();
    const adapter = makeAdapter(false);
    const deliveryService = makeDeliveryService();
    const handler = createGraphReportRequestHandler({
      dataDir: root,
      clock: createFakeClock(1),
      logger: makeLogger(),
      deliveryService,
      durability: { outwardLedger: undefined, resolveRootRunId: undefined },
    });

    await handler(GRAPH_ID, "telegram", "chat-1", adapter, routeOptions(), requestSession());

    expect(deliveryService.deliverToChannel).toHaveBeenCalledTimes(1);
    const text = vi.mocked(deliveryService.deliverToChannel).mock.calls[0]?.[2];
    expect(text).toMatch(/attachment delivery is not supported/i);
    expect(text).not.toContain(root);
    expect(text).not.toContain(graphDir);
    expect(deliveryService.deliverToChannel).toHaveBeenCalledWith(
      adapter,
      "chat-1",
      expect.any(String),
      routeOptions(),
    );
    expect(adapter.sendMessage).not.toHaveBeenCalled();
  });

  it("refuses a symlinked report instead of uploading its target", async () => {
    const outsideRoot = await mkdtemp(resolve(tmpdir(), "comis-graph-report-outside-"));
    roots.push(outsideRoot);
    const outside = resolve(outsideRoot, "sensitive.md");
    await writeFile(outside, "not graph output", { mode: 0o600 });
    const { root } = await makeReport(outside);
    const adapter = makeAdapter(true);
    const logger = makeLogger();
    const deliveryService = makeDeliveryService();
    const handler = createGraphReportRequestHandler({
      dataDir: root,
      clock: createFakeClock(1),
      logger,
      deliveryService,
      durability: { outwardLedger: undefined, resolveRootRunId: undefined },
    });

    await handler(GRAPH_ID, "telegram", "chat-1", adapter, routeOptions(), requestSession());

    expect(adapter.sendAttachment).not.toHaveBeenCalled();
    expect(deliveryService.deliverToChannel).toHaveBeenCalledWith(
      adapter,
      "chat-1",
      expect.stringMatching(/not available/i),
      routeOptions(),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorKind: "validation", hint: expect.any(String) }),
      expect.any(String),
    );
  });

  it("uploads an owner-only snapshot when the selected report path is swapped before the adapter reads it", async () => {
    const { root, graphDir } = await makeReport();
    const reportPath = resolve(graphDir, "final-output.md");
    const outsideRoot = await mkdtemp(resolve(tmpdir(), "comis-graph-report-outside-"));
    roots.push(outsideRoot);
    const outside = resolve(outsideRoot, "sensitive.md");
    await writeFile(outside, "outside secret", { mode: 0o600 });
    let uploaded = "";
    let deliveredPath = "";
    let deliveredMode = 0;
    const adapter = makeAdapter(true);
    vi.mocked(adapter.sendAttachment!).mockImplementation(async (_channelId, attachment) => {
      await rename(reportPath, `${reportPath}.original`);
      await symlink(outside, reportPath);
      deliveredPath = attachment.url;
      uploaded = await readFile(attachment.url, "utf8");
      deliveredMode = (await stat(attachment.url)).mode & 0o777;
      return ok({ kind: "tracked", messageId: "attachment-1" });
    });
    const handler = createGraphReportRequestHandler({
      dataDir: root,
      clock: createFakeClock(1),
      logger: makeLogger(),
      deliveryService: makeDeliveryService(),
      durability: {
        outwardLedger: makeOutwardLedger(),
        resolveRootRunId: vi.fn(() => ok("root-1")),
      },
    });

    await handler(GRAPH_ID, "telegram", "chat-1", adapter, routeOptions(), requestSession());

    expect(deliveredPath).not.toBe(reportPath);
    expect(deliveredPath).not.toContain(graphDir);
    expect(uploaded).toBe("# Final report\n");
    expect(deliveredMode).toBe(0o400);
  });

  it("rejects an endpoint-mismatched report route before platform delivery", async () => {
    const { root } = await makeReport();
    const adapter = makeAdapter(true);
    const deliveryService = makeDeliveryService();
    const handler = createGraphReportRequestHandler({
      dataDir: root,
      clock: createFakeClock(1),
      logger: makeLogger(),
      deliveryService,
      durability: { outwardLedger: undefined, resolveRootRunId: undefined },
    });

    await handler(GRAPH_ID, "telegram", "chat-1", adapter, routeOptions({
      destinationEndpoint: {
        channelType: "telegram",
        channelInstanceId: "other-bot",
        conversationId: "chat-1",
        threadId: "topic-1",
        conversationKind: "shared",
      },
    }), requestSession());

    expect(deliveryService.deliverToChannel).not.toHaveBeenCalled();
    expect(adapter.sendMessage).not.toHaveBeenCalled();
    expect(adapter.sendAttachment).not.toHaveBeenCalled();
  });
});
