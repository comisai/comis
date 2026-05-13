// SPDX-License-Identifier: Apache-2.0
// @ts-nocheck
interface MockLogger {
  warn(payload: unknown, msg?: string): void;
}
declare const logger: MockLogger;
const base = { traceId: "abc" };
logger.warn(
  { ...base, errorKind: "off-union-via-spread" as const },
  "test message",
);
