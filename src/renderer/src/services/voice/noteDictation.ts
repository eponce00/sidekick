import { captureMicrophone } from './microphone'
import { voicePreferences } from './voicePreferences'

export interface NoteDictation {
  /** Stops listening once what was said so far is transcribed. */
  stop: () => Promise<void>
}

/**
 * Dictation for a field the app window does not hold, such as a mark's note drawn over a page:
 * the window keeps the microphone and the transcription on this device, and hands on each piece
 * of text as it is heard. Rejects with a message the user can act on.
 */
export async function startNoteDictation(
  onText: (text: string, final: boolean) => void
): Promise<NoteDictation> {
  const api = window.api.voice
  const id = crypto.randomUUID().replaceAll('-', '')
  const result = await api.startDictation(id)
  if (!result.ok) throw new Error(result.message)
  const stopText = api.onDictationText((event) => {
    if (event.sessionId === id) onText(event.text, event.final)
  })
  try {
    const capture = await captureMicrophone(
      (samples) => api.pushDictationAudio(id, samples),
      voicePreferences().inputDeviceId
    )
    return {
      stop: async () => {
        await capture.stop().catch(() => undefined)
        try {
          await api.stopDictation(id)
        } finally {
          stopText()
        }
      }
    }
  } catch (error) {
    stopText()
    void api.cancelDictation(id)
    throw new Error(
      (error as DOMException)?.name === 'NotAllowedError'
        ? 'SideKick could not use the microphone. Allow microphone access for SideKick in your system privacy settings.'
        : 'No microphone was found. Connect one, or choose it in Settings → General → Voice.'
    )
  }
}
