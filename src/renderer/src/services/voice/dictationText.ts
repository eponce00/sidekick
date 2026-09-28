/** Inserts dictated text at the caret, spaced from the words around it. */
export function insertDictation(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  text: string
): { value: string; caret: number } {
  const before = value.slice(0, selectionStart)
  const after = value.slice(selectionEnd)
  const lead = before && !/\s$/.test(before) ? ' ' : ''
  const trail = after && !/^[\s.,!?;:]/.test(after) ? ' ' : ''
  return {
    value: `${before}${lead}${text}${trail}${after}`,
    caret: before.length + lead.length + text.length
  }
}

/** Where the next dictated words go: a selection or caret, or a draft to replace. */
export interface DictationRange {
  start: number
  end: number
}

/**
 * Puts dictated text into the message. A draft of the phrase still being
 * spoken stays selected as the range the next text replaces; final text is
 * kept and the range collapses after it. Empty final text removes a draft.
 */
export function applyDictation(
  value: string,
  range: DictationRange,
  text: string,
  final: boolean
): { value: string; range: DictationRange; caret: number } {
  if (!text) {
    const next = value.slice(0, range.start) + value.slice(range.end)
    return { value: next, range: { start: range.start, end: range.start }, caret: range.start }
  }
  const next = insertDictation(value, range.start, range.end, text)
  return {
    value: next.value,
    range: final ? { start: next.caret, end: next.caret } : { start: range.start, end: next.caret },
    caret: next.caret
  }
}
