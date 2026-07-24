import { describe, expect, it } from 'vitest'
import {
  getActiveSkillInjections,
  getPersistentSkillIds,
  getSkillById,
  getSkillsDirectory
} from './index'

describe('skill activation', () => {
  it('advertises web artifacts by metadata without injecting the full builder prompt', () => {
    const skill = getSkillById('web-artifacts')

    expect(skill).toMatchObject({ invocation: 'auto', activationScope: 'run' })
    expect(getSkillsDirectory([])).toContain('id: `web-artifacts`')
    expect(getSkillsDirectory([])).toContain('not for websites, apps, or HTML')
    expect(getActiveSkillInjections([])).not.toContain('Web Artifacts Builder')
  })

  it('does not persist or globally reinject run-scoped skills', () => {
    expect(getPersistentSkillIds(['web-artifacts', 'pdf'])).toEqual(['pdf'])
    expect(getActiveSkillInjections(['web-artifacts'])).not.toContain('Web Artifacts Builder')
    expect(getSkillsDirectory(['web-artifacts'])).toContain('id: `web-artifacts`')
  })

  it('advertises location research lazily with a complete rich-answer contract', () => {
    const skill = getSkillById('location-research')

    expect(skill).toMatchObject({ invocation: 'auto', activationScope: 'run' })
    expect(getSkillsDirectory([])).toContain('id: `location-research`')
    expect(getActiveSkillInjections([])).not.toContain('# Location Research')
    expect(skill?.systemPromptInjection).toContain('use `web_image_search`')
    expect(skill?.systemPromptInjection).toContain('Open in Google Maps')
    expect(getPersistentSkillIds(['location-research'])).toEqual([])
  })
})
