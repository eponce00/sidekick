import { generateKeyPairSync, randomBytes, sign, X509Certificate } from 'crypto'
import { isIPv4 } from 'net'

/**
 * The certificate the phone page is served with. Browsers give a page the microphone and the
 * clipboard only over HTTPS, and no public authority certifies a private address, so SideKick
 * makes its own: the phone warns once that it does not know it, and the user continues. Calls are
 * still encrypted end to end with the paired phone's keys; this certificate only makes the page a
 * secure one.
 */
export interface CompanionCertificate {
  /** PKCS #8, PEM. */
  key: string
  /** X.509, PEM. */
  cert: string
}

const DAY_MS = 24 * 60 * 60 * 1_000
/** Within what browsers accept for a server certificate. */
const VALID_DAYS = 397
/** A certificate this close to its end is replaced, before a phone refuses it. */
const RENEW_BEFORE_DAYS = 30

// The few DER structures one self-signed certificate needs (ITU-T X.690, RFC 5280).

function encodedLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length])
  const bytes: number[] = []
  for (let rest = length; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff)
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

function tlv(tag: number, ...content: Buffer[]): Buffer {
  const body = Buffer.concat(content)
  return Buffer.concat([Buffer.from([tag]), encodedLength(body.length), body])
}

const sequence = (...content: Buffer[]): Buffer => tlv(0x30, ...content)

function objectId(dotted: string): Buffer {
  const [first, second, ...rest] = dotted.split('.').map(Number)
  const bytes = [first * 40 + second]
  for (const arc of rest) {
    const groups = [arc & 0x7f]
    for (let value = arc >> 7; value > 0; value >>= 7) groups.unshift(0x80 | (value & 0x7f))
    bytes.push(...groups)
  }
  return tlv(0x06, Buffer.from(bytes))
}

function positiveInteger(value: Buffer): Buffer {
  return tlv(0x02, value[0] & 0x80 ? Buffer.concat([Buffer.from([0]), value]) : value)
}

function time(at: Date): Buffer {
  const text = at.toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z'
  // UTCTime through 2049, GeneralizedTime after, as RFC 5280 requires.
  return at.getUTCFullYear() < 2050
    ? tlv(0x17, Buffer.from(text.slice(2)))
    : tlv(0x18, Buffer.from(text))
}

function name(commonName: string): Buffer {
  const part = (id: string, value: string): Buffer =>
    tlv(0x31, sequence(objectId(id), tlv(0x0c, Buffer.from(value, 'utf8'))))
  return sequence(part('2.5.4.10', 'SideKick'), part('2.5.4.3', commonName))
}

function extension(id: string, critical: boolean, value: Buffer): Buffer {
  return sequence(
    objectId(id),
    ...(critical ? [Buffer.from([0x01, 0x01, 0xff])] : []),
    tlv(0x04, value)
  )
}

const ECDSA_WITH_SHA256 = sequence(objectId('1.2.840.10045.4.3.2'))

/** A new key and a certificate for one IPv4 address, valid from a day ago. */
export function createCompanionCertificate(
  address: string,
  now = Date.now()
): CompanionCertificate {
  if (!isIPv4(address)) throw new Error('A phone certificate is for an IPv4 address')
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const serial = randomBytes(16)
  serial[0] &= 0x7f
  const subject = name(`SideKick on ${address}`)
  const tbs = sequence(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))),
    positiveInteger(serial),
    ECDSA_WITH_SHA256,
    subject,
    // A day back, for a phone whose clock runs behind.
    sequence(time(new Date(now - DAY_MS)), time(new Date(now + VALID_DAYS * DAY_MS))),
    subject,
    publicKey.export({ type: 'spki', format: 'der' }),
    tlv(
      0xa3,
      sequence(
        // Not an authority: it cannot vouch for any other certificate.
        extension('2.5.29.19', true, sequence()),
        // Digital signature only.
        extension('2.5.29.15', true, tlv(0x03, Buffer.from([0x07, 0x80]))),
        extension('2.5.29.37', false, sequence(objectId('1.3.6.1.5.5.7.3.1'))),
        extension(
          '2.5.29.17',
          false,
          sequence(tlv(0x87, Buffer.from(address.split('.').map(Number))))
        )
      )
    )
  )
  const signature = sign('sha256', tbs, privateKey)
  const der = sequence(tbs, ECDSA_WITH_SHA256, tlv(0x03, Buffer.from([0]), signature))
  const body = der
    .toString('base64')
    .replace(/(.{64})/g, '$1\n')
    .trim()
  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    cert: `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`
  }
}

/** Whether a saved certificate still serves this address for a while longer. */
export function certificateServes(cert: string, address: string, now = Date.now()): boolean {
  try {
    const parsed = new X509Certificate(cert)
    return (
      parsed.checkIP(address) === address &&
      Date.parse(parsed.validTo) - RENEW_BEFORE_DAYS * DAY_MS > now
    )
  } catch {
    return false
  }
}
