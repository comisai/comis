// SPDX-License-Identifier: Apache-2.0
/**
 * Health aggregator types (ALERT-01).
 *
 * Shared interfaces for the alert budget policy configuration and
 * the `health:budget_exceeded` payload shape.
 *
 * @module
 */

export interface AlertBudgetThreshold {
  readonly count: number;
  readonly windowMs: number;
}

export interface AlertBudgetPolicy {
  readonly enabled: boolean;
  readonly thresholds: Readonly<Record<string, AlertBudgetThreshold>>;
}

export interface BudgetExceededPayload {
  readonly kind: string;
  readonly count: number;
  readonly windowMs: number;
  readonly timestamp: number;
}
