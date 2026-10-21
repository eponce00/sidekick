import { useCallback, useEffect, useId, useState } from 'react'
import {
  Activity,
  AudioLines,
  CircleAlert,
  Download,
  Keyboard,
  Languages,
  MessagesSquare,
  Mic,
  Play,
  Square,
  UserRound,
  Volume2
} from 'lucide-react'
import {
  SPEECH_LANGUAGES,
  SPEECH_VOICES,
  voiceModelProgress,
  type SpeechLanguageCode,
  type SpeechVoiceId,
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
import { SettingsRow, SettingsSection, ToggleField } from './SettingsLayout'
import { Select } from './Select'

type Device = { deviceId: string; label: string }

// CC BY 4.0 asks for the creators, the license, and what was changed.
const PARAKEET_ULTRA_URL = 'https://huggingface.co/moondream/parakeet-ultra'
const NVIDIA_PARAKEET_URL = 'https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3'
const CC_BY_URL = 'https://creativecommons.org/licenses/by/4.0/'

const SAMPLES: Partial<Record<SpeechLanguageCode, string>> = {
  en: 'Hi! This is how SideKick sounds when it reads a message to you.',
  es: '¡Hola! Así suena SideKick cuando te lee un mensaje.',
  pt: 'Olá! É assim que o SideKick soa quando lê uma mensagem para você.',
  fr: 'Bonjour ! Voici comment SideKick lit un message à voix haute.',
  it: 'Ciao! Ecco come suona SideKick quando ti legge un messaggio.',
  hi: 'नमस्ते! जब SideKick आपको संदेश पढ़कर सुनाता है, तो ऐसा सुनाई देता है।'
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
 * The Voice section of Settings. The switch is a saved setting; the device, voice, and language
 * choices below it belong to this machine and apply at once. Defaults follow the system and
 * detect the language.
 */
export function VoiceSettings({
  enabled,
  onEnabledChange
}: {
  enabled: boolean
  onEnabledChange: (enabled: boolean) => void
}): React.JSX.Element {
  return (
    <SettingsSection
      icon={AudioLines}
      title="Voice"
      description="Dictate messages and have replies read aloud. Speech never leaves this device."
    >
      <ToggleField
        icon={AudioLines}
        label="Dictation and read-aloud"
        hint={
          <>
            Downloads about 1 GB of speech models once, in the background. Dictation uses{' '}
            <a href={PARAKEET_ULTRA_URL} target="_blank" rel="noreferrer">
              Parakeet Ultra
            </a>{' '}
            by Moondream, based on{' '}
            <a href={NVIDIA_PARAKEET_URL} target="_blank" rel="noreferrer">
              NVIDIA Parakeet
            </a>
            , both{' '}
            <a href={CC_BY_URL} target="_blank" rel="noreferrer">
              CC BY 4.0
            </a>
            ; SideKick converted and quantized it. Read-aloud uses Kokoro (Apache 2.0).
          </>
        }
        checked={enabled}
        onChange={onEnabledChange}
      />
      {enabled && <VoiceDeviceRows />}
    </SettingsSection>
  )
}

function VoiceDeviceRows(): React.JSX.Element {
  const voice = useVoiceState()
  const preferences = useVoicePreferences()
  const playback = useSpeechPlayback()
  const id = useId()
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
  const hearing = level > 0.01

  return (
    <>
      {pending.length > 0 && (
        <p className="settings-note voice-settings-status" role="status">
          <Download size={14} aria-hidden="true" />
          <span>Setting up · {pending.join(' · ')}</span>
        </p>
      )}
      <SettingsRow
        icon={Mic}
        label="Microphone"
        description="Dictation listens here."
        controlId={`${id}-microphone`}
        control={
          <span className="voice-device-control">
            <Select
              id={`${id}-microphone`}
              value={preferences.inputDeviceId}
              onChange={(event) => chooseMicrophone(event.target.value)}
            >
              <option value="">Default device</option>
              {microphones.map((device) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label}
                </option>
              ))}
            </Select>
            <button
              type="button"
              className="settings-secondary-action"
              onClick={() =>
                testing ? setTesting(null) : void testMicrophone(preferences.inputDeviceId)
              }
              aria-label={testing ? 'Stop microphone test' : 'Test microphone'}
            >
              {testing ? (
                <Square size={11} fill="currentColor" aria-hidden="true" />
              ) : (
                <Activity size={14} aria-hidden="true" />
              )}
              {testing ? 'Stop' : 'Test'}
            </button>
          </span>
        }
      >
        {testing && (
          <span className={`voice-settings-meter-row${hearing ? ' hearing' : ''}`}>
            <span className="voice-settings-meter" aria-label="Input level">
              <span style={{ width: `${Math.round(level * 100)}%` }} />
            </span>
            {hearing ? 'Hearing you' : 'Say something…'}
          </span>
        )}
      </SettingsRow>

      <SettingsRow
        icon={Volume2}
        label="Speaker"
        description="Replies are read aloud here."
        controlId={`${id}-speaker`}
        control={
          <span className="voice-device-control">
            <Select
              id={`${id}-speaker`}
              value={preferences.outputDeviceId}
              onChange={(event) => updateVoicePreferences({ outputDeviceId: event.target.value })}
            >
              <option value="">Default device</option>
              {speakers.map((device) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label}
                </option>
              ))}
            </Select>
            <button
              type="button"
              className="settings-secondary-action"
              onClick={playSample}
              disabled={voice?.models.speech.status !== 'ready'}
              aria-label={sampleActive ? 'Stop sample' : 'Play a sample'}
            >
              {sampleActive ? (
                <Square size={11} fill="currentColor" aria-hidden="true" />
              ) : (
                <Play size={13} aria-hidden="true" />
              )}
              {sampleActive ? 'Stop' : 'Sample'}
            </button>
          </span>
        }
      />

      <SettingsRow
        icon={UserRound}
        label="Voice"
        description="A reply in another language is read by that language's voice of the same kind."
        controlId={`${id}-voice`}
        control={
          <Select
            id={`${id}-voice`}
            className="voice-wide-select"
            value={preferences.voice}
            onChange={(event) =>
              updateVoicePreferences({ voice: event.target.value as SpeechVoiceId })
            }
          >
            {SPEECH_VOICES.map(({ id: voiceId, name, gender }) => (
              <option key={voiceId} value={voiceId}>
                {`${name} · ${gender === 'female' ? 'Female' : 'Male'}`}
              </option>
            ))}
          </Select>
        }
      />

      <SettingsRow
        icon={Languages}
        label="Read-aloud language"
        description="Detected from each message unless you choose one."
        controlId={`${id}-language`}
        control={
          <Select
            id={`${id}-language`}
            className="voice-wide-select"
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
          </Select>
        }
      />

      <ToggleField
        icon={MessagesSquare}
        label="Talk back and forth"
        hint="With the mic on, read each reply aloud, then listen again."
        checked={preferences.readRepliesAloud}
        onChange={(readRepliesAloud) => updateVoicePreferences({ readRepliesAloud })}
      />

      <SettingsRow
        icon={Keyboard}
        label="Mic shortcut"
        description="Turns the mic on and off. Dictation understands 25 European languages."
        control={<kbd className="settings-kbd">{voiceShortcutLabel()}</kbd>}
      />
      {notice && (
        <p className="settings-note error" role="alert">
          <CircleAlert size={14} aria-hidden="true" />
          {notice}
        </p>
      )}
    </>
  )
}
