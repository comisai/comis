// SPDX-License-Identifier: Apache-2.0
// @ts-nocheck
interface MockLogger {
  warn(payload: unknown, msg?: string): void;
}
declare const logger: MockLogger;
// `as const` narrows the inferred type to the string-literal type
// "off-union-value" so the TypeChecker resolves it as a literal — without
// `as const` the inferred type is the open `string`, and the walker would
// report `<unresolved type>` instead of the actual off-union value.
logger.warn(
  { errorKind: "off-union-value" as const, traceId: "abc" },
  "test message",
);
