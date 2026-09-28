import { VOICE_SAMPLE_RATE } from '../../../../shared/voice'
import workletUrl from './pcmCapture.worklet.js?url&no-inline'

export interface MicrophoneCapture {
  /** The device being listened to, as the system names it. */
  label: string
  /** Live input level, 0 to 1, for the recording indicator. */
  level: () => number
  stop: () => Promise<void>
}

const PROCESSING = {
  channelCount: 1,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true
}

async function openMicrophone(deviceId: string): Promise<MediaStream> {
  if (deviceId) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: { ...PROCESSING, deviceId: { exact: deviceId } }
      })
    } catch (error) {
      // A chosen microphone that was unplugged falls back to the default.
      if ((error as DOMException)?.name !== 'OverconstrainedError') throw error
    }
  }
  return navigator.mediaDevices.getUserMedia({ audio: PROCESSING })
}

/**
 * Microphones or speakers the system offers, without its "Default" aliases
 * (the default is offered separately). Names appear once microphone access
 * has been granted.
 */
export async function listAudioDevices(
  kind: 'audioinput' | 'audiooutput'
): Promise<Array<{ deviceId: string; label: string }>> {
  const devices = await navigator.mediaDevices.enumerateDevices()
  const noun = kind === 'audioinput' ? 'Microphone' : 'Speaker'
  return devices
    .filter(
      (device) =>
        device.kind === kind &&
        device.deviceId !== 'default' &&
        device.deviceId !== 'communications'
    )
    .map((device, index) => ({
      deviceId: device.deviceId,
      label: device.label || `${noun} ${index + 1}`
    }))
}

/**
 * Captures the microphone as 16 kHz mono frames, the rate the dictation models
 * take. Chromium resamples the device to the context's rate.
 */
export async function captureMicrophone(
  onFrame: (samples: Float32Array) => void,
  deviceId = ''
): Promise<MicrophoneCapture> {
  const stream = await openMicrophone(deviceId)
  const context = new AudioContext({ sampleRate: VOICE_SAMPLE_RATE })
  try {
    await context.audioWorklet.addModule(workletUrl)
    const source = context.createMediaStreamSource(stream)
    const capture = new AudioWorkletNode(context, 'sidekick-pcm-capture')
    const analyser = context.createAnalyser()
    analyser.fftSize = 512
    const levels = new Float32Array(analyser.fftSize)
    capture.port.onmessage = (event: MessageEvent<Float32Array>) => onFrame(event.data)
    source.connect(analyser)
    source.connect(capture)
    return {
      label: stream.getAudioTracks()[0]?.label || 'the microphone',
      level: () => {
        analyser.getFloatTimeDomainData(levels)
        let sum = 0
        for (const sample of levels) sum += sample * sample
        return Math.min(1, Math.sqrt(sum / levels.length) * 4)
      },
      stop: async () => {
        capture.port.onmessage = null
        source.disconnect()
        for (const track of stream.getTracks()) track.stop()
        await context.close()
      }
    }
  } catch (error) {
    for (const track of stream.getTracks()) track.stop()
    await context.close()
    throw error
  }
}
