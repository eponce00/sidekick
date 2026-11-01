import { describe, expect, it, vi } from 'vitest'
import { certificateAllowed, certificateNotice } from './browserCertificatePolicy'

const mainWindow = { id: 'main' }
vi.mock('../ipc/state', () => ({
  getStore: () => undefined,
  appState: { mainWindowRef: mainWindow }
}))
const showTrustedDialog = vi.fn(async () => ({ response: 1, checkboxChecked: false }))
vi.mock('./trustedDialog', () => ({ showTrustedDialog }))

const { BrowserCertificateApprovals, confirmBrowserCertificate } =
  await import('./browserCertificateApprovals')

const DEVICE = 'https://10.50.161.1:3001'
const FIRST = `sha256/${'A'.repeat(43)}=`
const SECOND = `sha256/${'B'.repeat(43)}=`

function memoryStore(): {
  get: (key: string, fallback?: unknown) => unknown
  set: (key: string, value: unknown) => void
} {
  const values = new Map<string, unknown>()
  return {
    get: (key, fallback) => (values.has(key) ? values.get(key) : fallback),
    set: (key, value) => values.set(key, value)
  }
}

function failure(
  url = `${DEVICE}/`,
  fingerprint = FIRST,
  error = 'net::ERR_CERT_AUTHORITY_INVALID'
) {
  return { url, fingerprint, error, subject: 'hmi', issuer: 'hmi', validUntil: 2_000_000_000 }
}

function approvalsWith(confirm = vi.fn(async () => true)) {
  const store = memoryStore()
  const approvals = new BrowserCertificateApprovals(
    () => store,
    confirm,
    () => 42
  )
  return { approvals, confirm, store }
}

const event = (overrides: Partial<ReturnType<typeof failure>> & { pageUrl?: string } = {}) => ({
  ...failure(),
  isMainFrame: true,
  pageUrl: '',
  ...overrides
})

describe('BrowserCertificateApprovals', () => {
  it('never offers or honors an exception for a public address or any name', async () => {
    const { approvals, confirm, store } = approvalsWith()
    for (const url of [
      'https://8.8.8.8/',
      'https://expired.badssl.com/',
      // Names that lead to a private address today, and might lead anywhere tomorrow.
      'https://10.50.161.1.nip.io/',
      'https://hmi.local/',
      'https://hmi01/',
      // This computer is not a device on the network.
      'https://127.0.0.1:8443/',
      'https://localhost:8443/',
      // Not HTTPS.
      'http://10.50.161.1:3001/'
    ]) {
      expect(await approvals.approve(failure(url)), url).toBe(false)
      expect(certificateNotice(failure(url), approvals).canContinue, url).toBe(false)
    }
    expect(confirm).not.toHaveBeenCalled()

    // An entry that reached the store some other way counts for nothing.
    const planted = [
      { origin: 'https://8.8.8.8', fingerprint: FIRST, approvedAt: 1 },
      { origin: 'https://hmi.local', fingerprint: FIRST, approvedAt: 1 },
      { origin: DEVICE, fingerprint: 'not-a-fingerprint', approvedAt: 1 }
    ]
    store.set('browserCertificateApprovals', planted)
    expect(approvals.list()).toEqual([])
    expect(approvals.allowed('https://8.8.8.8', FIRST)).toBe(false)
    expect(certificateAllowed(event({ url: 'https://8.8.8.8/' }), { allowed: () => true })).toBe(
      false
    )
    expect(certificateAllowed(event({ url: 'https://hmi.local/' }), { allowed: () => true })).toBe(
      false
    )
  })

  it('holds an approval to the exact origin and certificate, and asks again for another', async () => {
    const { approvals, confirm } = approvalsWith()
    expect(await approvals.approve(failure())).toBe(true)
    expect(approvals.list()).toEqual([{ origin: DEVICE, fingerprint: FIRST, approvedAt: 42 }])

    expect(certificateAllowed(event(), approvals)).toBe(true)
    expect(certificateAllowed(event({ fingerprint: SECOND }), approvals)).toBe(false)
    expect(certificateAllowed(event({ url: 'https://10.50.161.1:3002/' }), approvals)).toBe(false)
    expect(certificateAllowed(event({ url: 'https://10.50.161.2:3001/' }), approvals)).toBe(false)

    // A changed certificate says so, asks, and replaces the old one rather than adding to it.
    expect(certificateNotice(failure(undefined, SECOND), approvals).note).toContain('different')
    expect(await approvals.approve(failure(undefined, SECOND))).toBe(true)
    expect(confirm).toHaveBeenLastCalledWith(failure(undefined, SECOND), true, undefined)
    expect(certificateAllowed(event(), approvals)).toBe(false)
    expect(certificateAllowed(event({ fingerprint: SECOND }), approvals)).toBe(true)

    expect(approvals.revoke(DEVICE)).toEqual([])
    expect(certificateAllowed(event({ fingerprint: SECOND }), approvals)).toBe(false)
  })

  it('stores nothing when the user goes back', async () => {
    const { approvals } = approvalsWith(vi.fn(async () => false))
    expect(await approvals.approve(failure())).toBe(false)
    expect(approvals.list()).toEqual([])
  })

  it('keeps an approval from a public page, and from problems it does not cover', async () => {
    const { approvals, confirm } = approvalsWith()
    await approvals.approve(failure())
    expect(confirm).toHaveBeenCalledTimes(1)
    const request = { isMainFrame: false }
    expect(
      certificateAllowed({ ...event(), ...request, pageUrl: `${DEVICE}/index.html` }, approvals)
    ).toBe(true)
    expect(
      certificateAllowed({ ...event(), ...request, pageUrl: 'https://example.com/' }, approvals)
    ).toBe(false)

    // A device's WebSocket counts as the device, and only on the device's page.
    const socket = { ...request, url: 'wss://10.50.161.1:3001/ws' }
    expect(
      certificateAllowed({ ...event(), ...socket, pageUrl: `${DEVICE}/index.html` }, approvals)
    ).toBe(true)
    expect(
      certificateAllowed({ ...event(), ...socket, pageUrl: 'https://example.com/' }, approvals)
    ).toBe(false)

    const revoked = failure(undefined, undefined, 'net::ERR_CERT_REVOKED')
    expect(certificateAllowed({ ...event(), ...revoked }, approvals)).toBe(false)
    expect(certificateNotice(revoked, approvals).canContinue).toBe(false)
    expect(await approvals.approve({ ...revoked, fingerprint: SECOND })).toBe(false)
    expect(confirm).toHaveBeenCalledTimes(1)
  })

  it("shows the certificate's hash over the app's own window, without its control characters", async () => {
    showTrustedDialog.mockClear()
    await confirmBrowserCertificate(
      { ...failure(), subject: 'hmi\n\nSideKick vouches for this‮' },
      false
    )
    expect(showTrustedDialog).toHaveBeenCalledWith(
      mainWindow,
      expect.objectContaining({
        message: expect.stringContaining(DEVICE),
        // The safe answer is the default, so Enter does not go through.
        defaultId: 0,
        cancelId: 0,
        facts: expect.arrayContaining([
          { label: 'Issued to', value: 'hmi  SideKick vouches for this' }
        ])
      }),
      expect.anything()
    )
  })
})
