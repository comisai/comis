// SPDX-License-Identifier: Apache-2.0
import type {
  DeliveredAssistantHistoryPort,
  TaskExtractionPort,
} from "@comis/core";
import { err, ok, type Result } from "@comis/shared";

export interface SchedulerCorePortBindingStatus {
  readonly accepting: boolean;
  readonly taskExtractionBound: boolean;
  readonly deliveredAssistantHistoryBound: boolean;
}

export interface SchedulerCorePortBindingError {
  readonly code: "already_bound" | "not_accepting";
  readonly errorKind: "precondition";
}

export interface SchedulerCorePortBindings {
  readonly taskExtractionPort: TaskExtractionPort;
  readonly deliveredAssistantHistoryPort: DeliveredAssistantHistoryPort;
  bind(ports: {
    taskExtractionPort: TaskExtractionPort;
    deliveredAssistantHistoryPort: DeliveredAssistantHistoryPort;
  }): Result<void, SchedulerCorePortBindingError>;
  close(): void;
  status(): SchedulerCorePortBindingStatus;
}

/** Stable fail-closed core-port identities for the daemon's two-phase boot. */
export function createSchedulerCorePortBindings(): SchedulerCorePortBindings {
  let accepting = true;
  let taskExtractionPort: TaskExtractionPort | undefined;
  let deliveredAssistantHistoryPort: DeliveredAssistantHistoryPort | undefined;

  const taskProxy: TaskExtractionPort = {
    enqueue(turn) {
      if (!accepting || taskExtractionPort === undefined) {
        return err({ code: "not_accepting", errorKind: "precondition" });
      }
      return taskExtractionPort.enqueue(turn);
    },
  };
  const historyProxy: DeliveredAssistantHistoryPort = {
    append(input) {
      if (!accepting || deliveredAssistantHistoryPort === undefined) {
        return Promise.resolve(err({ code: "not_accepting", errorKind: "precondition" }));
      }
      return deliveredAssistantHistoryPort.append(input);
    },
  };

  return {
    taskExtractionPort: taskProxy,
    deliveredAssistantHistoryPort: historyProxy,
    bind(ports) {
      if (!accepting) return err({ code: "not_accepting", errorKind: "precondition" });
      if (taskExtractionPort !== undefined || deliveredAssistantHistoryPort !== undefined) {
        return err({ code: "already_bound", errorKind: "precondition" });
      }
      taskExtractionPort = ports.taskExtractionPort;
      deliveredAssistantHistoryPort = ports.deliveredAssistantHistoryPort;
      return ok(undefined);
    },
    close(): void {
      accepting = false;
    },
    status(): SchedulerCorePortBindingStatus {
      return {
        accepting,
        taskExtractionBound: taskExtractionPort !== undefined,
        deliveredAssistantHistoryBound: deliveredAssistantHistoryPort !== undefined,
      };
    },
  };
}
