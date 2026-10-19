import type { BrowserNetworkApproval } from '../../shared/browserNetwork'
import { appState, getStore } from '../ipc/state'

const STORE_KEY = 'browserNetworkApprovals'
const MAX_APPROVALS = 200

export interface BrowserNetworkApprovalStore {
  get: (key: string, fallback?: unknown) => unknown
  set: (key: string, value: unknown) => void
}

/**
 * Asks the user whether the agent may open one local-network origin, in its browser or with
 * web_fetch. The signal withdraws the question when the request waiting on it is cancelled.
 */
export type BrowserNetworkConfirm = (origin: string, signal?: AbortSignal) => Promise<boolean>

/** The policy hooks for local-network origins, shared by the browser and web_fetch. */
export interface BrowserNetworkPolicy {
  approved: (origin: string) => boolean
  approve: (origin: string, signal?: AbortSignal) => Promise<boolean>
}

function validOrigin(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    return new URL(value).origin === value && value.startsWith('http://')
  } catch {
    return false
  }
}

/**
 * Local-network origins the user let the agent open over plain HTTP. Kept apart from the
 * settings object, which the window saves whole and would overwrite.
 */
export class BrowserNetworkApprovals implements BrowserNetworkPolicy {
  private readonly pending = new Map<string, Promise<boolean>>()

  constructor(
    private readonly store: () => BrowserNetworkApprovalStore,
    private readonly confirm: BrowserNetworkConfirm = confirmBrowserNetworkOrigin,
    private readonly now: () => number = Date.now
  ) {}

  list(): BrowserNetworkApproval[] {
    const raw = this.store().get(STORE_KEY, [])
    if (!Array.isArray(raw)) return []
    return raw.filter(
      (entry): entry is BrowserNetworkApproval =>
        Boolean(entry) &&
        typeof entry === 'object' &&
        validOrigin((entry as BrowserNetworkApproval).origin) &&
        typeof (entry as BrowserNetworkApproval).approvedAt === 'number'
    )
  }

  approved(origin: string): boolean {
    return this.list().some((entry) => entry.origin === origin)
  }

  /**
   * Asks once per origin, however many navigations wait on the answer. The first navigation's
   * signal governs the question: stopping that run withdraws it, as a denial.
   */
  approve(origin: string, signal?: AbortSignal): Promise<boolean> {
    if (!validOrigin(origin)) return Promise.resolve(false)
    if (this.approved(origin)) return Promise.resolve(true)
    const waiting = this.pending.get(origin)
    if (waiting) return waiting
    const decision = this.confirm(origin, signal)
      .then((allowed) => {
        if (allowed && !this.approved(origin)) {
          const next = [...this.list(), { origin, approvedAt: this.now() }]
          this.store().set(STORE_KEY, next.slice(-MAX_APPROVALS))
        }
        return allowed
      })
      .catch(() => false)
      .finally(() => this.pending.delete(origin))
    this.pending.set(origin, decision)
    return decision
  }

  revoke(origin: string): BrowserNetworkApproval[] {
    const next = this.list().filter((entry) => entry.origin !== origin)
    this.store().set(STORE_KEY, next)
    return next
  }
}

export const confirmBrowserNetworkOrigin: BrowserNetworkConfirm = async (origin, signal) => {
  const { showTrustedDialog } = await import('./trustedDialog')
  const options = {
    type: 'warning' as const,
    title: 'Open a local network address?',
    message: `Allow SideKick to open ${origin}?`,
    detail:
      'This address is on your local network and uses plain HTTP. Devices there often trust ' +
      'anyone who can reach them, so the agent will be able to read and use what this address ' +
      'serves, in its browser and with web fetch.\n\nSideKick remembers your answer for this ' +
      'address. You can remove it in Settings › Agent › Local network.',
    buttons: ['Deny', 'Allow this address'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  }
  // Over the app's own window: the browser's page sits in a window parked off screen.
  const result = await showTrustedDialog(appState.mainWindowRef, options, { signal })
  return result.response === 1
}

export const browserNetworkApprovals = new BrowserNetworkApprovals(() => getStore())
