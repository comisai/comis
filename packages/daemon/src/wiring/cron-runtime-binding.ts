// SPDX-License-Identifier: Apache-2.0
import { err } from "@comis/shared";
import type {
  CronRootRegistrar,
  CronRuntimeExecutor,
} from "@comis/scheduler";

export interface CronRuntimeBinding {
  readonly executor: CronRuntimeExecutor;
  readonly rootRegistrar: CronRootRegistrar;
  bind(deps: {
    executor: CronRuntimeExecutor;
    rootRegistrar: CronRootRegistrar;
  }): void;
  close(): void;
  isBound(): boolean;
}

/** Keep scheduler construction inert until daemon runtime dependencies exist. */
export function createLateBoundCronRuntime(): CronRuntimeBinding {
  let current: {
    executor: CronRuntimeExecutor;
    rootRegistrar: CronRootRegistrar;
  } | undefined;

  return {
    executor: {
      execute(input, signal) {
        return current?.executor.execute(input, signal) ?? Promise.resolve(err({
          code: "not_bound" as const,
          errorKind: "precondition" as const,
          message: "Cron runtime executor is not bound",
        }));
      },
    },
    rootRegistrar: {
      register(input) {
        return current?.rootRegistrar.register(input) ?? Promise.resolve(err({
          errorKind: "precondition" as const,
          message: "Cron root registrar is not bound",
        }));
      },
      release(rootRunId) {
        return current?.rootRegistrar.release(rootRunId) ?? Promise.resolve(err({
          errorKind: "precondition" as const,
          message: "Cron root registrar is not bound",
        }));
      },
    },
    bind(deps): void {
      current = deps;
    },
    close(): void {
      current = undefined;
    },
    isBound(): boolean {
      return current !== undefined;
    },
  };
}
