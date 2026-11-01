import {
  certificateFingerprintHex,
  type BrowserCertificateApproval
} from '../../shared/browserNetwork'
import { appState, getStore } from '../ipc/state'
import {
  certificateErrorPassable,
  certificateExceptionOrigin,
  certificateNotice,
  type BrowserCertificateFailure,
  type BrowserCertificatePolicy
} from './browserCertificatePolicy'
import type { BrowserNetworkApprovalStore } from './browserNetworkApprovals'

const STORE_KEY = 'browserCertificateApprovals'
const MAX_APPROVALS = 200
const FINGERPRINT = /^sha256\/[A-Za-z0-9+/]{43}=$/

/** The confirmation behind `approve`. It answers for the user; only the trusted dialog may. */
export type BrowserCertificateConfirm = (
  failure: BrowserCertificateFailure,
  changed: boolean,
  signal?: AbortSignal
) => Promise<boolean>

/** Checked on every read, so an entry for a public address counts for nothing however it got in. */
function validApproval(entry: unknown): entry is BrowserCertificateApproval {
  const { origin, fingerprint, approvedAt } = (entry ?? {}) as BrowserCertificateApproval
  return (
    typeof origin === 'string' &&
    typeof fingerprint === 'string' &&
    typeof approvedAt === 'number' &&
    FINGERPRINT.test(fingerprint) &&
    certificateExceptionOrigin(origin) === origin
  )
}

/**
 * Certificates the user accepted, each for one local-network origin. Kept apart from the settings
 * object, which the window saves whole. Nothing but `approve`, after the user's answer, adds one.
 */
export class BrowserCertificateApprovals implements BrowserCertificatePolicy {
  private readonly pending = new Map<string, Promise<boolean>>()

  constructor(
    private readonly store: () => BrowserNetworkApprovalStore,
    private readonly confirm: BrowserCertificateConfirm = confirmBrowserCertificate,
    private readonly now: () => number = Date.now
  ) {}

  list(): BrowserCertificateApproval[] {
    const raw = this.store().get(STORE_KEY, [])
    return Array.isArray(raw) ? raw.filter(validApproval) : []
  }

  allowed(origin: string, fingerprint: string): boolean {
    return this.list().some((entry) => entry.origin === origin && entry.fingerprint === fingerprint)
  }

  changed(origin: string, fingerprint: string): boolean {
    return this.list().some((entry) => entry.origin === origin && entry.fingerprint !== fingerprint)
  }

  /** Asks once per origin and certificate. A new answer replaces the origin's old certificate. */
  approve(failure: BrowserCertificateFailure, signal?: AbortSignal): Promise<boolean> {
    const origin = certificateExceptionOrigin(failure.url)
    const { fingerprint } = failure
    if (!origin || !FINGERPRINT.test(fingerprint) || !certificateErrorPassable(failure.error)) {
      return Promise.resolve(false)
    }
    if (this.allowed(origin, fingerprint)) return Promise.resolve(true)
    const key = `${origin} ${fingerprint}`
    const waiting = this.pending.get(key)
    if (waiting) return waiting
    const decision = this.confirm(failure, this.changed(origin, fingerprint), signal)
      .then((allowed) => {
        if (allowed) {
          const others = this.list().filter((entry) => entry.origin !== origin)
          const next = [...others, { origin, fingerprint, approvedAt: this.now() }]
          this.store().set(STORE_KEY, next.slice(-MAX_APPROVALS))
        }
        return allowed
      })
      .catch(() => false)
      .finally(() => this.pending.delete(key))
    this.pending.set(key, decision)
    return decision
  }

  revoke(origin: string): BrowserCertificateApproval[] {
    const next = this.list().filter((entry) => entry.origin !== origin)
    this.store().set(STORE_KEY, next)
    return next
  }
}

/** The certificate's own words reach a native dialog: one short line, without control characters. */
function certificateText(value: string): string {
  const clean = value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim()
  return clean.slice(0, 120) || 'unknown'
}

export const confirmBrowserCertificate: BrowserCertificateConfirm = async (
  failure,
  changed,
  signal
) => {
  const { showTrustedDialog } = await import('./trustedDialog')
  const { origin, reason, note } = certificateNotice(failure, { changed: () => changed })
  const hash = certificateFingerprintHex(failure.fingerprint)
  const options = {
    type: 'warning' as const,
    title: changed ? 'This certificate has changed' : 'Continue past an untrusted certificate?',
    message: `Continue to ${origin}?`,
    detail:
      `Its certificate is not trusted. ${changed ? note : reason}\n\n` +
      'Nothing vouches for who answers at this address. The agent will be able to read and use what it serves, in its browser.',
    facts: [
      { label: 'Issued to', value: certificateText(failure.subject) },
      { label: 'Issued by', value: certificateText(failure.issuer) },
      {
        label: 'Expires',
        value: failure.validUntil
          ? new Date(failure.validUntil * 1_000).toLocaleDateString()
          : 'Unknown'
      },
      // Sixteen pairs to a line, so it can be read out and compared with the device.
      {
        label: 'SHA-256',
        value: hash.replace(/((?:[0-9A-F]{2}:){15}[0-9A-F]{2}):/, '$1\n'),
        code: true
      }
    ],
    footnote:
      'SideKick asks again if this certificate changes. You can remove it in Settings › Agent › Local network.',
    buttons: ['Go back', 'Continue'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  }
  // Over the app's own window: the browser's page sits in a window parked off screen.
  const result = await showTrustedDialog(appState.mainWindowRef, options, { signal })
  return result.response === 1
}

export const browserCertificateApprovals = new BrowserCertificateApprovals(() => getStore())
