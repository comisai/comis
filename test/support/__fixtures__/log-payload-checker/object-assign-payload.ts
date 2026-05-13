// SPDX-License-Identifier: Apache-2.0
// @ts-nocheck
interface MockLogger {
  warn(payload: unknown, msg?: string): void;
}
declare const logger: MockLogger;
const base = { traceId: "abc" };
logger.warn(
  Object.assign({}, base, { errorKind: "off-union-via-assign" as const }),
  "test message",
);
