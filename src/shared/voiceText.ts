import type { SpeechLanguageCode } from './voice'

/** Languages recognized by their common words. */
type WordLanguage = 'en' | 'es' | 'pt' | 'fr' | 'de' | 'it'

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
const SCRIPTS: Array<[RegExp, SpeechLanguageCode]> = [
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
export function detectSpeechLanguage(text: string): SpeechLanguageCode {
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

/**
 * The prose of a markdown reply, as it should be heard: code blocks, tables,
 * images and bare links are left out; link labels, list items and emphasised
 * words are kept as plain text.
 */
export function speakableText(markdown: string): string {
  return (
    markdown
      // Reasoning some models write inline is not part of the answer.
      .replace(/<(think|thinking|reasoning)>[\s\S]*?(<\/\1>|(?![\s\S]))/gi, '\n')
      // Fenced code, math blocks and HTML comments are read by eye, not ear.
      .replace(/^(```|~~~)[^\n]*\n[\s\S]*?(^\1[^\n]*$|(?![\s\S]))/gm, '\n')
      .replace(/\$\$[\s\S]*?\$\$/g, '\n')
      .replace(/<!--[\s\S]*?-->/g, '')
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
      .replace(/<\/?[a-z][^>]*>/gi, '')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
      .replace(/^[ \t]{0,3}>[ \t]?/gm, '')
      .replace(/^[ \t]*([-*+]|\d+[.)])[ \t]+(\[[ xX]\][ \t]+)?/gm, '')
      .replace(/^[ \t]*([-*_][ \t]*){3,}$/gm, '')
      .replace(/(\*\*|__)(.+?)\1/g, '$2')
      .replace(/(\*|_)(\S(?:.*?\S)?)\1/g, '$2')
      .replace(/~~(.+?)~~/g, '$1')
      // A line that ends without punctuation is still the end of a thought.
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => (/[.!?:;,…]$/.test(line) ? line : `${line}.`))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
  )
}
