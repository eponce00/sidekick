import { describe, expect, it } from 'vitest'
import { getCompactToolTitle, getToolKind } from './toolPresentation'

describe('tool presentation', () => {
  it('classifies built-in tools from stable names and legacy command strings', () => {
    expect(getToolKind({ name: 'read', command: 'read', title: 'Read' })).toBe('file-read')
    expect(getToolKind({ command: 'web_image_search("mountains")', title: 'Image search' })).toBe(
      'image-search'
    )
    expect(getToolKind({ command: 'npm test', title: 'Run tests' })).toBe('terminal')
    expect(getToolKind({ command: 'spawn_subagent', title: 'Sub-agent: audit' })).toBe('subagent')
    expect(
      getToolKind({ name: 'create_artifact', command: 'create_artifact', title: 'Creating page' })
    ).toBe('artifact')
    expect(getToolKind({ name: 'wait', command: 'wait', title: 'Wait 30s' })).toBe('wait')
  })

  it('shortens web searches and reduces fetched pages to their domain', () => {
    const searchTitle = getCompactToolTitle({
      name: 'web_search',
      command: 'web_search("población Cuba 2024 2025 2026 and recent official statistics")',
      title: 'Searching: "población Cuba 2024 2025 2026 and recent official statistics"',
      status: 'success'
    })

    expect(searchTitle).toBe('Searched “población Cuba 2024 2025 2026…”')
    expect(searchTitle.length).toBeLessThan(45)
    expect(
      getCompactToolTitle({
        name: 'web_fetch',
        command: 'web_fetch("https://worldpopulationreview.com/countries/cuba")',
        title: 'Fetching: https://worldpopulationreview.com/countries/cuba',
        status: 'success'
      })
    ).toBe('Read worldpopulationreview.com')
  })
})
