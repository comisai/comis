// SPDX-License-Identifier: Apache-2.0
/**
 * Shared leaf types for the terminal wake/backstop wiring — a dependency-free module so
 * `setup-terminal-wake.ts`, `terminal-durable-wiring.ts`, and `terminal-wake-notify.ts` can
 * all import these WITHOUT a cycle (each of those imports the others in one direction; a type
 * shared between them must live in a leaf both can reach).
 *
 * @module
 */
import type { BusySignal } from "@comis/skills/tools";

/**
 * The liveness-probe result the liveness backstop consumes — a {@link BusySignal} (the busy/hung
 * verdict the reaper + backstop read) PLUS the completion signal `awaitingInput`:
 * `true` iff the classifier reported `awaiting-input` (a settled prompt — a backgrounded drive
 * that finished its current work and is now idle at its `❯` box). `busyOrHung` IGNORES it (an
 * awaiting-input drive is `busy`, not hung), so the field is purely additive; the backstop reads
 * it to deliver a ONE-TIME "drive finished — waiting for input" notification that a backgrounded
 * drive would otherwise never deliver (it emits no fd3 attention once promoted, and the backstop
 * acted only on `hung`).
 */
export type LivenessSignal = BusySignal & { awaitingInput?: boolean };
