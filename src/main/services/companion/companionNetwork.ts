import { isIPv4, isIPv6 } from 'net'
import type { NetworkInterfaceInfo } from 'os'

/** An IPv4 address mapped into IPv6, as Node reports IPv4 peers on dual-stack sockets. */
function unmapped(address: string): string {
  const match = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)
  return match ? match[1] : address
}

/**
 * Whether an address belongs to a local network: private IPv4 ranges, link-local, and IPv6
 * unique-local and link-local. Loopback is not a phone, and anything public is refused.
 */
export function isLocalNetworkAddress(raw: string | undefined): boolean {
  if (!raw) return false
  const address = unmapped(raw.split('%')[0])
  if (isIPv4(address)) {
    const [a, b] = address.split('.').map(Number)
    return (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    )
  }
  if (isIPv6(address)) {
    const first = parseInt(address.split(':')[0] || '0', 16)
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80
  }
  return false
}

export function normalizedAddress(raw: string | undefined): string {
  return unmapped((raw ?? '').split('%')[0])
}

/** Names that look like virtual adapters, whose addresses phones cannot reach. */
const VIRTUAL_ADAPTER =
  /vEthernet|VirtualBox|VMware|Hyper-V|WSL|docker|vboxnet|utun|tailscale|zerotier|bridge|veth|virbr|Loopback/i

/**
 * The address phones on the same Wi-Fi reach this computer at: a private IPv4 address of a real
 * network adapter, preferring Wi-Fi, then wired, then the rest.
 */
export function pickLocalNetworkAddress(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>
): string | null {
  const candidates = Object.entries(interfaces).flatMap(([name, infos]) =>
    (infos ?? [])
      .filter(
        (info) =>
          info.family === 'IPv4' &&
          !info.internal &&
          isLocalNetworkAddress(info.address) &&
          !info.address.startsWith('169.254.') &&
          !VIRTUAL_ADAPTER.test(name)
      )
      .map((info) => ({ name, address: info.address }))
  )
  const rank = (name: string): number =>
    /wi-?fi|wlan|wireless|^en0$/i.test(name) ? 0 : /ethernet|^eth|^en\d/i.test(name) ? 1 : 2
  candidates.sort((left, right) => rank(left.name) - rank(right.name))
  return candidates[0]?.address ?? null
}

/**
 * Whether a request's Host header names this server exactly. A web page elsewhere can point a
 * name it controls at this address (DNS rebinding); its requests then carry that name, not ours.
 */
export function hostMatches(host: string | undefined, address: string, port: number): boolean {
  return host === `${address}:${port}`
}

/** Whether a request's Origin, when present, is this server's own page. */
export function originMatches(origin: string | undefined, address: string, port: number): boolean {
  return origin === undefined || origin === `http://${address}:${port}`
}

/**
 * Whether a path is one the phone page loads from the renderer's development server: its sources,
 * prepared dependencies and client. That server can also read other files on disk, so nothing
 * else is passed on, and nothing that could step out of a folder.
 */
export function isDevelopmentPagePath(path: string): boolean {
  if (/\.\.|\\|%/.test(path)) return false
  return /^\/(?:src\/|node_modules\/\.vite\/deps\/|@id\/)|^\/(?:@vite\/client|@react-refresh)$/.test(
    path
  )
}
