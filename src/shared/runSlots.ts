import type { ProviderInstance, ProviderSettings } from './settings'

/** Runs that may sample a model or run tools at once across the app. */
export const DEFAULT_GLOBAL_RUN_SLOTS = 4
export const MAX_GLOBAL_RUN_SLOTS = 8
/** A hosted provider serves parallel requests; a local server usually serves one at a time. */
export const DEFAULT_HOSTED_RUNS_AT_ONCE = 4
export const DEFAULT_LOCAL_RUNS_AT_ONCE = 1
export const MAX_RUNS_AT_ONCE = 8

function clamp(value: unknown, fallback: number, max: number): number {
  const number = Math.floor(Number(value))
  return Number.isFinite(number) && number >= 1 ? Math.min(max, number) : fallback
}

export function globalRunSlots(settings: Pick<ProviderSettings, 'maxConcurrentRuns'>): number {
  return clamp(settings.maxConcurrentRuns, DEFAULT_GLOBAL_RUN_SLOTS, MAX_GLOBAL_RUN_SLOTS)
}

/** True for a server on this machine, which usually works through one request at a time. */
export function isLocalProviderUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false
  try {
    const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, '').toLowerCase()
    return (
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host === '::1' ||
      /^127(\.\d{1,3}){3}$/.test(host) ||
      host === '0.0.0.0'
    )
  } catch {
    return false
  }
}

export function defaultRunsAtOnce(instance: Pick<ProviderInstance, 'baseUrl'>): number {
  return isLocalProviderUrl(instance.baseUrl)
    ? DEFAULT_LOCAL_RUNS_AT_ONCE
    : DEFAULT_HOSTED_RUNS_AT_ONCE
}

/**
 * How many runs may use this provider at once: chats, scheduled runs, chats other chats started,
 * and sub-agents together. The older per-provider sub-agent limit still counts when set.
 */
export function providerRunsAtOnce(
  instance: Pick<ProviderInstance, 'baseUrl' | 'runsAtOnce' | 'subAgentsAtOnce'> | undefined
): number {
  if (!instance) return DEFAULT_HOSTED_RUNS_AT_ONCE
  return clamp(
    instance.runsAtOnce ?? instance.subAgentsAtOnce,
    defaultRunsAtOnce(instance),
    MAX_RUNS_AT_ONCE
  )
}

/** A run waiting for a slot, for status displays. */
export interface QueuedRun {
  runId: string
  conversationId: string | null
  providerKey: string
  queuedAt: number
  /** It already ran and gave its slot back while waiting; it is not a new start. */
  resuming: boolean
}
