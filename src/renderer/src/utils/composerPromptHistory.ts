// Adapted from T3 Code (https://github.com/pingdotgg/t3code, commit d15210c),
// apps/web/src/components/chat/composerPromptHistory.ts, under the MIT License:
//
// Copyright (c) 2026 T3 Tools Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

/**
 * Terminal-style prompt recall for the composer. ArrowUp at the start of the
 * box walks back through this conversation's sent prompts, ArrowDown walks
 * forward and, past the newest one, restores what was being typed before.
 *
 * History is derived from the conversation's user messages on each keypress,
 * so there is nothing to store or keep in sync.
 */

export interface PromptHistoryMessage {
  readonly id: string
  readonly role: string
  readonly content: string
  readonly hidden?: boolean
}

export interface PromptHistoryEntry {
  readonly id: string
  readonly prompt: string
}

/**
 * Active recall. `recalled` is the text put in the box; once the box no longer
 * matches it, the user has typed or sent and browsing is over. `draft` is what
 * was in the box when browsing began.
 */
export interface PromptHistoryPosition {
  readonly entryId: string
  readonly recalled: string
  readonly draft: string
}

export interface PromptHistoryStep {
  readonly position: PromptHistoryPosition | null
  readonly prompt: string
}

export type PromptHistoryDirection = 'backward' | 'forward'

/**
 * Oldest first. Consecutive identical prompts collapse into the newest one,
 * like a shell ignoring duplicates. Messages with no typed text (images or
 * attachments only) and hidden app-composed messages are skipped.
 */
export function buildPromptHistoryEntries(
  messages: readonly PromptHistoryMessage[]
): PromptHistoryEntry[] {
  const entries: PromptHistoryEntry[] = []
  for (const message of messages) {
    if (message.role !== 'user' || message.hidden) continue
    const prompt = message.content.trim()
    if (!prompt) continue
    if (entries.at(-1)?.prompt === prompt) {
      entries[entries.length - 1] = { id: message.id, prompt }
      continue
    }
    entries.push({ id: message.id, prompt })
  }
  return entries
}

/** The id is preferred; a collapsed duplicate falls back to the newest entry with the same text. */
function findActive(
  entries: readonly PromptHistoryEntry[],
  position: PromptHistoryPosition
): number {
  const byId = entries.findIndex((entry) => entry.id === position.entryId)
  if (byId >= 0) return byId
  return entries.findLastIndex((entry) => entry.prompt === position.recalled)
}

export function isBrowsingPromptHistory(
  position: PromptHistoryPosition | null,
  currentPrompt: string
): position is PromptHistoryPosition {
  return Boolean(position && position.recalled === currentPrompt)
}

/**
 * Whether the arrow key belongs to history rather than to caret movement.
 * Browsing starts only with the caret at the very start (or an empty box).
 * While browsing, any caret on the first line steps back and any caret on
 * the last line steps forward, so multi-line prompts can still be navigated.
 */
export function caretAllowsPromptHistoryStep(input: {
  readonly direction: PromptHistoryDirection
  readonly value: string
  readonly selectionStart: number
  readonly selectionEnd: number
  readonly browsing: boolean
}): boolean {
  const { direction, value, selectionStart, selectionEnd, browsing } = input
  if (selectionStart !== selectionEnd) return false
  if (direction === 'backward') {
    if (!value || selectionStart === 0) return true
    return browsing && !value.slice(0, selectionStart).includes('\n')
  }
  return browsing && !value.slice(selectionEnd).includes('\n')
}

/**
 * Returns null when the key should fall through to normal caret movement.
 * Backward stops at the oldest entry. Forward past the newest entry restores
 * the draft and ends browsing.
 */
export function stepPromptHistory(input: {
  readonly direction: PromptHistoryDirection
  readonly entries: readonly PromptHistoryEntry[]
  readonly position: PromptHistoryPosition | null
  readonly currentPrompt: string
}): PromptHistoryStep | null {
  const { entries, position, currentPrompt } = input
  const browsing = isBrowsingPromptHistory(position, currentPrompt)
  const activeIndex = browsing ? findActive(entries, position) : -1

  if (input.direction === 'backward') {
    const entry = entries[activeIndex < 0 ? entries.length - 1 : activeIndex - 1]
    if (!entry) return null
    const draft = activeIndex < 0 ? currentPrompt : position!.draft
    return { position: { entryId: entry.id, recalled: entry.prompt, draft }, prompt: entry.prompt }
  }

  if (activeIndex < 0) return null
  const entry = entries[activeIndex + 1]
  if (!entry) return { position: null, prompt: position!.draft }
  return {
    position: { entryId: entry.id, recalled: entry.prompt, draft: position!.draft },
    prompt: entry.prompt
  }
}
