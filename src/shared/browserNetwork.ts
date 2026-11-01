/**
 * Plain HTTP for the agent, in its browser and in web_fetch: a local-network address only once the
 * user has approved it. Devices on a local network (gateways, PLCs, printers, routers) often serve
 * plain HTTP and trust whoever can reach them, so a page the agent reads must not be able to send
 * it to one the user has not chosen.
 */

/** What an IP address reaches: this computer, a private network, or the internet. */
export type NetworkAddressKind = 'loopback' | 'local' | 'public'

function ipv4Octets(text: string): number[] | undefined {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text)
  const octets = match?.slice(1).map(Number)
  return octets?.every((octet) => octet <= 255) ? octets : undefined
}

function ipv4Kind([a, b]: number[]): NetworkAddressKind {
  // 0.0.0.0/8 means "this host": a connection to 0.0.0.0 reaches local servers.
  if (a === 127 || a === 0) return 'loopback'
  return a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    // Carrier-grade NAT, used by VPNs such as Tailscale.
    (a === 100 && b >= 64 && b <= 127) ||
    // Benchmarking, multicast, and reserved space never name a server on the internet.
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
    ? 'local'
    : 'public'
}

/** The eight 16-bit groups of an IPv6 address, or undefined when the text is not one. */
function ipv6Groups(text: string): number[] | undefined {
  let host = text.replace(/%.*$/, '')
  const dotted = /:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host)
  if (dotted) {
    const octets = ipv4Octets(dotted[1])
    if (!octets) return undefined
    const high = ((octets[0] << 8) | octets[1]).toString(16)
    const low = ((octets[2] << 8) | octets[3]).toString(16)
    host = `${host.slice(0, -dotted[1].length)}${high}:${low}`
  }
  const halves = host.split('::')
  if (halves.length > 2) return undefined
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const gap = 8 - head.length - tail.length
  if (halves.length === 1 ? gap !== 0 : gap < 1) return undefined
  const groups = [...head, ...Array<string>(halves.length === 2 ? gap : 0).fill('0'), ...tail]
  if (!groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return undefined
  return groups.map((group) => parseInt(group, 16))
}

function ipv6Kind(groups: number[]): NetworkAddressKind {
  const zeros = (count: number): boolean => groups.slice(0, count).every((group) => !group)
  const embedded = (high: number, low: number): NetworkAddressKind =>
    ipv4Kind([groups[high] >> 8, groups[high] & 255, groups[low] >> 8, groups[low] & 255])
  // The unspecified address (::) and ::1.
  if (zeros(7) && groups[7] <= 1) return 'loopback'
  // IPv4-compatible (::a.b.c.d), IPv4-mapped (::ffff:a.b.c.d), IPv4-translated
  // (::ffff:0:a.b.c.d), and NAT64 (64:ff9b::a.b.c.d) addresses reach the IPv4 address inside.
  if (
    zeros(6) ||
    (zeros(5) && groups[5] === 0xffff) ||
    (zeros(4) && groups[4] === 0xffff && !groups[5]) ||
    (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((group) => !group))
  )
    return embedded(6, 7)
  // 6to4 (2002::/16) carries an IPv4 address in its second and third groups.
  if (groups[0] === 0x2002) return embedded(1, 2)
  const first = groups[0]
  // Unique local (fc00::/7), link-local (fe80::/10), old site-local (fec0::/10), multicast, and
  // NAT64 for local use (64:ff9b:1::/48).
  return (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 ||
    (first & 0xffc0) === 0xfec0 ||
    (first & 0xff00) === 0xff00 ||
    (first === 0x64 && groups[1] === 0xff9b && groups[2] === 1)
    ? 'local'
    : 'public'
}

/**
 * What an IP address reaches, judged from the address itself so that every spelling of one
 * address, such as IPv4 written inside IPv6, gets the same answer. Undefined for a name.
 */
export function networkAddressKind(address: string): NetworkAddressKind | undefined {
  const host = address.replace(/^\[|\]$/g, '').toLowerCase()
  const octets = ipv4Octets(host)
  if (octets) return ipv4Kind(octets)
  const groups = host.includes(':') ? ipv6Groups(host) : undefined
  return groups && ipv6Kind(groups)
}

export function loopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return host === 'localhost' || networkAddressKind(host) === 'loopback'
}

const LOCAL_NAME_SUFFIXES = ['.local', '.lan', '.home', '.internal', '.intranet', '.home.arpa']

/** An address that names a device on a private network rather than the public internet. */
export function privateNetworkHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!host || loopbackHost(host)) return false
  const kind = networkAddressKind(host)
  if (kind) return kind === 'local'
  if (host.includes(':')) return false
  // A name without a dot resolves only on the local network, like a machine name.
  if (!host.includes('.')) return /^[a-z0-9-]+$/.test(host)
  return LOCAL_NAME_SUFFIXES.some((suffix) => host.endsWith(suffix))
}

/** The key an approval is kept under: scheme, host, and port. */
export function browserNetworkOrigin(url: URL): string {
  return url.origin
}

export interface BrowserNetworkApproval {
  origin: string
  approvedAt: number
}

/** A certificate the user accepted for one HTTPS address on their local network. */
export interface BrowserCertificateApproval {
  origin: string
  /** `sha256/` and the base64 hash of the certificate, as Chromium reports it. */
  fingerprint: string
  approvedAt: number
}

/** A certificate's SHA-256 hash the way devices and other tools print it, in hex pairs. */
export function certificateFingerprintHex(fingerprint: string): string {
  const bytes = atob(fingerprint.replace(/^sha256\//, ''))
  return Array.from(bytes, (byte) => byte.charCodeAt(0).toString(16).padStart(2, '0'))
    .join(':')
    .toUpperCase()
}

export interface BrowserNetworkAPI {
  /** Local-network addresses the browser may open over plain HTTP. */
  list: () => Promise<BrowserNetworkApproval[]>
  revoke: (origin: string) => Promise<BrowserNetworkApproval[]>
  /** Local-network addresses whose untrusted certificate the user accepted. */
  certificates: () => Promise<BrowserCertificateApproval[]>
  revokeCertificate: (origin: string) => Promise<BrowserCertificateApproval[]>
}
