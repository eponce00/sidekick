import { networkAddressKind, privateNetworkHost } from '../../shared/browserNetwork'
import type { BrowserCertificateNotice } from '../../shared/browserWorkspace'

/** Problems a device's own certificate can have; anything else, such as revocation, stays refused. */
const PASSABLE_ERRORS: Record<string, string> = {
  ERR_CERT_AUTHORITY_INVALID:
    'No authority this computer trusts issued it, as happens with a self-signed certificate.',
  ERR_CERT_COMMON_NAME_INVALID: 'It was issued for a different address.',
  ERR_CERT_DATE_INVALID: 'It has expired, or is not valid yet.',
  ERR_CERT_WEAK_KEY: 'It uses a key too weak to trust.',
  ERR_CERT_WEAK_SIGNATURE_ALGORITHM: 'It is signed with an algorithm too weak to trust.',
  ERR_CERT_VALIDITY_TOO_LONG: 'It is valid for longer than certificates may be.'
}

/** One refused connection, as Chromium reported it to the main process. */
export interface BrowserCertificateFailure {
  url: string
  /** Chromium's error name, such as `net::ERR_CERT_AUTHORITY_INVALID`. */
  error: string
  /** `sha256/` and the base64 hash of the certificate the server presented. */
  fingerprint: string
  subject: string
  issuer: string
  validUntil?: number
}

export interface BrowserCertificateEvent extends BrowserCertificateFailure {
  isMainFrame: boolean
  /** The page that made the request, for anything but the page's own document. */
  pageUrl: string
}

export interface BrowserCertificatePolicy {
  allowed: (origin: string, fingerprint: string) => boolean
  /** The user allowed this address before, with a different certificate. */
  changed: (origin: string, fingerprint: string) => boolean
  approve: (failure: BrowserCertificateFailure, signal?: AbortSignal) => Promise<boolean>
}

/** A page refused for its certificate. Trying again, by any tool, would not help. */
export class BrowserCertificateError extends Error {
  constructor(readonly notice: BrowserCertificateNotice) {
    super(
      `The browser did not open ${notice.origin}: its certificate is not trusted. ${notice.reason}`
    )
    this.name = 'BrowserCertificateError'
  }
}

function parsed(url: string): URL | undefined {
  try {
    return new URL(url)
  } catch {
    return undefined
  }
}

function errorName(error: string): string {
  return error.replace(/^net::/, '')
}

export function certificateErrorPassable(error: string): boolean {
  return Object.hasOwn(PASSABLE_ERRORS, errorName(error))
}

/**
 * The origin an exception can exist for: HTTPS to an IP address on a private network, written as
 * that address. A name never qualifies, however private it looks or wherever it resolves today:
 * what a name reaches can change between the check and the connection, and the certificate is the
 * one thing that would have said who answers.
 */
export function certificateExceptionOrigin(url: string): string | undefined {
  const target = parsed(url)
  if (target?.protocol !== 'https:' || target.username || target.password) return undefined
  return networkAddressKind(target.hostname) === 'local' ? target.origin : undefined
}

/**
 * Whether one connection may go on past its certificate error. Every connection answers for
 * itself, so a changed certificate is refused however recently the address was allowed. A public
 * page gets no use of an exception: only the device's own page, or another on the local network.
 */
export function certificateAllowed(
  event: BrowserCertificateEvent,
  policy: Pick<BrowserCertificatePolicy, 'allowed'>
): boolean {
  if (!certificateErrorPassable(event.error)) return false
  // A device's WebSocket reports its own scheme; it is the same origin on the same certificate.
  const origin = certificateExceptionOrigin(event.url.replace(/^wss:/i, 'https:'))
  if (!origin || !policy.allowed(origin, event.fingerprint)) return false
  if (event.isMainFrame) return true
  const page = parsed(event.pageUrl)
  return Boolean(page && networkAddressKind(page.hostname) === 'local')
}

/** What the Browser panel says about a refused page, decided here and not in the window. */
export function certificateNotice(
  failure: BrowserCertificateFailure,
  policy?: Pick<BrowserCertificatePolicy, 'changed'>
): BrowserCertificateNotice {
  const target = parsed(failure.url)
  const origin = target?.origin ?? failure.url
  const name = errorName(failure.error)
  const reason = PASSABLE_ERRORS[name] ?? `Chromium refused it (${name}).`
  const refused = (note: string): BrowserCertificateNotice => ({
    origin,
    reason,
    note,
    canContinue: false
  })
  if (!certificateErrorPassable(failure.error)) {
    return refused('SideKick does not offer a way past this kind of certificate problem.')
  }
  if (certificateExceptionOrigin(failure.url)) {
    if (!policy) return refused('SideKick does not offer a way past this here.')
    return {
      origin,
      reason,
      note: policy.changed(origin, failure.fingerprint)
        ? 'You allowed this address before with a different certificate. A replaced device can explain that; so can someone intercepting the connection.'
        : 'This address is on your local network, where devices often use their own certificates. Continue only if you expect this device here.',
      canContinue: true
    }
  }
  const host = target?.hostname ?? ''
  if (host === 'localhost' || networkAddressKind(host) === 'loopback') {
    return refused(
      'SideKick can continue only to a device on your local network. Trust the certificate in your operating system, or use plain HTTP, which is open on this computer.'
    )
  }
  if (privateNetworkHost(host)) {
    return refused(
      "SideKick can continue only to a device's IP address, because a name can lead anywhere. Open the device by its IP address, or trust its certificate in your operating system."
    )
  }
  return refused(
    'SideKick never opens an address on the internet with a certificate it cannot trust, and there is no way past this.'
  )
}
