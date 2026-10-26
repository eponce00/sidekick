// Dates in form fields. A native date input takes only its own ISO form and ignores typing it
// as text; a text box written in a format such as MM/DD/YYYY takes the date in that format, and
// its input mask may add or drop the separators. Adapted from the date filling in Pomerado
// (https://github.com/Pomerado/pomerado, typescript/src/browser/form-controls.ts; Copyright (c)
// 2026 Pomerado AI, Inc., MIT License, notice in browserPicker.ts).

/** The value each native date or time input takes. */
const NATIVE_FORMATS: Record<string, { pattern: RegExp; example: string }> = {
  date: { pattern: /^\d{4}-\d{2}-\d{2}$/, example: 'YYYY-MM-DD' },
  'datetime-local': {
    pattern: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/,
    example: 'YYYY-MM-DDTHH:MM'
  },
  month: { pattern: /^\d{4}-\d{2}$/, example: 'YYYY-MM' },
  week: { pattern: /^\d{4}-W\d{2}$/, example: 'YYYY-Www' },
  time: { pattern: /^\d{2}:\d{2}(:\d{2})?$/, example: 'HH:MM' }
}

export function nativeDateFormat(
  inputType: string | undefined
): { pattern: RegExp; example: string } | undefined {
  return inputType ? NATIVE_FORMATS[inputType] : undefined
}

/** The date format a text box asks for in its placeholder, such as `MM/DD/YYYY`, if any. */
export function fieldDateFormat(hint: string | undefined): string | undefined {
  const format = String(hint ?? '')
    .trim()
    .toUpperCase()
  // Three numeric parts, a day, a month and a year, each once, between one kind of separator.
  const match = /^(YYYY|YY|MM|M|DD|D)([/.\- ])(YYYY|YY|MM|M|DD|D)\2(YYYY|YY|MM|M|DD|D)$/.exec(
    format
  )
  if (!match) return undefined
  const parts = [match[1], match[3], match[4]].map((part) => part[0])
  return new Set(parts).size === 3 ? format : undefined
}

/** An ISO `YYYY-MM-DD` date written in `format`, or undefined for anything else. */
export function formatDate(iso: string, format: string): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim())
  if (!match) return undefined
  const [, year, month, day] = match
  const at = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)))
  if (at.getUTCMonth() !== Number(month) - 1 || at.getUTCDate() !== Number(day)) return undefined
  const tokens: Record<string, string> = {
    YYYY: year,
    YY: year.slice(2),
    MM: month,
    M: String(Number(month)),
    DD: day,
    D: String(Number(day))
  }
  return format.replace(/YYYY|YY|MM|M|DD|D/g, (token) => tokens[token])
}

/** Whether a field shows what was entered, allowing a mask's separators. */
export function sameEnteredText(actual: string | undefined, expected: string): boolean {
  if (actual === expected) return true
  const kept = (text: string): string => text.replace(/[^\p{L}\p{N}]/gu, '')
  return kept(expected) !== '' && kept(actual ?? '') === kept(expected)
}
