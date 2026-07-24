import type { Skill, SkillActivationScope, SkillInvocation } from './types'
import webArtifactsRaw from './definitions/web-artifacts.skill.md?raw'
import pdfRaw from './definitions/pdf.skill.md?raw'
import docxRaw from './definitions/docx.skill.md?raw'
import pptxRaw from './definitions/pptx.skill.md?raw'
import xlsxRaw from './definitions/xlsx.skill.md?raw'
import locationResearchRaw from './definitions/location-research.skill.md?raw'

export type { Skill, SkillActivationScope, SkillInvocation } from './types'

export function parseSkillMarkdown(raw: string): Skill {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)/)
  if (!match) throw new Error('Invalid skill file: missing frontmatter delimiters')
  const meta: Record<string, unknown> = {}
  for (const line of match[1].split('\n')) {
    const index = line.indexOf(':')
    if (index < 0) continue
    const key = line.slice(0, index).trim()
    if (!key) continue
    const rawValue = line.slice(index + 1).trim()
    if (rawValue === 'true') meta[key] = true
    else if (rawValue === 'false') meta[key] = false
    else if (rawValue.startsWith('[')) {
      try {
        meta[key] = JSON.parse(rawValue)
      } catch {
        meta[key] = []
      }
    } else if (
      (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
      (rawValue.startsWith("'") && rawValue.endsWith("'"))
    ) {
      meta[key] = rawValue.slice(1, -1).replace(/\\"/g, '"').replace(/\\'/g, "'")
    } else meta[key] = rawValue
  }
  if (
    typeof meta.id !== 'string' ||
    typeof meta.name !== 'string' ||
    typeof meta.description !== 'string'
  ) {
    throw new Error('Invalid skill file: id, name, and description are required')
  }
  return {
    id: meta.id,
    name: meta.name,
    icon: typeof meta.icon === 'string' ? meta.icon : 'FileText',
    description: meta.description,
    invocation: (meta.invocation as SkillInvocation | undefined) ?? 'auto',
    activationScope: (meta.activationScope as SkillActivationScope | undefined) ?? 'conversation',
    systemPromptInjection: match[2].trim(),
    requiresPython: meta.requiresPython as boolean | undefined,
    requiresNodePackages: meta.requiresNodePackages as string[] | undefined,
    requiresPythonPackages: meta.requiresPythonPackages as string[] | undefined
  }
}

export const ALL_SKILLS: readonly Skill[] = [
  parseSkillMarkdown(webArtifactsRaw),
  parseSkillMarkdown(locationResearchRaw),
  parseSkillMarkdown(pdfRaw),
  parseSkillMarkdown(docxRaw),
  parseSkillMarkdown(pptxRaw),
  parseSkillMarkdown(xlsxRaw)
]

export function getSkillById(id: string): Skill | undefined {
  return ALL_SKILLS.find((skill) => skill.id === id)
}

export function getActiveSkills(activeSkillIds: readonly string[]): Skill[] {
  return activeSkillIds.map(getSkillById).filter((skill): skill is Skill => Boolean(skill))
}

export function getPersistentSkillIds(skillIds: readonly string[]): string[] {
  return skillIds.filter((id) => getSkillById(id)?.activationScope === 'conversation')
}

export function getSkillsDirectory(activeSkillIds: readonly string[]): string {
  const available = ALL_SKILLS.filter(
    (skill) =>
      skill.invocation === 'auto' &&
      !(skill.activationScope === 'conversation' && activeSkillIds.includes(skill.id))
  )
  if (!available.length) return ''
  const rows = available
    .map((skill) => `- **${skill.name}** (id: \`${skill.id}\`): ${skill.description}`)
    .join('\n')
  return `\n\n## Available Skills\nFor specialized tasks, call \`use_skill\` with the relevant skill ID before proceeding:\n\n${rows}`
}

export function getActiveSkillInjections(activeSkillIds: readonly string[]): string {
  const active = ALL_SKILLS.filter(
    (skill) =>
      skill.invocation === 'always' ||
      (skill.activationScope === 'conversation' && activeSkillIds.includes(skill.id))
  )
  if (!active.length) return ''
  const sections = active
    .map((skill) => `### SKILL: ${skill.name}\n${skill.systemPromptInjection}`)
    .join('\n\n')
  return `\n---\n## Active Skills\n${sections}\n---`
}
