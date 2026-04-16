// Queue - Lane-aware FIFO command queue with per-session serialization

export { createCommandQueue } from "./command-queue.js";
export type { CommandQueue, CommandQueueDeps, QueueStats } from "./command-queue.js";
export type { SessionLane } from "./lane.js";
export { applyOverflowPolicy } from "./overflow.js";
export type { OverflowResult } from "./overflow.js";
export { coalesceMessages } from "./coalescer.js";
export { createDebounceBuffer } from "./debounce-buffer.js";
export type { DebounceBuffer, DebounceBufferDeps } from "./debounce-buffer.js";
export { createFollowupTrigger } from "./followup-trigger.js";
export type { FollowupTrigger, FollowupTriggerDeps } from "./followup-trigger.js";
export { createPriorityScheduler } from "./priority-scheduler.js";
export type { PriorityScheduler, PrioritySchedulerDeps, LaneStats } from "./priority-scheduler.js";
