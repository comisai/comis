import type { Mock } from "vitest";
/**
 * Assert a logger method was called with an object containing the given fields.
 * Uses expect.objectContaining() so new fields added later don't break the test.
 */
export declare function expectLoggedWith(logFn: Mock, fields: Record<string, unknown>, message?: string): void;
/**
 * Assert a logger method was NEVER called with an object containing the
 * given field name at any log level. Used to verify blocked fields
 * (msg.text, deliveryText, etc.) are not logged.
 */
export declare function expectNotLogged(logger: {
    info: Mock;
    warn: Mock;
    error: Mock;
    debug: Mock;
}, fieldName: string): void;
