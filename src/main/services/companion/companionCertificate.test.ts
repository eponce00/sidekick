import { createPrivateKey, createPublicKey, X509Certificate } from 'crypto'
import { describe, expect, it } from 'vitest'
import { certificateServes, createCompanionCertificate } from './companionCertificate'

const DAY_MS = 24 * 60 * 60 * 1_000
const NOW = Date.UTC(2026, 9, 23)

describe('createCompanionCertificate', () => {
  it('makes a self-signed server certificate for the address, signed by its own key', () => {
    const { key, cert } = createCompanionCertificate('192.168.1.108', NOW)
    const parsed = new X509Certificate(cert)
    expect(parsed.checkIP('192.168.1.108')).toBe('192.168.1.108')
    expect(parsed.checkIP('192.168.1.109')).toBeUndefined()
    expect(parsed.ca).toBe(false)
    expect(parsed.keyUsage).toEqual(['1.3.6.1.5.5.7.3.1'])
    expect(parsed.subject).toBe('O=SideKick\nCN=SideKick on 192.168.1.108')
    expect(parsed.verify(parsed.publicKey)).toBe(true)
    expect(parsed.checkPrivateKey(createPrivateKey(key))).toBe(true)
    expect(Date.parse(parsed.validFrom)).toBe(NOW - DAY_MS)
    expect(Date.parse(parsed.validTo)).toBe(NOW + 397 * DAY_MS)
    expect(createPublicKey(key).asymmetricKeyDetails?.namedCurve).toBe('prime256v1')
  })

  it('gives each certificate a new key and serial number', () => {
    const first = new X509Certificate(createCompanionCertificate('10.0.0.2', NOW).cert)
    const second = new X509Certificate(createCompanionCertificate('10.0.0.2', NOW).cert)
    expect(first.serialNumber).not.toBe(second.serialNumber)
    expect(first.fingerprint256).not.toBe(second.fingerprint256)
  })

  it('refuses anything but an IPv4 address', () => {
    expect(() => createCompanionCertificate('example.com', NOW)).toThrow()
    expect(() => createCompanionCertificate('fe80::1', NOW)).toThrow()
  })
})

describe('certificateServes', () => {
  const { cert } = createCompanionCertificate('172.16.4.20', NOW)

  it('keeps a certificate for its own address until a month before it ends', () => {
    expect(certificateServes(cert, '172.16.4.20', NOW)).toBe(true)
    expect(certificateServes(cert, '172.16.4.20', NOW + 366 * DAY_MS)).toBe(true)
    expect(certificateServes(cert, '172.16.4.20', NOW + 368 * DAY_MS)).toBe(false)
  })

  it('replaces a certificate when the computer moves to another address', () => {
    expect(certificateServes(cert, '172.16.4.21', NOW)).toBe(false)
  })

  it('replaces anything that is not a certificate', () => {
    expect(certificateServes('not a certificate', '172.16.4.20', NOW)).toBe(false)
  })
})
