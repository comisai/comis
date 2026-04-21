// SPDX-License-Identifier: Apache-2.0
/**
 * Minimal type declarations for irc-framework (no @types available).
 *
 * Only the subset of the API used by Comis's IRC adapter is declared here.
 */
declare module "irc-framework" {
  export class Client {
    connect(options: {
      host: string;
      port?: number;
      nick: string;
      username?: string;
      gecos?: string;
      tls?: boolean;
      auto_reconnect?: boolean;
      auto_reconnect_max_retries?: number;
    }): void;

    on(event: "registered", callback: (event: { nick: string }) => void): void;
    on(
      event: "privmsg" | "message" | "action" | "notice",
      callback: (event: IrcMessageEvent) => void,
    ): void;
    on(event: "error", callback: (event: { message: string; error?: unknown }) => void): void;
    on(event: "reconnecting", callback: (event: { attempt: number }) => void): void;
    on(event: "close", callback: () => void): void;
    on(event: string, callback: (...args: unknown[]) => void): void;

    say(target: string, message: string): void;
    join(channel: string, key?: string): void;
    part(channel: string, message?: string): void;
    quit(message?: string): void;
    setTopic(channel: string, topic: string): void;
    raw(command: string | string[]): void;

    /** The user information for this client */
    user: { nick: string };

    /** Network information */
    network: { name: string };
  }

  export interface IrcMessageEvent {
    target: string;
    nick: string;
    message: string;
    type?: string;
    tags?: Record<string, string>;
    reply: (message: string) => void;
  }
}
