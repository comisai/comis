/**
 * Action classifier for security-aware action categorization.
 *
 * Every action in the system gets classified as read, mutate, or destructive.
 * Unknown actions default to "destructive" (fail-closed principle).
 *
 * Action classification for audit logging and confirmation gates.
 */

/**
 * Classification of an action's risk level.
 * - "read": No side effects, safe to auto-approve
 * - "mutate": Modifiable side effects, logged but auto-approved
 * - "destructive": Irreversible or high-risk, requires confirmation
 */
export type ActionClassification = "read" | "mutate" | "destructive";

/**
 * Whether the action registry has been locked.
 * Once locked, no new actions can be registered (prevents runtime classification downgrades).
 */
let locked = false;

/**
 * Registry mapping action types to their classifications.
 * Extensible via registerAction(). Unknown actions default to "destructive".
 */
const ACTION_REGISTRY = new Map<string, ActionClassification>([
  // -------------------------------------------------------------------------
  // Read operations
  // -------------------------------------------------------------------------
  ["file.read", "read"],
  ["memory.search", "read"],
  ["memory.get", "read"],
  ["config.read", "read"],
  ["status.check", "read"],
  ["skill.list", "read"],
  ["skill.load", "read"],
  ["skill.scan", "read"],
  ["skill.scan.reject", "read"],
  ["session.get", "read"],
  ["log.read", "read"],

  // -------------------------------------------------------------------------
  // Read operations (v2.0 tool actions)
  // -------------------------------------------------------------------------
  ["tool.execute", "read"],
  ["cron.list", "read"],
  ["cron.status", "read"],
  ["cron.runs", "read"],
  ["cron.wake", "read"],
  ["session.list", "read"],
  ["session.history", "read"],
  ["session.status", "read"],
  ["session.run_status", "read"],
  ["message.fetch", "read"],
  ["agents.list", "read"],
  ["gateway.status", "read"],
  ["config.schema", "read"],
  ["web.fetch", "read"],
  ["web.search", "read"],
  ["image.analyze", "read"],
  ["media.transcribe", "read"],
  ["media.describe_video", "read"],
  ["media.extract_document", "read"],
  ["memory.search_files", "read"],
  ["memory.get_file", "read"],
  ["config.history", "read"],
  ["config.diff", "read"],

  // -------------------------------------------------------------------------
  // Mutate operations
  // -------------------------------------------------------------------------
  ["file.write", "mutate"],
  ["file.create", "mutate"],
  ["memory.store", "mutate"],
  ["memory.update", "mutate"],
  ["config.update", "mutate"],
  ["message.send", "mutate"],
  ["session.create", "mutate"],
  ["skill.install", "mutate"],
  ["skill.execute", "mutate"],

  // -------------------------------------------------------------------------
  // Mutate operations (v2.0 tool actions)
  // -------------------------------------------------------------------------
  ["message.reply", "mutate"],
  ["message.react", "mutate"],
  ["message.edit", "mutate"],
  ["cron.update", "mutate"],
  ["session.send", "mutate"],
  ["session.send_wait", "mutate"],
  ["config.patch", "destructive"],
  ["config.apply", "destructive"],
  ["tts.synthesize", "mutate"],
  ["canvas.present", "mutate"],
  ["canvas.eval", "mutate"],

  // -------------------------------------------------------------------------
  // Destructive operations
  // -------------------------------------------------------------------------
  ["file.delete", "destructive"],
  ["memory.delete", "destructive"],
  ["memory.clear", "destructive"],
  ["session.destroy", "destructive"],
  ["skill.uninstall", "destructive"],
  ["config.reset", "destructive"],
  ["system.shutdown", "destructive"],
  ["system.exec", "destructive"],

  // -------------------------------------------------------------------------
  // Mutate operations (v2.0 — reversible scheduling)
  // -------------------------------------------------------------------------
  ["cron.add", "mutate"],

  // -------------------------------------------------------------------------
  // Destructive operations (v2.0 tool actions)
  // -------------------------------------------------------------------------
  ["cron.remove", "destructive"],
  ["message.delete", "destructive"],
  ["session.spawn", "mutate"],

  // Subagent operations
  ["subagent.list", "read"],
  ["subagent.kill", "mutate"],
  ["subagent.steer", "mutate"],

  ["gateway.restart", "destructive"],
  ["gateway.update", "destructive"],
  ["config.rollback", "destructive"],
  ["config.gc", "destructive"],
  ["env.set", "destructive"],

  // -------------------------------------------------------------------------
  // Daemon infrastructure operations
  // -------------------------------------------------------------------------
  ["daemon.setLogLevel", "mutate"],

  // -------------------------------------------------------------------------
  // Browser operations
  // -------------------------------------------------------------------------

  // Read operations
  ["browser.status", "read"],
  ["browser.tabs", "read"],
  ["browser.profiles", "read"],
  ["browser.snapshot", "read"],
  ["browser.console", "read"],

  // Mutate operations
  ["browser.start", "mutate"],
  ["browser.stop", "mutate"],
  ["browser.navigate", "mutate"],
  ["browser.open", "mutate"],
  ["browser.focus", "mutate"],
  ["browser.close", "mutate"],
  ["browser.screenshot", "mutate"],
  ["browser.pdf", "mutate"],
  ["browser.act", "mutate"],

  // -------------------------------------------------------------------------
  // Platform-specific actions
  // -------------------------------------------------------------------------

  // Discord
  ["discord.pin", "mutate"],
  ["discord.unpin", "mutate"],
  ["discord.kick", "destructive"],
  ["discord.ban", "destructive"],
  ["discord.unban", "mutate"],
  ["discord.role_add", "mutate"],
  ["discord.role_remove", "mutate"],
  ["discord.set_topic", "mutate"],
  ["discord.set_slowmode", "mutate"],
  ["discord.guild_info", "read"],
  ["discord.channel_info", "read"],

  // Telegram
  ["telegram.pin", "mutate"],
  ["telegram.unpin", "mutate"],
  ["telegram.poll", "mutate"],
  ["telegram.sticker", "mutate"],
  ["telegram.chat_info", "read"],
  ["telegram.member_count", "read"],
  ["telegram.get_admins", "read"],
  ["telegram.set_title", "mutate"],
  ["telegram.set_description", "mutate"],
  ["telegram.ban", "destructive"],
  ["telegram.unban", "mutate"],
  ["telegram.promote", "destructive"],

  // Slack
  ["slack.pin", "mutate"],
  ["slack.unpin", "mutate"],
  ["slack.set_topic", "mutate"],
  ["slack.set_purpose", "mutate"],
  ["slack.archive", "destructive"],
  ["slack.unarchive", "mutate"],
  ["slack.create_channel", "destructive"],
  ["slack.invite", "mutate"],
  ["slack.kick", "destructive"],
  ["slack.channel_info", "read"],
  ["slack.members_list", "read"],
  ["slack.bookmark_add", "mutate"],

  // WhatsApp
  ["whatsapp.group_info", "read"],
  ["whatsapp.group_update_subject", "mutate"],
  ["whatsapp.group_update_description", "mutate"],
  ["whatsapp.group_participants_add", "mutate"],
  ["whatsapp.group_participants_remove", "destructive"],
  ["whatsapp.group_promote", "destructive"],
  ["whatsapp.group_demote", "mutate"],
  ["whatsapp.group_settings", "mutate"],
  ["whatsapp.group_invite_code", "read"],
  ["whatsapp.profile_status", "mutate"],
  ["whatsapp.group_leave", "destructive"],

  // -------------------------------------------------------------------------
  // Model failover & slash commands
  // -------------------------------------------------------------------------

  // Read operations
  ["model.fallback", "read"],
  ["model.list", "read"],
  ["command.parse", "read"],
  ["command.context", "read"],
  ["command.status", "read"],

  // Mutate operations
  ["model.switch", "mutate"],
  ["session.compact", "mutate"],

  // Destructive operations
  ["session.new", "destructive"],
  ["session.reset", "destructive"],

  // -------------------------------------------------------------------------
  // Prompt skill operations
  // -------------------------------------------------------------------------
  ["skill.prompt.load", "read"],
  ["skill.prompt.invoke", "mutate"],

  // -------------------------------------------------------------------------
  // Privileged tool operations
  // -------------------------------------------------------------------------

  // Agent management
  ["agents.create", "destructive"],
  ["agents.get", "read"],
  ["agents.update", "mutate"],
  ["agents.delete", "destructive"],
  ["agents.suspend", "destructive"],
  ["agents.resume", "mutate"],

  // Session management (session.reset, session.compact already exist above)
  ["session.delete", "destructive"],
  ["session.export", "read"],

  // Memory management (memory.delete already exists above)
  ["memory.stats", "read"],
  ["memory.browse", "read"],
  ["memory.flush", "destructive"],
  ["memory.export", "read"],

  // Channel management
  ["channels.list", "read"],
  ["channels.get", "read"],
  ["channels.enable", "destructive"],
  ["channels.disable", "destructive"],
  ["channels.restart", "destructive"],

  // Token management
  ["tokens.list", "read"],
  ["tokens.create", "destructive"],
  ["tokens.revoke", "destructive"],
  ["tokens.rotate", "destructive"],

  // Model management
  ["models.list", "read"],
  ["models.test", "read"],

  // -------------------------------------------------------------------------
  // Graph pipeline operations
  // -------------------------------------------------------------------------
  ["graph.define", "mutate"],
  ["graph.execute", "mutate"],
  ["graph.status", "read"],
  ["graph.save", "mutate"],
  ["graph.load", "read"],
  ["graph.list", "read"],
  ["graph.cancel", "destructive"],
  ["graph.delete", "destructive"],
]);

/**
 * Classify an action type by its risk level.
 *
 * Returns the registered classification, or "destructive" for unknown actions
 * (fail-closed: unknown operations are treated as highest risk).
 *
 * @param actionType - The action identifier (e.g., "file.read", "memory.delete")
 * @returns The action's classification
 */
export function classifyAction(actionType: string): ActionClassification {
  return ACTION_REGISTRY.get(actionType) ?? "destructive";
}

/**
 * Check whether an action type requires user confirmation before execution.
 *
 * Currently, only "destructive" actions require confirmation.
 *
 * @param actionType - The action identifier
 * @returns true if the action requires confirmation
 */
export function requiresConfirmation(actionType: string): boolean {
  return classifyAction(actionType) === "destructive";
}

/**
 * Lock the action registry, preventing any further registrations.
 *
 * Call this after bootstrap to prevent runtime classification downgrades
 * by malicious plugins. Idempotent — calling multiple times is a no-op.
 */
export function lockRegistry(): void {
  locked = true;
}

/**
 * Check whether the action registry is currently locked.
 *
 * @returns true if lockRegistry() has been called
 */
export function isRegistryLocked(): boolean {
  return locked;
}

/**
 * Reset the registry lock state. For testing only.
 * @internal
 */
export function _resetRegistryForTesting(): void {
  locked = false;
}

/**
 * Register a new action type with its classification.
 *
 * Use this to extend the registry for custom skills or plugins.
 * Overwrites any existing registration for the same action type.
 * Throws if the registry has been locked via lockRegistry().
 *
 * @param actionType - The action identifier
 * @param classification - The risk classification
 * @throws Error if the registry is locked
 */
export function registerAction(actionType: string, classification: ActionClassification): void {
  if (locked) {
    throw new Error(
      `Action registry is locked — registerAction() rejected for "${actionType}". Lock the registry only after bootstrap.`,
    );
  }
  ACTION_REGISTRY.set(actionType, classification);
}
