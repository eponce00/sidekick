import { useSyncExternalStore } from 'react'
import { speechPlayer } from './speechPlayer'
import { voicePreferences } from './voicePreferences'

/**
 * Voice conversation: with the mic on, SideKick listens and writes what is
 * said; Enter sends, the mic pauses while the reply is written and read aloud,
 * then it listens again. The user, not silence detection, decides when a
 * message is finished.
 *
 *   off ─mic/shortcut→ listening ─Enter→ waiting ─reply→ speaking ─read→ listening
 *
 * The mic or the shortcut turns it off from any state; Esc, or the mic while
 * reading, skips the reading.
 */
export type VoiceLoopMode = 'off' | 'listening' | 'waiting' | 'speaking'

const SPEECH_KEY = 'voice-loop-reply'
// A send that never starts a reply (refused, failed at once) must not strand
// the loop waiting.
const REPLY_START_TIMEOUT_MS = 4_000

let mode: VoiceLoopMode = 'off'
const listeners = new Set<() => void>()
let replyStarted = false
let replyTimer: ReturnType<typeof setTimeout> | undefined
let speechSeen = false

function set(next: VoiceLoopMode): void {
  if (next === mode) return
  mode = next
  if (replyTimer) clearTimeout(replyTimer)
  replyTimer = undefined
  for (const listener of listeners) listener()
}

export function voiceLoopMode(): VoiceLoopMode {
  return mode
}

export function useVoiceLoop(): VoiceLoopMode {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => mode
  )
}

export function startVoiceLoop(): void {
  set('listening')
}

export function stopVoiceLoop(): void {
  if (mode === 'speaking') speechPlayer.stop()
  set('off')
}

export function toggleVoiceLoop(): void {
  if (mode === 'off') startVoiceLoop()
  else stopVoiceLoop()
}

/** Ends the reading of a reply and listens again. */
export function skipVoiceLoopReading(): boolean {
  if (mode !== 'speaking') return false
  speechPlayer.stop()
  set('listening')
  return true
}

/** A message was sent while listening: pause for the reply, if it is to be read. */
export function voiceLoopSent(): void {
  if (mode !== 'listening' || !voicePreferences().readRepliesAloud) return
  replyStarted = false
  set('waiting')
  replyTimer = setTimeout(() => {
    if (mode === 'waiting' && !replyStarted) set('listening')
  }, REPLY_START_TIMEOUT_MS)
}

/** The chat started producing a reply. */
export function voiceLoopReplyStarted(): void {
  replyStarted = true
  if (replyTimer) clearTimeout(replyTimer)
  replyTimer = undefined
}

/** The reply finished; read its answer, then listen again. */
export function voiceLoopReplyFinished(answer: string): void {
  if (mode !== 'waiting') return
  if (!answer.trim()) {
    set('listening')
    return
  }
  speechSeen = false
  set('speaking')
  void speechPlayer.toggle(SPEECH_KEY, answer).then((problem) => {
    if (problem && mode === 'speaking') set('listening')
  })
}

// Reading ends when the player goes quiet after playing this reply.
speechPlayer.subscribe((playback) => {
  if (mode !== 'speaking') return
  if (playback.status !== 'idle' && playback.key === SPEECH_KEY) speechSeen = true
  else if (playback.status === 'idle' && speechSeen) set('listening')
  // Another message read by hand takes over the speaker; stop waiting on it.
  else if (playback.status !== 'idle' && playback.key !== SPEECH_KEY) set('listening')
})
