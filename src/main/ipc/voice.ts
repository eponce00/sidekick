import { BrowserWindow, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import type { SpeechOptions, VoiceState } from '../../shared/voice'
import type { VoiceService } from '../services/voice/voiceService'
import { appState } from './state'

function publish(state: VoiceState): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('voice:state', state)
  }
}

/** Voice captures the microphone and speaks aloud, so only the app's own page may drive it. */
function assertAppSender(event: IpcMainInvokeEvent | IpcMainEvent): void {
  if (
    event.sender !== appState.mainWindowRef?.webContents ||
    event.senderFrame !== event.sender.mainFrame
  ) {
    throw new Error('Only the SideKick application can use voice')
  }
}

function boundedId(value: unknown): string {
  if (typeof value !== 'string' || !/^[\w-]{1,80}$/.test(value)) {
    throw new Error('Invalid voice session')
  }
  return value
}

export function registerVoiceHandlers(service: VoiceService): () => void {
  ipcMain.handle('voice:getState', () => service.state())

  ipcMain.handle('voice:prioritize', (event, id: unknown) => {
    assertAppSender(event)
    if (id === 'dictation' || id === 'speech') service.prioritize(id)
  })

  ipcMain.handle('voice:dictation:start', (event, sessionId: unknown) => {
    assertAppSender(event)
    const id = boundedId(sessionId)
    const sender = event.sender
    return service.startDictation(id, (text, final) => {
      if (!sender.isDestroyed()) sender.send('voice:dictation:text', { sessionId: id, text, final })
    })
  })

  ipcMain.on('voice:dictation:audio', (event, sessionId: unknown, samples: unknown) => {
    try {
      assertAppSender(event)
      if (!(samples instanceof Float32Array) || samples.length > 16_000 * 5) return
      service.pushDictationAudio(boundedId(sessionId), samples)
    } catch {
      // Audio is best effort; an invalid frame is dropped, not answered.
    }
  })

  ipcMain.handle('voice:dictation:stop', (event, sessionId: unknown) => {
    assertAppSender(event)
    return service.stopDictation(boundedId(sessionId))
  })

  ipcMain.handle('voice:dictation:cancel', (event, sessionId: unknown) => {
    assertAppSender(event)
    service.cancelDictation(boundedId(sessionId))
  })

  ipcMain.handle(
    'voice:speak',
    async (event, speechId: unknown, text: unknown, options: unknown) => {
      assertAppSender(event)
      const id = boundedId(speechId)
      if (typeof text !== 'string') throw new Error('Invalid text')
      const requested = (options && typeof options === 'object' ? options : {}) as SpeechOptions
      const sender = event.sender
      const started = await service.speak(
        id,
        text.slice(0, 60_000),
        (samples, sampleRate) => {
          if (!sender.isDestroyed()) {
            sender.send('voice:speech:audio', { speechId: id, samples, sampleRate })
          }
        },
        // The service checks both against the voices and languages it has.
        { voice: requested.voice, language: requested.language }
      )
      if (!started.ok) return started
      void started.finished
        ?.then(() => undefined)
        .catch((error: Error) => error.message)
        .then((error) => {
          if (!sender.isDestroyed()) {
            sender.send('voice:speech:end', { speechId: id, ...(error ? { error } : {}) })
          }
        })
      return { ok: true }
    }
  )

  ipcMain.handle('voice:speech:stop', (event, speechId: unknown) => {
    assertAppSender(event)
    service.stopSpeech(boundedId(speechId))
  })

  return service.onState(publish)
}
