/** Languages recognized by their common words. */
type WordLanguage = 'en' | 'es' | 'pt' | 'fr' | 'de' | 'it'

/**
 * A language a reply can be recognized as. Read-aloud speaks only some of them
 * (SPEECH_LANGUAGES); the rest are recognized so it can say so.
 */
export type DetectedLanguage = WordLanguage | 'ja' | 'ko' | 'ar' | 'el' | 'hi' | 'uk' | 'ru'

const STOPWORDS: Record<WordLanguage, string[]> = {
  en: ['the', 'and', 'is', 'are', 'of', 'to', 'you', 'that', 'it', 'with', 'this', 'for', 'was'],
  es: [
    'el',
    'la',
    'los',
    'las',
    'que',
    'de',
    'y',
    'es',
    'en',
    'un',
    'una',
    'por',
    'para',
    'con',
    'como',
    'pero',
    'está',
    'también'
  ],
  pt: [
    'o',
    'os',
    'não',
    'que',
    'de',
    'e',
    'é',
    'em',
    'um',
    'uma',
    'para',
    'com',
    'como',
    'mas',
    'você',
    'também'
  ],
  fr: [
    'le',
    'la',
    'les',
    'que',
    'de',
    'et',
    'est',
    'en',
    'un',
    'une',
    'pour',
    'avec',
    'mais',
    'vous',
    'nous',
    'pas'
  ],
  de: [
    'der',
    'die',
    'das',
    'und',
    'ist',
    'nicht',
    'ein',
    'eine',
    'mit',
    'für',
    'auch',
    'aber',
    'sie',
    'wir',
    'ich'
  ],
  it: [
    'il',
    'lo',
    'gli',
    'che',
    'di',
    'e',
    'è',
    'un',
    'una',
    'per',
    'con',
    'come',
    'ma',
    'anche',
    'sono',
    'non'
  ]
}

// Languages with a script of their own, recognized by the letters they use.
const SCRIPTS: Array<[RegExp, DetectedLanguage]> = [
  [/[぀-ヿ]/gu, 'ja'],
  [/[가-힯]/gu, 'ko'],
  [/[؀-ۿ]/gu, 'ar'],
  [/[Ͱ-Ͽ]/gu, 'el'],
  [/[ऀ-ॿ]/gu, 'hi'],
  [/[іїєґ]/giu, 'uk'],
  [/[Ѐ-ӿ]/gu, 'ru']
]

/**
 * The language of a reply: by script where a language has its own, otherwise
 * from its most frequent common words. English when unsure.
 */
export function detectSpeechLanguage(text: string): DetectedLanguage {
  const sample = text.slice(0, 4_000)
  const letters = (sample.match(/\p{L}/gu) ?? []).length
  for (const [pattern, language] of SCRIPTS) {
    const count = (sample.match(pattern) ?? []).length
    // Ukrainian shares Cyrillic with Russian; a few of its own letters decide.
    if (language === 'uk' ? count >= 3 : count > letters * 0.3) return language
  }
  const words = text.toLowerCase().match(/[\p{L}']+/gu) ?? []
  const counts = new Map<string, number>()
  for (const word of words.slice(0, 600)) counts.set(word, (counts.get(word) ?? 0) + 1)
  let best: WordLanguage = 'en'
  let bestScore = 0
  for (const [language, stopwords] of Object.entries(STOPWORDS) as Array<
    [WordLanguage, string[]]
  >) {
    const score = stopwords.reduce((total, word) => total + (counts.get(word) ?? 0), 0)
    if (score > bestScore) {
      best = language
      bestScore = score
    }
  }
  return best
}

// A section that lists where a reply's facts came from is for reading, not listening.
const SOURCE_SECTION =
  /^[ \t]*(?:#{1,6}[ \t]+)?(?:\*\*|__)?[ \t]*(?:sources?|references?|citations?|further reading|read more|links|bibliography|fuentes|referencias|fontes|quellen|fonti)[ \t]*:?[ \t]*(?:\*\*|__)?[ \t]*:?[ \t]*$/i
const SOURCE_LINE =
  /^[ \t]*(?:\*\*|__)?(?:sources?|references?|citations?|fuentes|referencias)(?:\*\*|__)?[ \t]*:(?:\*\*|__)?[ \t]*\S/i
const LIST_OR_LINK_LINE = /^[ \t]*(?:[-*+]|\d+[.)]|\[[^\]]*\]\(|<?https?:\/\/|\[\^?\d+\])/

function withoutSourceSections(markdown: string): string {
  const kept: string[] = []
  let skipping = false
  for (const line of markdown.split('\n')) {
    if (SOURCE_SECTION.test(line)) {
      skipping = true
      continue
    }
    if (SOURCE_LINE.test(line)) continue
    if (skipping) {
      // The list goes on until a line that is neither a list item, a link nor blank.
      if (!line.trim() || LIST_OR_LINK_LINE.test(line)) continue
      skipping = false
    }
    kept.push(line)
  }
  return kept.join('\n')
}

const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?'
const DOMAIN =
  '(?:www\\.)?[\\w-]+(?:\\.[\\w-]+)*\\.(?:com|org|net|gov|edu|io|ai|dev|app|co|news|info)\\b(?:\\/[^\\s)]*)?'
// A parenthesis that only says when or where something was reported: (Oct 5), (late Sep),
// (2024), (source: Reuters), (via AP), (reuters.com).
const CITING_PARENTHESIS = new RegExp(
  `[ \\t]*\\((?:(?:early|mid|late)[ -])?(?:${MONTH}(?:[ \\t]+\\d{1,2})?(?:,?[ \\t]+\\d{4})?|\\d{4}|(?:sources?|via|per|citing|see)\\b[^)]*|${DOMAIN}[^)]*)\\)`,
  'gi'
)

/**
 * A markdown reply as it should be heard, one entry per paragraph. Code, table rules, images,
 * link addresses, citation marks and source lists are left out; link labels, list items and
 * emphasised words are kept as plain text, and symbols a reader skims are said as words so the
 * voice is not tripped up by them.
 */
export function speakableParagraphs(markdown: string): string[] {
  const prose = withoutSourceSections(
    markdown
      .replace(/\r\n?/g, '\n')
      // Reasoning some models write inline is not part of the answer.
      .replace(/<(think|thinking|reasoning)>[\s\S]*?(<\/\1>|(?![\s\S]))/gi, '\n')
      // Fenced code, math blocks and HTML comments are read by eye, not ear.
      .replace(/^(```|~~~)[^\n]*\n[\s\S]*?(^\1[^\n]*$|(?![\s\S]))/gm, '\n')
      .replace(/\$\$[\s\S]*?\$\$/g, '\n')
      .replace(/<!--[\s\S]*?-->/g, '')
  )
  return (
    prose
      // Footnotes and citation marks: [^1], [1], [2, 3], 【4†source】, numbered links.
      .replace(/^[ \t]*\[\^[^\]]+\]:.*$/gm, '')
      .replace(/\[\^[^\]]+\]/g, '')
      .replace(/【[^】]*】/g, '')
      .replace(/\[\d+(?:[ \t]*[,–-][ \t]*\d+)*\]\([^)]*\)/g, '')
      .replace(/\[\d+(?:[ \t]*[,–-][ \t]*\d+)*\](?!\()/g, '')
      // Tables: drop separator rows, keep cell text as sentences. Line patterns
      // match spaces and tabs only, so they never reach into the next line.
      .replace(/^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$/gm, '')
      .replace(/^[ \t]*\|(.*)\|[ \t]*$/gm, (_, row: string) =>
        row
          .split('|')
          .map((cell) => cell.trim())
          .filter(Boolean)
          .join(', ')
      )
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/<https?:\/\/[^>]+>/g, '')
      .replace(/https?:\/\/\S+/g, '')
      .replace(CITING_PARENTHESIS, '')
      .replace(new RegExp(`\\b${DOMAIN}`, 'gi'), '')
      .replace(/<\/?[a-z][^>]*>/gi, '')
      // A path is heard by its file name, a call by its name.
      .replace(/`([^`]+)`/g, (_, code: string) =>
        code
          .replace(/^.*[\\/](?=[^\\/]+$)/, '')
          .replace(/\(\)$/, '')
          .trim()
      )
      .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
      .replace(/^[ \t]{0,3}>[ \t]?/gm, '')
      .replace(/^[ \t]*([-*+]|\d+[.)])[ \t]+(\[[ xX]\][ \t]+)?/gm, '')
      .replace(/^[ \t]*([-*_][ \t]*){3,}$/gm, '')
      // A bold label opening a paragraph is a heading of its own: "**Energy** — The grid…".
      .replace(
        /^(\*\*|__)([^*_\n]+?)\1[ \t]*[—–:-][ \t]*/gm,
        (_, _marker: string, label: string) => (/[.!?:]$/.test(label) ? `${label} ` : `${label}. `)
      )
      .replace(/(\*\*|__)(.+?)\1/g, '$2')
      .replace(/(\*|_)(\S(?:.*?\S)?)\1/g, '$2')
      .replace(/~~(.+?)~~/g, '$1')
      // Symbols said as words.
      .replace(/(\d)[ \t]*[–—][ \t]*(\d)/g, '$1 to $2')
      .replace(/[ \t]*[—–][ \t]*/g, ', ')
      .replace(/[ \t]+-[ \t]+/g, ', ')
      .replace(/[ \t]*(?:→|->|=>)[ \t]*/g, ' to ')
      .replace(/~[ \t]*(?=\d)/g, 'about ')
      .replace(/≈[ \t]*/g, 'about ')
      .replace(/[ \t]+&[ \t]+/g, ' and ')
      .replace(/[ \t]+\/[ \t]+/g, ' or ')
      .replace(/\be\.g\.,?/gi, 'for example,')
      .replace(/\bi\.e\.,?/gi, 'that is,')
      .replace(/\betc\./gi, 'and so on.')
      .replace(/\bvs\.?(?=\s)/gi, 'versus')
      .replace(/\p{Extended_Pictographic}\uFE0F?/gu, '')
      // Paragraphs, each a run of sentences. A line that ends without punctuation is still
      // the end of a thought, unless the next line carries it on from a dash.
      .split(/\n[ \t]*\n/)
      .map((block) =>
        block
          .split('\n')
          .map((line) => line.replace(/\(\s*\)/g, '').trim())
          .filter((line) => /[\p{L}\p{N}]/u.test(line))
          .map((line, index, lines) =>
            /[.!?:;,…。！？]$/u.test(line) || /^[,;]/.test(lines[index + 1] ?? '')
              ? line
              : `${line}.`
          )
          .join(' ')
          .replace(/\s+/g, ' ')
          .replace(/\s+([,.;:!?])/g, '$1')
          .replace(/([,;:])(?:\s*[,;:])+/g, '$1')
          .replace(/,\s*\./g, '.')
          .trim()
      )
      .filter(Boolean)
  )
}

/** The prose of a markdown reply as one passage; see speakableParagraphs. */
export function speakableText(markdown: string): string {
  return speakableParagraphs(markdown).join(' ')
}

export interface SpeechChunk {
  text: string
  /** The last passage of its paragraph, so a longer pause follows. */
  endsParagraph: boolean
}

const SENTENCE_END = /(?<=[.!?…。！？]["'”’)\]]?)\s+/u

/**
 * Splits a reply into passages the voice says whole, as Supertone's reference code does:
 * sentences packed up to `maxLength` characters within a paragraph. Said a sentence at a time,
 * every sentence starts afresh and the intonation repeats; a passage flows. The first passage is
 * kept short so reading starts at once.
 */
export function speechChunks(
  paragraphs: readonly string[],
  maxLength = 300,
  firstLength = 140
): SpeechChunk[] {
  const chunks: SpeechChunk[] = []
  for (const paragraph of paragraphs) {
    let current = ''
    const flush = (endsParagraph: boolean): void => {
      if (current) chunks.push({ text: current, endsParagraph })
      current = ''
    }
    for (const sentence of paragraph.split(SENTENCE_END).filter(Boolean)) {
      const limit = chunks.length ? maxLength : firstLength
      if (current && current.length + 1 + sentence.length > limit) flush(false)
      current = current ? `${current} ${sentence}` : sentence
    }
    flush(true)
  }
  return chunks
}
