import { useCallback, useEffect, useState } from 'react'
import { Play, Square } from 'lucide-react'
import {
  SPEECH_LANGUAGES,
  SPEECH_VOICES,
  voiceModelProgress,
  type SpeechLanguageCode,
  type VoiceModelState
} from '../../../shared/voice'
import { useSpeechPlayback, useVoiceState } from '../hooks/useVoice'
import {
  captureMicrophone,
  listAudioDevices,
  type MicrophoneCapture
} from '../services/voice/microphone'
import { speechPlayer } from '../services/voice/speechPlayer'
import { updateVoicePreferences, useVoicePreferences } from '../services/voice/voicePreferences'
import { voiceShortcutLabel } from '../services/voice/voiceShortcut'

type Device = { deviceId: string; label: string }

const SAMPLES: Partial<Record<SpeechLanguageCode, string>> = {
  en: 'Hi! This is how SideKick sounds when it reads a message to you.',
  es: '¡Hola! Así suena SideKick cuando te lee un mensaje.',
  pt: 'Olá! É assim que o SideKick soa quando lê uma mensagem para você.',
  fr: 'Bonjour ! Voici comment SideKick lit un message à voix haute.',
  de: 'Hallo! So klingt SideKick, wenn es dir eine Nachricht vorliest.',
  it: 'Ciao! Ecco come suona SideKick quando ti legge un messaggio.'
}

const LANGUAGES = (Object.entries(SPEECH_LANGUAGES) as Array<[SpeechLanguageCode, string]>).sort(
  ([, left], [, right]) => left.localeCompare(right)
)

function settingUp(label: string, model: VoiceModelState): string | null {
  if (model.status === 'ready') return null
  const megabytes = Math.round(model.totalBytes / 1_000_000)
  if (model.status === 'error') return `${label}: download paused, retrying soon`
  if (model.status === 'downloading') {
    return `${label}: ${Math.floor(voiceModelProgress(model) * 100)}% of ${megabytes} MB`
  }
  return `${label}: waiting to download (${megabytes} MB)`
}

function useAudioDevices(kind: 'audioinput' | 'audiooutput'): [Device[], () => void] {
  const [devices, setDevices] = useState<Device[]>([])
  const refresh = useCallback(() => {
    void listAudioDevices(kind)
      .then(setDevices)
      .catch(() => setDevices([]))
  }, [kind])
  useEffect(() => {
    let active = true
    void listAudioDevices(kind)
      .then((found) => {
        if (active) setDevices(found)
      })
      .catch(() => undefined)
    navigator.mediaDevices?.addEventListener?.('devicechange', refresh)
    return () => {
      active = false
      navigator.mediaDevices?.removeEventListener?.('devicechange', refresh)
    }
  }, [kind, refresh])
  return [devices, refresh]
}

/**
 * Voice settings for this machine: the devices it listens and speaks through,
 * and how replies sound. Choices apply at once; defaults follow the system and
 * detect the language.
 */
export function VoiceSettings(): React.JSX.Element {
  const voice = useVoiceState()
  const preferences = useVoicePreferences()
  const playback = useSpeechPlayback()
  const [microphones, refreshMicrophones] = useAudioDevices('audioinput')
  const [speakers, refreshSpeakers] = useAudioDevices('audiooutput')
  const [testing, setTesting] = useState<MicrophoneCapture | null>(null)
  const [level, setLevel] = useState(0)
  const [notice, setNotice] = useState('')

  useEffect(() => {
    if (!testing) return undefined
    let frame = 0
    const tick = (): void => {
      setLevel(testing.level())
      frame = window.requestAnimationFrame(tick)
    }
    frame = window.requestAnimationFrame(tick)
    return () => {
      window.cancelAnimationFrame(frame)
      void testing.stop()
    }
  }, [testing])

  // A sample still playing is stopped when the settings close.
  useEffect(
    () => () => {
      const current = speechPlayer.current()
      if (current.status !== 'idle' && current.key === 'voice-sample') speechPlayer.stop()
    },
    []
  )

  const testMicrophone = async (deviceId: string): Promise<void> => {
    setNotice('')
    try {
      setTesting(await captureMicrophone(() => undefined, deviceId))
      // Device names are only shown once access has been granted.
      refreshMicrophones()
      refreshSpeakers()
    } catch (reason) {
      setTesting(null)
      setNotice(
        (reason as DOMException)?.name === 'NotAllowedError'
          ? 'Microphone access is blocked for SideKick in your system privacy settings.'
          : 'That microphone could not be opened.'
      )
    }
  }

  const chooseMicrophone = (deviceId: string): void => {
    updateVoicePreferences({ inputDeviceId: deviceId })
    if (testing) {
      setTesting(null)
      void testMicrophone(deviceId)
    }
  }

  const sampleActive = playback.status !== 'idle' && playback.key === 'voice-sample'
  const playSample = (): void => {
    setNotice('')
    const language = preferences.language === 'auto' ? 'en' : preferences.language
    void speechPlayer
      .toggle('voice-sample', SAMPLES[language] ?? SAMPLES.en!)
      .then((message) => message && setNotice(message))
  }

  const pending = voice
    ? [
        settingUp('Dictation', voice.models.dictation),
        settingUp('Read aloud', voice.models.speech)
      ].filter(Boolean)
    : []

  return (
    <div className="voice-settings">
      {pending.length > 0 && (
        <p className="voice-settings-status">Setting up · {pending.join(' · ')}</p>
      )}
      <div className="voice-settings-grid">
        <label className="modern-field">
          <span>Microphone</span>
          <div className="voice-settings-row">
            <select
              value={preferences.inputDeviceId}
              onChange={(event) => chooseMicrophone(event.target.value)}
            >
              <option value="">Default device</option>
              {microphones.map((device) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="voice-settings-button"
              onClick={() =>
                testing ? setTesting(null) : void testMicrophone(preferences.inputDeviceId)
              }
            >
              {testing ? 'Stop' : 'Test'}
            </button>
          </div>
          {testing && (
            <span className="voice-settings-meter-row">
              <span className="voice-settings-meter" aria-label="Input level">
                <span style={{ width: `${Math.round(level * 100)}%` }} />
              </span>
              {level > 0.01 ? 'Hearing you' : 'Say something…'}
            </span>
          )}
        </label>

        <label className="modern-field">
          <span>Speaker</span>
          <div className="voice-settings-row">
            <select
              value={preferences.outputDeviceId}
              onChange={(event) => updateVoicePreferences({ outputDeviceId: event.target.value })}
            >
              <option value="">Default device</option>
              {speakers.map((device) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="voice-settings-button"
              onClick={playSample}
              disabled={voice?.models.speech.status !== 'ready'}
              aria-label={sampleActive ? 'Stop sample' : 'Play a sample'}
            >
              {sampleActive ? <Square size={10} fill="currentColor" /> : <Play size={11} />}
              {sampleActive ? 'Stop' : 'Sample'}
            </button>
          </div>
        </label>

        <label className="modern-field">
          <span>Voice</span>
          <select
            value={preferences.voice}
            onChange={(event) => updateVoicePreferences({ voice: Number(event.target.value) })}
          >
            {SPEECH_VOICES.map((name, index) => (
              <option key={name} value={index}>
                {name}
              </option>
            ))}
          </select>
        </label>

        <label className="modern-field">
          <span>Read-aloud language</span>
          <select
            value={preferences.language}
            onChange={(event) =>
              updateVoicePreferences({
                language: event.target.value as SpeechLanguageCode | 'auto'
              })
            }
          >
            <option value="auto">Detect automatically</option>
            {LANGUAGES.map(([code, name]) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="voice-settings-check">
        <input
          type="checkbox"
          checked={preferences.readRepliesAloud}
          onChange={(event) => updateVoicePreferences({ readRepliesAloud: event.target.checked })}
        />
        <span>
          <strong>Talk back and forth</strong>
          With the mic on, read each reply aloud, then listen again.
        </span>
      </label>
      <p className="voice-settings-hint">
        Turn the mic on and off with {voiceShortcutLabel()}. Dictation detects the language you
        speak, among 25 European languages. These choices apply right away.
      </p>
      {notice && <p className="voice-settings-error">{notice}</p>}
    </div>
  )
}
