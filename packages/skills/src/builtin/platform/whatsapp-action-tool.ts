// SPDX-License-Identifier: Apache-2.0
/**
 * WhatsApp action tool: platform-specific actions for WhatsApp groups.
 *
 * Supports 11 actions: group_info, group_update_subject, group_update_description,
 * group_participants_add, group_participants_remove, group_promote, group_demote,
 * group_settings, group_invite_code, profile_status, group_leave.
 * Destructive actions (group_participants_remove, group_promote, group_leave)
 * require confirmation via action gates.
 * All actions delegate to the WhatsApp backend via rpcCall("whatsapp.action").
 *
 * @module
 */

import { Type } from "typebox";
import { createPlatformActionTool, type PlatformActionDescriptor } from "./platform-action-tool.js";
import type { RpcCall } from "./cron-tool.js";

// ---------------------------------------------------------------------------
// Parameter schema
// ---------------------------------------------------------------------------

const WhatsAppActionParams = Type.Object({
  action: Type.Union(
    [
      Type.Literal("group_info"),
      Type.Literal("group_update_subject"),
      Type.Literal("group_update_description"),
      Type.Literal("group_participants_add"),
      Type.Literal("group_participants_remove"),
      Type.Literal("group_promote"),
      Type.Literal("group_demote"),
      Type.Literal("group_settings"),
      Type.Literal("group_invite_code"),
      Type.Literal("profile_status"),
      Type.Literal("group_leave"),
    ],
    { description: "WhatsApp-specific action. Valid values: group_info (get group details), group_update_subject (change group name), group_update_description (change group description), group_participants_add (add members), group_participants_remove (remove members), group_promote (grant admin), group_demote (revoke admin), group_settings (change group setting), group_invite_code (get invite link), profile_status (update status text), group_leave (leave group)" },
  ),
  group_jid: Type.Optional(
    Type.String({ description: "Group JID with @g.us suffix (for all group actions)" }),
  ),
  participant_jids: Type.Optional(
    Type.Array(Type.String(), {
      description: "Participant JIDs with @s.whatsapp.net suffix (for add/remove/promote/demote)",
    }),
  ),
  subject: Type.Optional(
    Type.String({ description: "New group subject/name (for group_update_subject)" }),
  ),
  description: Type.Optional(
    Type.String({ description: "New group description (for group_update_description)" }),
  ),
  setting: Type.Optional(
    Type.Union(
      [
        Type.Literal("announcement"),
        Type.Literal("not_announcement"),
        Type.Literal("locked"),
        Type.Literal("unlocked"),
      ],
      { description: "Group setting to change (for group_settings). Valid values: announcement (only admins send), not_announcement (all members send), locked (only admins edit info), unlocked (all members edit info)" },
    ),
  ),
  status_text: Type.Optional(
    Type.String({ description: "Profile status text (for profile_status)" }),
  ),
  _confirmed: Type.Optional(
    Type.Boolean({
      description:
        "Set to true when re-calling a destructive action after user approval. " +
        "When a gated action returns requiresConfirmation, present the action to the user, " +
        "and after they approve, call the same action again with _confirmed: true.",
    }),
  ),
});

// ---------------------------------------------------------------------------
// Descriptor + factory wrapper
// ---------------------------------------------------------------------------

const whatsappDescriptor: PlatformActionDescriptor = {
  name: "whatsapp_action",
  label: "WhatsApp Actions",
  description:
    "Perform WhatsApp-specific actions: get group info, update group subject/description, add/remove/promote/demote participants, change group settings, get invite code, update profile status, leave group. JIDs must include @g.us (groups) or @s.whatsapp.net (users).",
  parameters: WhatsAppActionParams,
  rpcMethod: "whatsapp.action",
  gatedActions: [
    { action: "group_participants_remove", gateKey: "whatsapp.group_participants_remove", hint: "Ask the user to confirm this participant removal, then call again with _confirmed: true." },
    { action: "group_promote", gateKey: "whatsapp.group_promote", hint: "Ask the user to confirm this participant promotion, then call again with _confirmed: true." },
    { action: "group_leave", gateKey: "whatsapp.group_leave", hint: "Ask the user to confirm leaving this group, then call again with _confirmed: true." },
  ],
};

/**
 * Create a WhatsApp action tool with 11 actions.
 *
 * Destructive actions (group_participants_remove, group_promote, group_leave)
 * are gated via createActionGate and return requiresConfirmation:true when
 * the action is classified as destructive.
 *
 * @param rpcCall - RPC call function for delegating to the WhatsApp backend
 * @returns AgentTool implementing the WhatsApp actions interface
 */
export function createWhatsAppActionTool(rpcCall: RpcCall) {
  return createPlatformActionTool(whatsappDescriptor, rpcCall);
}
