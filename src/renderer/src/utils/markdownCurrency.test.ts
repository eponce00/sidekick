import { describe, expect, it } from 'vitest'
import { escapeCurrencyDollars } from './markdownCurrency'

describe('escapeCurrencyDollars', () => {
  it('keeps two prices on one line from becoming a formula', () => {
    expect(
      escapeCurrencyDollars(
        'Key facts: $825,000 asking (MLS 260012022), last sold 2015 for $299,500.'
      )
    ).toBe('Key facts: \\$825,000 asking (MLS 260012022), last sold 2015 for \\$299,500.')
  })

  it('reads decimals, scales and punctuation after an amount as a price', () => {
    expect(escapeCurrencyDollars('$1.2M, $40k or $3.50/day; up to $2 billion')).toBe(
      '\\$1.2M, \\$40k or \\$3.50/day; up to \\$2 billion'
    )
  })

  it('leaves math alone', () => {
    for (const math of [
      '$5x + 3$',
      '$2^{10}$',
      '$x_1$',
      '$$E = mc^2$$',
      '$\\frac{1}{2}$',
      '$10$'
    ]) {
      expect(escapeCurrencyDollars(`Solve ${math} now`)).toBe(`Solve ${math} now`)
    }
  })

  it('leaves code and dollars that are already escaped as written', () => {
    const text = 'Run `echo $5` and\n```sh\nprice=$100\n```\nthen pay \\$20 or $30.'
    expect(escapeCurrencyDollars(text)).toBe(
      'Run `echo $5` and\n```sh\nprice=$100\n```\nthen pay \\$20 or \\$30.'
    )
  })
})
