// Commands barrel - re-exports all command types, parser, and handler

// Types
export type {
  CommandType,
  ParsedCommand,
  CommandDirectives,
  CommandResult,
  CommandHandlerDeps,
  PromptSkillDirective,
} from "./types.js";

// Parser
export { parseSlashCommand } from "./command-parser.js";

// Handler
export { createCommandHandler } from "./command-handler.js";
export type { CommandHandler } from "./command-handler.js";

// Budget command parser
export { parseUserTokenBudget, MIN_USER_BUDGET, MAX_USER_BUDGET } from "./budget-command.js";
export type { ParsedBudget } from "./budget-command.js";

// Prompt skill command matcher
export { matchPromptSkillCommand, detectSkillCollisions, RESERVED_COMMAND_NAMES } from "./prompt-skill-command.js";
export type { PromptSkillMatch, CollisionWarning } from "./prompt-skill-command.js";
