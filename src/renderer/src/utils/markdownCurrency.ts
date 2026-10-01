// Code is left exactly as written: fenced blocks first, then inline spans.
const CODE = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/

// A dollar sign that opens an amount: digits, optional thousands groups and
// decimals, an optional scale, then anything but more of a formula. `$5x$`
// and `$2^{10}$` stay math; `$825,000 asking` and `$1.2M,` are prices.
const PRICE =
  /(?<!\\)\$(?=\d[\d,]*(?:\.\d+)?(?:\s?(?:[kKmMbB]|mn|bn|million|billion|thousand)\b)?(?![\w$^_{}\\]))/g

/**
 * Keeps prices from being typeset as math. Inline math is written between
 * single dollar signs, so a reply quoting two prices on one line ("$825,000
 * asking … sold for $299,500") had everything between them set as a formula:
 * italic, spaces gone, running off the edge.
 */
export function escapeCurrencyDollars(markdown: string): string {
  if (!markdown.includes('$')) return markdown
  return markdown
    .split(CODE)
    .map((part, index) => (index % 2 === 1 ? part : part.replace(PRICE, '\\$')))
    .join('')
}
