import { z } from "zod";

/**
 * DeliveryOrigin: Immutable snapshot of the originating channel context.
 *
 * Captured at channel adapter entry points and propagated through the
 * entire async call chain via RequestContext. Used by downstream
 * delivery routing to send responses back to the correct channel,
 * thread, and user — even across sub-agent spawns.
 *
 * All fields are validated via Zod; the factory freezes the result
 * to guarantee immutability after creation.
 */
export const DeliveryOriginSchema = z.strictObject({
    /** Platform identifier (e.g., "telegram", "discord", "gateway") */
    channelType: z.string().min(1),
    /** Channel or chat identifier within the platform */
    channelId: z.string().min(1),
    /** Originating user identifier */
    userId: z.string().min(1),
    /** Thread within the channel (platform-specific, e.g., Discord thread, Telegram topic) */
    threadId: z.string().optional(),
    /** Multi-tenant isolation key */
    tenantId: z.string().min(1).default("default"),
  });

export type DeliveryOrigin = Readonly<z.infer<typeof DeliveryOriginSchema>>;

/**
 * Create an immutable DeliveryOrigin from raw input.
 *
 * Validates through DeliveryOriginSchema (applies defaults), then
 * freezes the result. Throws ZodError on invalid input.
 */
export function createDeliveryOrigin(input: z.input<typeof DeliveryOriginSchema>): DeliveryOrigin {
  const parsed = DeliveryOriginSchema.parse(input);
  return Object.freeze(parsed);
}
