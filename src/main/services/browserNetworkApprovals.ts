import type { BrowserNetworkApproval } from '../../shared/browserNetwork'
import { getStore } from '../ipc/state'

const STORE_KEY = 'browserNetworkApprovals'
const MAX_APPROVALS = 200

export interface BrowserNetworkApprovalStore {
  get: (key: string, fallback?: unknown) => unknown
  set: (key: string, value: unknown) => void
}

/** Asks the user whether the browser may open one local-network origin. */
export type BrowserNetworkConfirm = (origin: string) => Promise<boolean>

/** The browser's policy hooks for local-network origins. */
export interface BrowserNetworkPolicy {
  approved: (origin: string) => boolean
  approve: (origin: string) => Promise<boolean>
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
 * Local-network origins the user let the browser open over plain HTTP. Kept apart from the
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

  /** Asks once per origin, however many navigations wait on the answer. */
  approve(origin: string): Promise<boolean> {
    if (!validOrigin(origin)) return Promise.resolve(false)
    if (this.approved(origin)) return Promise.resolve(true)
    const waiting = this.pending.get(origin)
    if (waiting) return waiting
    const decision = this.confirm(origin)
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

export const confirmBrowserNetworkOrigin: BrowserNetworkConfirm = async (origin) => {
  const { BrowserWindow, dialog } = await import('electron')
  const owner = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const options = {
    type: 'warning' as const,
    title: 'Open a local network address?',
    message: `Allow SideKick's browser to open ${origin}?`,
    detail:
      'This address is on your local network and uses plain HTTP. Devices there often trust ' +
      'anyone who can reach them, so the agent will be able to read and use what this address ' +
      'serves.\n\nSideKick remembers your answer for this address. You can remove it in ' +
      'Settings › Agent › Local network.',
    buttons: ['Deny', 'Allow this address'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  }
  const result = owner
    ? await dialog.showMessageBox(owner, options)
    : await dialog.showMessageBox(options)
  return result.response === 1
}

export const browserNetworkApprovals = new BrowserNetworkApprovals(() => getStore())
