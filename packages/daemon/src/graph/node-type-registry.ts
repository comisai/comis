// SPDX-License-Identifier: Apache-2.0
/**
 * Node type driver registry.
 * Simple hardcoded Map-based registry populated with all 7 built-in drivers:
 * 4 sequential (agent, debate, refine, collaborate) and 3 parallel/interactive
 * (vote, approval-gate, map-reduce).
 * @module
 */

import type { NodeTypeDriver } from "@comis/core";
import { createAgentDriver } from "./drivers/agent-driver.js";
import { createDebateDriver } from "./drivers/debate-driver.js";
import { createRefineDriver } from "./drivers/refine-driver.js";
import { createCollaborateDriver } from "./drivers/collaborate-driver.js";
import { createVoteDriver } from "./drivers/vote-driver.js";
import { createApprovalGateDriver } from "./drivers/approval-gate-driver.js";
import { createMapReduceDriver } from "./drivers/map-reduce-driver.js";

/** Read-only registry interface for node type driver lookup and validation. */
export interface NodeTypeRegistry {
  get(typeId: string): NodeTypeDriver | undefined;
  list(): readonly NodeTypeDriver[];
  validateConfig(typeId: string, typeConfig: Record<string, unknown>): string[];
}

/**
 * Create a NodeTypeRegistry populated with all 7 built-in drivers.
 */
export function createNodeTypeRegistry(): NodeTypeRegistry {
  const drivers = new Map<string, NodeTypeDriver>();

  for (const driver of [
    createAgentDriver(),
    createDebateDriver(),
    createRefineDriver(),
    createCollaborateDriver(),
    createVoteDriver(),
    createApprovalGateDriver(),
    createMapReduceDriver(),
  ]) {
    drivers.set(driver.typeId, driver);
  }

  return {
    get: (typeId) => drivers.get(typeId),
    list: () => [...drivers.values()],
    validateConfig(typeId, typeConfig) {
      const driver = drivers.get(typeId);
      if (!driver) return [`Unknown node type: ${typeId}`];
      const result = driver.configSchema.safeParse(typeConfig);
      if (result.success) return [];
      return result.error.issues.map((i) =>
        `${i.path.join(".")}: ${i.message}`
      );
    },
  };
}
