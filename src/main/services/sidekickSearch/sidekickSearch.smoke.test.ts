import { describe, expect, it } from 'vitest'
import { searchImages } from './imageSearch'
import { searchWeb } from './searchCoordinator'

const smoke = process.env.SIDEKICK_SEARCH_SMOKE === '1' ? describe : describe.skip

smoke('live embedded Sidekick Search', () => {
  it('federates web results without a configured service', async () => {
    const response = await searchWeb('Mozilla Readability documentation', 6)
    expect(response.results.length).toBeGreaterThanOrEqual(3)
    expect(response.diagnostics).toHaveLength(3)
    expect(
      response.diagnostics.filter((source) => source.status === 'ok').length
    ).toBeGreaterThanOrEqual(2)
    expect(response.results.every((result) => /^https?:\/\//.test(result.url))).toBe(true)
  }, 20_000)

  it('discovers images without a configured service', async () => {
    const results = await searchImages('Golden Gate Bridge sunset', 5)
    expect(results.length).toBeGreaterThanOrEqual(3)
    expect(results.every((result) => result.imageUrl.startsWith('http'))).toBe(true)
  }, 20_000)
})
