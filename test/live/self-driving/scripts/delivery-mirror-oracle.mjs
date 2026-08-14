// SPDX-License-Identifier: Apache-2.0

const validEndpoint =
  "CASE WHEN json_valid(destination_endpoint) THEN destination_endpoint ELSE '{}' END";

export function selectLatestTelegramDeliveryMirror(db, chatId) {
  return db.prepare(
    "SELECT tenant_id, agent_id, conversation_ref, destination_endpoint, text, channel_type, status, created_at "
    + "FROM delivery_mirror "
    + `WHERE json_extract(${validEndpoint}, '$.channelType') = 'telegram' `
    + `AND CAST(json_extract(${validEndpoint}, '$.conversationId') AS TEXT) = ? `
    + "ORDER BY created_at DESC LIMIT 1",
  ).get(String(chatId));
}

export function renderDeliveryMirrorForWire(mirror, formatForChannel) {
  if (mirror === undefined) return "";
  return formatForChannel(mirror.text, mirror.channel_type);
}
