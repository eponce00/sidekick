import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const player = vi.hoisted(() => {
  type Playback = { status: 'idle' } | { status: 'loading' | 'playing'; key: string }
  const listeners = new Set<(playback: Playback) => void>()
  let current: Playback = { status: 'idle' }
  const emit = (next: Playback): void => {
    current = next
    for (const listener of listeners) listener(next)
  }
  return {
    emit,
    speechPlayer: {
      current: () => current,
      subscribe: (listener: (playback: Playback) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      toggle: vi.fn(async (key: string) => {
        emit({ status: 'loading', key })
        return undefined
      }),
      stop: vi.fn(() => emit({ status: 'idle' }))
    }
  }
})
const preferences = vi.hoisted(() => ({ readRepliesAloud: true }))

vi.mock('./speechPlayer', () => ({ speechPlayer: player.speechPlayer }))
vi.mock('./voicePreferences', () => ({ voicePreferences: () => preferences }))

import {
  skipVoiceLoopReading,
  startVoiceLoop,
  stopVoiceLoop,
  toggleVoiceLoop,
  voiceLoopMode,
  voiceLoopReplyFinished,
  voiceLoopReplyStarted,
  voiceLoopSent
} from './voiceLoop'

describe('voice conversation', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    preferences.readRepliesAloud = true
    player.speechPlayer.toggle.mockClear()
    player.speechPlayer.stop.mockClear()
  })
  afterEach(() => {
    stopVoiceLoop()
    vi.useRealTimers()
  })

  it('listens, pauses for the reply, reads its answer, and listens again', async () => {
    toggleVoiceLoop()
    expect(voiceLoopMode()).toBe('listening')
    voiceLoopSent()
    expect(voiceLoopMode()).toBe('waiting')
    voiceLoopReplyStarted()
    // A long reply keeps the loop waiting past the start timeout.
    vi.advanceTimersByTime(60_000)
    expect(voiceLoopMode()).toBe('waiting')
    voiceLoopReplyFinished('Here is the answer.')
    expect(voiceLoopMode()).toBe('speaking')
    expect(player.speechPlayer.toggle).toHaveBeenCalledWith(
      'voice-loop-reply',
      'Here is the answer.'
    )
    player.emit({ status: 'playing', key: 'voice-loop-reply' })
    expect(voiceLoopMode()).toBe('speaking')
    player.emit({ status: 'idle' })
    expect(voiceLoopMode()).toBe('listening')
  })

  it('keeps listening after a send when replies are not read aloud', () => {
    preferences.readRepliesAloud = false
    startVoiceLoop()
    voiceLoopSent()
    expect(voiceLoopMode()).toBe('listening')
  })

  it('listens again when a sent message never starts a reply', () => {
    startVoiceLoop()
    voiceLoopSent()
    vi.advanceTimersByTime(4_000)
    expect(voiceLoopMode()).toBe('listening')
  })

  it('skips a reading on request, and listens again after a reply with nothing to read', () => {
    startVoiceLoop()
    voiceLoopSent()
    voiceLoopReplyFinished('Answer.')
    expect(skipVoiceLoopReading()).toBe(true)
    expect(player.speechPlayer.stop).toHaveBeenCalled()
    expect(voiceLoopMode()).toBe('listening')
    expect(skipVoiceLoopReading()).toBe(false)
    voiceLoopSent()
    voiceLoopReplyFinished('   ')
    expect(voiceLoopMode()).toBe('listening')
  })

  it('turns off from any state, silencing a reading', () => {
    startVoiceLoop()
    voiceLoopSent()
    voiceLoopReplyFinished('Answer.')
    toggleVoiceLoop()
    expect(voiceLoopMode()).toBe('off')
    expect(player.speechPlayer.stop).toHaveBeenCalled()
    // A reply finishing after the user turned voice off is not read.
    voiceLoopReplyFinished('Late answer.')
    expect(voiceLoopMode()).toBe('off')
  })
})
