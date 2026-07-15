// SPDX-License-Identifier: Apache-2.0
import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { RpcClient } from "../api/rpc-client.js";
import type { EventDispatcher } from "../state/event-dispatcher.js";
import type { ConnectionStatus, FetchedMessage, PlatformCapabilities } from "../api/types/index.js";
import { sharedStyles, focusStyles } from "../styles/shared.js";
import { IcToast } from "../components/feedback/ic-toast.js";

// Side-effect registrations for sub-components
import "../components/nav/ic-breadcrumb.js";
import "../components/feedback/ic-loading.js";
import "../components/feedback/ic-empty-state.js";
import "../components/feedback/ic-confirm-dialog.js";
import "../components/data/ic-relative-time.js";
import "../components/display/ic-platform-icon.js";

type LoadState = "idle" | "loading" | "loaded" | "error";

/** Curated emoji set for the reaction picker (24 common emoji). */
const REACTION_EMOJI = [
  "\u{1F44D}", "\u{1F44E}", "\u{2764}\u{FE0F}", "\u{1F602}", "\u{1F622}", "\u{1F914}",
  "\u{1F525}", "\u{1F4AF}", "\u{1F44F}", "\u{1F680}", "\u{1F440}", "\u{1F44B}",
  "\u{2705}", "\u{274C}", "\u{2B50}", "\u{1F389}", "\u{1F64F}", "\u{1F4AA}",
  "\u{1F9E0}", "\u{1F4A1}", "\u{1F451}", "\u{1F48E}", "\u{2728}", "\u{1F308}",
];

/** Minimal channel list entry from channels.list RPC. */
interface ChannelListEntry {
  channelType: string;
  channelId?: string;
  status: string;
}

interface MessageActionContext {
  revision: number;
  rpcClient: RpcClient;
  channel: string;
  chatId: string;
}

/** Attachment type options for message.attach RPC. */
type AttachmentType = "image" | "file" | "audio" | "video";

/** Platform action definition for the action panels. */
interface PlatformAction {
  action: string;
  label: string;
  needsMessageId?: boolean;
  needsInput?: string;
}

/** Platform action group with grouped actions. */
interface PlatformActionGroup {
  group: string;
  actions: PlatformAction[];
}

/** Platform-specific action panels grouped by platform. */
const PLATFORM_ACTIONS: Record<string, PlatformActionGroup[]> = {
  discord: [
    { group: "Messages", actions: [
      { action: "pin", label: "Pin Message", needsMessageId: true },
      { action: "unpin", label: "Unpin Message", needsMessageId: true },
    ]},
    { group: "Moderation", actions: [
      { action: "kick", label: "Kick User", needsInput: "userId" },
      { action: "ban", label: "Ban User", needsInput: "userId" },
      { action: "unban", label: "Unban User", needsInput: "userId" },
    ]},
    { group: "Channel", actions: [
      { action: "set_topic", label: "Set Topic", needsInput: "topic" },
      { action: "set_slowmode", label: "Set Slowmode", needsInput: "seconds" },
      { action: "sendTyping", label: "Send Typing Indicator" },
    ]},
    { group: "Threads", actions: [
      { action: "threadCreate", label: "Create Thread", needsInput: "name" },
      { action: "threadList", label: "List Threads" },
    ]},
    { group: "Info", actions: [
      { action: "guild_info", label: "Guild Info" },
      { action: "channel_info", label: "Channel Info" },
    ]},
  ],
  telegram: [
    { group: "Messages", actions: [
      { action: "pin", label: "Pin Message", needsMessageId: true },
      { action: "unpin", label: "Unpin Message", needsMessageId: true },
    ]},
    { group: "Moderation", actions: [
      { action: "ban", label: "Ban User", needsInput: "userId" },
      { action: "unban", label: "Unban User", needsInput: "userId" },
      { action: "restrict", label: "Restrict User", needsInput: "userId" },
      { action: "promote", label: "Promote User", needsInput: "userId" },
      { action: "demote", label: "Demote User", needsInput: "userId" },
    ]},
    { group: "Chat", actions: [
      { action: "set_title", label: "Set Chat Title", needsInput: "title" },
      { action: "set_description", label: "Set Description", needsInput: "description" },
      { action: "sendTyping", label: "Send Typing Indicator" },
    ]},
    { group: "Info", actions: [
      { action: "chat_info", label: "Chat Info" },
      { action: "member_count", label: "Member Count" },
      { action: "get_admins", label: "Get Admins" },
    ]},
  ],
  slack: [
    { group: "Messages", actions: [
      { action: "pin", label: "Pin Message", needsMessageId: true },
      { action: "unpin", label: "Unpin Message", needsMessageId: true },
    ]},
    { group: "Channel", actions: [
      { action: "set_topic", label: "Set Topic", needsInput: "topic" },
      { action: "set_purpose", label: "Set Purpose", needsInput: "purpose" },
      { action: "archive", label: "Archive Channel" },
      { action: "unarchive", label: "Unarchive Channel" },
      { action: "sendTyping", label: "Send Typing Indicator" },
    ]},
    { group: "Members", actions: [
      { action: "invite", label: "Invite User", needsInput: "userId" },
      { action: "kick", label: "Kick User", needsInput: "userId" },
      { action: "members_list", label: "List Members" },
    ]},
    { group: "Info", actions: [
      { action: "channel_info", label: "Channel Info" },
      { action: "bookmark_add", label: "Add Bookmark", needsInput: "url" },
    ]},
  ],
  whatsapp: [
    { group: "Group", actions: [
      { action: "group_info", label: "Group Info" },
      { action: "group_update_subject", label: "Update Subject", needsInput: "subject" },
      { action: "group_update_description", label: "Update Description", needsInput: "description" },
      { action: "group_invite_code", label: "Get Invite Code" },
    ]},
    { group: "Members", actions: [
      { action: "group_participants_add", label: "Add Participant", needsInput: "participant" },
      { action: "group_participants_remove", label: "Remove Participant", needsInput: "participant" },
      { action: "group_promote", label: "Promote to Admin", needsInput: "participant" },
      { action: "group_demote", label: "Demote from Admin", needsInput: "participant" },
    ]},
    { group: "Settings", actions: [
      { action: "group_settings", label: "Group Settings" },
    ]},
  ],
};

/** Map platform to its RPC method name for actions. */
const PLATFORM_RPC_METHOD: Record<string, string> = {
  discord: "discord.action",
  telegram: "telegram.action",
  slack: "slack.action",
  whatsapp: "whatsapp.action",
};

/**
 * Message center view for the Comis operator console.
 *
 * Displays a channel selector, message list (for platforms supporting fetchHistory),
 * and a send form with operator attribution confirmation dialog.
 *
 * Accessed via `#/messages/:type` route.
 *
 * @fires navigate - Dispatched when breadcrumb or channel selector navigation is triggered
 */
@customElement("ic-message-center")
export class IcMessageCenter extends LitElement {
  static override styles = [
    sharedStyles,
    focusStyles,
    css`
      :host { display: block; }
      .message-center { display: flex; flex-direction: column; gap: var(--ic-space-md, 1rem); }
      /* Header */
      .header-row { display: flex; align-items: center; justify-content: space-between; gap: var(--ic-space-md, 1rem); flex-wrap: wrap; }
      .header-left { display: flex; align-items: center; gap: var(--ic-space-sm, 0.5rem); }
      .page-title { font-size: 1.5rem; font-weight: 700; margin: 0; }
      /* Channel selector */
      .channel-selector { display: flex; align-items: center; gap: var(--ic-space-sm, 0.5rem); }
      .channel-selector label { font-size: var(--ic-text-sm, 0.875rem); color: var(--ic-text-muted, #9ca3af); }
      .channel-select { padding: 0.375rem 0.5rem; background: var(--ic-surface-2, #1f2937); border: 1px solid var(--ic-border, #374151); border-radius: var(--ic-radius-md, 0.5rem); color: var(--ic-text, #f3f4f6); font-size: var(--ic-text-sm, 0.875rem); outline: none; cursor: pointer; }
      .channel-select:focus { border-color: var(--ic-accent, #3b82f6); }
      /* Section card */
      .section { background: var(--ic-surface, #111827); border: 1px solid var(--ic-border, #374151); border-radius: var(--ic-radius-md, 0.5rem); padding: var(--ic-space-md, 1rem); }
      .section-title { font-size: var(--ic-text-sm, 0.875rem); font-weight: 600; color: var(--ic-text-muted, #9ca3af); margin: 0 0 var(--ic-space-sm, 0.5rem) 0; }
      /* Message list */
      .message-list { overflow-y: auto; max-height: 60vh; display: flex; flex-direction: column; gap: 2px; }
      .msg-row { display: flex; align-items: baseline; gap: var(--ic-space-sm, 0.5rem); padding: var(--ic-space-xs, 0.25rem) var(--ic-space-sm, 0.5rem); border-radius: var(--ic-radius-sm, 0.25rem); font-size: var(--ic-text-sm, 0.875rem); }
      .msg-row:nth-child(odd) { background: var(--ic-surface-2, #1f2937); }
      .msg-row:nth-child(even) { background: transparent; }
      .msg-sender { color: var(--ic-text-dim, #6b7280); font-size: var(--ic-text-xs, 0.75rem); flex-shrink: 0; min-width: 6rem; max-width: 10rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .msg-text { flex: 1; min-width: 0; color: var(--ic-text, #f3f4f6); word-break: break-word; }
      .msg-time { flex-shrink: 0; font-size: var(--ic-text-xs, 0.75rem); color: var(--ic-text-dim, #6b7280); }
      /* Send form */
      .send-form { display: flex; gap: var(--ic-space-sm, 0.5rem); align-items: flex-end; }
      .send-input { flex: 1; padding: 0.625rem 0.75rem; background: var(--ic-surface-2, #1f2937); border: 1px solid var(--ic-border, #374151); border-radius: var(--ic-radius-md, 0.5rem); color: var(--ic-text, #f3f4f6); font-size: var(--ic-text-sm, 0.875rem); outline: none; resize: vertical; min-height: 2.5rem; max-height: 8rem; font-family: inherit; }
      .send-input:focus { border-color: var(--ic-accent, #3b82f6); }
      .send-input::placeholder { color: var(--ic-text-dim, #6b7280); }
      .btn { padding: 0.5rem 1rem; font-size: var(--ic-text-sm, 0.875rem); font-weight: 500; border-radius: var(--ic-radius-md, 0.5rem); border: 1px solid transparent; cursor: pointer; transition: background var(--ic-transition, 150ms); }
      .btn:disabled { opacity: 0.5; cursor: not-allowed; }
      .btn-primary { background: var(--ic-accent, #3b82f6); color: white; }
      .btn-primary:hover:not(:disabled) { background: var(--ic-accent-hover, #2563eb); }
      /* Message action buttons (hover-visible) */
      .msg-actions { display: none; gap: 4px; align-items: center; flex-shrink: 0; }
      .msg-row:hover .msg-actions { display: flex; }
      .msg-action-btn { padding: 2px 6px; font-size: var(--ic-text-xs, 0.75rem); background: transparent; border: 1px solid var(--ic-border, #374151); border-radius: var(--ic-radius-sm, 0.25rem); color: var(--ic-text-dim, #6b7280); cursor: pointer; white-space: nowrap; transition: background var(--ic-transition, 150ms), color var(--ic-transition, 150ms); }
      .msg-action-btn:hover { background: var(--ic-surface-raised, #1e293b); color: var(--ic-text, #f3f4f6); }
      /* Inline reply / edit forms */
      .inline-form { background: var(--ic-surface-raised, #1e293b); border-radius: var(--ic-radius-sm, 0.25rem); padding: var(--ic-space-sm, 0.5rem); margin: 2px var(--ic-space-sm, 0.5rem); }
      .inline-form-label { font-size: var(--ic-text-xs, 0.75rem); color: var(--ic-text-muted, #9ca3af); margin-bottom: 4px; display: flex; align-items: center; gap: var(--ic-space-sm, 0.5rem); }
      .inline-form-cancel { background: none; border: none; color: var(--ic-text-dim, #6b7280); cursor: pointer; font-size: var(--ic-text-xs, 0.75rem); padding: 0 2px; }
      .inline-form-cancel:hover { color: var(--ic-text, #f3f4f6); }
      .inline-form-row { display: flex; gap: var(--ic-space-sm, 0.5rem); align-items: flex-end; }
      .inline-form-input { flex: 1; padding: 0.375rem 0.5rem; background: var(--ic-surface-2, #1f2937); border: 1px solid var(--ic-border, #374151); border-radius: var(--ic-radius-sm, 0.25rem); color: var(--ic-text, #f3f4f6); font-size: var(--ic-text-sm, 0.875rem); font-family: inherit; outline: none; resize: vertical; min-height: 2rem; max-height: 6rem; }
      .inline-form-input:focus { border-color: var(--ic-accent, #3b82f6); }
      .btn-sm { padding: 0.25rem 0.5rem; font-size: var(--ic-text-xs, 0.75rem); font-weight: 500; border-radius: var(--ic-radius-sm, 0.25rem); border: 1px solid transparent; cursor: pointer; transition: background var(--ic-transition, 150ms); }
      .btn-sm:disabled { opacity: 0.5; cursor: not-allowed; }
      .btn-sm-primary { background: var(--ic-accent, #3b82f6); color: white; }
      .btn-sm-primary:hover:not(:disabled) { background: var(--ic-accent-hover, #2563eb); }
      .btn-sm-ghost { background: transparent; border-color: var(--ic-border, #374151); color: var(--ic-text-muted, #9ca3af); }
      .btn-sm-ghost:hover:not(:disabled) { background: var(--ic-surface-2, #1f2937); color: var(--ic-text, #f3f4f6); }
      /* Danger action button variant */
      .msg-action-btn--danger:hover { color: var(--ic-error, #f87171); border-color: var(--ic-error, #f87171); background: transparent; }
      /* Emoji picker floating panel */
      .emoji-picker-anchor { position: relative; }
      .emoji-picker { position: absolute; top: 100%; right: 0; z-index: 100; background: var(--ic-surface, #111827); border: 1px solid var(--ic-border, #374151); border-radius: var(--ic-radius-md, 0.5rem); box-shadow: var(--ic-shadow-lg, 0 10px 15px rgba(0,0,0,0.25)); padding: var(--ic-space-sm, 0.5rem); display: grid; grid-template-columns: repeat(6, 1fr); gap: 2px; width: max-content; min-width: 12rem; }
      .emoji-btn { font-size: 1.25rem; padding: 4px; cursor: pointer; border: none; background: none; border-radius: var(--ic-radius-sm, 0.25rem); line-height: 1; text-align: center; }
      .emoji-btn:hover { background: var(--ic-surface-raised, #1e293b); }
      /* Selected message highlight */
      .msg-row--selected { border-left: 3px solid var(--ic-accent, #3b82f6); cursor: pointer; }
      .msg-row:not(.msg-row--selected) { cursor: pointer; border-left: 3px solid transparent; }
      /* Attachment form */
      .attach-form { display: flex; flex-direction: column; gap: var(--ic-space-sm, 0.5rem); padding: var(--ic-space-sm, 0.5rem); background: var(--ic-surface-raised, #1e293b); border-radius: var(--ic-radius-sm, 0.25rem); margin-top: var(--ic-space-xs, 0.25rem); }
      .attach-form-row { display: flex; gap: var(--ic-space-sm, 0.5rem); align-items: center; flex-wrap: wrap; }
      .attach-input { flex: 1; min-width: 12rem; padding: 0.375rem 0.5rem; background: var(--ic-surface-2, #1f2937); border: 1px solid var(--ic-border, #374151); border-radius: var(--ic-radius-sm, 0.25rem); color: var(--ic-text, #f3f4f6); font-size: var(--ic-text-sm, 0.875rem); font-family: inherit; outline: none; }
      .attach-input:focus { border-color: var(--ic-accent, #3b82f6); }
      .attach-select { padding: 0.375rem 0.5rem; background: var(--ic-surface-2, #1f2937); border: 1px solid var(--ic-border, #374151); border-radius: var(--ic-radius-sm, 0.25rem); color: var(--ic-text, #f3f4f6); font-size: var(--ic-text-sm, 0.875rem); outline: none; cursor: pointer; }
      .attach-select:focus { border-color: var(--ic-accent, #3b82f6); }
      /* Platform actions */
      .platform-actions { background: var(--ic-surface, #111827); border: 1px solid var(--ic-border, #374151); border-radius: var(--ic-radius-md, 0.5rem); padding: var(--ic-space-md, 1rem); }
      .platform-actions-title { display: flex; align-items: center; gap: var(--ic-space-sm, 0.5rem); font-size: 1rem; font-weight: 600; color: var(--ic-text, #f3f4f6); margin: 0 0 var(--ic-space-md, 1rem) 0; }
      .action-group-header { font-weight: 600; font-size: var(--ic-text-sm, 0.875rem); color: var(--ic-text-muted, #9ca3af); margin-top: var(--ic-space-md, 1rem); margin-bottom: var(--ic-space-xs, 0.25rem); }
      .action-group-header:first-of-type { margin-top: 0; }
      .action-buttons { display: flex; flex-wrap: wrap; gap: var(--ic-space-xs, 0.25rem); align-items: center; }
      .action-input { padding: 0.25rem 0.5rem; background: var(--ic-surface-2, #1f2937); border: 1px solid var(--ic-border, #374151); border-radius: var(--ic-radius-sm, 0.25rem); color: var(--ic-text, #f3f4f6); font-size: var(--ic-text-xs, 0.75rem); outline: none; width: 8rem; }
      .action-input:focus { border-color: var(--ic-accent, #3b82f6); }
      .action-input::placeholder { color: var(--ic-text-dim, #6b7280); }
      .action-result { margin-top: var(--ic-space-sm, 0.5rem); padding: var(--ic-space-sm, 0.5rem); background: var(--ic-surface-2, #1f2937); border: 1px solid var(--ic-border, #374151); border-radius: var(--ic-radius-sm, 0.25rem); font-size: var(--ic-text-xs, 0.75rem); color: var(--ic-text-muted, #9ca3af); max-height: 8rem; overflow-y: auto; white-space: pre-wrap; word-break: break-word; }
      /* Error retry */
      .error-container { text-align: center; padding: var(--ic-space-lg, 1.5rem); }
      .error-text { color: var(--ic-error, #f87171); margin-bottom: var(--ic-space-sm, 0.5rem); }
      .retry-btn { padding: 0.375rem 0.75rem; background: var(--ic-surface-2, #1f2937); border: 1px solid var(--ic-border, #374151); border-radius: var(--ic-radius-md, 0.5rem); color: var(--ic-text, #f3f4f6); cursor: pointer; font-size: var(--ic-text-sm, 0.875rem); }
      .retry-btn:hover { background: var(--ic-border, #374151); }
    `,
  ];

  // -------------------------------------------------------------------------
  // Properties (set by parent app.ts)
  // -------------------------------------------------------------------------

  @property({ attribute: false }) rpcClient: RpcClient | null = null;
  @property({ attribute: false }) eventDispatcher: EventDispatcher | null = null;
  @property() channelType = "";

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  @state() private _loadState: LoadState = "idle";
  @state() private _error = "";
  @state() private _messages: FetchedMessage[] = [];
  @state() private _messagesAreActionable = false;
  /** Effective channel type - equals channelType when set, or auto-selected first running channel. */
  @state() private _effectiveChannel = "";
  @state() private _channelIsRunning = false;
  @state() private _capabilities: PlatformCapabilities | null = null;
  @state() private _channelList: ChannelListEntry[] = [];
  @state() private _sendText = "";
  @state() private _showSendConfirm = false;
  @state() private _actionPending = false;
  @state() private _botName = "";

  // Reply state
  @state() private _replyToId = "";
  @state() private _replyText = "";
  @state() private _showReplyConfirm = false;

  // Edit state
  @state() private _editingId = "";
  @state() private _editText = "";

  // Delete state
  @state() private _deleteTargetId = "";
  @state() private _showDeleteConfirm = false;

  // React state
  @state() private _reactTargetId = "";
  @state() private _showEmojiPicker = false;

  // Attachment state
  @state() private _attachUrl = "";
  @state() private _attachType: AttachmentType = "file";
  @state() private _attachCaption = "";
  @state() private _showAttachForm = false;

  // Chat picker state
  @state() private _chatList: Array<{ chatId: string; label: string }> = [];
  @state() private _selectedChatId = "";

  // Platform action state
  @state() private _platformActionPending = false;
  @state() private _selectedMessageId = "";
  @state() private _actionResult = "";
  /** Stores input values for platform actions keyed by "group-action" */
  private _actionInputs: Record<string, string> = {};

  private _hasLoaded = false;
  private _channelRevision = 0;
  private _messageRequestRevision = 0;
  private _actionContextRevision = 0;
  private _rpcStatusUnsub: (() => void) | null = null;
  private _rpcStatusClient: RpcClient | null = null;

  private get _mutationPending(): boolean {
    return this._actionPending || this._platformActionPending;
  }

  /** Bound click-outside handler for emoji picker. */
  private _boundEmojiOutsideClick: ((e: MouseEvent) => void) | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    if (this.hasUpdated) this._bindRpcStatus();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this._rpcStatusUnsub?.();
    this._rpcStatusUnsub = null;
    this._rpcStatusClient = null;
    this._channelRevision += 1;
    this._resetChannelState();
  }

  override willUpdate(changedProperties: Map<string, unknown>): void {
    if (
      changedProperties.has("channelType")
      || (
        changedProperties.has("rpcClient")
        && changedProperties.get("rpcClient") !== null
        && changedProperties.get("rpcClient") !== undefined
      )
    ) {
      this._channelRevision += 1;
      this._resetChannelState();
    }
  }

  private _resetChannelState(): void {
    this._effectiveChannel = this.channelType;
    this._loadState = "idle";
    this._error = "";
    this._messages = [];
    this._messagesAreActionable = false;
    this._channelIsRunning = false;
    this._channelList = [];
    this._capabilities = null;
    this._botName = "";
    this._invalidateActionContext();
    this._chatList = [];
    this._selectedChatId = "";
    this._hasLoaded = false;
    this._autoSelectAttempted = false;
    this._messageRequestRevision += 1;
  }

  private _invalidateActionContext(): void {
    this._actionContextRevision += 1;
    this._actionPending = false;
    this._platformActionPending = false;
    this._sendText = "";
    this._showSendConfirm = false;
    this._replyToId = "";
    this._replyText = "";
    this._showReplyConfirm = false;
    this._editingId = "";
    this._editText = "";
    this._deleteTargetId = "";
    this._showDeleteConfirm = false;
    this._reactTargetId = "";
    this._showEmojiPicker = false;
    this._removeEmojiOutsideListener();
    this._attachUrl = "";
    this._attachType = "file";
    this._attachCaption = "";
    this._showAttachForm = false;
    this._selectedMessageId = "";
    this._actionResult = "";
    this._actionInputs = {};
  }

  private _captureActionContext(): MessageActionContext | null {
    if (!this.rpcClient || !this._effectiveChannel) return null;
    return {
      revision: this._actionContextRevision,
      rpcClient: this.rpcClient,
      channel: this._effectiveChannel,
      chatId: this._selectedChatId || this._effectiveChannel,
    };
  }

  private _isCurrentActionContext(context: MessageActionContext): boolean {
    return this.isConnected
      && context.revision === this._actionContextRevision
      && context.rpcClient === this.rpcClient
      && context.channel === this._effectiveChannel
      && context.chatId === (this._selectedChatId || this._effectiveChannel);
  }

  override updated(changedProperties: Map<string, unknown>): void {
    const rpcChanged = changedProperties.has("rpcClient");
    const channelChanged = changedProperties.has("channelType");
    if (rpcChanged) this._bindRpcStatus();
    if (!rpcChanged && channelChanged && this.rpcClient?.status === "connected") {
      this._loadCurrentRoute();
    }
  }

  private _autoSelectAttempted = false;

  private _bindRpcStatus(): void {
    const rpc = this.rpcClient;
    if (this.isConnected && rpc === this._rpcStatusClient && this._rpcStatusUnsub) return;
    this._rpcStatusUnsub?.();
    this._rpcStatusUnsub = null;
    this._rpcStatusClient = null;
    if (!rpc || !this.isConnected) return;

    this._rpcStatusClient = rpc;
    this._rpcStatusUnsub = rpc.onStatusChange((status) => {
      this._applyRpcStatus(status, rpc, true);
    });
    this._applyRpcStatus(rpc.status, rpc, false);
  }

  private _applyRpcStatus(status: ConnectionStatus, rpc: RpcClient, reset: boolean): void {
    if (rpc !== this.rpcClient || !this.isConnected) return;
    if (reset) {
      this._channelRevision += 1;
      this._resetChannelState();
    }
    if (status === "connected") {
      this._loadCurrentRoute();
    } else if (status === "disconnected") {
      this._loadState = "error";
      this._error = "RPC connection failed";
    } else {
      this._loadState = "loading";
    }
  }

  private _loadCurrentRoute(): void {
    if (!this.rpcClient || this.rpcClient.status !== "connected" || this._hasLoaded) return;
    if (this._effectiveChannel) {
      void this._loadData();
      return;
    }
    if (this._autoSelectAttempted) return;
    this._autoSelectAttempted = true;
    void this._autoSelectChannel();
  }

  private async _autoSelectChannel(): Promise<void> {
    if (!this.rpcClient || this.rpcClient.status !== "connected") return;
    const revision = this._channelRevision;
    const rpc = this.rpcClient;

    try {
      const result = await rpc.call<{ channels: ChannelListEntry[]; total: number }>("channels.list");
      if (!this._isCurrentAutoSelect(revision, rpc)) return;
      const channels = result?.channels ?? [];
      this._channelList = channels;
      const running = channels.filter((ch) => ch.status === "running");
      if (running.length > 0) {
        this._effectiveChannel = running[0].channelType;
        this._channelIsRunning = true;
        void this._loadData();
      } else {
        this._channelIsRunning = false;
        this._loadState = "loaded";
        this._hasLoaded = true;
      }
    } catch {
      if (!this._isCurrentAutoSelect(revision, rpc)) return;
      this._loadState = "error";
      this._error = "Failed to load channel list";
    }
  }

  private _isCurrentAutoSelect(revision: number, rpcClient: RpcClient): boolean {
    return this.isConnected
      && revision === this._channelRevision
      && !this.channelType
      && rpcClient.status === "connected"
      && rpcClient === this.rpcClient;
  }

  // -------------------------------------------------------------------------
  // Data loading
  // -------------------------------------------------------------------------

  private async _loadData(): Promise<void> {
    const channel = this._effectiveChannel;
    if (!this.rpcClient || this.rpcClient.status !== "connected" || !channel) return;
    const revision = this._channelRevision;

    this._loadState = "loading";
    this._error = "";

    try {
      // Load channel list, capabilities, and channel config in parallel
      // (rpcClient guarded above at the function entry)
      const rpc = this.rpcClient;
      const [listResult, capResult, configResult] = await Promise.allSettled([
        rpc.call<{ channels: Array<{ channelType: string; channelId?: string; status: string }>; total: number }>("channels.list").then((r) => r?.channels ?? []),
        rpc.call<{ channelType: string; features: PlatformCapabilities }>("channels.capabilities", { channel_type: channel }).then((r) => r?.features ?? null),
        rpc.call<Record<string, unknown>>("channels.get", { channel_type: channel }).then((r) => r ?? null),
      ]);
      if (!this._isCurrentChannel(revision, channel)) return;

      // Channel list
      if (listResult.status === "fulfilled") {
        this._channelList = listResult.value;
        this._channelIsRunning = listResult.value.some(
          (entry) => entry.channelType === channel && entry.status === "running",
        );
      } else {
        this._channelList = [];
        this._channelIsRunning = false;
        this._loadState = "error";
        this._error = "Failed to load channel list";
        this._hasLoaded = false;
        return;
      }

      if (!this._channelIsRunning) {
        this._loadState = "loaded";
        this._hasLoaded = true;
        return;
      }

      // Capabilities
      if (capResult.status === "fulfilled" && capResult.value) {
        this._capabilities = capResult.value;
      }

      // Bot name from channel config
      if (configResult.status === "fulfilled" && configResult.value) {
        this._botName = (configResult.value.botName as string)
          ?? (configResult.value.name as string)
          ?? channel;
      }

      // Load chat IDs from session data for the chat picker
      await this._loadChats(revision, channel);
      if (!this._isCurrentChannel(revision, channel)) return;

      // Fetch messages - uses session history fallback for non-fetchHistory platforms
      await this._refetchMessages(revision, channel);
      if (!this._isCurrentChannel(revision, channel)) return;

      this._loadState = "loaded";
      this._hasLoaded = true;
    } catch (err) {
      if (!this._isCurrentChannel(revision, channel)) return;
      this._loadState = "error";
      this._error = err instanceof Error ? err.message : "Failed to load message center data";
      this._hasLoaded = false;
    }
  }

  private _handleRetry(): void {
    if (!this.rpcClient || this.rpcClient.status !== "connected") return;
    this._channelRevision += 1;
    this._resetChannelState();
    this._loadCurrentRoute();
  }

  private _isCurrentChannel(revision: number, channel: string): boolean {
    return this.isConnected
      && revision === this._channelRevision
      && channel === this._effectiveChannel;
  }

  // -------------------------------------------------------------------------
  // Chat picker data
  // -------------------------------------------------------------------------

  /**
   * Load available chat IDs for the current channel type from obs.channels.all
   * (channel activity tracker) which tracks actual chat IDs the bot has interacted with.
   */
  private async _loadChats(
    revision = this._channelRevision,
    channel = this._effectiveChannel,
  ): Promise<void> {
    if (!this.rpcClient || !channel) return;

    try {
      const obsResult = await this.rpcClient.call<{ channels: Array<{ channelId: string; channelType: string; messagesSent: number; messagesReceived: number; lastActiveAt: number }> }>("obs.channels.all");
      if (!this._isCurrentChannel(revision, channel)) return;
      const channels = obsResult?.channels ?? [];
      const chatMap = new Map<string, string>(); // chatId -> label

      // Filter for the current channel type and extract chat IDs
      for (const ch of channels) {
        if (ch.channelType !== channel) continue;
        if (!ch.channelId || ch.channelId === "unknown") continue;
        const msgs = ch.messagesSent + ch.messagesReceived;
        chatMap.set(ch.channelId, `${ch.channelId} (${msgs} msgs)`);
      }

      // Build deduplicated chat list sorted by most recent
      this._chatList = Array.from(chatMap.entries()).map(([chatId, label]) => ({
        chatId,
        label,
      }));

      // Auto-select first chat if none selected
      if (this._chatList.length > 0 && !this._selectedChatId) {
        this._selectedChatId = this._chatList[0].chatId;
      }
    } catch {
      if (!this._isCurrentChannel(revision, channel)) return;
      // Non-fatal -- chat list simply stays empty
    }
  }

  // -------------------------------------------------------------------------
  // Re-fetch messages helper
  // -------------------------------------------------------------------------

  /** Re-fetch message list - uses message.fetch when the platform supports fetchHistory,
   *  otherwise falls back to stored session history via session.list + session.history. */
  private async _refetchMessages(
    revision = this._channelRevision,
    channel = this._effectiveChannel,
  ): Promise<void> {
    const requestRevision = ++this._messageRequestRevision;
    const selectedChatId = this._selectedChatId;
    if (!this.rpcClient || !channel) return;

    // Path 1: Platform supports native fetchHistory - use message.fetch as before
    if (this._capabilities?.fetchHistory) {
      try {
        const fetchResult = await this.rpcClient.call<{ messages: FetchedMessage[]; channelId: string }>("message.fetch", {
          channel_type: channel,
          channel_id: selectedChatId || channel,
          limit: 50,
        });
        if (!this._isCurrentMessageRequest(revision, requestRevision, channel, selectedChatId)) return;
        const messages = fetchResult?.messages ?? [];
        this._messages = messages;
        this._messagesAreActionable = true;
        if (
          this._selectedMessageId
          && !messages.some((message) => message.id === this._selectedMessageId)
        ) {
          this._selectedMessageId = "";
        }
      } catch {
        if (!this._isCurrentMessageRequest(revision, requestRevision, channel, selectedChatId)) return;
        // Non-fatal
      }
      return;
    }

    // Path 2: No fetchHistory - fall back to stored session data
    try {
      const sessionsResult = await this.rpcClient.call<{ sessions: Array<{ sessionKey: string; channelId: string; updatedAt: number }> }>("session.list", { kind: "all" });
      if (!this._isCurrentMessageRequest(revision, requestRevision, channel, selectedChatId)) return;
      const sessions = sessionsResult?.sessions ?? [];
      // Filter to sessions whose channelId matches the currently selected chat
      const chatId = selectedChatId;
      const matching = chatId
        ? sessions.filter((s) => s.channelId === chatId)
        : [];

      if (matching.length === 0) {
        this._messages = [];
        this._messagesAreActionable = false;
        this._selectedMessageId = "";
        return;
      }

      // Pick most recently updated session
      matching.sort((a, b) => b.updatedAt - a.updatedAt);
      const bestSession = matching[0]!;

      // Fetch conversation history from session store
      const histResult = await this.rpcClient.call<{ messages: Array<{ role: string; content: string; timestamp: number }>; total: number }>("session.history", {
        session_key: bestSession.sessionKey,
        limit: 50,
      });
      if (!this._isCurrentMessageRequest(revision, requestRevision, channel, selectedChatId)) return;
      const histMessages = histResult?.messages ?? [];

      // Map session history messages to FetchedMessage shape
      this._messages = histMessages.map((msg, idx) => ({
        id: `stored-${idx}`,
        senderId: msg.role,
        text: msg.content,
        timestamp: msg.timestamp,
      } as FetchedMessage));
      this._messagesAreActionable = false;
      this._selectedMessageId = "";
    } catch {
      if (!this._isCurrentMessageRequest(revision, requestRevision, channel, selectedChatId)) return;
      // Non-fatal - leave messages empty
      this._messages = [];
      this._messagesAreActionable = false;
      this._selectedMessageId = "";
    }
  }

  private _isCurrentMessageRequest(
    channelRevision: number,
    requestRevision: number,
    channel: string,
    selectedChatId: string,
  ): boolean {
    return this._isCurrentChannel(channelRevision, channel)
      && requestRevision === this._messageRequestRevision
      && selectedChatId === this._selectedChatId;
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  private _handleChannelChange(e: Event): void {
    if (this._mutationPending) return;
    const select = e.target as HTMLSelectElement;
    const newType = select.value;
    if (newType && newType !== this._effectiveChannel) {
      this.dispatchEvent(new CustomEvent("navigate", {
        detail: `messages/${newType}`,
        bubbles: false,
        composed: false,
      }));
    }
  }

  private _handleChatChange(e: Event): void {
    if (this._mutationPending) return;
    const select = e.target as HTMLSelectElement;
    const chatId = select.value;
    if (chatId === this._selectedChatId) return;
    this._invalidateActionContext();
    this._selectedChatId = chatId;
    this._messages = [];
    void this._refetchMessages();
  }

  private _handleSendClick(): void {
    if (this._mutationPending || !this._sendText.trim()) return;
    this._showSendConfirm = true;
  }

  private async _handleSendConfirm(): Promise<void> {
    if (this._mutationPending) return;
    this._showSendConfirm = false;
    const context = this._captureActionContext();
    const text = this._sendText.trim();
    if (!context || !text) return;

    this._actionPending = true;
    try {
      await context.rpcClient.call("message.send", {
        channel_type: context.channel,
        channel_id: context.chatId,
        text,
      });
      if (!this._isCurrentActionContext(context)) return;
      IcToast.show("Message sent", "success");
      this._sendText = "";
      await this._refetchMessages();
    } catch (err) {
      if (!this._isCurrentActionContext(context)) return;
      const msg = err instanceof Error ? err.message : "Failed to send message";
      IcToast.show(msg, "error");
    } finally {
      if (this._isCurrentActionContext(context)) this._actionPending = false;
    }
  }

  private _handleSendCancel(): void {
    this._showSendConfirm = false;
  }

  private _handleKeydown(e: KeyboardEvent): void {
    // Ctrl/Cmd+Enter to send
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      this._handleSendClick();
    }
  }

  // ---- Reply ----

  private _handleReplyClick(messageId: string): void {
    if (this._mutationPending || !this._messagesAreActionable) return;
    this._replyToId = messageId;
    this._replyText = "";
    // Focus the reply input after render
    this.updateComplete.then(() => {
      const input = this.shadowRoot?.querySelector<HTMLTextAreaElement>(".reply-input");
      input?.focus();
    });
  }

  private _handleReplyCancelClick(): void {
    if (this._mutationPending) return;
    this._replyToId = "";
    this._replyText = "";
    this._showReplyConfirm = false;
  }

  private _handleReplySendClick(): void {
    if (this._mutationPending || !this._replyText.trim() || !this._replyToId) return;
    this._showReplyConfirm = true;
  }

  private async _handleReplyConfirm(): Promise<void> {
    if (this._mutationPending || !this._messagesAreActionable) return;
    this._showReplyConfirm = false;
    const context = this._captureActionContext();
    const text = this._replyText.trim();
    const messageId = this._replyToId;
    if (!context || !text || !messageId) return;

    this._actionPending = true;
    try {
      await context.rpcClient.call("message.reply", {
        channel_type: context.channel,
        channel_id: context.chatId,
        text,
        message_id: messageId,
      });
      if (!this._isCurrentActionContext(context)) return;
      IcToast.show("Reply sent", "success");
      this._replyToId = "";
      this._replyText = "";
      await this._refetchMessages();
    } catch (err) {
      if (!this._isCurrentActionContext(context)) return;
      const msg = err instanceof Error ? err.message : "Failed to send reply";
      IcToast.show(msg, "error");
    } finally {
      if (this._isCurrentActionContext(context)) this._actionPending = false;
    }
  }

  private _handleReplyCancel(): void {
    this._showReplyConfirm = false;
  }

  private _handleReplyKeydown(e: KeyboardEvent): void {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      this._handleReplySendClick();
    }
    if (e.key === "Escape") {
      this._handleReplyCancelClick();
    }
  }

  // ---- Edit ----

  private _handleEditClick(msg: FetchedMessage): void {
    if (this._mutationPending || !this._messagesAreActionable) return;
    this._editingId = msg.id;
    this._editText = msg.text;
    // Focus the edit textarea after render
    this.updateComplete.then(() => {
      const ta = this.shadowRoot?.querySelector<HTMLTextAreaElement>(".edit-input");
      ta?.focus();
    });
  }

  private _handleEditCancelClick(): void {
    if (this._mutationPending) return;
    this._editingId = "";
    this._editText = "";
  }

  private async _handleEditSave(): Promise<void> {
    if (this._mutationPending || !this._messagesAreActionable) return;
    const context = this._captureActionContext();
    const text = this._editText.trim();
    const messageId = this._editingId;
    if (!context || !text || !messageId) return;

    this._actionPending = true;
    try {
      await context.rpcClient.call("message.edit", {
        channel_type: context.channel,
        channel_id: context.chatId,
        message_id: messageId,
        text,
      });
      if (!this._isCurrentActionContext(context)) return;
      IcToast.show("Message edited", "success");
      this._editingId = "";
      this._editText = "";
      await this._refetchMessages();
    } catch (err) {
      if (!this._isCurrentActionContext(context)) return;
      const msg = err instanceof Error ? err.message : "Failed to edit message";
      IcToast.show(msg, "error");
    } finally {
      if (this._isCurrentActionContext(context)) this._actionPending = false;
    }
  }

  private _handleEditKeydown(e: KeyboardEvent): void {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void this._handleEditSave();
    }
    if (e.key === "Escape") {
      this._handleEditCancelClick();
    }
  }

  // ---- Delete ----

  private _handleDeleteClick(messageId: string): void {
    if (this._mutationPending || !this._messagesAreActionable) return;
    this._deleteTargetId = messageId;
    this._showDeleteConfirm = true;
  }

  private async _handleDeleteConfirm(): Promise<void> {
    if (this._mutationPending || !this._messagesAreActionable) return;
    this._showDeleteConfirm = false;
    const context = this._captureActionContext();
    const messageId = this._deleteTargetId;
    if (!context || !messageId) return;

    this._actionPending = true;
    try {
      await context.rpcClient.call("message.delete", {
        channel_type: context.channel,
        channel_id: context.chatId,
        message_id: messageId,
      });
      if (!this._isCurrentActionContext(context)) return;
      IcToast.show("Message deleted", "success");
      // Optimistic local removal
      this._messages = this._messages.filter((m) => m.id !== messageId);
      if (this._selectedMessageId === messageId) this._selectedMessageId = "";
      this._deleteTargetId = "";
    } catch (err) {
      if (!this._isCurrentActionContext(context)) return;
      const msg = err instanceof Error ? err.message : "Failed to delete message";
      IcToast.show(msg, "error");
      this._deleteTargetId = "";
      // Re-fetch to restore state on error
      await this._refetchMessages();
    } finally {
      if (this._isCurrentActionContext(context)) this._actionPending = false;
    }
  }

  private _handleDeleteCancel(): void {
    this._showDeleteConfirm = false;
    this._deleteTargetId = "";
  }

  // ---- React ----

  private _handleReactClick(messageId: string): void {
    if (this._mutationPending || !this._messagesAreActionable) return;
    if (this._reactTargetId === messageId && this._showEmojiPicker) {
      // Toggle off if clicking same message
      this._closeEmojiPicker();
      return;
    }
    this._reactTargetId = messageId;
    this._showEmojiPicker = true;
    // Install click-outside handler on next tick
    requestAnimationFrame(() => this._installEmojiOutsideListener());
  }

  private async _handleEmojiSelect(emoji: string): Promise<void> {
    if (this._mutationPending || !this._messagesAreActionable) return;
    const context = this._captureActionContext();
    const messageId = this._reactTargetId;
    if (!context || !messageId) return;

    this._closeEmojiPicker();
    this._actionPending = true;
    try {
      await context.rpcClient.call("message.react", {
        channel_type: context.channel,
        channel_id: context.chatId,
        message_id: messageId,
        emoji,
      });
      if (!this._isCurrentActionContext(context)) return;
      IcToast.show("Reaction added", "success");
    } catch (err) {
      if (!this._isCurrentActionContext(context)) return;
      const msg = err instanceof Error ? err.message : "Failed to add reaction";
      IcToast.show(msg, "error");
    } finally {
      if (this._isCurrentActionContext(context)) {
        this._actionPending = false;
        this._reactTargetId = "";
      }
    }
  }

  private _closeEmojiPicker(): void {
    this._showEmojiPicker = false;
    this._reactTargetId = "";
    this._removeEmojiOutsideListener();
  }

  private _installEmojiOutsideListener(): void {
    this._removeEmojiOutsideListener();
    this._boundEmojiOutsideClick = (e: MouseEvent) => {
      // Check if click is inside the emoji picker (composed path crosses shadow DOM)
      const path = e.composedPath();
      const picker = this.shadowRoot?.querySelector(".emoji-picker");
      const reactBtn = this.shadowRoot?.querySelector(`[data-react-id="${this._reactTargetId}"]`);
      if (picker && !path.includes(picker) && (!reactBtn || !path.includes(reactBtn))) {
        this._closeEmojiPicker();
      }
    };
    document.addEventListener("click", this._boundEmojiOutsideClick, true);
  }

  private _removeEmojiOutsideListener(): void {
    if (this._boundEmojiOutsideClick) {
      document.removeEventListener("click", this._boundEmojiOutsideClick, true);
      this._boundEmojiOutsideClick = null;
    }
  }

  // ---- Attachment ----

  private _toggleAttachForm(): void {
    if (this._mutationPending) return;
    this._showAttachForm = !this._showAttachForm;
    if (!this._showAttachForm) {
      this._attachUrl = "";
      this._attachType = "file";
      this._attachCaption = "";
    }
  }

  private async _handleAttachSend(): Promise<void> {
    if (this._mutationPending) return;
    const context = this._captureActionContext();
    const attachmentUrl = this._attachUrl.trim();
    const attachmentType = this._attachType;
    const caption = this._attachCaption.trim() || undefined;
    if (!context || !attachmentUrl) return;

    this._actionPending = true;
    try {
      await context.rpcClient.call("message.attach", {
        channel_type: context.channel,
        channel_id: context.chatId,
        attachment_url: attachmentUrl,
        attachment_type: attachmentType,
        caption,
      });
      if (!this._isCurrentActionContext(context)) return;
      IcToast.show("Attachment sent", "success");
      this._attachUrl = "";
      this._attachType = "file";
      this._attachCaption = "";
      this._showAttachForm = false;
    } catch (err) {
      if (!this._isCurrentActionContext(context)) return;
      const msg = err instanceof Error ? err.message : "Failed to send attachment";
      IcToast.show(msg, "error");
    } finally {
      if (this._isCurrentActionContext(context)) this._actionPending = false;
    }
  }

  // ---- Message selection ----

  private _handleMessageClick(messageId: string): void {
    if (this._mutationPending || !this._messagesAreActionable) return;
    this._selectedMessageId = this._selectedMessageId === messageId ? "" : messageId;
  }

  // ---- Platform Actions ----

  private _getActionInputKey(group: string, action: string): string {
    return `${group}-${action}`;
  }

  private _handleActionInputChange(key: string, value: string): void {
    this._actionInputs = { ...this._actionInputs, [key]: value };
  }

  private async _handlePlatformAction(platformAction: PlatformAction): Promise<void> {
    if (this._mutationPending) return;
    if (platformAction.needsMessageId && !this._messagesAreActionable) return;
    const context = this._captureActionContext();
    if (!context) return;

    const rpcMethod = PLATFORM_RPC_METHOD[context.channel];
    if (!rpcMethod) return;

    // Build params
    const params: Record<string, unknown> = { action: platformAction.action };

    // Add channel/chat/group identifier based on platform
    if (context.channel === "telegram") {
      params.chat_id = context.chatId;
    } else if (context.channel === "whatsapp") {
      params.group_jid = context.chatId;
    } else {
      params.channel_id = context.chatId;
    }

    // Add message_id if needed
    if (platformAction.needsMessageId && this._selectedMessageId) {
      params.message_id = this._selectedMessageId;
    }

    // Add input value if needed
    if (platformAction.needsInput) {
      const inputKey = this._getActionInputKey("", platformAction.action);
      const value = this._actionInputs[inputKey]?.trim();
      if (value) {
        params[platformAction.needsInput] = value;
      }
    }

    this._platformActionPending = true;
    this._actionResult = "";
    try {
      const result = await context.rpcClient.call(rpcMethod, params);
      if (!this._isCurrentActionContext(context)) return;
      IcToast.show("Action completed", "success");
      this._actionResult = typeof result === "string" ? result : JSON.stringify(result, null, 2);
    } catch (err) {
      if (!this._isCurrentActionContext(context)) return;
      const msg = err instanceof Error ? err.message : "Action failed";
      IcToast.show(msg, "error");
      this._actionResult = "";
    } finally {
      if (this._isCurrentActionContext(context)) this._platformActionPending = false;
    }
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  override render() {
    return html`
      <div class="message-center">
        ${this._renderBreadcrumb()}
        ${this._renderHeader()}
        ${this._renderBody()}
        ${this._renderSendConfirmDialog()}
        ${this._renderReplyConfirmDialog()}
        ${this._renderDeleteConfirmDialog()}
      </div>
    `;
  }

  private _renderBreadcrumb() {
    return html`
      <ic-breadcrumb .items=${[
        { label: "Channels", route: "channels" },
        ...(this._effectiveChannel
          ? [{ label: this._effectiveChannel, route: `channels/${this._effectiveChannel}` }]
          : []),
        { label: "Messages" },
      ]}
        @navigate=${(e: CustomEvent<string>) => {
          this.dispatchEvent(new CustomEvent("navigate", {
            detail: e.detail,
            bubbles: false,
            composed: false,
          }));
        }}
      ></ic-breadcrumb>
    `;
  }

  private _renderHeader() {
    return html`
      <div class="header-row">
        <div class="header-left">
          <h1 class="page-title">Messages</h1>
        </div>
        <div class="channel-selector">
          <label for="channel-select">Channel:</label>
          <select
            id="channel-select"
            class="channel-select"
            .value=${this._effectiveChannel}
            @change=${this._handleChannelChange}
            ?disabled=${this._mutationPending}
          >
            ${this._channelList.length === 0
              ? html`<option value=${this._effectiveChannel}>${this._effectiveChannel}</option>`
              : this._channelList.map(
                  (ch) => html`
                    <option
                      value=${ch.channelType}
                      ?selected=${ch.channelType === this._effectiveChannel}
                      ?disabled=${ch.status !== "running"}
                    >${ch.channelType}</option>
                  `,
                )}
          </select>
        </div>
        <div class="channel-selector">
          <label for="chat-select">Chat:</label>
          <select
            id="chat-select"
            class="channel-select"
            .value=${this._selectedChatId}
            @change=${this._handleChatChange}
            ?disabled=${this._chatList.length === 0 || this._mutationPending}
          >
            ${this._chatList.length === 0
              ? html`<option value="">No chats found</option>`
              : this._chatList.map(
                  (ch) => html`<option value=${ch.chatId} ?selected=${ch.chatId === this._selectedChatId}>${ch.label}</option>`,
                )}
          </select>
        </div>
      </div>
    `;
  }

  private _renderBody() {
    switch (this._loadState) {
      case "idle":
      case "loading":
        return html`<ic-loading></ic-loading>`;
      case "error":
        return html`
          <div class="error-container">
            <div class="error-text">${this._error || "Failed to load"}</div>
            ${this.rpcClient?.status === "connected"
              ? html`<button class="retry-btn" @click=${this._handleRetry}>Retry</button>`
              : nothing}
          </div>
        `;
      case "loaded":
        if (!this._effectiveChannel) {
          return html`
            <ic-empty-state
              message="No running channels"
              description="Start a channel to view and send messages."
            ></ic-empty-state>
          `;
        }
        if (!this._channelIsRunning) {
          return html`
            <ic-empty-state
              message="Channel is not running"
              description="Start this channel to view and send messages."
            ></ic-empty-state>
          `;
        }
        return html`
          ${this._renderMessageList()}
          ${this._renderSendForm()}
          ${this._renderAttachForm()}
          ${this._renderPlatformActions()}
        `;
      default:
        return nothing;
    }
  }

  private _renderMessageList() {
    // No messages fetched
    if (this._messages.length === 0) {
      return html`
        <ic-empty-state
          message="No messages found"
          description="No recent messages in this channel."
        ></ic-empty-state>
      `;
    }

    // Sort by timestamp ascending (oldest first)
    const sorted = [...this._messages].sort((a, b) => a.timestamp - b.timestamp);
    const canReply = this._messagesAreActionable;
    const canEdit = canReply && this._capabilities?.editMessages === true;
    const canDelete = canReply && this._capabilities?.deleteMessages === true;
    const canReact = canReply && this._capabilities?.reactions === true;

    return html`
      <div class="section">
        <div class="section-title">Recent Messages (${sorted.length})</div>
        <div class="message-list">
          ${sorted.map((msg) => html`
            <div class="msg-row ${this._selectedMessageId === msg.id ? "msg-row--selected" : ""}" @click=${() => this._handleMessageClick(msg.id)}>
              <span class="msg-sender" title=${msg.senderId}>${msg.senderId}</span>
              ${this._editingId === msg.id
                ? this._renderEditForm(msg)
                : html`<span class="msg-text">${msg.text}</span>`}
              <span class="msg-time"><ic-relative-time .timestamp=${msg.timestamp}></ic-relative-time></span>
              <span class="msg-actions">
                ${canReply ? html`
                  <button class="msg-action-btn" title="Reply" @click=${() => this._handleReplyClick(msg.id)} ?disabled=${this._mutationPending}>Reply</button>
                ` : nothing}
                ${canEdit ? html`
                  <button class="msg-action-btn" title="Edit" @click=${() => this._handleEditClick(msg)} ?disabled=${this._mutationPending}>Edit</button>
                ` : nothing}
                ${canDelete ? html`
                  <button class="msg-action-btn msg-action-btn--danger" title="Delete" @click=${() => this._handleDeleteClick(msg.id)} ?disabled=${this._mutationPending}>Delete</button>
                ` : nothing}
                ${canReact ? html`
                  <span class="emoji-picker-anchor">
                    <button class="msg-action-btn" title="React" data-react-id=${msg.id} @click=${() => this._handleReactClick(msg.id)} ?disabled=${this._mutationPending}>React</button>
                    ${this._showEmojiPicker && this._reactTargetId === msg.id ? this._renderEmojiPicker() : nothing}
                  </span>
                ` : nothing}
              </span>
            </div>
            ${this._replyToId === msg.id ? this._renderReplyForm(msg) : nothing}
          `)}
        </div>
      </div>
    `;
  }

  private _renderReplyForm(msg: FetchedMessage) {
    return html`
      <div class="inline-form">
        <div class="inline-form-label">
          Replying to ${msg.senderId}
          <button class="inline-form-cancel" title="Cancel reply" @click=${this._handleReplyCancelClick} ?disabled=${this._mutationPending}>X</button>
        </div>
        <div class="inline-form-row">
          <textarea
            class="inline-form-input reply-input"
            placeholder="Type your reply..."
            .value=${this._replyText}
            @input=${(e: InputEvent) => { this._replyText = (e.target as HTMLTextAreaElement).value; }}
            @keydown=${this._handleReplyKeydown}
            ?disabled=${this._mutationPending}
            rows="1"
          ></textarea>
          <button
            class="btn-sm btn-sm-primary"
            @click=${this._handleReplySendClick}
            ?disabled=${this._mutationPending || !this._replyText.trim()}
          >Send Reply</button>
        </div>
      </div>
    `;
  }

  private _renderEditForm(_msg: FetchedMessage) {
    return html`
      <span class="msg-text" style="flex:1;min-width:0;">
        <div class="inline-form" style="margin:0;">
          <div class="inline-form-row">
            <textarea
              class="inline-form-input edit-input"
              .value=${this._editText}
              @input=${(e: InputEvent) => { this._editText = (e.target as HTMLTextAreaElement).value; }}
              @keydown=${this._handleEditKeydown}
              ?disabled=${this._mutationPending}
              rows="1"
            ></textarea>
            <button
              class="btn-sm btn-sm-primary"
              @click=${() => void this._handleEditSave()}
              ?disabled=${this._mutationPending || !this._editText.trim()}
            >Save</button>
            <button
              class="btn-sm btn-sm-ghost"
              @click=${this._handleEditCancelClick}
              ?disabled=${this._mutationPending}
            >Cancel</button>
          </div>
        </div>
      </span>
    `;
  }

  private _renderEmojiPicker() {
    return html`
      <div class="emoji-picker">
        ${REACTION_EMOJI.map((emoji) => html`
          <button class="emoji-btn" title=${emoji} @click=${() => void this._handleEmojiSelect(emoji)} ?disabled=${this._mutationPending}>${emoji}</button>
        `)}
      </div>
    `;
  }

  private _renderSendForm() {
    const attachSupported = this._capabilities?.attachments === true;

    return html`
      <div class="section">
        <div class="section-title">Send Message</div>
        <div class="send-form">
          <textarea
            class="send-input"
            placeholder="Type a message to send as ${this._botName || this._effectiveChannel}..."
            .value=${this._sendText}
            @input=${(e: InputEvent) => { this._sendText = (e.target as HTMLTextAreaElement).value; }}
            @keydown=${this._handleKeydown}
            ?disabled=${this._mutationPending}
            rows="2"
          ></textarea>
          <button
            class="btn btn-primary"
            @click=${this._handleSendClick}
            ?disabled=${this._mutationPending || !this._sendText.trim()}
          >
            ${this._actionPending ? "Sending..." : "Send"}
          </button>
          ${attachSupported
            ? html`
              <button
                class="btn-sm btn-sm-ghost"
                @click=${this._toggleAttachForm}
                ?disabled=${this._mutationPending}
                title="Attach File"
              >
                ${this._showAttachForm ? "Close Attach" : "Attach File"}
              </button>
            `
            : html`
              <button
                class="btn-sm btn-sm-ghost"
                disabled
                title="Attachments not supported on ${this._effectiveChannel}"
              >Attach File</button>
            `}
        </div>
      </div>
    `;
  }

  private _renderAttachForm() {
    if (!this._showAttachForm || this._capabilities?.attachments !== true) return nothing;

    return html`
      <div class="section">
        <div class="section-title">Send Attachment</div>
        <div class="attach-form">
          <div class="attach-form-row">
            <input
              class="attach-input"
              type="text"
              placeholder="File URL or Path"
              .value=${this._attachUrl}
              @input=${(e: InputEvent) => { this._attachUrl = (e.target as HTMLInputElement).value; }}
              ?disabled=${this._mutationPending}
            />
            <select
              class="attach-select"
              .value=${this._attachType}
              @change=${(e: Event) => { this._attachType = (e.target as HTMLSelectElement).value as AttachmentType; }}
              ?disabled=${this._mutationPending}
            >
              <option value="file">File</option>
              <option value="image">Image</option>
              <option value="audio">Audio</option>
              <option value="video">Video</option>
            </select>
          </div>
          <div class="attach-form-row">
            <input
              class="attach-input"
              type="text"
              placeholder="Caption (optional)"
              .value=${this._attachCaption}
              @input=${(e: InputEvent) => { this._attachCaption = (e.target as HTMLInputElement).value; }}
              ?disabled=${this._mutationPending}
            />
            <button
              class="btn-sm btn-sm-primary"
              @click=${() => void this._handleAttachSend()}
              ?disabled=${this._mutationPending || !this._attachUrl.trim()}
            >
              Send Attachment
            </button>
            <button
              class="btn-sm btn-sm-ghost"
              @click=${this._toggleAttachForm}
              ?disabled=${this._mutationPending}
            >Cancel</button>
          </div>
        </div>
      </div>
    `;
  }

  private _renderPlatformActions() {
    const groups = PLATFORM_ACTIONS[this._effectiveChannel];
    if (!groups) return nothing;

    const platformLabel = this._effectiveChannel.charAt(0).toUpperCase() + this._effectiveChannel.slice(1);

    return html`
      <div class="platform-actions">
        <div class="platform-actions-title">
          <ic-platform-icon platform=${this._effectiveChannel}></ic-platform-icon>
          ${platformLabel} Actions
        </div>
        ${groups.map((group) => html`
          <div class="action-group-header">${group.group}</div>
          <div class="action-buttons">
            ${group.actions.map((action) => {
              const inputKey = this._getActionInputKey("", action.action);
              const needsMessageAndMissing = action.needsMessageId
                && (!this._messagesAreActionable || !this._selectedMessageId);
              return html`
                ${action.needsInput ? html`
                  <input
                    class="action-input"
                    type="text"
                    placeholder=${action.needsInput}
                    .value=${this._actionInputs[inputKey] ?? ""}
                    @input=${(e: InputEvent) => this._handleActionInputChange(inputKey, (e.target as HTMLInputElement).value)}
                    ?disabled=${this._mutationPending}
                  />
                ` : nothing}
                <button
                  class="btn-sm btn-sm-ghost"
                  @click=${() => void this._handlePlatformAction(action)}
                  ?disabled=${this._mutationPending || needsMessageAndMissing}
                  title=${needsMessageAndMissing ? "Select a message first" : action.label}
                >
                  ${action.label}
                </button>
              `;
            })}
          </div>
        `)}
        ${this._actionResult ? html`
          <div class="action-result">${this._actionResult}</div>
        ` : nothing}
      </div>
    `;
  }

  private _renderSendConfirmDialog() {
    if (!this._showSendConfirm) return nothing;

    return html`
      <ic-confirm-dialog
        open
        title="Send Message"
        message="This message will be sent as ${this._botName || this._effectiveChannel} on ${this._effectiveChannel}. You are acting as operator."
        confirmLabel="Send"
        @confirm=${this._handleSendConfirm}
        @cancel=${this._handleSendCancel}
      ></ic-confirm-dialog>
    `;
  }

  private _renderReplyConfirmDialog() {
    if (!this._showReplyConfirm) return nothing;

    return html`
      <ic-confirm-dialog
        open
        title="Send Reply"
        message="This reply will be sent as ${this._botName || this._effectiveChannel} on ${this._effectiveChannel}. You are acting as operator."
        confirmLabel="Send Reply"
        @confirm=${this._handleReplyConfirm}
        @cancel=${this._handleReplyCancel}
      ></ic-confirm-dialog>
    `;
  }

  private _renderDeleteConfirmDialog() {
    if (!this._showDeleteConfirm) return nothing;

    return html`
      <ic-confirm-dialog
        open
        title="Delete Message"
        message="This will permanently delete this message from ${this._effectiveChannel}. This cannot be undone."
        variant="danger"
        confirmLabel="Delete"
        @confirm=${this._handleDeleteConfirm}
        @cancel=${this._handleDeleteCancel}
      ></ic-confirm-dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-message-center": IcMessageCenter;
  }
}
