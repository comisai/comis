// SPDX-License-Identifier: Apache-2.0
// @ts-nocheck
/**
 * Fixture: NEGATIVE — globals rule MUST classify every site below as clean.
 *
 * Walker assertion: 0 violations.
 */

// CLEAN: JSDoc reference to Date.now() — comment, not a call
/** Computes age in ms using Date.now() as the reference. */
function age(): number {
  return 0;
}

// CLEAN: line comment mentioning setTimeout
// Replaced setTimeout with timers.setTimeout via TimerPort.
function noop1() {}

// CLEAN: type-only import (the file imports a type whose name is shaped like a global)
// import type { setTimeout } from "./fake-types";  // intentionally commented to avoid linting

// CLEAN: string literal containing forbidden text
const msg = "setTimeout is forbidden";

// CLEAN: template-literal containing forbidden text in STRING part (not substitution)
const help = `Avoid Date.now() — use clock.now() instead`;

// CLEAN: Identifier mention (passing as callback) — NOT a CallExpression
declare const callbacks: Array<() => void>;
declare const fakeNow: () => number;
function register() {
  // The identifier is a value reference, not an invocation.
  callbacks.push(fakeNow);
}

// CLEAN: Property access without call — `Date.now` (no parens)
const fn = Date.now;  // function reference, not invocation

// CLEAN: TimerHandle.unref() — type-checker resolves to TimerHandle
interface TimerHandle {
  readonly cancelled: boolean;
  cancel(): void;
  unref(): void;
}
declare const handle: TimerHandle;
handle.unref();   // .unref() on TimerHandle is permitted
handle.cancel();  // .cancel() on TimerHandle is permitted

// CLEAN: NodeJS.Timeout.unref() — same type-checker exemption
declare const nodeTimer: NodeJS.Timeout;
nodeTimer.unref();

// CLEAN: object property called `setTimeout` (not the global)
const timersStub = { setTimeout: (cb: () => void, ms: number) => cb() };
timersStub.setTimeout(() => {}, 0);
