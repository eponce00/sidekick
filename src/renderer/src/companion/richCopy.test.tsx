// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { formattedCopy } from './richCopy'

describe('formattedCopy', () => {
  it('gives formatted HTML and plain text without Markdown marks', () => {
    const { html, text } = formattedCopy(
      '## Week 42\n\nShipped **0.19.0** and *more*.\n\n- one\n- two\n\n1. first\n2. second\n\n| Area | Status |\n| --- | --- |\n| Phone | Done |'
    )
    expect(html).toContain('<h2>Week 42</h2>')
    expect(html).toContain('<strong>0.19.0</strong>')
    expect(html).toContain('<table>')
    expect(text).toBe(
      [
        'Week 42',
        'Shipped 0.19.0 and more.',
        '• one',
        '• two',
        '1. first',
        '2. second',
        'Area\tStatus',
        'Phone\tDone'
      ].join('\n')
    )
    expect(text).not.toMatch(/\*\*|##|\|/)
  })

  it('does not render HTML the reply contains', () => {
    const { html } = formattedCopy('Hello <img src=x onerror=alert(1)> there')
    expect(html).not.toContain('<img')
  })
})
