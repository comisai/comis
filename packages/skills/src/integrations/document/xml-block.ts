/**
 * XML file block formatting and injection prevention.
 *
 * Utilities for formatting extracted text content into XML file blocks
 * (`<file name="..." mime="...">content</file>`) with proper escaping
 * to prevent XML injection attacks.
 *
 * DESIGN NOTE: Only the specific `</file>` and `<file` injection patterns
 * are escaped in content, NOT all angle brackets. Escaping all `<` and `>`
 * would destroy legitimate code samples, HTML, and XML content in extracted files.
 *
 * @module
 */

/**
 * Escape a string for safe use as an XML attribute value.
 *
 * Escapes the five XML special characters in attribute values:
 * - `&` → `&amp;` (must be first to avoid double-escaping)
 * - `<` → `&lt;`
 * - `>` → `&gt;`
 * - `"` → `&quot;`
 * - `'` → `&apos;`
 *
 * @param value - Attribute value to escape
 * @returns Escaped string safe for use in XML attributes
 */
export function xmlEscapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Escape file content to prevent XML block injection.
 *
 * Targets only the specific sequences that would break the `<file>...</file>`
 * XML block structure:
 * - `</file>` (exact closing tag, case-insensitive) → `&lt;/file&gt;`
 * - `</file` followed by word boundary → `&lt;/file` (partial tag injection)
 * - `<file` followed by whitespace or `>` → `&lt;` + rest (opening tag injection)
 *
 * All other angle brackets (e.g., `<div>`, `if (a < b)`, TypeScript generics)
 * are left untouched to preserve code samples, HTML, and XML content.
 *
 * @param content - Extracted file content to escape
 * @returns Content safe for embedding in XML file blocks
 */
export function escapeFileBlockContent(content: string): string {
  return content
    // Replace exact closing tag first (most specific pattern)
    .replace(/<\/file>/gi, "&lt;/file&gt;")
    // Replace partial closing tag (covers </file followed by word boundary)
    .replace(/<\/file\b/gi, "&lt;/file")
    // Replace opening tag injection (<file followed by whitespace or >)
    .replace(/<file[\s>]/gi, (match) => "&lt;" + match.slice(1));
}

/**
 * Format extracted text into an XML file block.
 *
 * Produces:
 * ```
 * <file name="escaped-name" mime="escaped-mime">
 * escaped-content
 * </file>
 * ```
 *
 * @param content - Extracted text content (will be injection-escaped)
 * @param fileName - Original file name (will be attribute-escaped)
 * @param mimeType - MIME type of the file (will be attribute-escaped)
 * @returns Formatted XML file block string
 */
export function formatFileBlock(
  content: string,
  fileName: string,
  mimeType: string,
): string {
  const escapedName = xmlEscapeAttr(fileName);
  const escapedMime = xmlEscapeAttr(mimeType);
  const escapedContent = escapeFileBlockContent(content);
  return `<file name="${escapedName}" mime="${escapedMime}">\n${escapedContent}\n</file>`;
}
