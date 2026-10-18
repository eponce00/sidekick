import { describe, expect, it } from 'vitest'
import { loopbackHost, networkAddressKind, privateNetworkHost } from './browserNetwork'

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
      '[::ffff:c0a8:101]',
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
      '[::ffff:7f00:1]',
      'evil.local.example.com'
    ]) {
      expect(privateNetworkHost(host), host).toBe(false)
    }
    expect(loopbackHost('127.0.0.1')).toBe(true)
  })
})

describe('networkAddressKind', () => {
  it('finds this computer in every spelling of it', () => {
    for (const address of [
      '127.0.0.1',
      '127.255.255.254',
      '0.0.0.0',
      '0.1.2.3',
      '::1',
      '[::1]',
      '::',
      '0:0:0:0:0:0:0:1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '[::ffff:7f00:1]',
      '::FFFF:7F00:0001',
      '::127.0.0.1',
      '::ffff:0:127.0.0.1',
      '64:ff9b::127.0.0.1',
      '2002:7f00:1::',
      '::ffff:0.0.0.0'
    ]) {
      expect(networkAddressKind(address), address).toBe('loopback')
      expect(loopbackHost(address), address).toBe(true)
    }
  })

  it('finds the local network, including IPv4 inside IPv6', () => {
    for (const address of [
      '10.0.0.1',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.100.100.100',
      '198.18.0.1',
      '224.0.0.251',
      '255.255.255.255',
      'fc00::1',
      'fd12:3456:789a::1',
      'fe80::1',
      'fe80::1%eth0',
      'febf::1',
      'fec0::1',
      'ff02::1',
      '::ffff:192.168.1.1',
      '::ffff:c0a8:101',
      '::ffff:a00:1',
      '::ffff:169.254.169.254',
      '64:ff9b::192.168.1.1',
      '64:ff9b:1::1',
      '2002:c0a8:101::1'
    ]) {
      expect(networkAddressKind(address), address).toBe('local')
    }
  })

  it('leaves the internet public', () => {
    for (const address of [
      '8.8.8.8',
      '1.1.1.1',
      '172.15.255.255',
      '172.32.0.0',
      '100.63.255.255',
      '100.128.0.0',
      '198.17.255.255',
      '223.255.255.255',
      '2606:4700:4700::1111',
      '2001:db8::1',
      'fbff::1',
      'fe7f::1',
      '::ffff:8.8.8.8',
      '64:ff9b::8.8.8.8',
      '2002:808:808::1'
    ]) {
      expect(networkAddressKind(address), address).toBe('public')
    }
  })

  it('treats anything that is not an address as a name', () => {
    for (const value of [
      'example.com',
      'localhost',
      '256.0.0.1',
      '1.2.3',
      '1.2.3.4.5',
      ':::1',
      '1::2::3',
      '1:2:3:4:5:6:7:8:9',
      '::ffff:999.0.0.1',
      'fe80::g',
      ''
    ]) {
      expect(networkAddressKind(value), value).toBeUndefined()
    }
  })
})
