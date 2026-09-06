import {
  TOOL_ERROR_CODES,
  TOOL_RECOVERY_ACTIONS,
  type AgentCapability
} from '../../shared/agentRuntime'
import { getAgentToolDefinitions } from '../../shared/agentToolCatalog'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { PromptComposer, capabilitiesFromTools, detectHostPlatform } from '../../shared/prompts'

export const officeAgentCapabilities: readonly AgentCapability[] = [
  'workspace.read',
  'workspace.write',
  'command.execute',
  'skills'
]

export const OFFICE_AGENT_REPORT_SCHEMA_VERSION = 2

// Derive only from the trusted built-in catalog, never from model/tool-result fields.
const officeToolNames = new Set(
  getAgentToolDefinitions({
    surface: 'conversation',
    workspaceRoot: '/synthetic-office-catalog',
    capabilities: officeAgentCapabilities
  }).map((tool) => tool.function.name)
)

export const officeAgentScenarios = [
  {
    id: 'docx-comment',
    skill: 'docx',
    input: 'source.docx',
    output: 'reviewed.docx',
    requiredHelpers: ['unpack.py', 'comment.py', 'pack.py'],
    task: 'Add one classic comment to the paragraph "Please confirm delivery on Monday." in source.docx. The comment text must be exactly "Confirm the shipping date." and the author "Office QA". Save the result as reviewed.docx. Preserve all original paragraph text, tables and headers, and leave source.docx unchanged. Use the bundled comment workflow and verify the resulting comment anchor/IDs and package structure.'
  },
  {
    id: 'xlsx-edit',
    skill: 'xlsx',
    input: 'source.xlsx',
    output: 'updated.xlsx',
    requiredHelpers: ['validate.py'],
    task: 'In source.xlsx, change the quantity of Packing boxes on the Orders sheet from 3 to 7 (cell B2), and save updated.xlsx. Preserve every other cell, all formulas, formatting and the hidden Archive sheet; leave source.xlsx unchanged. Reopen the saved workbook to verify the edit and use the bundled Office structural validator. Do not recalculate formulas or claim fresh formula caches.'
  },
  {
    id: 'pptx-edit',
    skill: 'pptx',
    input: 'source.pptx',
    output: 'revised.pptx',
    requiredHelpers: ['validate.py'],
    task: 'Change only the second slide title of source.pptx from "Shipping checklist" to exactly "Shipping checklist — reviewed". Save revised.pptx. Preserve the first slide, second-slide body text, speaker notes, slide count and page size; leave source.pptx unchanged. Use the loaded skill instructions, reopen to verify the saved content and run the bundled Office structural validator.'
  }
] as const

export type OfficeAgentScenario = (typeof officeAgentScenarios)[number]

/** Actual app prompt composition rather than a helper-specific substitute system prompt. */
export function officeAgentSystemPrompt(
  workspaceRoot: string,
  skillAssetsPath: string,
  model: string
): string {
  const tools = getAgentToolDefinitions({
    surface: 'conversation',
    workspaceRoot,
    capabilities: officeAgentCapabilities
  })
  return new PromptComposer().compose({
    platform: detectHostPlatform(process.platform),
    capabilities: capabilitiesFromTools(tools),
    permissionMode: 'full-access',
    model: {
      family: 'qwen',
      provider: 'litellm',
      providerKind: 'litellm',
      modelId: model,
      displayName: model,
      instructionStyle: 'compact-structured'
    },
    project: { workspaceRoot, instructions: '', instructionSources: [], memory: '' },
    currentDate: new Date().toISOString().slice(0, 10),
    toolRoundLimit: 24,
    activeSkillIds: [],
    skillAssetsPath
  }).content
}

export interface OfficeToolTrace {
  name: string
  arguments: Record<string, unknown>
  status: unknown
  stdout?: string
  exitCode?: number
  errorCode?: unknown
  recoveryAction?: unknown
}

export async function officeSourceDigest(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

export async function officeSourceUnchanged(
  path: string,
  original: string | null
): Promise<boolean | null> {
  if (original === null) return null
  try {
    return original === (await officeSourceDigest(path))
  } catch {
    return false
  }
}

/** Fixed vocabulary only: no provider messages, paths, arbitrary tool names or commands. */
export function summarizeOfficeErrors(trace: readonly OfficeToolTrace[]) {
  return trace.flatMap((tool, index) =>
    tool.status === 'success'
      ? []
      : [
          {
            callIndex: index + 1,
            tool: officeToolNames.has(tool.name) ? tool.name : 'other',
            code: TOOL_ERROR_CODES.find((code) => code === tool.errorCode) || 'unclassified',
            recoveryAction:
              TOOL_RECOVERY_ACTIONS.find((action) => action === tool.recoveryAction) ||
              'unspecified',
            provenance: 'tool_execution_result' as const,
            laterSameToolSucceeded: trace
              .slice(index + 1)
              .some((later) => later.name === tool.name && later.status === 'success')
          }
        ]
  )
}

export function officeArtifactOutcome(
  phase: string,
  sourceUnchanged: boolean,
  artifactsPassed: boolean,
  journeyPassed: boolean
) {
  return {
    passed: phase === 'completed' && sourceUnchanged && artifactsPassed && journeyPassed,
    sourceUnchanged,
    artifactsPassed,
    journeyPassed
  }
}

/** Persist only allowlisted counts/booleans, never raw shell commands or document text. */
export function summarizeOfficeTrace(
  scenario: OfficeAgentScenario,
  trace: readonly OfficeToolTrace[]
) {
  const loaded = trace.findIndex(
    (tool) =>
      tool.name === 'use_skill' &&
      tool.arguments.skill_id === scenario.skill &&
      tool.status === 'success'
  )
  const preflight = trace.findIndex(
    (tool, index) =>
      index > loaded &&
      loaded >= 0 &&
      tool.name === 'shell' &&
      tool.status === 'success' &&
      tool.exitCode === 0 &&
      /"status"\s*:\s*"available"/.test(tool.stdout || '') &&
      /(?:^|[/\\\s"'])preflight\.py(?:[\s"']|$)/i.test(String(tool.arguments.command || ''))
  )
  const helperPasses = scenario.requiredHelpers.map((helper) => ({
    helper,
    // This labels the legacy predicate, not a trusted observation of a child process.
    evidenceKind: 'stdout_regex_signal' as const,
    executionProvenance: 'unverified' as const,
    passed: trace.some(
      (tool, index) =>
        index >= preflight &&
        preflight >= 0 &&
        tool.name === 'shell' &&
        tool.status === 'success' &&
        tool.exitCode === 0 &&
        {
          'unpack.py': /Unpacked .+ XML files\)/,
          'comment.py': /Added anchored classic comment \d+ to paragraph \d+/,
          'pack.py': /Successfully packed .+structural validation passed/,
          'validate.py': /"valid"\s*:\s*true/
        }[helper].test(tool.stdout || '')
    )
  }))
  const installationAttempted = trace.some(
    (tool) =>
      tool.name === 'shell' &&
      /\b(?:pip3?|npm|pnpm|yarn|winget|choco|apt(?:-get)?)\s+(?:[^;\r\n]*?\s)?install\b/i.test(
        String(tool.arguments.command || '')
      )
  )
  return {
    schemaVersion: OFFICE_AGENT_REPORT_SCHEMA_VERSION,
    skillLoaded: loaded >= 0,
    successfulPreflightAfterSkill: preflight >= 0,
    helperPasses,
    installationAttempted,
    toolCalls: trace.length,
    toolErrors: trace.filter((tool) => tool.status !== 'success').length,
    errorEvents: summarizeOfficeErrors(trace),
    passed:
      loaded >= 0 &&
      preflight >= 0 &&
      helperPasses.every((helper) => helper.passed) &&
      !installationAttempted
  }
}
