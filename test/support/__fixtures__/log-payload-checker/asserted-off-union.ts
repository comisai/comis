// SPDX-License-Identifier: Apache-2.0
// @ts-nocheck
interface MockLogger {
  warn(payload: unknown, message?: string): void;
}
type ErrorKind = "config" | "network";
declare const logger: MockLogger;

logger.warn(
  { errorKind: "transient" as ErrorKind },
  "asserted off-union literal",
);
