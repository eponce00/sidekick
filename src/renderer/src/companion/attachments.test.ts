import { describe, expect, it } from 'vitest'
import { COMPANION_UPLOAD_CHUNK_BYTES, type CompanionCalls } from '../../../shared/companion'
import {
  imagePlan,
  KEEP_PNG_BYTES,
  MAX_TEXT_FILE_BYTES,
  PHONE_IMAGE_SIDE,
  textFileProblem,
  uploadBytes,
  uploadPieces
} from './attachments'
import { base64ToBytes } from './audio'
import type { CompanionConnection } from './chatState'

describe('imagePlan', () => {
  it('keeps a small PNG screenshot as it is', () => {
    expect(imagePlan({ type: 'image/png', size: 400_000 }, 1170, 2532)).toEqual({
      keep: true,
      width: 1170,
      height: 2532,
      mimeType: 'image/png'
    })
  })

  it('makes a camera photo a JPEG no longer than the limit on its longest side', () => {
    const plan = imagePlan({ type: 'image/jpeg', size: 4_000_000 }, 4032, 3024)
    expect(plan).toEqual({
      keep: false,
      width: PHONE_IMAGE_SIDE,
      height: 1920,
      mimeType: 'image/jpeg'
    })
  })

  it('reduces a PNG that is large in bytes or in size', () => {
    expect(imagePlan({ type: 'image/png', size: KEEP_PNG_BYTES }, 800, 600).keep).toBe(false)
    expect(imagePlan({ type: 'image/png', size: 1_000 }, 3000, 1000)).toMatchObject({
      keep: false,
      width: PHONE_IMAGE_SIDE,
      height: 853
    })
  })

  it('re-encodes a small image of another kind without enlarging it', () => {
    expect(imagePlan({ type: 'image/heic', size: 900_000 }, 640, 480)).toEqual({
      keep: false,
      width: 640,
      height: 480,
      mimeType: 'image/jpeg'
    })
  })
})

describe('textFileProblem', () => {
  const text = (value: string): Uint8Array => new TextEncoder().encode(value)

  it('accepts text and code', () => {
    expect(textFileProblem('notes.md', text('# Notes\n- café ✓'))).toBeNull()
    expect(textFileProblem('empty.txt', new Uint8Array())).toBeNull()
  })

  it('refuses binary files', () => {
    expect(textFileProblem('app.exe', new Uint8Array([77, 90, 0, 1]))).toMatch(/not a text file/)
    const latin1 = new Uint8Array(Array.from({ length: 200 }, (_, index) => 0xc0 + (index % 30)))
    expect(textFileProblem('photo.raw', latin1)).toMatch(/not a text file/)
  })

  it('refuses files over 2 MB', () => {
    expect(textFileProblem('big.log', new Uint8Array(MAX_TEXT_FILE_BYTES + 1))).toMatch(/2 MB/)
  })
})

describe('uploads', () => {
  it('go in pieces no larger than the computer takes', () => {
    expect(uploadPieces(0)).toEqual([[0, 0]])
    expect(uploadPieces(10, 4)).toEqual([
      [0, 4],
      [4, 8],
      [8, 10]
    ])
    expect(uploadPieces(COMPANION_UPLOAD_CHUNK_BYTES * 2)).toHaveLength(2)
  })

  it('name the upload from the first piece on and mark the last', async () => {
    const calls: Array<CompanionCalls['upload.put']['input']> = []
    const connection = {
      call: async (_name: string, input: CompanionCalls['upload.put']['input']) => {
        calls.push(input)
        return { uploadId: 'u1', complete: input.last }
      }
    } as unknown as CompanionConnection
    const bytes = Uint8Array.from({ length: COMPANION_UPLOAD_CHUNK_BYTES + 5 }, (_, i) => i % 251)
    const progress: number[] = []
    const id = await uploadBytes(
      connection,
      { kind: 'image', name: 'a.jpg', mimeType: 'image/jpeg', bytes },
      (value) => progress.push(value)
    )
    expect(id).toBe('u1')
    expect(calls.map(({ uploadId, last }) => [uploadId, last])).toEqual([
      [undefined, false],
      ['u1', true]
    ])
    const sent = calls.flatMap(({ data }) => Array.from(base64ToBytes(data)))
    expect(sent).toEqual(Array.from(bytes))
    expect(progress.at(-1)).toBe(1)
    expect(progress[0]).toBeLessThan(1)
  })
})
