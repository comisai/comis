// SPDX-License-Identifier: Apache-2.0
// @ts-nocheck
/**
 * Fixture: NEGATIVE — raw-throw rule MUST classify every site below as clean.
 *
 * Walker assertion: 0 violations.
 */

// CLEAN: Result.err return
type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };
const ok = <T,>(value: T): Result<T, never> => ({ ok: true, value });
const err = <E,>(error: E): Result<never, E> => ({ ok: false, error });

function c1(): Result<number, { kind: "config"; message: string }> {
  return err({ kind: "config", message: "missing env" });
}

// CLEAN: JSDoc @throws annotation (comment, not code)
/**
 * Parses a config.
 *
 * @throws never — returns Result on every path
 */
function c2() {
  return ok(0);
}

// CLEAN: throw inside a string literal
const docs = "Don't do: throw new Error('...');";

// CLEAN: throw inside a template-literal string portion
const example = `Replace \`throw new Error('x')\` with \`return err(...)\`.`;

// CLEAN: line-comment containing throw
// throw new Error("this is in a comment");
function c3() {}

// CLEAN: function name containing "throw" but no actual throw statement
function maybeThrowable() {
  return ok(1);
}
