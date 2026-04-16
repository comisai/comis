import { LitElement, html, css, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { sharedStyles } from "../../styles/shared.js";

// Side-effect imports for sub-components used in template
import "../../components/domain/ic-chat-message.js";
import "../../components/domain/ic-tool-call.js";
import "../../components/feedback/ic-empty-state.js";
import "../../components/shell/ic-skeleton-view.js";

/** A single chat message in the conversation. */
export interface ChatMessageData {
  id: string;
  role: "user" | "assistant" | "error" | "system" | "tool";
  content: string;
  timestamp: number;
  toolCalls?: ToolCallData[];
}

/** Tool invocation data attached to assistant messages. */
export interface ToolCallData {
  id: string;
  name: string;
  input: unknown;
  output: unknown;
  status: "running" | "success" | "error";
}

/**
 * Chat message formatting and rendering sub-component.
 * Renders a list of chat messages with tool calls, streaming indicator,
 * and empty state handling.
 *
 * @fires retry - Re-dispatches retry events from ic-chat-message
 * @fires delete - Re-dispatches delete events from ic-chat-message
 */
@customElement("ic-message-renderer")
export class IcMessageRenderer extends LitElement {
  static override styles = [
    sharedStyles,
    css`
      :host {
        display: block;
        flex: 1;
        overflow-y: auto;
      }

      .message-area {
        flex: 1;
        overflow-y: auto;
        padding: var(--ic-space-md);
        display: flex;
        flex-direction: column;
        gap: var(--ic-space-sm);
      }

      .thinking-indicator {
        display: flex;
        align-items: center;
        gap: var(--ic-space-sm);
        padding: var(--ic-space-sm);
        color: var(--ic-text-dim);
        font-size: var(--ic-text-sm);
      }

      .typing-dots {
        display: flex;
        gap: 4px;
      }

      .typing-dot {
        width: 6px;
        height: 6px;
        background: var(--ic-text-dim);
        border-radius: 50%;
        animation: dot-pulse 1.5s infinite;
      }

      .typing-dot:nth-child(2) {
        animation-delay: 0.15s;
      }

      .typing-dot:nth-child(3) {
        animation-delay: 0.3s;
      }

      @keyframes dot-pulse {
        0%, 80%, 100% { opacity: 0.3; }
        40% { opacity: 1; }
      }

      .thinking-label {
        font-style: italic;
      }

      .streaming-indicator {
        display: flex;
        align-items: center;
        gap: var(--ic-space-sm);
        padding: var(--ic-space-xs) var(--ic-space-md);
        color: var(--ic-text-dim);
        font-size: var(--ic-text-xs);
      }

      .token-counter {
        font-family: ui-monospace, monospace;
      }

      .new-messages-btn {
        position: sticky;
        bottom: var(--ic-space-md);
        align-self: center;
        padding: 0.375rem 1rem;
        background: var(--ic-accent);
        color: white;
        border: none;
        border-radius: var(--ic-radius-md);
        font-size: var(--ic-text-xs);
        cursor: pointer;
        font-family: inherit;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
      }
    `,
  ];

  @property({ type: Array }) messages: ChatMessageData[] = [];
  @property({ type: Boolean }) streaming = false;
  @property({ type: Boolean }) sending = false;
  @property({ type: Boolean }) loading = false;
  @property({ type: Boolean }) hasSession = false;
  @property({ type: String }) streamingContent = "";
  @property({ type: Number }) streamingTokens = 0;
  @property({ type: String }) authToken = "";
  @property({ type: Boolean }) hasNewMessages = false;

  private _formatTokens(tokens: number): string {
    if (tokens === 0) return "";
    if (tokens < 1000) return `${tokens} tokens`;
    return `${(tokens / 1000).toFixed(1)}k tokens`;
  }

  private _renderMessage(msg: ChatMessageData) {
    if (msg.role === "tool") {
      let parsedOutput: unknown = msg.content;
      try { parsedOutput = JSON.parse(msg.content); } catch { /* Keep raw content */ }
      return html`
        <ic-tool-call .toolName=${"tool"} .output=${parsedOutput} .status=${"success"}></ic-tool-call>
      `;
    }

    return html`
      <ic-chat-message
        .role=${msg.role}
        .content=${msg.content}
        .timestamp=${msg.timestamp}
        .messageId=${msg.id}
        .mediaToken=${this.authToken}
        @retry=${(e: Event) => this.dispatchEvent(new CustomEvent("retry", { detail: (e as CustomEvent).detail, bubbles: true, composed: true }))}
        @delete=${(e: Event) => this.dispatchEvent(new CustomEvent("delete", { detail: (e as CustomEvent).detail, bubbles: true, composed: true }))}
      ></ic-chat-message>
      ${msg.toolCalls?.map(
        (tc) => html`
          <ic-tool-call
            .toolName=${tc.name}
            .input=${typeof tc.input === "string" ? tc.input : JSON.stringify(tc.input, null, 2)}
            .output=${typeof tc.output === "string" ? tc.output : JSON.stringify(tc.output, null, 2)}
            .status=${tc.status === "running" ? "running" : tc.status === "error" ? "error" : "success"}
          ></ic-tool-call>
        `,
      )}
    `;
  }

  private _renderStreamingIndicator() {
    if (this.streamingContent) {
      return html`
        <ic-chat-message
          .role=${"assistant"} .content=${this.streamingContent}
          .timestamp=${Date.now()} .showActions=${false}
        ></ic-chat-message>
        <div class="streaming-indicator">
          <span class="token-counter">${this._formatTokens(this.streamingTokens)}</span>
        </div>
      `;
    }
    return html`
      <div class="streaming-indicator">
        <div class="typing-dots">
          <span class="typing-dot"></span>
          <span class="typing-dot"></span>
          <span class="typing-dot"></span>
        </div>
        <span class="token-counter">${this._formatTokens(this.streamingTokens)}</span>
      </div>
    `;
  }

  override render() {
    if (this.loading) {
      return html`<ic-skeleton-view variant="detail"></ic-skeleton-view>`;
    }

    if (!this.hasSession) {
      return html`
        <div class="message-area">
          <ic-empty-state icon="chat" message="Select a session"
            description="Choose a session from the sidebar or create a new one."
          ></ic-empty-state>
        </div>
      `;
    }

    if (this.messages.length === 0 && !this.streaming && !this.sending) {
      return html`
        <div class="message-area">
          <ic-empty-state icon="chat" message="No messages yet" description="Start a conversation."></ic-empty-state>
        </div>
      `;
    }

    return html`
      <div class="message-area">
        ${this.messages.map((msg) => this._renderMessage(msg))}
        ${this.sending && !this.streaming
          ? html`<div class="thinking-indicator">
              <div class="typing-dots">
                <span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>
              </div>
              <span class="thinking-label">Thinking...</span>
            </div>`
          : nothing}
        ${this.streaming ? this._renderStreamingIndicator() : nothing}
        ${this.hasNewMessages
          ? html`<button class="new-messages-btn"
              @click=${() => this.dispatchEvent(new CustomEvent("scroll-to-bottom", { bubbles: true, composed: true }))}
            >New messages</button>`
          : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-message-renderer": IcMessageRenderer;
  }
}
