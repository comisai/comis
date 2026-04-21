// SPDX-License-Identifier: Apache-2.0
import { tryGetContext, runWithContext, type RequestContext } from "@comis/core";
import { Writable } from "node:stream";
import pino from "pino";
import { describe, it, expect } from "vitest";
import { createTracingLogger } from "./trace-logger.js";

/**
 * Capture log output by piping a Pino logger to a Writable stream
 * that collects JSON-parsed log objects.
 */
function createCapture(): { lines: Record<string, unknown>[]; stream: Writable } {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      const text = chunk.toString().trim();
      if (text) {
        try {
          lines.push(JSON.parse(text) as Record<string, unknown>);
        } catch {
          // ignore non-JSON lines
        }
      }
      callback();
    },
  });
  return { lines, stream };
}

/**
 * Create a test logger that writes to a capture stream with the tracing mixin.
 * Uses pino directly (not createTracingLogger) because createLogger from infra
 * does not expose a destination parameter for test capture.
 */
function createTestLogger(stream: Writable) {
  return pino(
    {
      name: "test",
      level: "trace",
      timestamp: pino.stdTimeFunctions.isoTime,
      mixin: () => {
        const ctx = tryGetContext();
        if (!ctx) return {};
        return {
          traceId: ctx.traceId,
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          sessionKey: ctx.sessionKey,
        };
      },
    },
    stream,
  );
}

const testContext: RequestContext = {
  tenantId: "tenant-abc",
  userId: "user-123",
  sessionKey: "telegram:user-123:peer:user-123",
  traceId: "550e8400-e29b-41d4-a716-446655440000",
  startedAt: Date.now(),
};

describe("createTracingLogger", () => {
  it("creates a logger (smoke test)", () => {
    const logger = createTracingLogger({ name: "test-trace", level: "info" });
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.child).toBe("function");
  });

  it("within runWithContext, log lines include traceId, tenantId, userId, sessionKey", () => {
    const { lines, stream } = createCapture();
    const logger = createTestLogger(stream);

    runWithContext(testContext, () => {
      logger.info("request started");
    });

    expect(lines.length).toBe(1);
    const line = lines[0]!;
    expect(line.traceId).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(line.tenantId).toBe("tenant-abc");
    expect(line.userId).toBe("user-123");
    expect(line.sessionKey).toBe("telegram:user-123:peer:user-123");
    expect(line.msg).toBe("request started");
  });

  it("outside context, log lines do NOT include trace fields", () => {
    const { lines, stream } = createCapture();
    const logger = createTestLogger(stream);

    logger.info("no context here");

    expect(lines.length).toBe(1);
    const line = lines[0]!;
    expect(line.traceId).toBeUndefined();
    expect(line.tenantId).toBeUndefined();
    expect(line.userId).toBeUndefined();
    expect(line.sessionKey).toBeUndefined();
    expect(line.msg).toBe("no context here");
  });

  it("nested contexts use inner context values", () => {
    const { lines, stream } = createCapture();
    const logger = createTestLogger(stream);

    const innerContext: RequestContext = {
      tenantId: "tenant-xyz",
      userId: "user-456",
      sessionKey: "discord:user-456:peer:user-456",
      traceId: "660e8400-e29b-41d4-a716-446655440000",
      startedAt: Date.now(),
    };

    runWithContext(testContext, () => {
      logger.info("outer");
      runWithContext(innerContext, () => {
        logger.info("inner");
      });
    });

    expect(lines.length).toBe(2);
    expect(lines[0]!.traceId).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(lines[1]!.traceId).toBe("660e8400-e29b-41d4-a716-446655440000");
    expect(lines[1]!.tenantId).toBe("tenant-xyz");
  });

  it("log line includes structured data alongside trace fields", () => {
    const { lines, stream } = createCapture();
    const logger = createTestLogger(stream);

    runWithContext(testContext, () => {
      logger.info({ action: "tool:execute", toolName: "read" }, "tool executed");
    });

    expect(lines.length).toBe(1);
    const line = lines[0]!;
    expect(line.traceId).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(line.action).toBe("tool:execute");
    expect(line.toolName).toBe("read");
    expect(line.msg).toBe("tool executed");
  });
});
