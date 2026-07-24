import { describe, expect, it } from 'vitest'
import { resolveSpellCheckerLanguages } from './spellCheckerLanguages'

describe('resolveSpellCheckerLanguages', () => {
  it('matches exact locales and falls back to a compatible base language', () => {
    expect(
      resolveSpellCheckerLanguages(['es-US', 'en_US'], ['en-US', 'es', 'fr', 'de-DE'])
    ).toEqual(['es', 'en-US'])
  })

  it('deduplicates results, ignores unavailable languages, and stays bounded', () => {
    expect(
      resolveSpellCheckerLanguages(
        ['en-US', 'en', 'zz-ZZ', 'es-ES', 'fr-FR', 'de-DE', 'it-IT'],
        ['en-US', 'es-ES', 'fr', 'de', 'it']
      )
    ).toEqual(['en-US', 'es-ES', 'fr', 'de'])
  })
})
