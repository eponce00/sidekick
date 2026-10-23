// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentRunEvent } from '../../../shared/agentRuntime'
import type { CompanionConnection } from './chatState'
import { bindPhoneApi, createPhoneApi, dispatchToPhoneApi, resolvePhoneImage } from './phoneApi'
import { refreshPhoneVoice, voiceStateFor } from './phoneVoice'

function fakeConnection(handlers: Record<string, (input: never) => unknown>) {
  const call = vi.fn(async (name: string, input: unknown) => {
    const handler = handlers[name]
    if (!handler) throw new Error(`unexpected ${name}`)
    return handler(input as never)
  })
  return {
    connection: { call, listen: vi.fn(), close: vi.fn() } as unknown as CompanionConnection,
    call
  }
}

afterEach(() => {
  bindPhoneApi(null)
  void refreshPhoneVoice(null)
})

describe('images on the phone', () => {
  it('show their own data, and captures the computer keeps, fetched once', async () => {
    const { connection, call } = fakeConnection({
      'media.get': () => ({ dataUrl: 'data:image/jpeg;base64,AAAA' })
    })
    bindPhoneApi(connection)
    expect(await resolvePhoneImage('data:image/png;base64,AA==')).toBe('data:image/png;base64,AA==')
    const url = 'sidekick-browser://artifact/abc'
    expect(await resolvePhoneImage(url)).toBe('data:image/jpeg;base64,AAAA')
    expect(await resolvePhoneImage(url)).toBe('data:image/jpeg;base64,AAAA')
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('leave out anything on the network, and anything that is not an image', async () => {
    const { connection } = fakeConnection({ 'media.get': () => ({ dataUrl: 'data:text/html,x' }) })
    bindPhoneApi(connection)
    expect(
      await resolvePhoneImage('https://cdn.jsdelivr.net/gh/twitter/twemoji/1f389.svg')
    ).toBeNull()
    expect(await resolvePhoneImage('data:text/html,<script>')).toBeNull()
    expect(await resolvePhoneImage('sidekick-browser://artifact/page')).toBeNull()
  })

  it('try a capture again after a failure', async () => {
    let fail = true
    const { connection } = fakeConnection({
      'media.get': () => {
        if (fail) throw new Error('offline')
        return { dataUrl: 'data:image/png;base64,AA==' }
      }
    })
    bindPhoneApi(connection)
    expect(await resolvePhoneImage('sidekick-browser://artifact/x')).toBeNull()
    fail = false
    expect(await resolvePhoneImage('sidekick-browser://artifact/x')).toBe(
      'data:image/png;base64,AA=='
    )
  })
})

describe('the desktop API on the phone', () => {
  it('passes the computer’s run events to the components that follow runs', () => {
    const api = createPhoneApi()
    const seen: string[] = []
    const stop = api.agentRuns.onEvent(({ event }) => seen.push(event.id))
    const event = {
      id: 'e1',
      runId: 'r',
      sequence: 1,
      type: 'run.started',
      timestamp: 0,
      payload: {}
    }
    dispatchToPhoneApi({ type: 'run.event', event: event as AgentRunEvent })
    stop()
    dispatchToPhoneApi({ type: 'run.event', event: { ...event, id: 'e2' } as AgentRunEvent })
    expect(seen).toEqual(['e1'])
  })

  it('answers cards and follows sub-agents through the connection', async () => {
    const { connection, call } = fakeConnection({
      'interaction.resolve': () => ({ success: true }),
      'run.events': () => ({ run: { id: 'child' }, events: [] })
    })
    bindPhoneApi(connection)
    const api = createPhoneApi()
    await expect(
      api.agentRuns.resolveInteraction({ interactionId: 'i', response: { approved: true } })
    ).resolves.toEqual({ success: true })
    await expect(api.agentRuns.events('child', 3)).resolves.toMatchObject({
      run: { id: 'child' },
      pendingInteractions: []
    })
    expect(call).toHaveBeenCalledWith('run.events', { runId: 'child', afterSequence: 3 })
  })

  it('says to use the computer for its files, windows and browser', async () => {
    const notice = vi.fn()
    bindPhoneApi(fakeConnection({}).connection, notice)
    const api = createPhoneApi()
    await api.workspace.openFile()
    expect(notice).toHaveBeenCalledWith('Open this on the computer to use it.')
    await expect(api.agentRuns.beginBrowserHumanTakeover()).rejects.toThrow(/computer/)
    await expect(api.sessions.startProposal()).rejects.toThrow(/computer/)
    expect(await api.siteIcons.get()).toEqual({ dataUrl: null })
  })
})

describe('read aloud on the phone', () => {
  it('shows only when the computer can speak', () => {
    expect(voiceStateFor(null).enabled).toBe(false)
    const state = voiceStateFor({ dictation: true, speech: false, message: null })
    expect(state.enabled).toBe(false)
    expect(state.models.dictation.status).toBe('ready')
    expect(voiceStateFor({ dictation: false, speech: true, message: null })).toMatchObject({
      enabled: true,
      models: { speech: { status: 'ready' } }
    })
  })

  it('plays the speech the computer sends, decoded to samples', async () => {
    const { connection, call } = fakeConnection({
      'voice.state': () => ({ dictation: false, speech: true, message: null }),
      'voice.speak': () => ({ ok: true }),
      'voice.stop': () => ({ stopped: true })
    })
    bindPhoneApi(connection)
    await refreshPhoneVoice(connection)
    const voice = createPhoneVoice()
    expect((await voice.getState()).enabled).toBe(true)
    const audio: Array<{ speechId: string; samples: number[] }> = []
    const ended: string[] = []
    voice.onSpeechAudio(({ speechId, samples }) =>
      audio.push({ speechId, samples: Array.from(samples) })
    )
    voice.onSpeechEnd(({ speechId }) => ended.push(speechId))
    expect(await voice.speak('s1', 'Hello')).toEqual({ ok: true })
    // 0x7fff then 0x8000 (-32768), little-endian.
    dispatchToPhoneApi({
      type: 'speech.audio',
      speechId: 's1',
      sampleRate: 24_000,
      pcm: '/38AgA=='
    })
    dispatchToPhoneApi({ type: 'speech.end', speechId: 's1' })
    expect(audio).toEqual([{ speechId: 's1', samples: [1, -1] }])
    expect(ended).toEqual(['s1'])
    await voice.stopSpeech('s1')
    expect(call).toHaveBeenCalledWith('voice.stop', { speechId: 's1' })
  })

  it('reports why speech did not start', async () => {
    const { connection } = fakeConnection({
      'voice.speak': () => ({ ok: false, message: 'Read aloud is off on the computer.' })
    })
    bindPhoneApi(connection)
    expect(await createPhoneVoice().speak('s2', 'Hi')).toEqual({
      ok: false,
      reason: 'unavailable',
      message: 'Read aloud is off on the computer.'
    })
  })
})

function createPhoneVoice() {
  return createPhoneApi().voice
}
