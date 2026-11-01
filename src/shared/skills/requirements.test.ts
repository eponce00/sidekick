import { expect, it } from 'vitest'
import { getActiveSkillInjections, getSkillById, getSkillRuntimeGuidance } from './index'

it.each([
  ['pdf', 'requiresPythonPackages', ['pypdf', 'pdfplumber', 'reportlab', 'pdf2image']],
  ['xlsx', 'requiresPythonPackages', ['openpyxl', 'pandas', 'xlrd']],
  ['docx', 'requiresNodePackages', ['docx']],
  ['docx', 'requiresPythonPackages', ['defusedxml', 'lxml', 'python-docx']],
  ['pptx', 'requiresPythonPackages', ['python-pptx', 'defusedxml', 'lxml']],
  ['pptx', 'requiresNodePackages', ['pptxgenjs']]
] as const)('preserves bundled %s dependency declarations', (id, property, packages) => {
  expect(getSkillById(id)?.[property]).toEqual(packages)
})

it('keeps dependency uncertainty and cross-platform instructions on later skill turns', () => {
  const injection = getActiveSkillInjections(['pdf'])
  expect(injection).toContain('python3 "$SIDEKICK_SKILLS/preflight.py"')
  expect(injection).toContain('never switch to host execution silently')
})

it('does not attach Python preflight to browser-only declarative skills', () => {
  expect(getSkillRuntimeGuidance(getSkillById('web-artifacts')!)).toBe('')
})
