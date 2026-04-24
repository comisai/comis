// SPDX-License-Identifier: Apache-2.0
/**
 * Gateway configuration step -- step 07 of the init wizard.
 *
 * Collects network and security settings for the daemon gateway:
 * port (default 4766), bind mode (loopback/LAN/custom IP), and
 * authentication method (auto-generated token or user-chosen password).
 *
 * Token auth generates a 48-char hex token via crypto.randomBytes.
 * Custom IP bind mode validates the address via validateIpAddress.
 *
 * @module
 */

import { randomBytes } from "node:crypto";
import type { WizardState, WizardStep, WizardPrompter, GatewayConfig } from "../index.js";
import {
  updateState,
  sectionSeparator,
  validatePort,
  validateIpAddress,
} from "../index.js";

// ---------- Step Implementation ----------

export const gatewayStep: WizardStep = {
  id: "gateway",
  label: "Gateway Configuration",

  async execute(state: WizardState, prompter: WizardPrompter): Promise<WizardState> {
    prompter.note(sectionSeparator("Gateway Configuration"));

    // 1. Port prompt
    const portInput = await prompter.text({
      message: "Gateway port",
      placeholder: state.gateway?.port ? String(state.gateway.port) : "4766",
      defaultValue: state.gateway?.port ? String(state.gateway.port) : "4766",
      required: true,
      validate: (value: string) => {
        if (typeof value !== "string") return undefined;
        const result = validatePort(value);
        return result ? result.message : undefined;
      },
    });

    const port = Number(portInput);

    // 2. Bind mode prompt
    const bindMode = await prompter.select<string>({
      message: "Gateway bind mode",
      options: [
        { value: "loopback", label: "Loopback only (127.0.0.1)", hint: "Safest -- local access only" },
        { value: "lan", label: "LAN (0.0.0.0)", hint: "Accessible from local network" },
        { value: "custom", label: "Custom IP", hint: "Bind to a specific interface" },
      ],
      initialValue: state.gateway?.bindMode ?? "loopback",
    });

    // 3. Security hints and custom IP
    let customIp: string | undefined;

    if (bindMode === "lan") {
      prompter.log.warn("LAN mode exposes the gateway to your local network. Use token auth and a firewall.");
    }

    if (bindMode === "custom") {
      customIp = await prompter.text({
        message: "Bind IP address",
        placeholder: state.gateway?.customIp ?? "192.168.1.100",
        defaultValue: state.gateway?.customIp,
        validate: (value: string) => {
          if (typeof value !== "string") return undefined;
          const result = validateIpAddress(value);
          return result ? result.message : undefined;
        },
      });
    }

    // 4. Auth method prompt
    const authMethod = await prompter.select<string>({
      message: "Authentication method",
      options: [
        { value: "token", label: "Token (recommended)", hint: "Auto-generated 48-char hex token" },
        { value: "password", label: "Password", hint: "You choose a password" },
      ],
      initialValue: state.gateway?.authMethod ?? "token",
    });

    // 5. Token generation or password prompt
    let token: string | undefined;
    let password: string | undefined;

    if (authMethod === "token") {
      token = randomBytes(24).toString("hex");
      prompter.log.info(`Gateway token: ${token}`);
      prompter.log.info("Save this token -- you'll need it for remote access.");
    } else {
      password = await prompter.password({
        message: "Gateway password",
        validate: (value: string) => {
          if (typeof value !== "string") return undefined;
          if (value.length < 8) {
            return "Password must be at least 8 characters.";
          }
          return undefined;
        },
      });
    }

    // 5b. Web dashboard prompt
    const webEnabled = await prompter.confirm({
      message: "Enable web dashboard? (served at /app/ on the gateway port)",
      initialValue: state.gateway?.webEnabled ?? true,
    });

    if (webEnabled && bindMode === "loopback") {
      prompter.log.info(
        "Dashboard will bind to 127.0.0.1 only. For remote access, SSH-tunnel: `ssh -L 4766:localhost:4766 user@host`.",
      );
    }

    // 6. Build config and update state
    const config: GatewayConfig = {
      port,
      bindMode: bindMode as GatewayConfig["bindMode"],
      ...(customIp !== undefined && { customIp }),
      authMethod: authMethod as GatewayConfig["authMethod"],
      ...(token !== undefined && { token }),
      ...(password !== undefined && { password }),
      webEnabled,
    };

    return updateState(state, { gateway: config });
  },
};
