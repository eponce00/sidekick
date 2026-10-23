import { useCallback, useEffect, useRef, useState } from 'react'
import type { CompanionImage } from '../../../shared/companion'
import { MAX_MESSAGE_IMAGES } from '../../../shared/messageImages'
import { prepareImage, textFileProblem, uploadBytes } from './attachments'
import type { CompanionConnection } from './chatState'

/** A file on its way to the computer, shown as a chip until the message is sent. */
export interface PhoneAttachment {
  id: string
  kind: 'image' | 'text'
  name: string
  /** For an image: the reduced copy the chip and lightbox show. */
  preview?: CompanionImage
  /** From 0 to 1 while it uploads. */
  progress: number
  /** Set once the computer holds the whole file. */
  uploadId?: string
}

let nextAttachmentId = 1

/**
 * Files attached to the message being written. Each uploads as soon as it is chosen, so sending
 * is quick; one the user removes is left to expire on the computer.
 */
export function usePhoneAttachments(connection: CompanionConnection) {
  const [attachments, setAttachments] = useState<PhoneAttachment[]>([])
  const [error, setError] = useState('')
  const live = useRef(new Set<string>())
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const update = useCallback((id: string, change: Partial<PhoneAttachment>) => {
    if (!mounted.current || !live.current.has(id)) return
    setAttachments((current) =>
      current.map((attachment) =>
        attachment.id === id ? { ...attachment, ...change } : attachment
      )
    )
  }, [])

  const drop = useCallback((id: string) => {
    live.current.delete(id)
    if (mounted.current)
      setAttachments((current) => current.filter((attachment) => attachment.id !== id))
  }, [])

  const begin = useCallback(
    (kind: PhoneAttachment['kind'], name: string, work: (id: string) => Promise<void>) => {
      const id = `attachment-${nextAttachmentId++}`
      live.current.add(id)
      setAttachments((current) => [...current, { id, kind, name, progress: 0 }])
      work(id).catch((failure: unknown) => {
        drop(id)
        if (mounted.current)
          setError(failure instanceof Error ? failure.message : `${name} could not be attached.`)
      })
    },
    [drop]
  )

  const addImages = useCallback(
    (files: File[]) => {
      setError('')
      const room = MAX_MESSAGE_IMAGES - attachments.filter(({ kind }) => kind === 'image').length
      if (files.length > room) setError(`A message can contain up to ${MAX_MESSAGE_IMAGES} images.`)
      for (const file of files.slice(0, Math.max(0, room))) {
        begin('image', file.name || 'Photo', async (id) => {
          const image = await prepareImage(file)
          const preview: CompanionImage = {
            id,
            name: image.name,
            mimeType: image.mimeType,
            dataUrl: image.dataUrl
          }
          update(id, { name: image.name, preview })
          const uploadId = await uploadBytes(
            connection,
            { kind: 'image', name: image.name, mimeType: image.mimeType, bytes: image.bytes },
            (progress) => update(id, { progress })
          )
          update(id, { uploadId, progress: 1 })
        })
      }
    },
    [attachments, begin, connection, update]
  )

  const addTextFiles = useCallback(
    (files: File[]) => {
      setError('')
      for (const file of files) {
        const name = file.name || 'File'
        begin('text', name, async (id) => {
          const bytes = new Uint8Array(await file.arrayBuffer())
          const problem = textFileProblem(name, bytes)
          if (problem) throw new Error(problem)
          const uploadId = await uploadBytes(
            connection,
            { kind: 'text', name, mimeType: file.type || 'text/plain', bytes },
            (progress) => update(id, { progress })
          )
          update(id, { uploadId, progress: 1 })
        })
      }
    },
    [begin, connection, update]
  )

  /** Empties the tray for a sent message and hands back what it held. */
  const take = useCallback((): PhoneAttachment[] => {
    const taken = attachments
    live.current.clear()
    setAttachments([])
    setError('')
    return taken
  }, [attachments])

  /** Puts back what a failed send took. */
  const restore = useCallback((restored: PhoneAttachment[]) => {
    for (const attachment of restored) live.current.add(attachment.id)
    setAttachments((current) => [...restored, ...current])
  }, [])

  return {
    attachments,
    error,
    setError,
    uploading: attachments.some((attachment) => !attachment.uploadId),
    imageCount: attachments.filter(({ kind }) => kind === 'image').length,
    addImages,
    addTextFiles,
    remove: drop,
    take,
    restore
  }
}
