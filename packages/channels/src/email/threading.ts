/**
 * RFC 5322 threading header management for email.
 *
 * Builds In-Reply-To and References headers for proper email thread
 * continuity. Extracts thread IDs from message metadata.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Threading headers for an outbound email. */
export interface ThreadingHeaders {
  /** The In-Reply-To header value (RFC 5322 Message-ID format). */
  inReplyTo?: string;
  /** The References header values (RFC 5322 Message-ID list). */
  references: string[];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build threading headers for an outbound email reply.
 *
 * Follows RFC 5322: In-Reply-To is the parent message ID,
 * References is the full ancestry chain with the parent appended.
 *
 * @param opts.inReplyTo - Message-ID of the parent email being replied to
 * @param opts.existingReferences - Existing References chain from the parent
 * @returns Threading headers for the outbound email
 */
export function buildThreadingHeaders(opts: {
  inReplyTo?: string;
  existingReferences?: string[];
}): ThreadingHeaders {
  if (!opts.inReplyTo) {
    return { references: [] };
  }

  const refs = [...(opts.existingReferences ?? []), opts.inReplyTo];
  return {
    inReplyTo: opts.inReplyTo,
    references: refs,
  };
}

/**
 * Extract the email thread ID from normalized message metadata.
 *
 * Looks for the `emailMessageId` field set by the message mapper.
 *
 * @param metadata - Message metadata record
 * @returns The Message-ID string, or undefined if not present/not a string
 */
export function extractThreadId(
  metadata: Record<string, unknown>,
): string | undefined {
  const value = metadata.emailMessageId;
  return typeof value === "string" ? value : undefined;
}
