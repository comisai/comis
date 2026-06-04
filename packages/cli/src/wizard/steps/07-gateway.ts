// SPDX-License-Identifier: Apache-2.0
/**
 * Gateway configuration step -- step 07 of the init wizard.
 *
 * Collects network and security settings for the daemon gateway:
 * port (default 4766) and bind mode (loopback/LAN/custom IP). Token is
 * the only supported gateway auth method, so the step always generates
 * a 48-char hex token via crypto.randomBytes (the daemon's
 * GatewayConfigSchema has no password field).
 *
 * Custom IP bind mode validates the address via validateIpAddress.
 *
 * @module
 */

import { randomBytes } from "node:crypto";
import type { WizardState, WizardStep, GatewayConfig } from "../types.js";
import type { WizardPrompter } from "../prompter.js";
import { updateState } from "../state.js";
import { sectionSeparator } from "../theme.js";
import { validatePort } from "../validators/port.js";
import { validateIpAddress } from "../validators/network.js";

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

    // 4. Generate the gateway token -- token is the only supported gateway auth method.
    const token = randomBytes(24).toString("hex");
    prompter.log.info(`Gateway token: ${token}`);
    prompter.log.info("Save this token -- you'll need it for remote access.");

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
      token,
      webEnabled,
    };

    return updateState(state, { gateway: config });
  },
};
