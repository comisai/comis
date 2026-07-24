// SPDX-License-Identifier: Apache-2.0
import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state, query } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../styles/shared.js";
import { IcToast } from "../components/feedback/ic-toast.js";
import type { ApiClient } from "../api/api-client.js";
import type { RpcClient } from "../api/rpc-client.js";
import type { EventDispatcher } from "../state/event-dispatcher.js";
import type { SessionTarget } from "../api/session-scope.js";
import { parseSessionKeyString } from "../utils/session-key-parser.js";
import { stripSilentTokens } from "../utils/message-content.js";
import { systemClearInterval, systemNowMs, systemSetInterval, systemSetTimeout } from "@comis/core";
import {
  createLocalChatSession,
  filterChatSessions,
  loadChatAgents,
  loadChatBudget,
  loadChatHistory,
  loadChatSessionSelection,
  resolveActiveSessionTarget,
  resolveTransportSessionKey,
  sendChatMessage,
  type ChatAgentOption,
  type ChatSessionInfo,
} from "./chat-console/session-data.js";

// Side-effect imports to register child components
import "../components/domain/ic-chat-message.js";
import "../components/domain/ic-tool-call.js";
import "../components/form/ic-search-input.js";
import "../components/data/ic-tag.js";
import "../components/data/ic-relative-time.js";
import "../components/feedback/ic-loading.js";
import "../components/feedback/ic-empty-state.js";
import "../components/shell/ic-skeleton-view.js";
import "../components/display/ic-icon.js";
import "../components/data/ic-budget-segment-bar.js";

// Sub-component imports
import "./chat-console/session-sidebar.js";
import "./chat-console/message-renderer.js";

/** A single chat message in the conversation. */
interface ChatMessageData {
  id: string;
  role: "user" | "assistant" | "error" | "system" | "tool";
  content: string;
  timestamp: number;
  toolCalls?: ToolCallData[];
}

/** Tool invocation data attached to assistant messages. */
interface ToolCallData {
  id: string;
  name: string;
  input: unknown;
  output: unknown;
  status: "running" | "success" | "error";
}

/** Pending file attachment data. */
interface AttachmentData {
  id: string;
  file: File;
  type: "image" | "audio" | "file";
  previewUrl?: string;
}

interface ChatRequestContext {
  readonly revision: number;
  readonly activeSession: string;
  readonly selectedAgent: string;
  readonly transportSessionKey: string;
  readonly rpcClient: RpcClient | null;
  readonly apiClient: ApiClient | null;
  readonly target?: SessionTarget;
}

interface StoredSessionRequestContext {
  readonly activeRevision: number;
  readonly historyRevision: number;
  readonly rpcClient: RpcClient;
  readonly selectedAgent: string;
  readonly target: SessionTarget;
}

interface SessionListRequestContext {
  readonly revision: number;
  readonly activeRevision: number;
  readonly rpcClient: RpcClient;
  readonly selectedAgent: string;
  readonly conversationRef: string;
}

/** Slash command definition. */
const SLASH_COMMANDS = [
  { command: "/new", description: "Start a new session", icon: "plus" },
  { command: "/reset", description: "Reset current session", icon: "refresh" },
  { command: "/export", description: "Export session as JSONL", icon: "download" },
  { command: "/compact", description: "Compact current session context", icon: "compress" },
  { command: "/switch", description: "Switch to another agent", icon: "agents" },
  { command: "/help", description: "Show available commands", icon: "chat" },
] as const;

/** Maximum number of file attachments per message. */
const MAX_ATTACHMENTS = 5;
/** Maximum file size in bytes (10 MB). */
const MAX_FILE_SIZE = 10 * 1024 * 1024;
/** Maximum voice recording duration in seconds. */
const MAX_RECORDING_DURATION = 120;

/** Full chat console view (sidebar + conversation + input + voice + attachments + streaming). */
@customElement("ic-chat-console")
export class IcChatConsole extends LitElement {
  static override styles = [
    sharedStyles,
    focusStyles,
    css`
      :host { display: flex; height: calc(100vh - 6.5rem); max-height: calc(100vh - 6.5rem); overflow: hidden; }
      /* --- Sidebar --- */
      .sidebar { width: 280px; min-width: 280px; background: var(--ic-surface); border-right: 1px solid var(--ic-border); display: flex; flex-direction: column; height: 100%; overflow: hidden; }
      .sidebar-header { display: flex; align-items: center; justify-content: space-between; padding: var(--ic-space-md); border-bottom: 1px solid var(--ic-border); flex-shrink: 0; }
      .sidebar-title { font-size: var(--ic-text-base); font-weight: 600; }
      .new-btn { display: inline-flex; align-items: center; gap: 4px; background: var(--ic-accent); color: white; border: none; border-radius: var(--ic-radius-md); padding: var(--ic-space-xs) var(--ic-space-sm); font-size: var(--ic-text-xs); font-family: inherit; cursor: pointer; font-weight: 500; transition: background var(--ic-transition); }
      .new-btn:hover { background: var(--ic-accent-hover); }
      .sidebar-search { padding: var(--ic-space-sm) var(--ic-space-md); flex-shrink: 0; }
      .session-list { flex: 1; overflow-y: auto; }
      .session-item { display: flex; flex-direction: column; gap: 4px; padding: var(--ic-space-sm) var(--ic-space-md); cursor: pointer; border-left: 3px solid transparent; transition: background var(--ic-transition); }
      .session-item:hover { background: var(--ic-surface-2); }
      .session-item--active { background: var(--ic-surface-2); border-left-color: var(--ic-accent); }
      .session-key { font-family: var(--ic-font-mono); font-size: var(--ic-text-xs); color: var(--ic-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .session-meta { display: flex; align-items: center; gap: var(--ic-space-sm); }
      .msg-count { font-size: var(--ic-text-xs); color: var(--ic-text-dim); background: var(--ic-surface-2); padding: 1px 6px; border-radius: 9999px; }
      /* --- Conversation Area --- */
      .conversation { flex: 1; display: flex; flex-direction: column; min-width: 0; height: 100%; overflow: hidden; }
      .conv-header { display: flex; align-items: center; gap: var(--ic-space-md); padding: var(--ic-space-md); border-bottom: 1px solid var(--ic-border); flex-shrink: 0; }
      .agent-select { background: var(--ic-surface-2); border: 1px solid var(--ic-border); border-radius: var(--ic-radius-md); color: var(--ic-text); font-size: var(--ic-text-sm); padding: var(--ic-space-xs) var(--ic-space-sm); font-family: inherit; }
      .session-info { display: flex; align-items: center; gap: var(--ic-space-sm); margin-left: auto; font-size: var(--ic-text-xs); color: var(--ic-text-dim); }
      .session-info-key { font-family: var(--ic-font-mono); }
      .message-area { flex: 1; overflow-y: auto; padding: var(--ic-space-lg) var(--ic-space-xl); display: flex; flex-direction: column; gap: var(--ic-space-sm); position: relative; max-width: 900px; margin: 0 auto; width: 100%; }
      .new-messages-btn { position: sticky; bottom: var(--ic-space-sm); align-self: center; background: var(--ic-accent); color: white; border: none; border-radius: 9999px; padding: var(--ic-space-xs) var(--ic-space-md); font-size: var(--ic-text-xs); font-family: inherit; cursor: pointer; box-shadow: var(--ic-shadow-md); z-index: 1; }
      .new-messages-btn:hover { background: var(--ic-accent-hover); }
      /* --- Input Bar --- */
      .input-bar { display: flex; flex-direction: column; padding: var(--ic-space-md); border-top: 1px solid var(--ic-border); gap: var(--ic-space-sm); flex-shrink: 0; position: relative; }
      .attachment-strip { display: flex; gap: var(--ic-space-sm); flex-wrap: wrap; }
      .attachment-preview { display: flex; align-items: center; gap: 4px; padding: 4px 8px; background: var(--ic-surface-2); border-radius: var(--ic-radius-sm); font-size: var(--ic-text-xs); color: var(--ic-text); }
      .attachment-preview img { width: 48px; height: 48px; object-fit: cover; border-radius: var(--ic-radius-sm); }
      .attachment-remove { background: none; border: none; color: var(--ic-text-dim); cursor: pointer; padding: 2px; font-size: var(--ic-text-xs); line-height: 1; border-radius: var(--ic-radius-sm); }
      .attachment-remove:hover { color: var(--ic-error); }
      .input-row { display: flex; align-items: flex-end; gap: var(--ic-space-sm); }
      .input-textarea { flex: 1; min-height: 2.5rem; max-height: 8rem; background: var(--ic-surface-2); border: 1px solid var(--ic-border); border-radius: var(--ic-radius-md); color: var(--ic-text); font-size: var(--ic-text-sm); padding: var(--ic-space-sm) var(--ic-space-md); resize: none; font-family: inherit; line-height: 1.5; outline: none; transition: border-color var(--ic-transition); }
      .input-textarea:focus { border-color: var(--ic-accent); }
      .input-textarea:disabled { opacity: 0.5; cursor: not-allowed; }
      .voice-btn { display: inline-flex; align-items: center; justify-content: center; background: none; border: none; color: var(--ic-text-muted); cursor: pointer; padding: var(--ic-space-sm); border-radius: 50%; transition: color var(--ic-transition), background var(--ic-transition); }
      .voice-btn:hover { color: var(--ic-text); }
      .voice-btn--recording { background: var(--ic-error); color: white; }
      .voice-btn--recording:hover { background: var(--ic-error); color: white; }
      .voice-btn:disabled { opacity: 0.5; cursor: not-allowed; }
      .recording-indicator { display: flex; align-items: center; gap: var(--ic-space-xs); }
      .recording-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ic-error); animation: pulse 1.5s ease-in-out infinite; }
      @media (prefers-reduced-motion: reduce) {
      .recording-dot { animation: none; opacity: 0.7; }
      }
      @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.3; }
      }
      .recording-time { color: var(--ic-error); font-family: var(--ic-font-mono); font-size: var(--ic-text-xs); }
      .send-btn { display: inline-flex; align-items: center; justify-content: center; background: var(--ic-accent); color: white; border: none; border-radius: var(--ic-radius-md); padding: var(--ic-space-sm) var(--ic-space-md); cursor: pointer; transition: opacity var(--ic-transition); }
      .send-btn:disabled { opacity: 0.4; cursor: not-allowed; }
      .send-btn:hover:not(:disabled) { opacity: 0.9; }
      /* --- Drag overlay --- */
      .drag-overlay { position: absolute; inset: 0; border: 2px dashed var(--ic-accent); background: color-mix(in srgb, var(--ic-accent) 10%, transparent); display: flex; align-items: center; justify-content: center; gap: var(--ic-space-sm); z-index: 5; font-size: var(--ic-text-sm); color: var(--ic-accent); pointer-events: none; }
      /* --- Slash command menu --- */
      .slash-menu { position: absolute; bottom: 100%; left: var(--ic-space-md); right: var(--ic-space-md); background: var(--ic-surface); border: 1px solid var(--ic-border); border-radius: var(--ic-radius-md); box-shadow: var(--ic-shadow-lg); max-height: 12rem; overflow-y: auto; z-index: 100; }
      .slash-item { display: flex; align-items: center; gap: var(--ic-space-sm); padding: var(--ic-space-sm) var(--ic-space-md); cursor: pointer; transition: background var(--ic-transition); }
      .slash-item:hover,
      .slash-item--active { background: var(--ic-surface-2); }
      .slash-cmd { font-family: var(--ic-font-mono); color: var(--ic-text); font-size: var(--ic-text-sm); }
      .slash-desc { color: var(--ic-text-dim); font-size: var(--ic-text-xs); }
      /* --- Budget bar --- */
      .budget-bar-area { padding: 0 var(--ic-space-md); flex-shrink: 0; border-top: 1px solid var(--ic-border); }
      /* --- Streaming indicator --- */
      .streaming-indicator { display: flex; align-items: center; gap: var(--ic-space-sm); padding: var(--ic-space-sm) var(--ic-space-md); }
      .typing-dots { display: flex; gap: 4px; }
      .typing-dot { width: 6px; height: 6px; background: var(--ic-text-muted); border-radius: 50%; animation: bounce 1.2s infinite; }
      .typing-dot:nth-child(2) { animation-delay: 0.15s; }
      .typing-dot:nth-child(3) { animation-delay: 0.3s; }
      @keyframes bounce {
      0%, 60%, 100% { transform: scale(1); }
      30% { transform: scale(1.4); }
      }
      @media (prefers-reduced-motion: reduce) {
      .typing-dot { animation: none; }
      .typing-dot:nth-child(1) { opacity: 0.4; }
      .typing-dot:nth-child(2) { opacity: 0.7; }
      .typing-dot:nth-child(3) { opacity: 1; }
      }
      .thinking-indicator { display: flex; align-items: center; gap: var(--ic-space-sm); padding: var(--ic-space-sm) var(--ic-space-md); color: var(--ic-text-muted); font-size: 0.85rem; }
      .thinking-label { color: var(--ic-text-muted); font-size: 0.85rem; }
      .token-counter { font-family: var(--ic-font-mono); font-size: var(--ic-text-xs); color: var(--ic-text-dim); }
      /* Mobile toggle */
      .mobile-toggle { display: none; background: none; border: none; color: var(--ic-text); cursor: pointer; padding: var(--ic-space-xs); }
      /* Loading center */
      .loading-center { display: flex; justify-content: center; padding: var(--ic-space-2xl); }
      /* Responsive: mobile */
      @media (max-width: 767px) {
      .sidebar { display: none; }
      .sidebar--open { display: flex; position: absolute; top: 0; left: 0; z-index: 10; height: 100%; box-shadow: var(--ic-shadow-lg); }
      .mobile-toggle { display: inline-flex; }
      }
    `,
  ];

  @property({ attribute: false }) apiClient: ApiClient | null = null;

  @property({ attribute: false }) rpcClient: RpcClient | null = null;

  @property({ attribute: false }) eventDispatcher: EventDispatcher | null = null;

  @property() conversationRef = "";

  @property() authToken = "";

  // --- Session / conversation state ---
  @state() private _sessions: ChatSessionInfo[] = [];
  @state() private _activeSession = "";
  @state() private _messages: ChatMessageData[] = [];
  @state() private _agents: ChatAgentOption[] = [];
  @state() private _selectedAgent = "default";
  @state() private _loading = true;
  @state() private _searchQuery = "";
  @state() private _sidebarOpen = false;
  @state() private _hasNewMessages = false;

  // --- Input bar state ---
  @state() private _inputValue = "";
  @state() private _sending = false;
  @state() private _attachments: AttachmentData[] = [];

  // --- Voice recording state ---
  @state() private _recording = false;
  @state() private _recordingDuration = 0;
  @state() private _transcribing = false;

  // --- Drag-and-drop state ---
  @state() private _dragOver = false;

  // --- Slash command state ---
  @state() private _showSlashMenu = false;
  @state() private _slashFilter = "";
  @state() private _slashSelectedIndex = 0;

  // --- Streaming state ---
  @state() private _streaming = false;
  @state() private _streamingTokens = 0;
  @state() private _streamingContent = "";

  // --- Budget bar state ---
  @state() private _budgetSegments: Array<{ label: string; tokens: number; color: string }> = [];
  @state() private _budgetTotal = 0;
  private _sessionLoadRevision = 0;
  private _sessionListLoadingRevision: number | undefined;
  private _activeSessionRevision = 0;
  private _historyRequestRevision = 0;
  private _budgetRequestRevision = 0;
  private _sendRequestRevision = 0;
  private _sendingRequestId: number | undefined;

  @query(".message-area") private _messageArea!: HTMLElement;
  @query(".input-textarea") private _textarea!: HTMLTextAreaElement;

  private _userScrolledUp = false;
  private _streamBuffer = "";
  private _rafPending = false;
  private _eventUnsubs: Array<() => void> = [];
  private _rpcStatusUnsub: (() => void) | null = null;
  private _dataLoaded = false;

  // Voice recording internals
  private _mediaRecorder: MediaRecorder | null = null;
  private _audioChunks: Blob[] = [];
  private _recordingTimer: ReturnType<typeof setInterval> | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    this._setupEventListeners();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    for (const unsub of this._eventUnsubs) {
      unsub();
    }
    this._eventUnsubs = [];
    this._rpcStatusUnsub?.();
    this._rpcStatusUnsub = null;
    // Clean up recording
    if (this._recordingTimer !== null) {
      systemClearInterval(this._recordingTimer);
    }
    if (this._mediaRecorder?.state === "recording") {
      this._mediaRecorder.stop();
    }
    // Revoke attachment object URLs
    for (const att of this._attachments) {
      if (att.previewUrl) {
        URL.revokeObjectURL(att.previewUrl);
      }
    }
  }

  override updated(changed: Map<string, unknown>): void {
    if (changed.has("_messages") && !this._userScrolledUp) {
      this._scrollToBottom();
    }
    // Load data when rpcClient becomes available (handles late property binding)
    if (changed.has("rpcClient") && this.rpcClient) {
      this._rpcStatusUnsub?.();
      if (this.rpcClient.status === "connected") {
        this._initialLoad();
      } else {
        this._rpcStatusUnsub = this.rpcClient.onStatusChange((status) => {
          if (status === "connected" && !this._dataLoaded) {
            this._initialLoad();
          }
        });
      }
    }
    if (
      !changed.has("rpcClient")
      && changed.has("conversationRef")
      && this.rpcClient?.status === "connected"
    ) {
      this._sessions = [];
      this._activateSession("");
      void this._loadSessions();
    }
    // Load agents when apiClient becomes available
    if (changed.has("apiClient") && this.apiClient && this._agents.length <= 1) {
      this._loadAgents();
    }
  }

  private _initialLoad(): void {
    if (this._dataLoaded) return;
    this._dataLoaded = true;
    this._loadSessions();
  }

  /** Register a `document` CustomEvent listener with auto-unsubscribe tracking. */
  private _onDocEvent(type: string, handler: (data: Record<string, unknown>) => void): void {
    const fn = (e: Event) => handler((e as CustomEvent).detail as Record<string, unknown>);
    document.addEventListener(type, fn);
    this._eventUnsubs.push(() => document.removeEventListener(type, fn));
  }

  private _setupEventListeners(): void {
    const appendIfActive = (data: Record<string, unknown>) => {
      if (data.sessionKey === this._activeTransportSessionKey()) this._appendMessage(data);
    };
    this._onDocEvent("message:received", appendIfActive);
    this._onDocEvent("message:sent", appendIfActive);
    this._onDocEvent("session:created", (data) => {
      const invalidatedRevision = this._sessionLoadRevision;
      this._sessionLoadRevision += 1;
      if (this._sessionListLoadingRevision === invalidatedRevision) {
        this._sessionListLoadingRevision = undefined;
        this._loading = false;
      }
      const session: ChatSessionInfo = {
        key: String(data.sessionKey ?? ""),
        agentId: String(data.agentId ?? "unknown"),
        channelType: String(data.channelType ?? "web"),
        messageCount: 0,
        lastActivity: systemNowMs(),
      };
      this._sessions = [session, ...this._sessions];
    });
    this._onDocEvent("message:streaming", (data) => this._handleStreamingEvent(data));
    if (this.rpcClient) {
      this._eventUnsubs.push(this.rpcClient.onNotification((method, params) => {
        if (method === "notification.message") this._handleNotificationMessage(params);
        else if (method === "notification.attachment") this._handleNotificationAttachment(params);
      }));
    }
  }

  private _handleStreamingEvent(data: Record<string, unknown>): void {
    if (data.sessionKey !== this._activeTransportSessionKey()) return;
    if (!this._streaming) {
      this._streaming = true;
      this._streamingTokens = 0;
      this._streamingContent = "";
      this._streamBuffer = "";
    }
    if (typeof data.content === "string") {
      this._streamBuffer += data.content;
      if (!this._rafPending) {
        this._rafPending = true;
        requestAnimationFrame(() => {
          this._streamingContent = this._streamBuffer;
          this._rafPending = false;
        });
      }
    }
    if (typeof data.tokens === "number") this._streamingTokens = data.tokens;
    if (data.done === true) {
      this._streamingContent = this._streamBuffer;
      if (this._streamBuffer.trim()) {
        this._messages = [...this._messages, {
          id: crypto.randomUUID(),
          role: "assistant",
          content: this._streamBuffer,
          timestamp: systemNowMs(),
        }];
      }
      this._streaming = false;
      this._streamingTokens = 0;
      this._streamingContent = "";
      this._streamBuffer = "";
      this._rafPending = false;
      this._focusInput();
    }
  }

  private _handleNotificationMessage(params: unknown): void {
    const p = params as Record<string, unknown> | undefined;
    const text = typeof p?.text === "string" ? p.text : "";
    if (!text) return;
    console.debug("[chat] notification.message received, length:", text.length);
    this._messages = [...this._messages, {
      id: crypto.randomUUID(),
      role: "assistant",
      content: text,
      timestamp: typeof p?.timestamp === "number" ? p.timestamp : systemNowMs(),
    }];
    this._syncSessionMessageCount();
    this._scrollToBottom();
  }

  private _handleNotificationAttachment(params: unknown): void {
    const p = params as Record<string, unknown> | undefined;
    const url = typeof p?.url === "string" ? p.url : "";
    const channelId = typeof p?.channelId === "string" ? p.channelId : "";
    const notificationSessionKey = typeof p?.sessionKey === "string" ? p.sessionKey : "";
    const activeSession = parseSessionKeyString(this._activeTransportSessionKey());
    const notifiedSession = parseSessionKeyString(notificationSessionKey);
    const isActiveSession = notificationSessionKey === this._activeTransportSessionKey()
      || (activeSession !== undefined
        && notifiedSession !== undefined
        && activeSession.tenantId === "web"
        && activeSession.tenantId === notifiedSession.tenantId
        && activeSession.agentId === notifiedSession.agentId
        && activeSession.userId === notifiedSession.userId
        && activeSession.channelId === notifiedSession.channelId);
    if (!url || !channelId || !isActiveSession || notifiedSession?.channelId !== channelId) return;
    console.debug("[chat] notification.attachment received:", p?.type, p?.fileName);
    const type = (p?.type as string) ?? "file";
    const fileName = (p?.fileName as string) ?? "attachment";
    const caption = typeof p?.caption === "string" ? p.caption : "";
    const mimeType = (p?.mimeType as string) ?? "";
    const attachmentJson = JSON.stringify({ url, type, mimeType, fileName });
    const content = caption
      ? `${caption}\n\n<!-- attachment:${attachmentJson} -->`
      : `<!-- attachment:${attachmentJson} -->`;
    this._messages = [...this._messages, {
      id: crypto.randomUUID(),
      role: "assistant",
      content,
      timestamp: typeof p?.timestamp === "number" ? p.timestamp : systemNowMs(),
    }];
    this._syncSessionMessageCount();
    this._scrollToBottom();
  }

  private _appendMessage(data: Record<string, unknown>): void {
    const msg: ChatMessageData = {
      id: String(data.id ?? crypto.randomUUID()),
      role: (data.role as ChatMessageData["role"]) ?? "assistant",
      content: String(data.content ?? ""),
      timestamp: (data.timestamp as number) ?? systemNowMs(),
    };
    this._messages = [...this._messages, msg];
    if (this._userScrolledUp) {
      this._hasNewMessages = true;
    }
  }

  private async _loadSessions(): Promise<void> {
    if (!this.rpcClient) {
      this._sessionListLoadingRevision = undefined;
      this._loading = false;
      return;
    }
    const request: SessionListRequestContext = {
      revision: ++this._sessionLoadRevision,
      activeRevision: this._activeSessionRevision,
      rpcClient: this.rpcClient,
      selectedAgent: this._selectedAgent,
      conversationRef: this.conversationRef,
    };
    this._sessionListLoadingRevision = request.revision;
    this._loading = true;
    try {
      const selection = await loadChatSessionSelection(
        request.rpcClient,
        request.selectedAgent,
        request.conversationRef,
      );
      if (!this._isCurrentSessionListRequest(request)) return;
      this._selectedAgent = selection.selectedAgent;
      this._sessions = selection.sessions;
      this._sessionListLoadingRevision = undefined;
      this._loading = false;
      if (request.conversationRef && selection.routeResolved) {
        const match = this._sessions.find((session) => session.key === request.conversationRef);
        if (match) {
          this._activateSession(match.key);
          void this._loadSessionHistory();
        }
      }
    } catch {
      if (!this._isCurrentSessionListRequest(request)) return;
      this._sessions = [];
      this._sessionListLoadingRevision = undefined;
      this._loading = false;
    }
  }

  private _isCurrentSessionListRequest(request: SessionListRequestContext): boolean {
    return request.revision === this._sessionLoadRevision
      && request.activeRevision === this._activeSessionRevision
      && request.rpcClient === this.rpcClient
      && request.selectedAgent === this._selectedAgent
      && request.conversationRef === this.conversationRef;
  }

  private async _loadSessionHistory(): Promise<void> {
    if (!this.rpcClient || !this._activeSession) return;
    const target = this._activeSessionTarget();
    if (!target) return;
    const request: StoredSessionRequestContext = {
      activeRevision: this._activeSessionRevision,
      historyRevision: ++this._historyRequestRevision,
      rpcClient: this.rpcClient,
      selectedAgent: this._selectedAgent,
      target,
    };
    this._sessionListLoadingRevision = undefined;
    this._loading = true;
    try {
      const result = await loadChatHistory(request.rpcClient, request.target);
      if (!this._isCurrentStoredSessionRequest(request)) return;
      this._messages = result.messages;
    } catch {
      if (!this._isCurrentStoredSessionRequest(request)) return;
      this._messages = [];
    } finally {
      if (this._isCurrentStoredSessionRequest(request)) {
        this._loading = false;
        this._scrollToBottom();
        void this._loadBudgetData(request);
      }
    }
  }

  private async _loadBudgetData(request: StoredSessionRequestContext): Promise<void> {
    const budgetRevision = ++this._budgetRequestRevision;
    const budget = await loadChatBudget(request.rpcClient, request.target.agentId);
    if (
      budgetRevision !== this._budgetRequestRevision
      || !this._isCurrentStoredSessionRequest(request)
    ) return;
    this._budgetSegments = budget.segments;
    this._budgetTotal = budget.total;
  }

  private async _loadAgents(): Promise<void> {
    if (!this.apiClient) return;
    try {
      const nextAgents = await loadChatAgents(this.apiClient);
      this._agents = nextAgents;
      if (!nextAgents.some((agent) => agent.id === this._selectedAgent)) {
        this._selectedAgent = nextAgents[0]!.id;
        this._sessions = [];
        this._activateSession("");
        await this._loadSessions();
      }
    } catch {
      this._agents = [{ id: "default", name: "Default", model: "unknown" }];
    }
  }

  private _handleAgentChange(e: Event): void {
    this._selectedAgent = (e.target as HTMLSelectElement).value;
    this._sessions = [];
    this._activateSession("");
    void this._loadSessions();
  }

  private _createNewSession(): void {
    this._sessionLoadRevision += 1;
    const newSession = createLocalChatSession(this._selectedAgent, systemNowMs());
    this._sessions = [newSession, ...this._sessions];
    this._activateSession(newSession.key);
  }

  private _selectSession(key: string): void {
    const selected = this._sessions.find((session) => session.key === key);
    if (selected) this._selectedAgent = selected.agentId;
    this._activateSession(key);
    this._sidebarOpen = false;
    void this._loadSessionHistory();
  }

  private _activateSession(key: string): void {
    this._activeSessionRevision += 1;
    this._sessionListLoadingRevision = undefined;
    this._activeSession = key;
    this._messages = [];
    this._budgetSegments = [];
    this._budgetTotal = 0;
    this._loading = false;
    this._sendingRequestId = undefined;
    this._sending = false;
    this._streaming = false;
    this._streamingTokens = 0;
    this._streamingContent = "";
    this._streamBuffer = "";
    this._rafPending = false;
  }

  private _activeTransportSessionKey(): string {
    return resolveTransportSessionKey(this._sessions, this._activeSession);
  }

  private _activeSessionTarget() {
    return resolveActiveSessionTarget(this._sessions, this._activeSession);
  }

  private _activeTargetMatches(target: SessionTarget): boolean {
    const activeTarget = this._activeSessionTarget();
    return activeTarget !== undefined
      && activeTarget.tenantId === target.tenantId
      && activeTarget.agentId === target.agentId
      && activeTarget.conversationRef === target.conversationRef;
  }

  private _isCurrentStoredSessionRequest(request: StoredSessionRequestContext): boolean {
    return request.activeRevision === this._activeSessionRevision
      && request.historyRevision === this._historyRequestRevision
      && request.rpcClient === this.rpcClient
      && request.selectedAgent === this._selectedAgent
      && request.selectedAgent === request.target.agentId
      && this._activeTargetMatches(request.target);
  }

  private _handleScroll(): void {
    if (!this._messageArea) return;
    const { scrollTop, scrollHeight, clientHeight } = this._messageArea;
    const atBottom = scrollHeight - scrollTop - clientHeight < 50;
    this._userScrolledUp = !atBottom;
    if (atBottom) {
      this._hasNewMessages = false;
    }
  }

  private _scrollToBottom(): void {
    requestAnimationFrame(() => {
      if (this._messageArea) {
        this._messageArea.scrollTop = this._messageArea.scrollHeight;
        this._userScrolledUp = false;
        this._hasNewMessages = false;
      }
    });
  }

  private _focusInput(): void {
    this.updateComplete.then(() => {
      // Push to macrotask queue so cascading Lit updates (e.g. _messages -> updated -> scrollToBottom)
      // and requestAnimationFrame callbacks have all settled before we focus.
      systemSetTimeout(() => {
        if (this._textarea && !this._textarea.disabled) {
          this._textarea.focus();
        }
      }, 0);
    });
  }

  private _handleInput(e: Event): void {
    const textarea = e.target as HTMLTextAreaElement;
    this._inputValue = textarea.value;
    // Auto-grow textarea
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 128)}px`;
    // Slash command detection
    if (this._inputValue.startsWith("/")) {
      this._slashFilter = this._inputValue.slice(1);
      this._showSlashMenu = true;
      this._slashSelectedIndex = 0;
    } else {
      this._showSlashMenu = false;
    }
  }

  private _handleKeydown(e: KeyboardEvent): void {
    // If slash menu is open, intercept navigation keys
    if (this._showSlashMenu) {
      const filtered = this._getFilteredSlashCommands();
      if (e.key === "ArrowDown") {
        e.preventDefault();
        this._slashSelectedIndex = (this._slashSelectedIndex + 1) % filtered.length;
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        this._slashSelectedIndex = (this._slashSelectedIndex - 1 + filtered.length) % filtered.length;
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        if (filtered.length > 0) {
          this._executeSlashCommand(filtered[this._slashSelectedIndex].command);
        }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        this._showSlashMenu = false;
        return;
      }
    }
    // Normal input handling
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      this._sendMessage();
    }
  }

  /** Append a chat message to the conversation. */
  private _pushMsg(role: ChatMessageData["role"], content: string): void {
    this._messages = [...this._messages, {
      id: crypto.randomUUID(),
      role,
      content,
      timestamp: systemNowMs(),
    }];
  }

  private _captureChatRequest(): ChatRequestContext | undefined {
    if (!this._activeSession) return undefined;
    const target = this._activeSessionTarget();
    const transportSessionKey = this._activeTransportSessionKey();
    if (!target && !transportSessionKey) return undefined;
    return {
      revision: this._activeSessionRevision,
      activeSession: this._activeSession,
      selectedAgent: this._selectedAgent,
      transportSessionKey,
      rpcClient: this.rpcClient,
      apiClient: this.apiClient,
      ...(target ? { target } : {}),
    };
  }

  private _isCurrentChatRequest(request: ChatRequestContext): boolean {
    if (
      request.revision !== this._activeSessionRevision
      || request.activeSession !== this._activeSession
      || request.selectedAgent !== this._selectedAgent
    ) {
      return false;
    }
    if (request.target) {
      return request.rpcClient === this.rpcClient
        && request.selectedAgent === request.target.agentId
        && this._activeTargetMatches(request.target);
    }
    return request.transportSessionKey !== ""
      && request.transportSessionKey === this._activeTransportSessionKey()
      && request.apiClient === this.apiClient
      && this._activeSessionTarget() === undefined;
  }

  private _canSendToActiveSession(): boolean {
    const target = this._activeSessionTarget();
    if (target) return this.rpcClient !== null && target.agentId === this._selectedAgent;
    const transportSessionKey = this._activeTransportSessionKey();
    if (transportSessionKey) return this.apiClient !== null;
    return !this._activeSession && !this.conversationRef && this.apiClient !== null;
  }

  /** Round-trip text through the active chat boundary; append assistant or error. */
  private async _chatRoundTrip(
    text: string,
    errorPrefix: string,
    request: ChatRequestContext,
  ): Promise<void> {
    try {
      const response = request.target
        ? request.rpcClient
          ? await sendChatMessage(request.rpcClient, request.target, text)
          : ""
        : request.apiClient
          ? (await request.apiClient.chat(
              text,
              request.selectedAgent,
              request.transportSessionKey,
            )).response
          : "";
      if (!this._isCurrentChatRequest(request)) return;
      const cleaned = response ? stripSilentTokens(response) : "";
      if (cleaned) this._pushMsg("assistant", cleaned);
    } catch (err) {
      if (!this._isCurrentChatRequest(request)) return;
      this._pushMsg("error", err instanceof Error ? err.message : errorPrefix);
    }
  }

  private async _sendMessage(): Promise<void> {
    const text = this._inputValue.trim();
    if ((text === "" && this._attachments.length === 0) || this._sending) return;
    if (!this._canSendToActiveSession()) return;
    if (!this._activeSession) {
      this._createNewSession();
      if (!this._activeSession) return;
    }
    const request = this._captureChatRequest();
    if (!request) return;
    this._historyRequestRevision += 1;
    this._budgetRequestRevision += 1;
    const requestId = ++this._sendRequestRevision;
    this._sendingRequestId = requestId;
    this._sending = true;
    if (text) this._pushMsg("user", text);
    this._inputValue = "";
    if (this._textarea) this._textarea.style.height = "auto";
    this._scrollToBottom();
    // Revoke attachment previews and clear (attachments not yet supported via REST)
    for (const att of this._attachments) {
      if (att.previewUrl) URL.revokeObjectURL(att.previewUrl);
    }
    this._attachments = [];
    try {
      await this._chatRoundTrip(text, "Failed to send message", request);
      if (!this._isCurrentChatRequest(request)) return;
      this._syncSessionMessageCount();
      this._scrollToBottom();
      this._focusInput();
    } finally {
      if (this._sendingRequestId === requestId) {
        this._sendingRequestId = undefined;
        this._sending = false;
      }
    }
  }

  private _syncSessionMessageCount(): void {
    if (!this._activeSession) return;
    const count = this._messages.filter((m) => m.role !== "error").length;
    this._sessions = this._sessions.map((s) =>
      s.key === this._activeSession
        ? { ...s, messageCount: count, lastActivity: systemNowMs() }
        : s,
    );
  }

  private async _transcribeBlob(blob: Blob): Promise<void> {
    if (!this.rpcClient) {
      IcToast.show("Transcription unavailable -- not connected", "error");
      return;
    }
    this._transcribing = true;
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      const result = await this.rpcClient.call(
        "audio.transcribe",
        { audio: btoa(binary), mimeType: blob.type || "audio/webm" },
      );
      const text = result?.text ?? "";
      if (text) this._inputValue += (this._inputValue ? " " : "") + text;
    } catch {
      IcToast.show("Transcription failed", "error");
    } finally {
      this._transcribing = false;
    }
  }

  private async _startRecording(): Promise<void> {
    if (!navigator.mediaDevices) {
      IcToast.show("Microphone access not available", "error");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this._mediaRecorder = new MediaRecorder(stream);
      this._audioChunks = [];
      this._recording = true;
      this._recordingDuration = 0;
      this._recordingTimer = systemSetInterval(() => {
        this._recordingDuration++;
        if (this._recordingDuration >= MAX_RECORDING_DURATION) {
          IcToast.show("Maximum recording duration reached", "warning");
          this._stopRecording();
        }
      }, 1000);
      this._mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) this._audioChunks.push(e.data);
      };
      this._mediaRecorder.onerror = () => {
        IcToast.show("Recording error occurred", "error");
        this._resetRecordingState();
      };
      this._mediaRecorder.onstop = async () => {
        await this._transcribeBlob(new Blob(this._audioChunks, { type: "audio/webm" }));
        stream.getTracks().forEach((t) => t.stop());
      };
      this._mediaRecorder.start();
    } catch {
      IcToast.show("Microphone access denied", "error");
    }
  }

  private _stopRecording(): void {
    if (this._mediaRecorder && this._mediaRecorder.state === "recording") {
      this._mediaRecorder.stop();
    }
    this._resetRecordingState();
  }

  private _resetRecordingState(): void {
    this._recording = false;
    if (this._recordingTimer !== null) {
      systemClearInterval(this._recordingTimer);
      this._recordingTimer = null;
    }
  }

  private _handleDragOver(e: DragEvent): void {
    e.preventDefault();
    this._dragOver = true;
  }

  private _handleDragLeave(): void {
    this._dragOver = false;
  }

  private _handleDrop(e: DragEvent): void {
    e.preventDefault();
    this._dragOver = false;
    const files = e.dataTransfer?.files;
    if (!files) return;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (this._attachments.length >= MAX_ATTACHMENTS) {
        IcToast.show("Maximum 5 attachments per message", "warning");
        break;
      }
      if (file.size > MAX_FILE_SIZE) {
        IcToast.show(`File too large (max 10MB): ${file.name}`, "error");
        continue;
      }
      let type: AttachmentData["type"] = "file";
      let previewUrl: string | undefined;
      if (file.type.startsWith("image/")) {
        type = "image";
        previewUrl = URL.createObjectURL(file);
      } else if (file.type.startsWith("audio/")) {
        type = "audio";
      }
      const attachment: AttachmentData = {
        id: crypto.randomUUID(),
        file,
        type,
        previewUrl,
      };
      this._attachments = [...this._attachments, attachment];
    }
  }

  private _removeAttachment(id: string): void {
    const att = this._attachments.find((a) => a.id === id);
    if (att?.previewUrl) {
      URL.revokeObjectURL(att.previewUrl);
    }
    this._attachments = this._attachments.filter((a) => a.id !== id);
  }

  private _getFilteredSlashCommands() {
    if (!this._slashFilter) return [...SLASH_COMMANDS];
    const filter = this._slashFilter.toLowerCase();
    return SLASH_COMMANDS.filter((cmd) =>
      cmd.command.toLowerCase().includes(filter) ||
      cmd.description.toLowerCase().includes(filter),
    );
  }

  private async _executeSlashCommand(command: string): Promise<void> {
    this._showSlashMenu = false;
    this._inputValue = "";
    switch (command) {
      case "/new":
        await this._createNewSession();
        break;
      case "/reset":
        if (this.rpcClient) {
          const target = this._activeSessionTarget();
          if (!target) break;
          try {
            await this.rpcClient.call("session.reset", {
              tenant_id: target.tenantId,
              agent_id: target.agentId,
              conversation_ref: target.conversationRef,
            });
            IcToast.show("Session reset", "success");
            await this._loadSessionHistory();
          } catch {
            IcToast.show("Failed to reset session", "error");
          }
        }
        break;
      case "/export":
        if (this.rpcClient) {
          const target = this._activeSessionTarget();
          if (!target) break;
          try {
            const result = await this.rpcClient.call(
              "session.export",
              {
                tenant_id: target.tenantId,
                agent_id: target.agentId,
                conversation_ref: target.conversationRef,
              },
            );
            const data = JSON.stringify(result, null, 2);
            if (data) {
              const blob = new Blob([data], { type: "application/jsonl" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = `session-${this._activeSession.slice(0, 8)}.jsonl`;
              a.click();
              URL.revokeObjectURL(url);
            }
          } catch {
            IcToast.show("Failed to export session", "error");
          }
        }
        break;
      case "/compact":
        if (this.rpcClient) {
          const target = this._activeSessionTarget();
          if (!target) break;
          try {
            await this.rpcClient.call("session.compact", {
              tenant_id: target.tenantId,
              agent_id: target.agentId,
              conversation_ref: target.conversationRef,
            });
            IcToast.show("Session compacted", "success");
          } catch {
            IcToast.show("Failed to compact session", "error");
          }
        }
        break;
      case "/switch": {
        const select = this.shadowRoot?.querySelector(".agent-select") as HTMLSelectElement | null;
        if (select) select.focus();
        break;
      }
      case "/help": {
        const helpLines = SLASH_COMMANDS.map((c) => `${c.command} - ${c.description}`).join("\n");
        const helpMsg: ChatMessageData = {
          id: crypto.randomUUID(),
          role: "system",
          content: `Available commands:\n${helpLines}`,
          timestamp: systemNowMs(),
        };
        this._messages = [...this._messages, helpMsg];
        break;
      }
    }
  }

  private async _handleRetry(e: CustomEvent<{ messageId: string }>): Promise<void> {
    const { messageId } = e.detail;
    const idx = this._messages.findIndex((m) => m.id === messageId);
    if (idx < 0) return;
    // Find the preceding user message
    let userMsg: ChatMessageData | undefined;
    for (let i = idx - 1; i >= 0; i--) {
      if (this._messages[i].role === "user") { userMsg = this._messages[i]; break; }
    }
    this._messages = this._messages.filter((m) => m.id !== messageId);
    const request = this._captureChatRequest();
    if (userMsg && request && this._canSendToActiveSession()) {
      this._historyRequestRevision += 1;
      this._budgetRequestRevision += 1;
      const requestId = ++this._sendRequestRevision;
      this._sendingRequestId = requestId;
      this._sending = true;
      this._scrollToBottom();
      try {
        await this._chatRoundTrip(userMsg.content, "Retry failed", request);
        if (!this._isCurrentChatRequest(request)) return;
        this._scrollToBottom();
        this._focusInput();
      } finally {
        if (this._sendingRequestId === requestId) {
          this._sendingRequestId = undefined;
          this._sending = false;
        }
      }
    }
  }

  private _handleDelete(e: CustomEvent<{ messageId: string }>): void {
    const { messageId } = e.detail;
    this._messages = this._messages.filter((m) => m.id !== messageId);
    // Platform-level message.delete requires channel_type, channel_id, message_id
    // -- not available in session context. Local removal only.
  }

  private get _filteredSessions(): ChatSessionInfo[] {
    return filterChatSessions(this._sessions, this._searchQuery);
  }

  private _renderSidebar() {
    return html`
      <ic-session-sidebar
        .sessions=${this._filteredSessions}
        .selectedKey=${this._activeSession}
        .filter=${this._searchQuery}
        ?open=${this._sidebarOpen}
        @session-selected=${(e: CustomEvent<{ key: string }>) => this._selectSession(e.detail.key)}
        @filter-changed=${(e: CustomEvent<{ value: string }>) => { this._searchQuery = e.detail.value; }}
        @new-session=${() => this._createNewSession()}
      ></ic-session-sidebar>
    `;
  }

  private _renderConversation() {
    return html`
      <div
        class="conversation"
        @dragover=${this._handleDragOver}
        @dragleave=${this._handleDragLeave}
        @drop=${this._handleDrop}
      >
        ${this._renderConvHeader()}
        ${this._renderMessageArea()}
        ${this._activeSession || this._messages.length > 0 || !this._loading
          ? this._renderInputBar()
          : nothing}
        ${this._dragOver
          ? html`<div class="drag-overlay"><ic-icon name="attach" size="24px"></ic-icon> Drop files here</div>`
          : nothing}
      </div>
    `;
  }

  private _renderConvHeader() {
    return html`
      <div class="conv-header">
        <button
          class="mobile-toggle"
          @click=${() => { this._sidebarOpen = !this._sidebarOpen; }}
          aria-label="Toggle sidebar"
        >
          <ic-icon name="menu" size="20px"></ic-icon>
        </button>
        <select
          class="agent-select"
          aria-label="Agent"
          .value=${this._selectedAgent}
          @change=${this._handleAgentChange}
        >
          ${this._agents.map(
            (a) => html`<option value=${a.id}>${a.name} (${a.model})</option>`,
          )}
        </select>
        ${this._activeSession
          ? html`
              <div class="session-info">
                <span class="session-info-key">${this._activeSession.length > 12 ? `${this._activeSession.slice(0, 12)}…` : this._activeSession}</span>
                <span>${this._messages.length} messages</span>
              </div>
            `
          : nothing}
      </div>
    `;
  }

  private _renderMessageArea() {
    return html`
      <ic-message-renderer
        .messages=${this._messages}
        ?streaming=${this._streaming}
        ?sending=${this._sending}
        ?loading=${this._loading}
        ?hasSession=${!!this._activeSession}
        .streamingContent=${this._streamingContent}
        .streamingTokens=${this._streamingTokens}
        .authToken=${this.authToken ?? ""}
        ?hasNewMessages=${this._hasNewMessages}
        @retry=${this._handleRetry}
        @delete=${this._handleDelete}
        @scroll-to-bottom=${() => this._scrollToBottom()}
        @scroll=${this._handleScroll}
      ></ic-message-renderer>
    `;
  }

  /* _renderMessage and _renderStreamingIndicator extracted to message-renderer sub-component */

  private _renderInputBar() {
    const filteredCmds = this._getFilteredSlashCommands();
    const canSend = this._canSendToActiveSession();
    const sendDisabled =
      !canSend
      || (this._inputValue.trim() === "" && this._attachments.length === 0)
      || this._sending;
    return html`
      <div class="input-bar">
        ${this._showSlashMenu && filteredCmds.length > 0
          ? html`
              <div class="slash-menu" role="listbox">
                ${filteredCmds.map(
                  (cmd, i) => html`
                    <div
                      class="slash-item ${i === this._slashSelectedIndex ? "slash-item--active" : ""}"
                      role="option"
                      aria-selected=${i === this._slashSelectedIndex}
                      @click=${() => this._executeSlashCommand(cmd.command)}
                    >
                      <ic-icon name=${cmd.icon} size="16px" color="var(--ic-text-muted)"></ic-icon>
                      <span class="slash-cmd">${cmd.command}</span>
                      <span class="slash-desc">${cmd.description}</span>
                    </div>
                  `,
                )}
              </div>
            `
          : nothing}
        ${this._budgetSegments.length > 0 ? html`
          <div class="budget-bar-area">
            <ic-budget-segment-bar
              .segments=${this._budgetSegments}
              .total=${this._budgetTotal}
            ></ic-budget-segment-bar>
          </div>
        ` : nothing}
        ${this._attachments.length > 0
          ? html`
              <div class="attachment-strip">
                ${this._attachments.map((att) => this._renderAttachmentPreview(att))}
              </div>
            `
          : nothing}
        <div class="input-row">
          ${this._renderVoiceButton()}
          <textarea
            class="input-textarea"
            aria-label="Message"
            placeholder="Type a message... (Enter to send, Shift+Enter for newline)"
            maxlength="10000"
            .value=${this._inputValue}
            ?disabled=${this._sending || !canSend}
            @input=${this._handleInput}
            @keydown=${this._handleKeydown}
          ></textarea>
          <button
            class="send-btn"
            ?disabled=${sendDisabled}
            @click=${this._sendMessage}
            aria-label="Send message"
          >
            <ic-icon name="send" size="18px"></ic-icon>
          </button>
        </div>
      </div>
    `;
  }

  private _renderVoiceButton() {
    if (this._transcribing) {
      return html`
        <button class="voice-btn" disabled aria-label="Transcribing">
          <ic-loading size="sm"></ic-loading>
        </button>
      `;
    }
    if (this._recording) {
      const mins = Math.floor(this._recordingDuration / 60);
      const secs = this._recordingDuration % 60;
      const timeStr = `${mins}:${secs.toString().padStart(2, "0")}`;
      return html`
        <div class="recording-indicator">
          <span class="recording-dot"></span>
          <span class="recording-time">${timeStr}</span>
          <button
            class="voice-btn voice-btn--recording"
            @click=${this._stopRecording}
            aria-label="Stop recording"
          >
            <ic-icon name="stop" size="18px"></ic-icon>
          </button>
        </div>
      `;
    }
    return html`
      <button
        class="voice-btn"
        @click=${this._startRecording}
        aria-label="Start voice recording"
      >
        <ic-icon name="microphone" size="18px"></ic-icon>
      </button>
    `;
  }

  private _renderAttachmentPreview(att: AttachmentData) {
    return html`
      <div class="attachment-preview">
        ${att.type === "image" && att.previewUrl
          ? html`<img src=${att.previewUrl} alt=${att.file.name}>`
          : att.type === "audio"
          ? html`<ic-icon name="audio-wave" size="16px"></ic-icon>`
          : html`<ic-icon name="attach" size="16px"></ic-icon>`}
        <span>${att.file.name}</span>
        <button
          class="attachment-remove"
          @click=${() => this._removeAttachment(att.id)}
          aria-label="Remove attachment"
        >\u2715</button>
      </div>
    `;
  }

  override render() {
    return html`
      ${this._renderSidebar()}
      ${this._renderConversation()}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-chat-console": IcChatConsole;
  }
}
