// SPDX-License-Identifier: Apache-2.0
/** Minimal pino-compatible logger interface for scheduler subsystem logging. */
export interface SchedulerLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  info(msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  warn(msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  error(msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
  debug(msg: string): void;
  child(bindings: Record<string, unknown>): SchedulerLogger;
}
