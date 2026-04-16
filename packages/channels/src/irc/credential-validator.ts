/**
 * IRC Credential Validator: Probes an IRC server for connectivity.
 *
 * Creates a temporary connection with a short timeout to verify that
 * the server is reachable and accepts the configured nick. The test
 * connection is cleanly torn down after validation.
 *
 * @module
 */

import { ok, err, type Result } from "@comis/shared";
import { Client } from "irc-framework";
import { createCredentialValidator } from "../shared/credential-validator-factory.js";

/** Information returned on successful IRC connection probe. */
export interface IrcBotInfo {
  /** IRC server hostname that was connected to */
  host: string;
  /** Confirmed nick after registration */
  nick: string;
  /** Server name reported by the IRC network */
  serverName: string;
}

/** Options for validating an IRC connection. */
export interface ValidateIrcOpts {
  host: string;
  port?: number;
  nick: string;
  tls?: boolean;
}

/** Connection probe timeout in milliseconds. */
const VALIDATE_TIMEOUT_MS = 10_000;

/**
 * Attempt a temporary connection to an IRC server to verify connectivity.
 *
 * Connects with a 10-second timeout. On successful registration, captures
 * server info and disconnects. Returns an error on timeout or connection
 * failure.
 */
export const validateIrcConnection: (opts: ValidateIrcOpts) => Promise<Result<IrcBotInfo, Error>> =
  createCredentialValidator<ValidateIrcOpts, IrcBotInfo>({
    platform: "IRC",
    validateInputs: (opts) => {
      if (!opts.host || opts.host.trim() === "") {
        return "host must not be empty";
      }
      if (!opts.nick || opts.nick.trim() === "") {
        return "nick must not be empty";
      }
      return undefined;
    },
    callApi: (opts) => {
      return new Promise<Result<IrcBotInfo, Error>>((resolve) => {
        const bot = new Client();
        let settled = false;

        const settle = (result: Result<IrcBotInfo, Error>): void => {
          if (settled) return;
          settled = true;
          try {
            bot.quit("validation complete");
          } catch {
            // Best effort cleanup
          }
          clearTimeout(timer);
          resolve(result);
        };

        const timer = setTimeout(() => {
          settle(err(new Error(`IRC connection to ${opts.host} timed out after ${VALIDATE_TIMEOUT_MS}ms`)));
        }, VALIDATE_TIMEOUT_MS);

        bot.on("registered", () => {
          settle(
            ok({
              host: opts.host,
              nick: bot.user.nick,
              serverName: bot.network.name || opts.host,
            }),
          );
        });

        bot.on("error", (event: { message: string }) => {
          settle(err(new Error(`IRC connection error: ${event.message}`)));
        });

        bot.on("close", () => {
          settle(err(new Error(`IRC connection to ${opts.host} closed before registration`)));
        });

        const useTls = opts.tls ?? true;
        bot.connect({
          host: opts.host,
          port: opts.port ?? (useTls ? 6697 : 6667),
          nick: opts.nick,
          tls: useTls,
          auto_reconnect: false,
          auto_reconnect_max_retries: 0,
        });
      });
    },
  });
