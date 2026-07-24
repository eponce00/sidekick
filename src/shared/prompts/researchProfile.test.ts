import { describe, expect, it } from 'vitest'
import { createResearchProfilePrompt, RESEARCH_PROFILE_PROMPT_VERSION } from './researchProfile'

describe('research profile prompt', () => {
  it('defines an evidence-first contract without creating a separate execution loop', () => {
    const prompt = createResearchProfilePrompt()

    expect(RESEARCH_PROFILE_PROMPT_VERSION).toBe('sidekick-research-v2')
    expect(prompt).toContain('Treat search snippets as leads, not evidence')
    expect(prompt).toContain('Cross-check consequential or time-sensitive claims')
    expect(prompt).toContain('[source title](https://example.com)')
    expect(prompt).toContain('SideKick already renders search and fetch activity')
    expect(prompt).not.toContain('exactly 5')
  })
})
