// SPDX-License-Identifier: Apache-2.0
// @ts-nocheck
interface MockLogger {
  warn(payload: unknown, msg?: string): void;
}
declare const logger: MockLogger;
const fields = { errorKind: "off-union-via-member" as const, traceId: "abc" };
logger.warn(fields, "test message");
