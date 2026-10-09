/**
 * Plain HTTP in the agent's browser: always for this computer, and for a local-network address
 * only once the user has approved it. Devices on a local network (gateways, PLCs, printers,
 * routers) often serve plain HTTP and trust whoever can reach them, so a page the agent reads
 * must not be able to send it to one the user has not chosen.
 */

export function loopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return (
    host === 'localhost' ||
    host === '::1' ||
    host === '0.0.0.0' ||
    host === '127.0.0.1' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  )
}

const LOCAL_NAME_SUFFIXES = ['.local', '.lan', '.home', '.internal', '.intranet', '.home.arpa']

/** An address that names a device on a private network rather than the public internet. */
export function privateNetworkHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!host || loopbackHost(host)) return false
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])]
    return (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      // Carrier-grade NAT, used by VPNs such as Tailscale.
      (a === 100 && b >= 64 && b <= 127)
    )
  }
  if (host.includes(':')) return /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)
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

export interface BrowserNetworkAPI {
  /** Local-network addresses the browser may open over plain HTTP. */
  list: () => Promise<BrowserNetworkApproval[]>
  revoke: (origin: string) => Promise<BrowserNetworkApproval[]>
}
