import { describe, expect, it } from 'vitest'
import {
  buildPromptHistoryEntries,
  caretAllowsPromptHistoryStep,
  stepPromptHistory,
  type PromptHistoryEntry,
  type PromptHistoryPosition
} from './composerPromptHistory'

const entries: PromptHistoryEntry[] = [
  { id: 'm1', prompt: 'first' },
  { id: 'm2', prompt: 'second' },
  { id: 'm3', prompt: 'third' }
]

function walk(
  keys: ('backward' | 'forward')[],
  start = ''
): { prompt: string; position: PromptHistoryPosition | null } {
  let prompt = start
  let position: PromptHistoryPosition | null = null
  for (const direction of keys) {
    const step = stepPromptHistory({ direction, entries, position, currentPrompt: prompt })
    if (!step) continue
    prompt = step.prompt
    position = step.position
  }
  return { prompt, position }
}

describe('buildPromptHistoryEntries', () => {
  it('keeps typed user prompts, oldest first, without hidden, empty or repeated ones', () => {
    expect(
      buildPromptHistoryEntries([
        { id: 'u1', role: 'user', content: '  fix the test  ' },
        { id: 'a1', role: 'agent', content: 'done' },
        { id: 'u2', role: 'user', content: '' },
        { id: 'u3', role: 'user', content: 'again' },
        { id: 'u4', role: 'user', content: 'again' },
        { id: 'u5', role: 'user', content: 'internal', hidden: true },
        { id: 'u6', role: 'user', content: 'ship it' }
      ])
    ).toEqual([
      { id: 'u1', prompt: 'fix the test' },
      { id: 'u4', prompt: 'again' },
      { id: 'u6', prompt: 'ship it' }
    ])
  })
})

describe('stepPromptHistory', () => {
  it('walks back from the newest prompt and stops at the oldest', () => {
    expect(walk(['backward']).prompt).toBe('third')
    expect(walk(['backward', 'backward']).prompt).toBe('second')
    expect(walk(['backward', 'backward', 'backward', 'backward']).prompt).toBe('first')
  })

  it('walks forward and restores the draft past the newest prompt', () => {
    expect(walk(['backward', 'backward', 'forward']).prompt).toBe('third')
    const done = walk(['backward', 'backward', 'forward', 'forward'], 'half typed')
    expect(done).toEqual({ prompt: 'half typed', position: null })
  })

  it('does nothing forward unless browsing', () => {
    expect(
      stepPromptHistory({ direction: 'forward', entries, position: null, currentPrompt: '' })
    ).toBeNull()
  })

  it('ends browsing once the recalled text is edited', () => {
    const recalled = walk(['backward'], 'draft')
    const edited = `${recalled.prompt}!`
    expect(
      stepPromptHistory({
        direction: 'forward',
        entries,
        position: recalled.position,
        currentPrompt: edited
      })
    ).toBeNull()
    // A fresh backward step starts again from the newest, keeping the edit as the draft.
    expect(
      stepPromptHistory({
        direction: 'backward',
        entries,
        position: recalled.position,
        currentPrompt: edited
      })?.position
    ).toMatchObject({ entryId: 'm3', draft: edited })
  })

  it('returns nothing without history', () => {
    expect(
      stepPromptHistory({ direction: 'backward', entries: [], position: null, currentPrompt: '' })
    ).toBeNull()
  })
})

describe('caretAllowsPromptHistoryStep', () => {
  const allows = (
    direction: 'backward' | 'forward',
    value: string,
    caret: number,
    browsing = false,
    selectionEnd = caret
  ): boolean =>
    caretAllowsPromptHistoryStep({
      direction,
      value,
      selectionStart: caret,
      selectionEnd,
      browsing
    })

  it('starts browsing only from an empty box or the very start', () => {
    expect(allows('backward', '', 0)).toBe(true)
    expect(allows('backward', 'typed', 0)).toBe(true)
    expect(allows('backward', 'typed', 3)).toBe(false)
    expect(allows('backward', 'typed', 0, false, 3)).toBe(false)
  })

  it('leaves multi-line caret movement alone', () => {
    expect(allows('backward', 'one\ntwo', 5)).toBe(false)
    expect(allows('backward', 'one\ntwo', 5, true)).toBe(false)
    expect(allows('backward', 'one\ntwo', 2, true)).toBe(true)
    expect(allows('forward', 'one\ntwo', 2, true)).toBe(false)
    expect(allows('forward', 'one\ntwo', 5, true)).toBe(true)
    expect(allows('forward', 'one', 3, false)).toBe(false)
  })
})
