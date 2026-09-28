import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Mic, Volume2 } from 'lucide-react'
import { voiceModelProgress } from '../../../shared/voice'
import { useVoiceState } from '../hooks/useVoice'
import { captureMicrophone, type MicrophoneCapture } from '../services/voice/microphone'
import { voicePreferences } from '../services/voice/voicePreferences'
import { applyDictation, type DictationRange } from '../services/voice/dictationText'
import { registerDictation } from '../services/voice/dictationControl'
import {
  skipVoiceLoopReading,
  startVoiceLoop,
  stopVoiceLoop,
  toggleVoiceLoop,
  useVoiceLoop,
  voiceLoopMode
} from '../services/voice/voiceLoop'
import { isVoiceShortcut, voiceShortcutLabel } from '../services/voice/voiceShortcut'
import './DictationButton.css'

type Phase = 'idle' | 'starting' | 'recording' | 'finishing'

// Silence this long from a device means it is not the user's microphone
// (a virtual cable, a muted input) rather than a pause before speaking.
const SILENT_DEVICE_MS = 3_000
const SILENT_LEVEL = 0.004

interface DictationButtonProps {
  inputRef: React.RefObject<HTMLTextAreaElement | null>
  onInputChange: (value: string) => void
  disabled?: boolean
}

/**
 * The voice conversation switch. On, SideKick listens and writes what is said
 * at the caret as it is spoken; Enter sends, the reply is read aloud, and it
 * listens again. Speech is transcribed on this device.
 */
export function DictationButton({
  inputRef,
  onInputChange,
  disabled = false
}: DictationButtonProps): React.JSX.Element | null {
  const voice = useVoiceState()
  const [phase, setPhase] = useState<Phase>('idle')
  const [notice, setNotice] = useState('')
  const [level, setLevel] = useState(0)
  const session = useRef<
    | { id: string; capture?: MicrophoneCapture; stopText?: () => void; startedAt: number }
    | undefined
  >(undefined)
  // Where the next words go, and the message as dictation last left it; a
  // message the user edited meanwhile restarts from their caret.
  const range = useRef<DictationRange | null>(null)
  const written = useRef<string | null>(null)
  const replaced = useRef<string | null>(null)

  const place = useCallback(
    (text: string, final: boolean): void => {
      const input = inputRef.current
      let value = input?.value ?? ''
      // Text can arrive again before the box re-renders the last change.
      if (written.current !== null && value === replaced.current) value = written.current
      if (!range.current || written.current !== value) {
        const caret = input?.selectionStart ?? value.length
        range.current = { start: caret, end: input?.selectionEnd ?? caret }
      }
      const next = applyDictation(value, range.current, text, final)
      range.current = next.range
      replaced.current = value
      written.current = next.value
      onInputChange(next.value)
      window.requestAnimationFrame(() => {
        const current = inputRef.current
        if (!current) return
        current.setSelectionRange(next.caret, next.caret)
        current.scrollTop = current.scrollHeight
      })
    },
    [inputRef, onInputChange]
  )

  const showNotice = useCallback((message: string) => {
    setNotice(message)
    window.setTimeout(() => setNotice((current) => (current === message ? '' : current)), 8_000)
  }, [])

  const stop = useCallback(async (): Promise<void> => {
    const active = session.current
    if (!active) return
    setPhase('finishing')
    await active.capture?.stop().catch(() => undefined)
    try {
      await window.api.voice.stopDictation(active.id)
    } finally {
      active.stopText?.()
      session.current = undefined
      range.current = null
      written.current = null
      replaced.current = null
      setLevel(0)
      setPhase('idle')
      inputRef.current?.focus()
    }
  }, [inputRef])

  /** Starts recording; false when the microphone or the model is unavailable. */
  const start = useCallback(async (): Promise<boolean> => {
    const api = window.api.voice
    const id = crypto.randomUUID().replaceAll('-', '')
    setNotice('')
    setPhase('starting')
    const result = await api.startDictation(id)
    if (!result.ok) {
      setPhase('idle')
      showNotice(result.message)
      return false
    }
    range.current = null
    written.current = null
    replaced.current = null
    const stopText = api.onDictationText((event) => {
      if (event.sessionId === id) place(event.text, event.final)
    })
    session.current = { id, stopText, startedAt: Date.now() }
    try {
      const capture = await captureMicrophone(
        (samples) => api.pushDictationAudio(id, samples),
        voicePreferences().inputDeviceId
      )
      if (session.current?.id !== id) {
        await capture.stop()
        return true
      }
      session.current.capture = capture
      session.current.startedAt = Date.now()
      setPhase('recording')
      return true
    } catch (error) {
      stopText()
      session.current = undefined
      void api.cancelDictation(id)
      setPhase('idle')
      const denied = (error as DOMException)?.name === 'NotAllowedError'
      showNotice(
        denied
          ? 'SideKick could not use the microphone. Allow microphone access for SideKick in your system privacy settings.'
          : 'No microphone was found. Connect one, or choose it in Settings → General → Voice.'
      )
      return false
    }
  }, [place, showNotice])

  // The level ring, the timer, and a warning when the device sends only silence.
  useEffect(() => {
    if (phase !== 'recording') return undefined
    let frame = 0
    let loudest = 0
    let warned = false
    const tick = (): void => {
      const active = session.current
      const current = active?.capture?.level() ?? 0
      loudest = Math.max(loudest, current)
      setLevel(current)
      if (active) {
        const ms = Date.now() - active.startedAt
        if (!warned && ms > SILENT_DEVICE_MS && loudest < SILENT_LEVEL) {
          warned = true
          showNotice(
            `No sound is reaching SideKick from “${active.capture?.label}”. Choose your microphone in Settings → General → Voice, or check it in your system sound settings.`
          )
        }
      }
      frame = window.requestAnimationFrame(tick)
    }
    frame = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(frame)
  }, [phase, showNotice])

  /** Ends listening at once, keeping what is in the box and dropping the rest. */
  const cancel = useCallback((): void => {
    const active = session.current
    if (!active) return
    session.current = undefined
    active.stopText?.()
    void active.capture?.stop()
    void window.api.voice.cancelDictation(active.id)
    range.current = null
    written.current = null
    replaced.current = null
    setLevel(0)
    setPhase('idle')
  }, [])

  // Sending the message ends the dictation, so later words do not refill the box.
  useEffect(() => registerDictation(cancel), [cancel])

  // The voice conversation drives the microphone: listening records; turning
  // it off keeps the last words; waiting for or reading a reply pauses it, so
  // SideKick never transcribes the model's own voice.
  const loop = useVoiceLoop()
  useEffect(() => {
    if (loop === 'listening') {
      if (!session.current && phase === 'idle') {
        void start().then((started) => {
          if (!started) stopVoiceLoop()
        })
      }
    } else if (session.current && phase === 'recording') {
      if (loop === 'off') void stop()
      else cancel()
    }
  }, [loop, phase, start, stop, cancel])

  // The shortcut turns voice on and off anywhere in the app; Esc skips a reply
  // being read aloud.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (isVoiceShortcut(event)) {
        event.preventDefault()
        event.stopPropagation()
        if (voiceLoopMode() === 'off' && !window.api?.voice) return
        toggleVoiceLoop()
      } else if (event.key === 'Escape' && skipVoiceLoopReading()) {
        event.preventDefault()
        event.stopPropagation()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // Leaving the chat ends the conversation rather than leaving the microphone on.
  useEffect(
    () => () => {
      cancel()
      stopVoiceLoop()
    },
    [cancel]
  )

  if (!voice?.enabled || !window.api?.voice) return null
  const model = voice.models.dictation
  const settingUp = model.status !== 'ready'
  const percent = Math.floor(voiceModelProgress(model) * 100)
  const shortcut = voiceShortcutLabel()
  const busy = phase === 'starting' || phase === 'finishing'
  const label = busy
    ? 'Starting the microphone'
    : loop === 'speaking'
      ? 'Skip reading the reply (Esc)'
      : loop !== 'off'
        ? `Turn voice off (${shortcut})`
        : settingUp
          ? `Voice is being set up (${percent}%)`
          : `Talk to SideKick (${shortcut})`

  return (
    <div className="dictation">
      <button
        type="button"
        className={`dictation-button is-${loop}${busy ? ' is-busy' : ''}${settingUp && loop === 'off' ? ' is-setting-up' : ''}`}
        style={
          {
            '--dictation-level': level.toFixed(3),
            '--dictation-progress': `${percent}%`
          } as React.CSSProperties
        }
        disabled={disabled}
        onClick={() => {
          if (loop === 'off') startVoiceLoop()
          else if (loop === 'speaking') skipVoiceLoopReading()
          else stopVoiceLoop()
        }}
        title={label}
        aria-label={label}
        aria-pressed={loop !== 'off'}
      >
        {busy ? (
          <Loader2 size={15} className="dictation-spinner" />
        ) : loop === 'speaking' ? (
          <Volume2 size={16} strokeWidth={1.9} />
        ) : loop === 'off' ? (
          <Mic size={16} strokeWidth={1.9} />
        ) : (
          <Mic size={16} strokeWidth={2.2} />
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
