import { useEffect, useRef, useState } from 'react'
import { Loader2, Mic } from 'lucide-react'
import '../components/DictationButton.css'
import { float32ToBytes, recordingToDictationSamples } from './audio'
import { uploadBytes } from './attachments'
import type { CompanionConnection } from './chatState'

const KEYBOARD_MIC = 'Use your keyboard’s microphone to dictate.'

/**
 * Dictation on the phone. The page is plain HTTP, where browsers give it no live microphone, so
 * the phone's own recorder records; the computer transcribes the recording and the words go in
 * at the cursor. The keyboard's microphone always works in the message box as well.
 */
export function PhoneDictation({
  connection,
  onText
}: {
  connection: CompanionConnection
  onText: (text: string) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const [transcribing, setTranscribing] = useState(false)
  const [notice, setNotice] = useState('')
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mounted = useRef(true)
  useEffect(
    () => () => {
      mounted.current = false
      if (noticeTimer.current) clearTimeout(noticeTimer.current)
    },
    []
  )

  const show = (text: string, hold = 5_000): void => {
    setNotice(text)
    if (noticeTimer.current) clearTimeout(noticeTimer.current)
    noticeTimer.current = hold ? setTimeout(() => setNotice(''), hold) : null
  }

  // A phone without a recorder offers only files, or nothing, and the choice is cancelled.
  useEffect(() => {
    const element = input.current
    if (!element) return undefined
    const onCancel = (): void => show(KEYBOARD_MIC)
    element.addEventListener('cancel', onCancel)
    return () => element.removeEventListener('cancel', onCancel)
  }, [])

  const transcribe = async (file: File): Promise<void> => {
    setTranscribing(true)
    show('Transcribing…', 0)
    try {
      let samples: Float32Array
      try {
        samples = await recordingToDictationSamples(file)
      } catch {
        show(KEYBOARD_MIC)
        return
      }
      if (!samples.length) {
        show('Nothing was recorded.')
        return
      }
      const uploadId = await uploadBytes(connection, {
        kind: 'audio',
        name: 'dictation.pcm',
        mimeType: 'audio/pcm',
        bytes: float32ToBytes(samples)
      })
      const { text } = await connection.call('voice.transcribe', { uploadId })
      if (!mounted.current) return
      if (text.trim()) {
        onText(text.trim())
        setNotice('')
      } else show('No words were heard in the recording.')
    } catch (failure) {
      if (mounted.current)
        show(failure instanceof Error ? failure.message : 'The recording could not be transcribed.')
    } finally {
      if (mounted.current) setTranscribing(false)
    }
  }

  return (
    <div className="dictation">
      <input
        ref={input}
        className="composer-image-input"
        type="file"
        accept="audio/*"
        capture
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) void transcribe(file)
        }}
      />
      <button
        type="button"
        className="dictation-button"
        onClick={() => input.current?.click()}
        disabled={transcribing}
        title={transcribing ? 'Transcribing…' : 'Dictate'}
        aria-label={transcribing ? 'Transcribing' : 'Dictate'}
      >
        {transcribing ? (
          <Loader2 size={16} className="dictation-spinner" aria-hidden="true" />
        ) : (
          <Mic size={16} aria-hidden="true" />
        )}
      </button>
      {notice && (
        <div className="dictation-notice" role="status">
          {notice}
        </div>
      )}
    </div>
  )
}
