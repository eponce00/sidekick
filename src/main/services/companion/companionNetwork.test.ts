import { describe, expect, it } from 'vitest'
import type { NetworkInterfaceInfo } from 'os'
import {
  hostMatches,
  isDevelopmentPagePath,
  isLocalNetworkAddress,
  originMatches,
  pickLocalNetworkAddress
} from './companionNetwork'

const ipv4 = (address: string, internal = false): NetworkInterfaceInfo =>
  ({ address, family: 'IPv4', internal, netmask: '255.255.255.0', mac: '', cidr: null }) as never

describe('companion network checks', () => {
  it('takes private, link-local and unique-local peers, and nothing public or loopback', () => {
    for (const address of [
      '10.0.0.5',
      '172.16.0.1',
      '172.31.255.254',
      '192.168.1.20',
      '169.254.3.4',
      '::ffff:192.168.1.20',
      'fd12:3456::1',
      'fe80::1%12'
    ])
      expect(isLocalNetworkAddress(address), address).toBe(true)
    for (const address of [
      '8.8.8.8',
      '172.32.0.1',
      '127.0.0.1',
      '::1',
      '::ffff:8.8.8.8',
      '2001:4860::8888',
      '',
      undefined
    ])
      expect(isLocalNetworkAddress(address), String(address)).toBe(false)
  })

  it('prefers a Wi-Fi adapter and skips virtual ones', () => {
    expect(
      pickLocalNetworkAddress({
        'vEthernet (WSL)': [ipv4('172.20.0.1')],
        Ethernet: [ipv4('10.0.0.8')],
        'Wi-Fi': [ipv4('192.168.1.20')],
        Loopback: [ipv4('127.0.0.1', true)]
      })
    ).toBe('192.168.1.20')
    expect(pickLocalNetworkAddress({ 'vEthernet (WSL)': [ipv4('172.20.0.1')] })).toBeNull()
  })

  it('matches only its own host and origin', () => {
    expect(hostMatches('192.168.1.20:47615', '192.168.1.20', 47615)).toBe(true)
    expect(hostMatches('evil.example:47615', '192.168.1.20', 47615)).toBe(false)
    expect(hostMatches(undefined, '192.168.1.20', 47615)).toBe(false)
    expect(originMatches(undefined, '192.168.1.20', 47615)).toBe(true)
    expect(originMatches('https://192.168.1.20:47615', '192.168.1.20', 47615)).toBe(true)
    // The page is HTTPS; a plain HTTP page at the same address is not it.
    expect(originMatches('http://192.168.1.20:47615', '192.168.1.20', 47615)).toBe(false)
    expect(originMatches('null', '192.168.1.20', 47615)).toBe(false)
  })

  it('passes on only the paths the development page loads', () => {
    for (const path of [
      '/src/companion/main.tsx',
      '/@vite/client',
      '/@react-refresh',
      '/node_modules/.vite/deps/react.js',
      '/@fs/E:/repo/node_modules/.vite/deps/react-dom_client.js',
      '/@fs/E:/repo/node_modules/katex/dist/katex.min.css',
      '/@fs/E:/repo/src/shared/companionProtocol.ts'
    ])
      expect(isDevelopmentPagePath(path), path).toBe(true)
    for (const path of [
      '/@fs/C:/Users/me/.ssh/id_rsa',
      '/@fs/E:/repo/src/main/secret.ts',
      '/@fs/E:/repo/node_modules/../.env',
      '/src/../../.env',
      '/src/%2e%2e/secret',
      '/src/a\\b',
      '/srcx',
      '/@vite/clientx',
      '/node_modules/electron/package.json'
    ])
      expect(isDevelopmentPagePath(path), path).toBe(false)
  })
})
