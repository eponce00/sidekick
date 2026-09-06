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
  expect(injection).toContain('does not install or verify dependencies')
  expect(injection).toContain('python3 "$SIDEKICK_SKILLS/preflight.py"')
  expect(injection).toContain('Browser-only PDF tasks must stay in the browser')
  expect(injection).toContain('never switch to host execution silently')
  expect(injection).toContain(
    'mounted read-only at /sidekick-skills and SIDEKICK_SKILLS points there'
  )
  expect(injection).toContain('Use Linux shell syntax inside the container, even on a Windows host')
  expect(injection).toContain(
    'Host Python, Node packages, and Office runtimes are not mounted or installed'
  )
  expect(injection).toContain(
    'A missing or invalid configured helper directory fails the isolated command explicitly'
  )
})

it('does not attach Python preflight to browser-only declarative skills', () => {
  expect(getSkillRuntimeGuidance(getSkillById('web-artifacts')!)).toBe('')
})

it('advertises supported comments/creation without claiming full XSD or threaded replies', () => {
  const docx = getSkillById('docx')!.systemPromptInjection
  const pptx = getSkillById('pptx')!.systemPromptInjection
  expect(docx).toContain('Classic anchored DOCX comments')
  expect(docx).toContain('docx-create-python')
  expect(pptx).toContain('pptx-create-python')
  expect(docx).toContain('Threaded replies and full XSD conformance validation are not supported')
  expect(docx).toContain('`--xsd` fails explicitly')
  expect(pptx).toContain('Honor a user-requested engine')
})
