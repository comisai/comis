import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { RpcClient } from "../api/rpc-client.js";
import type { EventDispatcher } from "../state/event-dispatcher.js";
import type { FetchedMessage, PlatformCapabilities } from "../api/types/index.js";
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
      :host {
        display: block;
      }

      .message-center {
        display: flex;
        flex-direction: column;
        gap: var(--ic-space-md, 1rem);
      }

      /* Header */
      .header-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--ic-space-md, 1rem);
        flex-wrap: wrap;
      }

      .header-left {
        display: flex;
        align-items: center;
        gap: var(--ic-space-sm, 0.5rem);
      }

      .page-title {
        font-size: 1.5rem;
        font-weight: 700;
        margin: 0;
      }

      /* Channel selector */
      .channel-selector {
        display: flex;
        align-items: center;
        gap: var(--ic-space-sm, 0.5rem);
      }

      .channel-selector label {
        font-size: var(--ic-text-sm, 0.875rem);
        color: var(--ic-text-muted, #9ca3af);
      }

      .channel-select {
        padding: 0.375rem 0.5rem;
        background: var(--ic-surface-2, #1f2937);
        border: 1px solid var(--ic-border, #374151);
        border-radius: var(--ic-radius-md, 0.5rem);
        color: var(--ic-text, #f3f4f6);
        font-size: var(--ic-text-sm, 0.875rem);
        outline: none;
        cursor: pointer;
      }

      .channel-select:focus {
        border-color: var(--ic-accent, #3b82f6);
      }

      /* Section card */
      .section {
        background: var(--ic-surface, #111827);
        border: 1px solid var(--ic-border, #374151);
        border-radius: var(--ic-radius-md, 0.5rem);
        padding: var(--ic-space-md, 1rem);
      }

      .section-title {
        font-size: var(--ic-text-sm, 0.875rem);
        font-weight: 600;
        color: var(--ic-text-muted, #9ca3af);
        margin: 0 0 var(--ic-space-sm, 0.5rem) 0;
      }

      /* Message list */
      .message-list {
        overflow-y: auto;
        max-height: 60vh;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .msg-row {
        display: flex;
        align-items: baseline;
        gap: var(--ic-space-sm, 0.5rem);
        padding: var(--ic-space-xs, 0.25rem) var(--ic-space-sm, 0.5rem);
        border-radius: var(--ic-radius-sm, 0.25rem);
        font-size: var(--ic-text-sm, 0.875rem);
      }

      .msg-row:nth-child(odd) {
        background: var(--ic-surface-2, #1f2937);
      }

      .msg-row:nth-child(even) {
        background: transparent;
      }

      .msg-sender {
        color: var(--ic-text-dim, #6b7280);
        font-size: var(--ic-text-xs, 0.75rem);
        flex-shrink: 0;
        min-width: 6rem;
        max-width: 10rem;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .msg-text {
        flex: 1;
        min-width: 0;
        color: var(--ic-text, #f3f4f6);
        word-break: break-word;
      }

      .msg-time {
        flex-shrink: 0;
        font-size: var(--ic-text-xs, 0.75rem);
        color: var(--ic-text-dim, #6b7280);
      }

      /* Send form */
      .send-form {
        display: flex;
        gap: var(--ic-space-sm, 0.5rem);
        align-items: flex-end;
      }

      .send-input {
        flex: 1;
        padding: 0.625rem 0.75rem;
        background: var(--ic-surface-2, #1f2937);
        border: 1px solid var(--ic-border, #374151);
        border-radius: var(--ic-radius-md, 0.5rem);
        color: var(--ic-text, #f3f4f6);
        font-size: var(--ic-text-sm, 0.875rem);
        outline: none;
        resize: vertical;
        min-height: 2.5rem;
        max-height: 8rem;
        font-family: inherit;
      }

      .send-input:focus {
        border-color: var(--ic-accent, #3b82f6);
      }

      .send-input::placeholder {
        color: var(--ic-text-dim, #6b7280);
      }

      .btn {
        padding: 0.5rem 1rem;
        font-size: var(--ic-text-sm, 0.875rem);
        font-weight: 500;
        border-radius: var(--ic-radius-md, 0.5rem);
        border: 1px solid transparent;
        cursor: pointer;
        transition: background var(--ic-transition, 150ms);
      }

      .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .btn-primary {
        background: var(--ic-accent, #3b82f6);
        color: white;
      }

      .btn-primary:hover:not(:disabled) {
        background: var(--ic-accent-hover, #2563eb);
      }

      /* Message action buttons (hover-visible) */
      .msg-actions {
        display: none;
        gap: 4px;
        align-items: center;
        flex-shrink: 0;
      }

      .msg-row:hover .msg-actions {
        display: flex;
      }

      .msg-action-btn {
        padding: 2px 6px;
        font-size: var(--ic-text-xs, 0.75rem);
        background: transparent;
        border: 1px solid var(--ic-border, #374151);
        border-radius: var(--ic-radius-sm, 0.25rem);
        color: var(--ic-text-dim, #6b7280);
        cursor: pointer;
        white-space: nowrap;
        transition: background var(--ic-transition, 150ms), color var(--ic-transition, 150ms);
      }

      .msg-action-btn:hover {
        background: var(--ic-surface-raised, #1e293b);
        color: var(--ic-text, #f3f4f6);
      }

      /* Inline reply / edit forms */
      .inline-form {
        background: var(--ic-surface-raised, #1e293b);
        border-radius: var(--ic-radius-sm, 0.25rem);
        padding: var(--ic-space-sm, 0.5rem);
        margin: 2px var(--ic-space-sm, 0.5rem);
      }

      .inline-form-label {
        font-size: var(--ic-text-xs, 0.75rem);
        color: var(--ic-text-muted, #9ca3af);
        margin-bottom: 4px;
        display: flex;
        align-items: center;
        gap: var(--ic-space-sm, 0.5rem);
      }

      .inline-form-cancel {
        background: none;
        border: none;
        color: var(--ic-text-dim, #6b7280);
        cursor: pointer;
        font-size: var(--ic-text-xs, 0.75rem);
        padding: 0 2px;
      }

      .inline-form-cancel:hover {
        color: var(--ic-text, #f3f4f6);
      }

      .inline-form-row {
        display: flex;
        gap: var(--ic-space-sm, 0.5rem);
        align-items: flex-end;
      }

      .inline-form-input {
        flex: 1;
        padding: 0.375rem 0.5rem;
        background: var(--ic-surface-2, #1f2937);
        border: 1px solid var(--ic-border, #374151);
        border-radius: var(--ic-radius-sm, 0.25rem);
        color: var(--ic-text, #f3f4f6);
        font-size: var(--ic-text-sm, 0.875rem);
        font-family: inherit;
        outline: none;
        resize: vertical;
        min-height: 2rem;
        max-height: 6rem;
      }

      .inline-form-input:focus {
        border-color: var(--ic-accent, #3b82f6);
      }

      .btn-sm {
        padding: 0.25rem 0.5rem;
        font-size: var(--ic-text-xs, 0.75rem);
        font-weight: 500;
        border-radius: var(--ic-radius-sm, 0.25rem);
        border: 1px solid transparent;
        cursor: pointer;
        transition: background var(--ic-transition, 150ms);
      }

      .btn-sm:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .btn-sm-primary {
        background: var(--ic-accent, #3b82f6);
        color: white;
      }

      .btn-sm-primary:hover:not(:disabled) {
        background: var(--ic-accent-hover, #2563eb);
      }

      .btn-sm-ghost {
        background: transparent;
        border-color: var(--ic-border, #374151);
        color: var(--ic-text-muted, #9ca3af);
      }

      .btn-sm-ghost:hover:not(:disabled) {
        background: var(--ic-surface-2, #1f2937);
        color: var(--ic-text, #f3f4f6);
      }

      /* Danger action button variant */
      .msg-action-btn--danger:hover {
        color: var(--ic-error, #f87171);
        border-color: var(--ic-error, #f87171);
        background: transparent;
      }

      /* Emoji picker floating panel */
      .emoji-picker-anchor {
        position: relative;
      }

      .emoji-picker {
        position: absolute;
        top: 100%;
        right: 0;
        z-index: 100;
        background: var(--ic-surface, #111827);
        border: 1px solid var(--ic-border, #374151);
        border-radius: var(--ic-radius-md, 0.5rem);
        box-shadow: var(--ic-shadow-lg, 0 10px 15px rgba(0,0,0,0.25));
        padding: var(--ic-space-sm, 0.5rem);
        display: grid;
        grid-template-columns: repeat(6, 1fr);
        gap: 2px;
        width: max-content;
        min-width: 12rem;
      }

      .emoji-btn {
        font-size: 1.25rem;
        padding: 4px;
        cursor: pointer;
        border: none;
        background: none;
        border-radius: var(--ic-radius-sm, 0.25rem);
        line-height: 1;
        text-align: center;
      }

      .emoji-btn:hover {
        background: var(--ic-surface-raised, #1e293b);
      }

      /* Selected message highlight */
      .msg-row--selected {
        border-left: 3px solid var(--ic-accent, #3b82f6);
        cursor: pointer;
      }

      .msg-row:not(.msg-row--selected) {
        cursor: pointer;
        border-left: 3px solid transparent;
      }

      /* Attachment form */
      .attach-form {
        display: flex;
        flex-direction: column;
        gap: var(--ic-space-sm, 0.5rem);
        padding: var(--ic-space-sm, 0.5rem);
        background: var(--ic-surface-raised, #1e293b);
        border-radius: var(--ic-radius-sm, 0.25rem);
        margin-top: var(--ic-space-xs, 0.25rem);
      }

      .attach-form-row {
        display: flex;
        gap: var(--ic-space-sm, 0.5rem);
        align-items: center;
        flex-wrap: wrap;
      }

      .attach-input {
        flex: 1;
        min-width: 12rem;
        padding: 0.375rem 0.5rem;
        background: var(--ic-surface-2, #1f2937);
        border: 1px solid var(--ic-border, #374151);
        border-radius: var(--ic-radius-sm, 0.25rem);
        color: var(--ic-text, #f3f4f6);
        font-size: var(--ic-text-sm, 0.875rem);
        font-family: inherit;
        outline: none;
      }

      .attach-input:focus {
        border-color: var(--ic-accent, #3b82f6);
      }

      .attach-select {
        padding: 0.375rem 0.5rem;
        background: var(--ic-surface-2, #1f2937);
        border: 1px solid var(--ic-border, #374151);
        border-radius: var(--ic-radius-sm, 0.25rem);
        color: var(--ic-text, #f3f4f6);
        font-size: var(--ic-text-sm, 0.875rem);
        outline: none;
        cursor: pointer;
      }

      .attach-select:focus {
        border-color: var(--ic-accent, #3b82f6);
      }

      /* Platform actions */
      .platform-actions {
        background: var(--ic-surface, #111827);
        border: 1px solid var(--ic-border, #374151);
        border-radius: var(--ic-radius-md, 0.5rem);
        padding: var(--ic-space-md, 1rem);
      }

      .platform-actions-title {
        display: flex;
        align-items: center;
        gap: var(--ic-space-sm, 0.5rem);
        font-size: 1rem;
        font-weight: 600;
        color: var(--ic-text, #f3f4f6);
        margin: 0 0 var(--ic-space-md, 1rem) 0;
      }

      .action-group-header {
        font-weight: 600;
        font-size: var(--ic-text-sm, 0.875rem);
        color: var(--ic-text-muted, #9ca3af);
        margin-top: var(--ic-space-md, 1rem);
        margin-bottom: var(--ic-space-xs, 0.25rem);
      }

      .action-group-header:first-of-type {
        margin-top: 0;
      }

      .action-buttons {
        display: flex;
        flex-wrap: wrap;
        gap: var(--ic-space-xs, 0.25rem);
        align-items: center;
      }

      .action-input {
        padding: 0.25rem 0.5rem;
        background: var(--ic-surface-2, #1f2937);
        border: 1px solid var(--ic-border, #374151);
        border-radius: var(--ic-radius-sm, 0.25rem);
        color: var(--ic-text, #f3f4f6);
        font-size: var(--ic-text-xs, 0.75rem);
        outline: none;
        width: 8rem;
      }

      .action-input:focus {
        border-color: var(--ic-accent, #3b82f6);
      }

      .action-input::placeholder {
        color: var(--ic-text-dim, #6b7280);
      }

      .action-result {
        margin-top: var(--ic-space-sm, 0.5rem);
        padding: var(--ic-space-sm, 0.5rem);
        background: var(--ic-surface-2, #1f2937);
        border: 1px solid var(--ic-border, #374151);
        border-radius: var(--ic-radius-sm, 0.25rem);
        font-size: var(--ic-text-xs, 0.75rem);
        color: var(--ic-text-muted, #9ca3af);
        max-height: 8rem;
        overflow-y: auto;
        white-space: pre-wrap;
        word-break: break-word;
      }

      /* Error retry */
      .error-container {
        text-align: center;
        padding: var(--ic-space-lg, 1.5rem);
      }

      .error-text {
        color: var(--ic-error, #f87171);
        margin-bottom: var(--ic-space-sm, 0.5rem);
      }

      .retry-btn {
        padding: 0.375rem 0.75rem;
        background: var(--ic-surface-2, #1f2937);
        border: 1px solid var(--ic-border, #374151);
        border-radius: var(--ic-radius-md, 0.5rem);
        color: var(--ic-text, #f3f4f6);
        cursor: pointer;
        font-size: var(--ic-text-sm, 0.875rem);
      }

      .retry-btn:hover {
        background: var(--ic-border, #374151);
      }
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
  /** Effective channel type - equals channelType when set, or auto-selected first running channel. */
  @state() private _effectiveChannel = "";
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

  // Chat picker state (236)
  @state() private _chatList: Array<{ chatId: string; label: string }> = [];
  @state() private _selectedChatId = "";

  // Platform action state
  @state() private _platformActionPending = false;
  @state() private _selectedMessageId = "";
  @state() private _actionResult = "";
  /** Stores input values for platform actions keyed by "group-action" */
  private _actionInputs: Record<string, string> = {};

  private _hasLoaded = false;
  private _previousChannelType = "";

  /** Bound click-outside handler for emoji picker. */
  private _boundEmojiOutsideClick: ((e: MouseEvent) => void) | null = null;

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this._removeEmojiOutsideListener();
  }

  override updated(changedProperties: Map<string, unknown>): void {
    const rpcReady = this.rpcClient && this.rpcClient.status === "connected";

    // Sync effective channel from parent-provided channelType
    if (changedProperties.has("channelType") && this.channelType) {
      this._effectiveChannel = this.channelType;
      // Reset chat picker state for new channel type (236)
      this._selectedChatId = "";
      this._chatList = [];
    }

    // Reload data when channelType changes or rpcClient becomes available
    if (changedProperties.has("channelType") && this.channelType && this.channelType !== this._previousChannelType) {
      this._previousChannelType = this.channelType;
      this._hasLoaded = false;
      void this._loadData();
    } else if (
      changedProperties.has("rpcClient") &&
      rpcReady &&
      this._effectiveChannel &&
      !this._hasLoaded
    ) {
      void this._loadData();
    }

    // Auto-select the first available channel when no channelType is set
    if (!this.channelType && this.rpcClient && !this._autoSelectAttempted) {
      this._autoSelectAttempted = true;
      void this._autoSelectChannel();
    }
  }

  private _autoSelectAttempted = false;

  private async _autoSelectChannel(): Promise<void> {
    if (!this.rpcClient) return;

    // Wait for the rpcClient to connect (it may still be "connecting")
    const rpc = this.rpcClient;
    if (rpc.status !== "connected") {
      await new Promise<void>((resolve) => {
        const check = () => {
          if (rpc.status === "connected") { resolve(); return; }
          if (rpc.status === "disconnected") { resolve(); return; }
          setTimeout(check, 100);
        };
        check();
      });
    }
    if (rpc.status !== "connected") {
      this._loadState = "error";
      this._error = "RPC connection failed";
      return;
    }

    try {
      const result = await rpc.call<{ channels: ChannelListEntry[]; total: number }>("channels.list");
      const channels = result?.channels ?? [];
      this._channelList = channels;
      const running = channels.filter((ch) => ch.status === "running");
      if (running.length > 0) {
        this._effectiveChannel = running[0].channelType;
        void this._loadChats();
        void this._loadData();
      } else {
        this._loadState = "loaded";
      }
    } catch {
      this._loadState = "error";
      this._error = "Failed to load channel list";
    }
  }

  // -------------------------------------------------------------------------
  // Data loading
  // -------------------------------------------------------------------------

  private async _loadData(): Promise<void> {
    const channel = this._effectiveChannel;
    if (!this.rpcClient || !channel) return;

    this._loadState = "loading";
    this._error = "";

    try {
      // Load channel list, capabilities, and channel config in parallel
      const [listResult, capResult, configResult] = await Promise.allSettled([
        this.rpcClient.call<{ channels: ChannelListEntry[]; total: number }>(
          "channels.list",
        ),
        this.rpcClient.call<{ channelType: string; features: PlatformCapabilities }>(
          "channels.capabilities",
          { channel_type: channel },
        ),
        this.rpcClient.call<Record<string, unknown>>(
          "channels.get",
          { channel_type: channel },
        ),
      ]);

      // Channel list
      if (listResult.status === "fulfilled" && listResult.value?.channels) {
        this._channelList = listResult.value.channels;
      }

      // Capabilities -- IMPORTANT: unpack features field
      if (capResult.status === "fulfilled" && capResult.value?.features) {
        this._capabilities = capResult.value.features;
      }

      // Bot name from channel config
      if (configResult.status === "fulfilled" && configResult.value) {
        this._botName = (configResult.value.botName as string)
          ?? (configResult.value.name as string)
          ?? channel;
      }

      // Load chat IDs from session data for the chat picker
      await this._loadChats();

      // Fetch messages - uses session history fallback for non-fetchHistory platforms
      await this._refetchMessages();

      this._loadState = "loaded";
      this._hasLoaded = true;
    } catch (err) {
      this._loadState = "error";
      this._error = err instanceof Error ? err.message : "Failed to load message center data";
    }
  }

  // -------------------------------------------------------------------------
  // Chat picker data (236)
  // -------------------------------------------------------------------------

  /**
   * Load available chat IDs for the current channel type from obs.channels.all
   * (channel activity tracker) which tracks actual chat IDs the bot has interacted with.
   */
  private async _loadChats(): Promise<void> {
    if (!this.rpcClient || !this._effectiveChannel) return;

    try {
      const result = await this.rpcClient.call<{
        channels: Array<{ channelId: string; channelType: string; messagesSent: number; messagesReceived: number; lastActiveAt: number }>;
      }>("obs.channels.all");

      const channels = result?.channels ?? [];
      const chatMap = new Map<string, string>(); // chatId -> label

      // Filter for the current channel type and extract chat IDs
      for (const ch of channels) {
        if (ch.channelType !== this._effectiveChannel) continue;
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
      // Non-fatal -- chat list simply stays empty
    }
  }

  // -------------------------------------------------------------------------
  // Re-fetch messages helper
  // -------------------------------------------------------------------------

  /** Re-fetch message list - uses message.fetch when the platform supports fetchHistory,
   *  otherwise falls back to stored session history via session.list + session.history. */
  private async _refetchMessages(): Promise<void> {
    if (!this.rpcClient) return;

    // Path 1: Platform supports native fetchHistory - use message.fetch as before
    if (this._capabilities?.fetchHistory) {
      try {
        const fetchResult = await this.rpcClient.call<{ messages: FetchedMessage[]; channelId: string }>(
          "message.fetch",
          { channel_type: this._effectiveChannel, channel_id: this._selectedChatId || this._effectiveChannel, limit: 50 },
        );
        this._messages = fetchResult?.messages ?? [];
      } catch {
        // Non-fatal
      }
      return;
    }

    // Path 2: No fetchHistory - fall back to stored session data
    try {
      // Find sessions matching the selected chat ID
      const listResult = await this.rpcClient.call<{
        sessions: Array<{ sessionKey: string; channelId: string; updatedAt: number }>;
      }>("session.list", { kind: "all" });

      const sessions = listResult?.sessions ?? [];
      // Filter to sessions whose channelId matches the currently selected chat
      const chatId = this._selectedChatId;
      const matching = chatId
        ? sessions.filter((s) => s.channelId === chatId)
        : [];

      if (matching.length === 0) {
        this._messages = [];
        return;
      }

      // Pick most recently updated session
      matching.sort((a, b) => b.updatedAt - a.updatedAt);
      const bestSession = matching[0]!;

      // Fetch conversation history from session store
      const histResult = await this.rpcClient.call<{
        messages: Array<{ role: string; content: string; timestamp: number }>;
        total: number;
      }>("session.history", { session_key: bestSession.sessionKey, limit: 50 });

      const histMessages = histResult?.messages ?? [];

      // Map session history messages to FetchedMessage shape
      this._messages = histMessages.map((msg, idx) => ({
        id: `stored-${idx}`,
        senderId: msg.role,
        text: msg.content,
        timestamp: msg.timestamp,
      } as FetchedMessage));
    } catch {
      // Non-fatal - leave messages empty
      this._messages = [];
    }
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  private _handleChannelChange(e: Event): void {
    const select = e.target as HTMLSelectElement;
    const newType = select.value;
    if (newType && newType !== this._effectiveChannel) {
      this.dispatchEvent(new CustomEvent("navigate", {
        detail: `messages/${newType}`,
        bubbles: true,
        composed: true,
      }));
    }
  }

  private _handleChatChange(e: Event): void {
    const select = e.target as HTMLSelectElement;
    this._selectedChatId = select.value;
    void this._refetchMessages();
  }

  private _handleSendClick(): void {
    if (!this._sendText.trim()) return;
    this._showSendConfirm = true;
  }

  private async _handleSendConfirm(): Promise<void> {
    this._showSendConfirm = false;
    if (!this.rpcClient || !this._sendText.trim()) return;

    this._actionPending = true;
    try {
      await this.rpcClient.call(
        "message.send",
        { channel_type: this._effectiveChannel, channel_id: this._selectedChatId || this._effectiveChannel, text: this._sendText.trim() },
      );
      IcToast.show("Message sent", "success");
      this._sendText = "";
      await this._refetchMessages();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to send message";
      IcToast.show(msg, "error");
    } finally {
      this._actionPending = false;
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
    this._replyToId = messageId;
    this._replyText = "";
    // Focus the reply input after render
    this.updateComplete.then(() => {
      const input = this.shadowRoot?.querySelector<HTMLTextAreaElement>(".reply-input");
      input?.focus();
    });
  }

  private _handleReplyCancelClick(): void {
    this._replyToId = "";
    this._replyText = "";
    this._showReplyConfirm = false;
  }

  private _handleReplySendClick(): void {
    if (!this._replyText.trim() || !this._replyToId) return;
    this._showReplyConfirm = true;
  }

  private async _handleReplyConfirm(): Promise<void> {
    this._showReplyConfirm = false;
    if (!this.rpcClient || !this._replyText.trim() || !this._replyToId) return;

    this._actionPending = true;
    try {
      await this.rpcClient.call(
        "message.reply",
        {
          channel_type: this._effectiveChannel,
          channel_id: this._selectedChatId || this._effectiveChannel,
          text: this._replyText.trim(),
          message_id: this._replyToId,
        },
      );
      IcToast.show("Reply sent", "success");
      this._replyToId = "";
      this._replyText = "";
      await this._refetchMessages();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to send reply";
      IcToast.show(msg, "error");
    } finally {
      this._actionPending = false;
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
    this._editingId = msg.id;
    this._editText = msg.text;
    // Focus the edit textarea after render
    this.updateComplete.then(() => {
      const ta = this.shadowRoot?.querySelector<HTMLTextAreaElement>(".edit-input");
      ta?.focus();
    });
  }

  private _handleEditCancelClick(): void {
    this._editingId = "";
    this._editText = "";
  }

  private async _handleEditSave(): Promise<void> {
    if (!this.rpcClient || !this._editText.trim() || !this._editingId) return;

    this._actionPending = true;
    try {
      await this.rpcClient.call(
        "message.edit",
        {
          channel_type: this._effectiveChannel,
          channel_id: this._selectedChatId || this._effectiveChannel,
          message_id: this._editingId,
          text: this._editText.trim(),
        },
      );
      IcToast.show("Message edited", "success");
      this._editingId = "";
      this._editText = "";
      await this._refetchMessages();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to edit message";
      IcToast.show(msg, "error");
    } finally {
      this._actionPending = false;
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
    this._deleteTargetId = messageId;
    this._showDeleteConfirm = true;
  }

  private async _handleDeleteConfirm(): Promise<void> {
    this._showDeleteConfirm = false;
    if (!this.rpcClient || !this._deleteTargetId) return;

    this._actionPending = true;
    try {
      await this.rpcClient.call(
        "message.delete",
        {
          channel_type: this._effectiveChannel,
          channel_id: this._selectedChatId || this._effectiveChannel,
          message_id: this._deleteTargetId,
        },
      );
      IcToast.show("Message deleted", "success");
      // Optimistic local removal
      this._messages = this._messages.filter((m) => m.id !== this._deleteTargetId);
      this._deleteTargetId = "";
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to delete message";
      IcToast.show(msg, "error");
      this._deleteTargetId = "";
      // Re-fetch to restore state on error
      await this._refetchMessages();
    } finally {
      this._actionPending = false;
    }
  }

  private _handleDeleteCancel(): void {
    this._showDeleteConfirm = false;
    this._deleteTargetId = "";
  }

  // ---- React ----

  private _handleReactClick(messageId: string): void {
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
    if (!this.rpcClient || !this._reactTargetId) return;

    this._closeEmojiPicker();
    this._actionPending = true;
    try {
      await this.rpcClient.call(
        "message.react",
        {
          channel_type: this._effectiveChannel,
          channel_id: this._selectedChatId || this._effectiveChannel,
          message_id: this._reactTargetId,
          emoji,
        },
      );
      IcToast.show("Reaction added", "success");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to add reaction";
      IcToast.show(msg, "error");
    } finally {
      this._actionPending = false;
      this._reactTargetId = "";
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
    this._showAttachForm = !this._showAttachForm;
    if (!this._showAttachForm) {
      this._attachUrl = "";
      this._attachType = "file";
      this._attachCaption = "";
    }
  }

  private async _handleAttachSend(): Promise<void> {
    if (!this.rpcClient || !this._attachUrl.trim()) return;

    this._actionPending = true;
    try {
      await this.rpcClient.call(
        "message.attach",
        {
          channel_type: this._effectiveChannel,
          channel_id: this._selectedChatId || this._effectiveChannel,
          attachment_url: this._attachUrl.trim(),
          attachment_type: this._attachType,
          caption: this._attachCaption.trim() || undefined,
        },
      );
      IcToast.show("Attachment sent", "success");
      this._attachUrl = "";
      this._attachType = "file";
      this._attachCaption = "";
      this._showAttachForm = false;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to send attachment";
      IcToast.show(msg, "error");
    } finally {
      this._actionPending = false;
    }
  }

  // ---- Message selection ----

  private _handleMessageClick(messageId: string): void {
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
    if (!this.rpcClient) return;

    const rpcMethod = PLATFORM_RPC_METHOD[this._effectiveChannel];
    if (!rpcMethod) return;

    // Build params
    const params: Record<string, unknown> = { action: platformAction.action };

    // Add channel/chat/group identifier based on platform
    if (this._effectiveChannel === "telegram") {
      params.chat_id = this._selectedChatId || this._effectiveChannel;
    } else if (this._effectiveChannel === "whatsapp") {
      params.group_jid = this._selectedChatId || this._effectiveChannel;
    } else {
      params.channel_id = this._selectedChatId || this._effectiveChannel;
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
      const result = await this.rpcClient.call(rpcMethod, params);
      IcToast.show("Action completed", "success");
      this._actionResult = typeof result === "string" ? result : JSON.stringify(result, null, 2);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Action failed";
      IcToast.show(msg, "error");
      this._actionResult = "";
    } finally {
      this._platformActionPending = false;
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
        { label: this._effectiveChannel || "...", route: `channels/${this._effectiveChannel}` },
        { label: "Messages" },
      ]}></ic-breadcrumb>
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
          >
            ${this._channelList.length === 0
              ? html`<option value=${this._effectiveChannel}>${this._effectiveChannel}</option>`
              : this._channelList.map(
                  (ch) => html`<option value=${ch.channelType} ?selected=${ch.channelType === this._effectiveChannel}>${ch.channelType}</option>`,
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
            ?disabled=${this._chatList.length === 0}
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
            <button class="retry-btn" @click=${() => void this._loadData()}>Retry</button>
          </div>
        `;
      case "loaded":
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
    const canEdit = this._capabilities?.editMessages === true;
    const canDelete = this._capabilities?.deleteMessages === true;
    const canReact = this._capabilities?.reactions === true;

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
                <button class="msg-action-btn" title="Reply" @click=${() => this._handleReplyClick(msg.id)}>Reply</button>
                ${canEdit ? html`
                  <button class="msg-action-btn" title="Edit" @click=${() => this._handleEditClick(msg)}>Edit</button>
                ` : nothing}
                ${canDelete ? html`
                  <button class="msg-action-btn msg-action-btn--danger" title="Delete" @click=${() => this._handleDeleteClick(msg.id)}>Delete</button>
                ` : nothing}
                ${canReact ? html`
                  <span class="emoji-picker-anchor">
                    <button class="msg-action-btn" title="React" data-react-id=${msg.id} @click=${() => this._handleReactClick(msg.id)}>React</button>
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
          <button class="inline-form-cancel" title="Cancel reply" @click=${this._handleReplyCancelClick}>X</button>
        </div>
        <div class="inline-form-row">
          <textarea
            class="inline-form-input reply-input"
            placeholder="Type your reply..."
            .value=${this._replyText}
            @input=${(e: InputEvent) => { this._replyText = (e.target as HTMLTextAreaElement).value; }}
            @keydown=${this._handleReplyKeydown}
            ?disabled=${this._actionPending}
            rows="1"
          ></textarea>
          <button
            class="btn-sm btn-sm-primary"
            @click=${this._handleReplySendClick}
            ?disabled=${this._actionPending || !this._replyText.trim()}
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
              ?disabled=${this._actionPending}
              rows="1"
            ></textarea>
            <button
              class="btn-sm btn-sm-primary"
              @click=${() => void this._handleEditSave()}
              ?disabled=${this._actionPending || !this._editText.trim()}
            >Save</button>
            <button
              class="btn-sm btn-sm-ghost"
              @click=${this._handleEditCancelClick}
              ?disabled=${this._actionPending}
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
          <button class="emoji-btn" title=${emoji} @click=${() => void this._handleEmojiSelect(emoji)}>${emoji}</button>
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
            ?disabled=${this._actionPending}
            rows="2"
          ></textarea>
          <button
            class="btn btn-primary"
            @click=${this._handleSendClick}
            ?disabled=${this._actionPending || !this._sendText.trim()}
          >
            ${this._actionPending ? "Sending..." : "Send"}
          </button>
          ${attachSupported
            ? html`
              <button
                class="btn-sm btn-sm-ghost"
                @click=${this._toggleAttachForm}
                ?disabled=${this._actionPending}
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
              ?disabled=${this._actionPending}
            />
            <select
              class="attach-select"
              .value=${this._attachType}
              @change=${(e: Event) => { this._attachType = (e.target as HTMLSelectElement).value as AttachmentType; }}
              ?disabled=${this._actionPending}
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
              ?disabled=${this._actionPending}
            />
            <button
              class="btn-sm btn-sm-primary"
              @click=${() => void this._handleAttachSend()}
              ?disabled=${this._actionPending || !this._attachUrl.trim()}
            >
              Send Attachment
            </button>
            <button
              class="btn-sm btn-sm-ghost"
              @click=${this._toggleAttachForm}
              ?disabled=${this._actionPending}
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
              const needsMessageAndMissing = action.needsMessageId && !this._selectedMessageId;
              return html`
                ${action.needsInput ? html`
                  <input
                    class="action-input"
                    type="text"
                    placeholder=${action.needsInput}
                    .value=${this._actionInputs[inputKey] ?? ""}
                    @input=${(e: InputEvent) => this._handleActionInputChange(inputKey, (e.target as HTMLInputElement).value)}
                    ?disabled=${this._platformActionPending}
                  />
                ` : nothing}
                <button
                  class="btn-sm btn-sm-ghost"
                  @click=${() => void this._handlePlatformAction(action)}
                  ?disabled=${this._platformActionPending || needsMessageAndMissing}
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
