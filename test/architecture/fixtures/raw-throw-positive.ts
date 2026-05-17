// SPDX-License-Identifier: Apache-2.0
// @ts-nocheck
/**
 * Fixture: POSITIVE — raw-throw rule should flag every throw below.
 *
 * Walker assertion: ≥ 6 violations.
 */

// VIOLATION: throw new Error
function v1() {
  throw new Error("invalid state");
}

// VIOLATION: throw new SubclassError
class MyError extends Error {}
function v2() {
  throw new MyError("specific case");
}

// VIOLATION: throw new RangeError (Node built-in)
function v3() {
  throw new RangeError("out of range");
}

// VIOLATION: bare rethrow `throw err;`
function v4() {
  try {
    JSON.parse("{");
  } catch (err) {
    throw err;
  }
}

// VIOLATION: `throw err as Error;` retyped rethrow
function v5() {
  try {
    JSON.parse("{");
  } catch (err) {
    throw err as Error;
  }
}

// VIOLATION: throw e; (single-letter)
function v6() {
  try {
    JSON.parse("{");
  } catch (e) {
    throw e;
  }
}
