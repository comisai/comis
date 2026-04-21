// SPDX-License-Identifier: Apache-2.0
import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state, query } from "lit/decorators.js";
import type { ApiClient, ChatResponse, ChatHistoryMessage } from "../api/api-client.js";

/** A single chat message in the conversation. */
interface ChatMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly timestamp: number;
  readonly error?: boolean;
}

/**
 * Chat view component for conversing with the Comis agent.
 *
 * Features:
 * - Message list with user/assistant bubbles (blue right / gray left)
 * - Auto-growing text input with Enter to send, Shift+Enter for newline
 * - Streaming indication (blinking cursor) during response
 * - Session maintained via crypto.randomUUID()
 * - Error handling with inline message display
 * - Auto-scroll to latest message
 */
@customElement("ic-chat")
export class IcChat extends LitElement {
  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: calc(100vh - 6.5rem);
      max-height: calc(100vh - 6.5rem);
    }

    .chat-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.75rem 0;
      border-bottom: 1px solid #1f2937;
      margin-bottom: 0.75rem;
      flex-shrink: 0;
    }

    .chat-title {
      font-size: 0.875rem;
      font-weight: 600;
      color: #f3f4f6;
    }

    .session-badge {
      font-size: 0.6875rem;
      color: #6b7280;
      background: #1f2937;
      padding: 0.25rem 0.5rem;
      border-radius: 0.25rem;
      font-family: ui-monospace, monospace;
    }

    .messages-container {
      flex: 1;
      overflow-y: auto;
      padding: 0.75rem 0;
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }

    .message {
      display: flex;
      flex-direction: column;
      max-width: 75%;
      animation: fadeIn 0.15s ease;
    }

    @keyframes fadeIn {
      from {
        opacity: 0;
        transform: translateY(4px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    .message-user {
      align-self: flex-end;
    }

    .message-assistant {
      align-self: flex-start;
    }

    .message-bubble {
      padding: 0.625rem 0.875rem;
      border-radius: 0.75rem;
      font-size: 0.875rem;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .message-user .message-bubble {
      background: #2563eb;
      color: #ffffff;
      border-bottom-right-radius: 0.25rem;
    }

    .message-assistant .message-bubble {
      background: #1f2937;
      color: #e5e7eb;
      border-bottom-left-radius: 0.25rem;
    }

    .message-error .message-bubble {
      background: #7f1d1d;
      color: #fca5a5;
    }

    .message-time {
      font-size: 0.6875rem;
      color: #4b5563;
      margin-top: 0.25rem;
      padding: 0 0.25rem;
    }

    .message-user .message-time {
      text-align: right;
    }

    /* Streaming indicator */
    .streaming-cursor {
      display: inline-block;
      width: 0.5rem;
      height: 1rem;
      background: #6b7280;
      margin-left: 0.125rem;
      vertical-align: text-bottom;
      animation: blink 1s step-end infinite;
    }

    @keyframes blink {
      0%,
      100% {
        opacity: 1;
      }
      50% {
        opacity: 0;
      }
    }

    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      flex: 1;
      color: #4b5563;
      gap: 0.5rem;
    }

    .empty-icon {
      font-size: 2rem;
      opacity: 0.5;
    }

    .empty-text {
      font-size: 0.875rem;
    }

    .empty-hint {
      font-size: 0.75rem;
      color: #374151;
    }

    /* Input area */
    .input-area {
      display: flex;
      gap: 0.5rem;
      padding: 0.75rem 0;
      border-top: 1px solid #1f2937;
      flex-shrink: 0;
      align-items: flex-end;
    }

    .input-wrapper {
      flex: 1;
      position: relative;
    }

    .chat-input {
      width: 100%;
      min-height: 2.5rem;
      max-height: 8rem;
      padding: 0.5rem 0.75rem;
      background: #1f2937;
      border: 1px solid #374151;
      border-radius: 0.5rem;
      color: #f3f4f6;
      font-size: 0.875rem;
      font-family: inherit;
      line-height: 1.5;
      resize: none;
      outline: none;
      overflow-y: auto;
      box-sizing: border-box;
    }

    .chat-input:focus {
      border-color: #3b82f6;
    }

    .chat-input::placeholder {
      color: #6b7280;
    }

    .chat-input:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .send-btn {
      padding: 0.5rem 1rem;
      background: #3b82f6;
      color: white;
      border: none;
      border-radius: 0.5rem;
      font-size: 0.875rem;
      font-weight: 500;
      cursor: pointer;
      height: 2.5rem;
      flex-shrink: 0;
      font-family: inherit;
      transition: background 0.15s;
    }

    .send-btn:hover:not(:disabled) {
      background: #2563eb;
    }

    .send-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
  `;

  @property({ attribute: false }) apiClient: ApiClient | null = null;

  @state() private _messages: ChatMessage[] = [];
  @state() private _sending = false;
  @state() private _inputValue = "";
  @state() private _loadingHistory = false;

  @query(".messages-container") private _messagesContainer!: HTMLElement;

  private _sessionId: string =
    (typeof sessionStorage !== "undefined" && sessionStorage.getItem("comis_chat_session")) ||
    crypto.randomUUID();

  override connectedCallback(): void {
    super.connectedCallback();
    // Persist session ID
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.setItem("comis_chat_session", this._sessionId);
    }
    // Note: _loadHistory() is NOT called here -- apiClient is typically
    // null at this point. The updated() callback handles loading once
    // the client property is set.
  }

  override updated(changed: Map<string, unknown>): void {
    if (changed.has("apiClient") && this.apiClient && this._messages.length === 0) {
      this._loadHistory();
    }
  }

  private async _loadHistory(): Promise<void> {
    if (!this.apiClient || this._loadingHistory) return;
    this._loadingHistory = true;
    try {
      const history = await this.apiClient.getChatHistory();
      if (history.length > 0 && this._messages.length === 0) {
        this._messages = history.map((msg: ChatHistoryMessage) => ({
          id: crypto.randomUUID(),
          role: msg.role,
          content: msg.content,
          timestamp: msg.timestamp,
        }));
        this._scrollToBottom();
      }
    } catch {
      // History load failure is non-fatal
    } finally {
      this._loadingHistory = false;
    }
  }

  private _formatTime(timestamp: number): string {
    const date = new Date(timestamp);
    return date.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  private _scrollToBottom(): void {
    requestAnimationFrame(() => {
      if (this._messagesContainer) {
        this._messagesContainer.scrollTop = this._messagesContainer.scrollHeight;
      }
    });
  }

  private _handleInput(e: Event): void {
    const textarea = e.target as HTMLTextAreaElement;
    this._inputValue = textarea.value;

    // Auto-grow textarea
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 128)}px`;
  }

  private _handleKeyDown(e: KeyboardEvent): void {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      this._sendMessage();
    }
  }

  /** Create a ChatMessage with a generated ID and current timestamp. */
  private _createMessage(
    role: ChatMessage["role"],
    content: string,
    error?: boolean,
  ): ChatMessage {
    return {
      id: crypto.randomUUID(),
      role,
      content,
      timestamp: Date.now(),
      ...(error ? { error } : {}),
    };
  }

  /** Reset textarea height and scroll to bottom of messages. */
  private _resetInput(): void {
    const textarea = this.shadowRoot?.querySelector(".chat-input") as HTMLTextAreaElement | null;
    if (textarea) {
      textarea.style.height = "auto";
    }
    this._scrollToBottom();
  }

  private async _sendMessage(): Promise<void> {
    const text = this._inputValue.trim();
    if (!text || this._sending || !this.apiClient) return;

    this._messages = [...this._messages, this._createMessage("user", text)];
    this._inputValue = "";
    this._sending = true;
    this._resetInput();

    try {
      const response: ChatResponse = await this.apiClient.chat(text);

      // Update session ID if server provides one
      if (response.sessionId) {
        this._sessionId = response.sessionId;
      }

      this._messages = [...this._messages, this._createMessage("assistant", response.response)];
    } catch (err) {
      const raw = err instanceof Error ? err.message : "";
      // Show generic message for server errors; show user-friendly message for known client errors
      const content = raw.startsWith("Request failed")
        ? "Unable to reach the agent. Please try again."
        : (raw || "Failed to get response from agent");
      this._messages = [...this._messages, this._createMessage("assistant", content, true)];
    } finally {
      this._sending = false;
      this._scrollToBottom();
    }
  }

  private _renderMessage(msg: ChatMessage) {
    const roleClass = msg.role === "user" ? "message-user" : "message-assistant";
    const errorClass = msg.error ? "message-error" : "";

    return html`
      <div class="message ${roleClass} ${errorClass}">
        <div class="message-bubble">${msg.content}</div>
        <span class="message-time">${this._formatTime(msg.timestamp)}</span>
      </div>
    `;
  }

  override render() {
    const shortSession = this._sessionId.slice(0, 8);

    return html`
      <div class="chat-header">
        <span class="chat-title">Chat</span>
        <span class="session-badge">session: ${shortSession}</span>
      </div>

      <div class="messages-container">
        ${
          this._messages.length === 0 && !this._sending
            ? this._loadingHistory
              ? html`<div class="empty-state"><span class="empty-text">Loading history...</span></div>`
              : html`
                <div class="empty-state">
                  <span class="empty-icon">\u25AC</span>
                  <span class="empty-text">No messages yet</span>
                  <span class="empty-hint">Send a message to start chatting with the agent</span>
                </div>
              `
            : nothing
        }
        ${this._messages.map((msg) => this._renderMessage(msg))}
        ${
          this._sending
            ? html`
                <div class="message message-assistant">
                  <div class="message-bubble">
                    <span class="streaming-cursor"></span>
                  </div>
                </div>
              `
            : nothing
        }
      </div>

      <div class="input-area">
        <div class="input-wrapper">
          <textarea
            class="chat-input"
            placeholder="Type a message... (Enter to send, Shift+Enter for newline)"
            .value=${this._inputValue}
            @input=${this._handleInput}
            @keydown=${this._handleKeyDown}
            ?disabled=${this._sending}
            rows="1"
            maxlength="10000"
          ></textarea>
        </div>
        <button
          class="send-btn"
          @click=${() => this._sendMessage()}
          ?disabled=${this._sending || !this._inputValue.trim()}
        >
          ${this._sending ? "Sending..." : "Send"}
        </button>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-chat": IcChat;
  }
}
