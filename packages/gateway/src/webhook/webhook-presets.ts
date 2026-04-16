import type { WebhookMappingConfig } from "@comis/core";

/**
 * Gmail webhook preset configuration.
 *
 * Routes Gmail push notifications to the agent with email metadata
 * extracted from the webhook payload. Session key uses the first
 * message ID for deduplication.
 */
export const GMAIL_PRESET: WebhookMappingConfig = {
  id: "gmail",
  match: { path: "gmail" },
  action: "agent",
  wakeMode: "now",
  name: "Gmail",
  sessionKey: "hook:gmail:{{payload.messages[0].id}}",
  messageTemplate:
    "New email from {{payload.messages[0].from}}\nSubject: {{payload.messages[0].subject}}\n{{payload.messages[0].snippet}}\n{{payload.messages[0].body}}",
};

/**
 * GitHub webhook preset configuration.
 *
 * Routes GitHub webhook events to the agent with event metadata
 * from headers and payload. Session key uses the delivery ID
 * for deduplication.
 */
export const GITHUB_PRESET: WebhookMappingConfig = {
  id: "github",
  match: { path: "github" },
  action: "agent",
  wakeMode: "now",
  name: "GitHub",
  sessionKey: "hook:github:{{headers.x-github-delivery}}",
  messageTemplate:
    "GitHub {{headers.x-github-event}}: {{payload.repository.full_name}}\n{{payload.action}} by {{payload.sender.login}}",
};

/**
 * Map of known preset names to their configurations.
 */
const PRESET_MAP: Record<string, WebhookMappingConfig> = {
  gmail: GMAIL_PRESET,
  github: GITHUB_PRESET,
};

/**
 * Get preset mapping configurations by name.
 *
 * Unknown preset names are silently ignored. Returns configurations
 * in the same order as the input names.
 *
 * @param names - Array of preset names (e.g., ["gmail", "github"])
 * @returns Array of matching preset configurations
 */
export function getPresetMappings(names: string[]): WebhookMappingConfig[] {
  const result: WebhookMappingConfig[] = [];
  for (const name of names) {
    const preset = PRESET_MAP[name.toLowerCase()];
    if (preset) result.push(preset);
  }
  return result;
}
