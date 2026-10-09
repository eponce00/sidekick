import { describe, expect, it } from 'vitest'
import { loopbackHost, privateNetworkHost } from './browserNetwork'

describe('privateNetworkHost', () => {
  it('recognises private, link-local, and VPN addresses and local names', () => {
    for (const host of [
      '10.50.160.123',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.10.10',
      '100.64.0.1',
      '[fd12:3456::1]',
      '[fe80::1]',
      'rno-l-024',
      'printer.local',
      'gateway.lan',
      'nas.home.arpa'
    ]) {
      expect(privateNetworkHost(host), host).toBe(true)
    }
  })

  it('leaves public addresses and this computer out', () => {
    for (const host of [
      'example.com',
      '8.8.8.8',
      '172.32.0.1',
      '192.169.0.1',
      '100.128.0.1',
      '[2001:db8::1]',
      'localhost',
      '127.0.0.1',
      'evil.local.example.com'
    ]) {
      expect(privateNetworkHost(host), host).toBe(false)
    }
    expect(loopbackHost('127.0.0.1')).toBe(true)
  })
})
