import { useState } from 'react'
import { Loader2, Square, Volume2 } from 'lucide-react'
import { voiceModelProgress } from '../../../shared/voice'
import { useSpeechPlayback, useVoiceState } from '../hooks/useVoice'
import { speechPlayer } from '../services/voice/speechPlayer'

/** Reads a reply aloud on this device; a second click stops it. */
export function ReadAloudButton({
  messageId,
  text
}: {
  messageId: string
  text: string
}): React.JSX.Element | null {
  const voice = useVoiceState()
  const playback = useSpeechPlayback()
  const [notice, setNotice] = useState('')
  if (!voice?.enabled || !text.trim()) return null

  const model = voice.models.speech
  const active = playback.status !== 'idle' && playback.key === messageId
  const loading = active && playback.status === 'loading'
  const settingUp = model.status !== 'ready'
  const label = active
    ? 'Stop reading'
    : notice ||
      (settingUp
        ? `Read aloud is being set up (${Math.floor(voiceModelProgress(model) * 100)}%)`
        : 'Read aloud')

  return (
    <button
      type="button"
      className={`message-action icon read-aloud${active ? ' is-reading' : ''}`}
      onClick={() => {
        setNotice('')
        void speechPlayer.toggle(messageId, text).then((message) => {
          if (!message) return
          setNotice(message)
          window.setTimeout(() => setNotice(''), 5_000)
        })
      }}
      title={label}
      aria-label={label}
      aria-pressed={active}
    >
      {loading ? (
        <Loader2 size={13} className="read-aloud-spinner" />
      ) : active ? (
        <Square size={10} fill="currentColor" />
      ) : (
        <Volume2 size={13} />
      )}
    </button>
  )
}
