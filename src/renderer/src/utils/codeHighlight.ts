import hljs from 'highlight.js/lib/common'

/** Extensions highlight.js does not name the way the file does. */
const LANGUAGE_ALIASES: Record<string, string> = {
  mjs: 'javascript',
  cjs: 'javascript',
  mts: 'typescript',
  cts: 'typescript',
  jsx: 'javascript',
  tsx: 'typescript',
  yml: 'yaml',
  ps1: 'powershell',
  sh: 'bash',
  zsh: 'bash',
  h: 'c',
  hpp: 'cpp',
  cc: 'cpp',
  rs: 'rust',
  kt: 'kotlin',
  py: 'python',
  rb: 'ruby',
  cs: 'csharp',
  toml: 'ini',
  env: 'ini',
  txt: 'plaintext',
  log: 'plaintext'
}

export function extensionOf(filePath: string): string {
  const name = filePath.split(/[\\/]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export function languageFor(extension: string): string | null {
  const candidate = LANGUAGE_ALIASES[extension] ?? extension
  return candidate && hljs.getLanguage(candidate) ? candidate : null
}

/**
 * Highlighted HTML, one entry per source line. The HTML is escaped by highlight.js, so it is safe
 * to inject. Without a language, highlight.js guesses.
 */
export function highlightLines(text: string, language: string | null): string[] {
  const html = language
    ? hljs.highlight(text, { language, ignoreIllegals: true }).value
    : hljs.highlightAuto(text).value
  return html.split('\n')
}

export interface NumberedLine {
  number: number | null
  text: string
}

const NUMBERED_LINE = /^(\d+): ?(.*)$/

/**
 * Splits the `12: text` lines the read tool gives the model into a number and the source text.
 * Returns null when the text is not in that shape. A saved-output page can start or end mid-line,
 * so the first and last lines may be unnumbered.
 */
export function parseNumberedLines(content: string): NumberedLine[] | null {
  const lines = content
    .replace(/\r?\n$/, '')
    .split(/\r?\n/)
    .map((line): NumberedLine => {
      const match = NUMBERED_LINE.exec(line)
      return match ? { number: Number(match[1]), text: match[2] } : { number: null, text: line }
    })
  const numbered = lines.filter((line) => line.number !== null).length
  if (numbered < Math.min(2, lines.length)) return null
  if (lines.slice(1, -1).some((line) => line.number === null)) return null
  return lines
}
