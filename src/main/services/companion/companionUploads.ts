import { randomUUID } from 'crypto'
import { COMPANION_MAX_UPLOAD_BYTES, COMPANION_UPLOAD_CHUNK_BYTES } from '../../../shared/companion'

export type CompanionUploadKind = 'image' | 'text'

export interface CompanionUpload {
  id: string
  deviceId: string
  kind: CompanionUploadKind
  name: string
  mimeType: string
  data: Buffer
}

interface Pending {
  deviceId: string
  kind: CompanionUploadKind
  name: string
  mimeType: string
  chunks: Buffer[]
  size: number
  complete: boolean
  expiresAt: number
}

const UPLOAD_TTL_MS = 10 * 60 * 1_000
/** Uploads held at once across every phone, so a phone cannot fill the computer's memory. */
const MAX_HELD_BYTES = 64 * 1024 * 1024

/**
 * Files a phone sends in pieces before the message that uses them: images and text files. Each
 * belongs to the phone that sent it and is taken once.
 */
export class CompanionUploads {
  private uploads = new Map<string, Pending>()

  constructor(private readonly now: () => number = Date.now) {}

  private held(): number {
    let total = 0
    for (const [id, upload] of this.uploads) {
      if (upload.expiresAt < this.now()) this.uploads.delete(id)
      else total += upload.size
    }
    return total
  }

  put(
    deviceId: string,
    input: {
      uploadId?: unknown
      kind: unknown
      name: unknown
      mimeType: unknown
      data: unknown
      last: unknown
    }
  ): { uploadId: string; complete: boolean } {
    if (typeof input.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.data))
      throw new Error('Invalid upload')
    const chunk = Buffer.from(input.data, 'base64')
    if (chunk.length > COMPANION_UPLOAD_CHUNK_BYTES) throw new Error('Upload pieces are too large')
    let id: string
    let upload: Pending | undefined
    if (input.uploadId === undefined) {
      const kind = input.kind
      if (kind !== 'image' && kind !== 'text') throw new Error('Invalid upload')
      const name =
        typeof input.name === 'string' ? input.name.replace(/[\p{C}/\\]/gu, '').slice(0, 200) : ''
      const mimeType =
        typeof input.mimeType === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(input.mimeType)
          ? input.mimeType.toLowerCase()
          : 'application/octet-stream'
      id = randomUUID()
      upload = {
        deviceId,
        kind,
        name: name || 'File',
        mimeType,
        chunks: [],
        size: 0,
        complete: false,
        expiresAt: this.now() + UPLOAD_TTL_MS
      }
    } else {
      id = typeof input.uploadId === 'string' ? input.uploadId : ''
      upload = this.uploads.get(id)
      if (
        !upload ||
        upload.deviceId !== deviceId ||
        upload.complete ||
        upload.expiresAt < this.now()
      )
        throw new Error('That upload is no longer available; send the file again')
    }
    if (upload.size + chunk.length > COMPANION_MAX_UPLOAD_BYTES)
      throw new Error('That file is too large to send from the phone')
    if (this.held() + chunk.length > MAX_HELD_BYTES)
      throw new Error('The computer is busy receiving other files; try again shortly')
    upload.chunks.push(chunk)
    upload.size += chunk.length
    upload.complete = input.last === true
    this.uploads.set(id, upload)
    return { uploadId: id, complete: upload.complete }
  }

  /** A complete upload of this phone, removed as it is taken. */
  take(deviceId: string, uploadId: unknown, kind: CompanionUploadKind): CompanionUpload {
    const id = typeof uploadId === 'string' ? uploadId : ''
    const upload = this.uploads.get(id)
    if (
      !upload ||
      upload.deviceId !== deviceId ||
      upload.kind !== kind ||
      !upload.complete ||
      upload.expiresAt < this.now()
    )
      throw new Error('That file is no longer available; attach it again')
    this.uploads.delete(id)
    return {
      id,
      deviceId,
      kind,
      name: upload.name,
      mimeType: upload.mimeType,
      data: Buffer.concat(upload.chunks)
    }
  }

  clear(): void {
    this.uploads.clear()
  }
}
