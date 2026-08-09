/** Pull inline approval controls out of either emulator casing. */
export function approvalButtons(message) {
  const markup = message?.reply_markup ?? message?.replyMarkup ?? message?.raw?.reply_markup ?? {};
  const rows = markup.inline_keyboard ?? markup.inlineKeyboard ?? [];
  return (Array.isArray(rows) ? rows : []).flat().map((button) => ({
    label: String(button?.text ?? ""),
    data: String(button?.callback_data ?? button?.callbackData ?? ""),
  }));
}

function hasExplicitlyEmptyControls(message) {
  const markup = message?.reply_markup ?? message?.replyMarkup ?? message?.raw?.reply_markup;
  if (markup === undefined || markup === null) return false;
  const rows = markup.inline_keyboard ?? markup.inlineKeyboard;
  return Array.isArray(rows) && rows.length === 0;
}

/** Classify only events emitted after the callback tap. */
export function classifyApprovalRetirement({
  messages,
  messageId,
  afterEventCount,
  elapsedMs,
  maxRetirementMs,
}) {
  if (elapsedMs > maxRetirementMs) {
    return { state: "late", elapsedMs, maxRetirementMs };
  }
  const expectedId = String(messageId);
  for (let index = Math.max(0, afterEventCount); index < messages.length; index += 1) {
    const message = messages[index];
    if (String(message?.messageId ?? message?.raw?.message_id) !== expectedId) continue;
    if (message?.method === "deleteMessage" || hasExplicitlyEmptyControls(message)) {
      return { state: "retired", method: message.method, eventIndex: index };
    }
    if (approvalButtons(message).length > 0) {
      return { state: "still_actionable", eventIndex: index };
    }
  }
  return { state: "pending" };
}
