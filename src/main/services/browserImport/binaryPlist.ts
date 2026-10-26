/**
 * A reader for Apple's binary property lists (`bplist00`), enough for Safari's `Bookmarks.plist`.
 * Every offset, length and reference is checked against the file, references are resolved once
 * each, and a reference back to an object still being read is refused, so a crafted file cannot
 * read out of bounds, loop, or multiply its size through shared references.
 * https://github.com/apple-oss-distributions/CF/blob/main/CFBinaryPList.c
 */

export type PlistValue =
  | null
  | boolean
  | number
  | string
  | Date
  | Uint8Array
  | { uid: number }
  | PlistValue[]
  | { [key: string]: PlistValue }

const MAX_OBJECTS = 2_000_000
const MAX_DEPTH = 64
const TRAILER_BYTES = 32

export class PlistError extends Error {}

export function parseBinaryPlist(bytes: Uint8Array): PlistValue {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (buffer.length < 8 + TRAILER_BYTES || buffer.toString('latin1', 0, 8) !== 'bplist00')
    throw new PlistError('Not a binary property list')
  const trailer = buffer.length - TRAILER_BYTES
  const offsetSize = buffer[trailer + 6]
  const refSize = buffer[trailer + 7]
  const objectCount = safeInteger(buffer.readBigUInt64BE(trailer + 8))
  const topObject = safeInteger(buffer.readBigUInt64BE(trailer + 16))
  const tableOffset = safeInteger(buffer.readBigUInt64BE(trailer + 24))
  if (offsetSize < 1 || offsetSize > 8 || refSize < 1 || refSize > 8)
    throw new PlistError('Bad integer sizes')
  if (objectCount < 1 || objectCount > MAX_OBJECTS || topObject >= objectCount)
    throw new PlistError('Bad object count')
  if (tableOffset < 8 || tableOffset + objectCount * offsetSize > trailer)
    throw new PlistError('Bad offset table')

  const readUnsigned = (at: number, size: number): number => {
    if (at < 0 || at + size > trailer) throw new PlistError('Read past the end')
    if (size === 8) return safeInteger(buffer.readBigUInt64BE(at))
    let value = 0
    for (let index = 0; index < size; index++) value = value * 256 + buffer[at + index]
    return value
  }
  const objectOffset = (ref: number): number => {
    if (ref >= objectCount) throw new PlistError('Bad object reference')
    const offset = readUnsigned(tableOffset + ref * offsetSize, offsetSize)
    if (offset < 8 || offset >= tableOffset) throw new PlistError('Bad object offset')
    return offset
  }

  const done = new Map<number, PlistValue>()
  const reading = new Set<number>()

  /** A length in the marker's low bits, or in the integer that follows when they are all set. */
  const lengthAt = (at: number, low: number): { length: number; start: number } => {
    if (low !== 0xf) return { length: low, start: at + 1 }
    const marker = buffer[at + 1]
    if (marker === undefined || marker >> 4 !== 0x1) throw new PlistError('Bad length')
    const size = 1 << (marker & 0xf)
    if (size > 8) throw new PlistError('Bad length')
    return { length: readUnsigned(at + 2, size), start: at + 2 + size }
  }

  const span = (start: number, length: number, unit: number): void => {
    if (length * unit > tableOffset - start) throw new PlistError('Object past its end')
  }

  const read = (ref: number, depth: number): PlistValue => {
    const known = done.get(ref)
    if (known !== undefined) return known
    if (reading.has(ref)) throw new PlistError('Reference loop')
    if (depth > MAX_DEPTH) throw new PlistError('Nested too deeply')
    reading.add(ref)
    const at = objectOffset(ref)
    const marker = buffer[at]
    const high = marker >> 4
    const low = marker & 0xf
    let value: PlistValue
    switch (high) {
      case 0x0:
        if (marker === 0x00) value = null
        else if (marker === 0x08) value = false
        else if (marker === 0x09) value = true
        else throw new PlistError('Unknown marker')
        break
      case 0x1: {
        const size = 1 << low
        if (size > 8) throw new PlistError('Bad integer')
        if (size === 8) {
          if (at + 9 > tableOffset) throw new PlistError('Object past its end')
          const big = buffer.readBigInt64BE(at + 1)
          value = Number(big)
        } else {
          span(at + 1, size, 1)
          value = readUnsigned(at + 1, size)
        }
        break
      }
      case 0x2:
        if (low === 2) {
          span(at + 1, 4, 1)
          value = buffer.readFloatBE(at + 1)
        } else if (low === 3) {
          span(at + 1, 8, 1)
          value = buffer.readDoubleBE(at + 1)
        } else throw new PlistError('Bad real')
        break
      case 0x3:
        if (marker !== 0x33) throw new PlistError('Bad date')
        span(at + 1, 8, 1)
        // Seconds from 2001-01-01.
        value = new Date((buffer.readDoubleBE(at + 1) + 978_307_200) * 1000)
        break
      case 0x4: {
        const { length, start } = lengthAt(at, low)
        span(start, length, 1)
        value = new Uint8Array(buffer.subarray(start, start + length))
        break
      }
      case 0x5: {
        const { length, start } = lengthAt(at, low)
        span(start, length, 1)
        value = buffer.toString('latin1', start, start + length)
        break
      }
      case 0x6: {
        const { length, start } = lengthAt(at, low)
        span(start, length, 2)
        const units = Buffer.from(buffer.subarray(start, start + length * 2))
        value = units.swap16().toString('utf16le')
        break
      }
      case 0x8:
        if (low > 7) throw new PlistError('Bad uid')
        span(at + 1, low + 1, 1)
        value = { uid: readUnsigned(at + 1, low + 1) }
        break
      case 0xa: {
        const { length, start } = lengthAt(at, low)
        span(start, length, refSize)
        const list: PlistValue[] = []
        for (let index = 0; index < length; index++)
          list.push(read(readUnsigned(start + index * refSize, refSize), depth + 1))
        value = list
        break
      }
      case 0xd: {
        const { length, start } = lengthAt(at, low)
        span(start, length * 2, refSize)
        // No prototype, so a key such as `__proto__` is only a key.
        const dict = Object.create(null) as { [key: string]: PlistValue }
        for (let index = 0; index < length; index++) {
          const key = read(readUnsigned(start + index * refSize, refSize), depth + 1)
          if (typeof key !== 'string') throw new PlistError('Dictionary key is not a string')
          dict[key] = read(readUnsigned(start + (length + index) * refSize, refSize), depth + 1)
        }
        value = dict
        break
      }
      default:
        throw new PlistError('Unknown marker')
    }
    reading.delete(ref)
    done.set(ref, value)
    return value
  }

  return read(topObject, 0)
}

function safeInteger(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new PlistError('Number too large')
  return Number(value)
}
