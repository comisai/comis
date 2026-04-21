import { expect } from "vitest";
/**
 * Assert a logger method was called with an object containing the given fields.
 * Uses expect.objectContaining() so new fields added later don't break the test.
 */
export function expectLoggedWith(logFn, fields, message) {
    if (message) {
        expect(logFn).toHaveBeenCalledWith(expect.objectContaining(fields), message);
    }
    else {
        expect(logFn).toHaveBeenCalledWith(expect.objectContaining(fields));
    }
}
/**
 * Assert a logger method was NEVER called with an object containing the
 * given field name at any log level. Used to verify blocked fields
 * (msg.text, deliveryText, etc.) are not logged.
 */
export function expectNotLogged(logger, fieldName) {
    for (const level of ["info", "warn", "error", "debug"]) {
        const calls = logger[level].mock.calls;
        for (const call of calls) {
            const obj = call[0];
            if (obj && typeof obj === "object" && fieldName in obj) {
                throw new Error(`Expected "${fieldName}" to never be logged, but found it in ${level}() call: ${JSON.stringify(obj)}`);
            }
        }
    }
}
