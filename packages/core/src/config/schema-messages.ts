import { z } from "zod";

/**
 * Messaging UX configuration schema.
 *
 * Controls outbound message formatting, splitting behavior, typing indicators,
 * and delivery settings. These are operational UX knobs, not security-critical.
 *
 * @module
 */
export const MessagesConfigSchema = z.strictObject({
    /** Maximum outbound message length in characters (0 = no limit, default: 0) */
    maxOutboundLength: z.number().int().nonnegative().default(0),
    /** Whether to split long messages into multiple parts (default: true) */
    splitLongMessages: z.boolean().default(true),
    /** Character limit per split part (default: 4000) */
    splitMaxChars: z.number().int().positive().default(4000),
    /** Separator string between split parts (default: double newline) */
    splitSeparator: z.string().default("\n\n"),
    /** Enable typing indicator during agent processing (default: true) */
    showTypingIndicator: z.boolean().default(true),
    /** Prefix for system messages shown to users (default: "[System] ") */
    systemMessagePrefix: z.string().default("[System] "),
    /** Enable read receipts where supported (default: false) */
    readReceipts: z.boolean().default(false),
    /** Maximum message.send/reply tool calls per agent execution (0 = no limit, default: 3) */
    maxSendsPerExecution: z.number().int().nonnegative().default(3),
  });

/** Inferred messages configuration type. */
export type MessagesConfig = z.infer<typeof MessagesConfigSchema>;
