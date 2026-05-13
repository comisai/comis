// SPDX-License-Identifier: Apache-2.0
// @ts-nocheck
interface MockLogger {
  warn(payload: unknown, msg?: string): void;
}
declare const logger: MockLogger;
logger.warn({ errorKind: "config" as const, traceId: "abc" }, "valid payload");
logger.warn({ errorKind: "network" as const }, "another valid");
