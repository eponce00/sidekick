import { createPrivateKey, createPublicKey, X509Certificate } from 'crypto'
import { describe, expect, it, vi } from 'vitest'
import { certificateServes, createCompanionCertificate } from './companionCertificate'

// The serial's random bytes, replaceable for one certificate.
const nextSerial = vi.hoisted(() => ({ bytes: null as Buffer | null }))
vi.mock('crypto', async (original) => {
  const actual = await original<typeof import('crypto')>()
  return {
    ...actual,
    randomBytes: (size: number) => {
      const bytes = nextSerial.bytes
      nextSerial.bytes = null
      return bytes ?? actual.randomBytes(size)
    }
  }
})

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
    expect(parsed.verify(parsed.publicKey)).toBe(true)
    expect(parsed.checkPrivateKey(createPrivateKey(key))).toBe(true)
    expect(Date.parse(parsed.validFrom)).toBe(NOW - DAY_MS)
    expect(Date.parse(parsed.validTo)).toBe(NOW + 397 * DAY_MS)
    expect(createPublicKey(key).asymmetricKeyDetails?.namedCurve).toBe('prime256v1')
  })

  it('encodes a serial that starts with zero bytes, about one in 256 serials', () => {
    // DER refuses a leading zero byte before one under 0x80, so these failed to parse.
    nextSerial.bytes = Buffer.from([0x00, 0x00, 0x12, ...Array(13).fill(0xab)])
    const parsed = new X509Certificate(createCompanionCertificate('10.0.0.3', NOW).cert)
    expect(parsed.serialNumber).toBe('12' + 'AB'.repeat(13))
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

  it('keeps a certificate for its own address until a month before it ends, and nothing else', () => {
    expect(certificateServes(cert, '172.16.4.20', NOW)).toBe(true)
    expect(certificateServes(cert, '172.16.4.20', NOW + 366 * DAY_MS)).toBe(true)
    expect(certificateServes(cert, '172.16.4.20', NOW + 368 * DAY_MS)).toBe(false)
    expect(certificateServes(cert, '172.16.4.21', NOW)).toBe(false)
    expect(certificateServes('not a certificate', '172.16.4.20', NOW)).toBe(false)
  })
})
