import type { HeartbeatConfig, PerAgentHeartbeatConfig } from "@comis/core";

export interface EffectiveHeartbeatConfig {
  enabled: boolean;
  intervalMs: number;
  showOk: boolean;
  showAlerts: boolean;
  target?: { channelType: string; channelId: string; chatId: string; isDm?: boolean };
  prompt?: string;
  session?: string;
  allowDm?: boolean;
  lightContext?: boolean;
  ackMaxChars?: number;
  responsePrefix?: string;
  skipHeartbeatOnlyDelivery?: boolean;
  /** Consecutive failures before alerting */
  alertThreshold?: number;
  /** Minimum ms between alerts for the same agent */
  alertCooldownMs?: number;
  /** Max ms a heartbeat tick can run before stuck detection */
  staleMs?: number;
}

export function resolveEffectiveHeartbeatConfig(
  global: HeartbeatConfig,
  perAgent?: PerAgentHeartbeatConfig,
): EffectiveHeartbeatConfig {
  return {
    enabled: perAgent?.enabled ?? global.enabled,
    intervalMs: perAgent?.intervalMs ?? global.intervalMs,
    showOk: perAgent?.showOk ?? global.showOk,
    showAlerts: perAgent?.showAlerts ?? global.showAlerts,
    target: perAgent?.target,
    prompt: perAgent?.prompt,
    session: perAgent?.session,
    allowDm: perAgent?.allowDm,
    lightContext: perAgent?.lightContext,
    ackMaxChars: perAgent?.ackMaxChars,
    responsePrefix: perAgent?.responsePrefix,
    skipHeartbeatOnlyDelivery: perAgent?.skipHeartbeatOnlyDelivery,
    alertThreshold: perAgent?.alertThreshold ?? global.alertThreshold,
    alertCooldownMs: perAgent?.alertCooldownMs ?? global.alertCooldownMs,
    staleMs: perAgent?.staleMs ?? global.staleMs,
  };
}
