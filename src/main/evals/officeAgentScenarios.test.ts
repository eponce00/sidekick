import { expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getAgentToolDefinitions } from '../../shared/agentToolCatalog'
import {
  officeAgentScenarios,
  officeAgentSystemPrompt,
  officeArtifactOutcome,
  officeSourceDigest,
  officeSourceUnchanged,
  officeAgentCapabilities,
  summarizeOfficeErrors,
  summarizeOfficeTrace
} from './officeAgentScenarios'

it('composes the real skills/runtime prompt and keeps generation separate from read-only probes', () => {
  const prompt = officeAgentSystemPrompt(
    '/synthetic/project',
    '/app/resources/skills',
    'fixture-model'
  )
  expect(prompt).toContain('Available Skills')
  expect(prompt).toContain('id: `docx`')
  expect(prompt).toContain('SIDEKICK_SKILLS')
  if (process.platform === 'win32') {
    expect(prompt).toContain('Short read-only Python or Node probes')
    expect(prompt).toContain('use apply_patch to create a uniquely named project-relative script')
    expect(prompt).not.toContain(
      'instead of nesting quotes in `-c` or creating a temporary project file'
    )
  }
})

it('requires successful skill -> preflight -> helper stdout signals in that order', () => {
  const scenario = officeAgentScenarios[1]
  const valid = [
    { name: 'use_skill', arguments: { skill_id: 'xlsx' }, status: 'success' },
    {
      name: 'shell',
      arguments: { command: 'python "$env:SIDEKICK_SKILLS\\preflight.py" xlsx' },
      status: 'success',
      exitCode: 0,
      stdout: '{"status":"available"}'
    },
    {
      name: 'shell',
      arguments: { command: 'python "$env:SIDEKICK_SKILLS\\office\\validate.py" updated.xlsx' },
      status: 'success',
      exitCode: 0,
      stdout: '{"valid":true}'
    }
  ]
  expect(summarizeOfficeTrace(scenario, valid).passed).toBe(true)
  expect(summarizeOfficeTrace(scenario, [...valid].reverse()).passed).toBe(false)
  expect(
    summarizeOfficeTrace(
      scenario,
      valid.map((tool) => ({ ...tool, stdout: '' }))
    ).passed
  ).toBe(false)
  expect(
    summarizeOfficeTrace(scenario, [
      valid[0],
      valid[1],
      { ...valid[2], arguments: { command: 'python task-unique.py' } }
    ]).passed
  ).toBe(true)
  expect(
    summarizeOfficeTrace(scenario, [
      valid[0],
      { ...valid[1], stdout: '{"status":"available"}\n{"valid":true}' }
    ]).passed
  ).toBe(true)
  expect(
    summarizeOfficeTrace(
      scenario,
      valid.map((tool, index) => (index === 1 ? { ...tool, status: 'error' } : tool))
    ).passed
  ).toBe(false)
  expect(
    summarizeOfficeTrace(scenario, [
      ...valid,
      { name: 'shell', arguments: { command: 'python -m pip install openpyxl' }, status: 'error' }
    ]).passed
  ).toBe(false)
})

it('keeps raw commands and arbitrary error/status strings out of summary exports', () => {
  const report = summarizeOfficeTrace(officeAgentScenarios[0], [
    { name: 'shell', arguments: { command: 'PRIVATE_COMMAND_TEXT' }, status: 'PRIVATE_ERROR_TEXT' }
  ])
  expect(JSON.stringify(report)).not.toContain('PRIVATE_')
  expect(report.toolErrors).toBe(1)
  expect(report.passed).toBe(false)
})

it.each([
  { command: 'echo unrelated printed JSON', stdout: '{"valid":true}', passed: true },
  { command: 'python nested-script-with-captured-validator-output.py', stdout: '', passed: false }
])(
  'labels helper stdout signals without asserting execution: $command',
  ({ command, stdout, passed }) => {
    const report = summarizeOfficeTrace(officeAgentScenarios[1], [
      { name: 'use_skill', arguments: { skill_id: 'xlsx' }, status: 'success' },
      {
        name: 'shell',
        arguments: { command: 'python preflight.py xlsx' },
        status: 'success',
        exitCode: 0,
        stdout: '{"status":"available"}'
      },
      { name: 'shell', arguments: { command }, status: 'success', exitCode: 0, stdout }
    ])
    expect(report.schemaVersion).toBe(2)
    expect(report.helperPasses).toEqual([
      {
        helper: 'validate.py',
        evidenceKind: 'stdout_regex_signal',
        executionProvenance: 'unverified',
        passed
      }
    ])
    // Preserve historical predicates: a lookalike is a signal, absence is not proof of omission.
    expect(report.passed).toBe(passed)
    expect(JSON.stringify(report)).not.toContain(command)
  }
)

it('classifies error provenance without retaining arbitrary provider-controlled fields', () => {
  const events = summarizeOfficeErrors([
    {
      name: 'apply_patch',
      arguments: {},
      status: 'error',
      errorCode: 'invalid_arguments',
      recoveryAction: 'correct_input'
    },
    {
      name: 'PRIVATE_TOOL',
      arguments: { command: 'PRIVATE_COMMAND' },
      status: 'PRIVATE_STATUS',
      errorCode: 'PRIVATE_CODE',
      recoveryAction: 'PRIVATE_RECOVERY',
      stdout: 'PRIVATE_PATH'
    },
    { name: 'apply_patch', arguments: {}, status: 'success' }
  ])
  expect(events[0]).toEqual({
    callIndex: 1,
    tool: 'apply_patch',
    code: 'invalid_arguments',
    recoveryAction: 'correct_input',
    provenance: 'tool_execution_result',
    laterSameToolSucceeded: true
  })
  expect(events[1]).toMatchObject({
    tool: 'other',
    code: 'unclassified',
    recoveryAction: 'unspecified',
    laterSameToolSucceeded: false
  })
  expect(JSON.stringify(events)).not.toContain('PRIVATE_')
})

it('rejects an otherwise correct artifact when the source was modified or helper journey was skipped', () => {
  expect(officeArtifactOutcome('completed', true, true, true).passed).toBe(true)
  expect(officeArtifactOutcome('completed', false, true, true).passed).toBe(false)
  expect(officeArtifactOutcome('completed', true, true, false).passed).toBe(false)
  expect(officeArtifactOutcome('cancelled', true, true, true).passed).toBe(false)
})

it('detects same-size source tampering even when artifact and journey evaluators pass', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'sidekick-office-source-'))
  try {
    const source = join(root, 'opaque-input')
    await fs.writeFile(source, 'original')
    const before = await officeSourceDigest(source)
    expect(await officeSourceUnchanged(source, before)).toBe(true)
    await fs.writeFile(source, 'tampered')
    const after = await officeSourceDigest(source)
    expect(officeArtifactOutcome('completed', before === after, true, true).passed).toBe(false)
    expect(await officeSourceUnchanged(source, before)).toBe(false)
    expect(await officeSourceUnchanged(join(root, 'missing'), before)).toBe(false)
    expect(await officeSourceUnchanged(source, null)).toBeNull()
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

it('classifies every current Office catalog tool, including read, without accepting legacy or arbitrary names', () => {
  const names = getAgentToolDefinitions({
    surface: 'conversation',
    workspaceRoot: '/fixture',
    capabilities: officeAgentCapabilities
  }).map((tool) => tool.function.name)
  expect(names).toContain('read')
  const events = summarizeOfficeErrors(
    names.map((name) => ({ name, arguments: {}, status: 'error', errorCode: 'not_found' }))
  )
  expect(events.map((event) => event.tool)).toEqual(names)
  const rejected = summarizeOfficeErrors(
    ['read_file', 'list_directory', 'search_files', 'PRIVATE_TOOL'].map((name) => ({
      name,
      arguments: {},
      status: 'error'
    }))
  )
  expect(rejected.every((event) => event.tool === 'other')).toBe(true)
})
