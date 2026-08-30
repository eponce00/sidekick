import { afterAll, describe, expect, it } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import { randomUUID } from 'crypto'
import { fileURLToPath, pathToFileURL } from 'url'
import type { WebContents } from 'electron'
import {
  completeOpenAICompatibleChat,
  fetchOpenAICompatibleModels,
  openAICompatibleHeaders,
  type OpenAICompatibleModel
} from '../providers/openAICompatibleClient'
import { streamOpenAICompatibleChat } from '../providers/openAIStreamingClient'
import { executeWorkspaceMutation } from '../services/workspaceMutationService'
import { ProjectStore } from '../services/projectStore'
import { CollaborationStore } from '../services/collaborationStore'
import { CollaborationSupervisor } from '../services/collaborationSupervisor'
import type { AgentRuntimeCoordinator } from '../services/agentRuntimeCoordinator'
import { configureCheckpointStorageRoot } from '../services/checkpoints'
import { loadWorkspaceRules } from '../services/workspaceRules'
import { workspaceToolDefinitions } from '../../shared/agentToolDefinitions'
import type {
  ProviderStreamChunk,
  ProviderTarget,
  ProviderToolCall
} from '../../shared/providerRuntime'
import type { ProviderKind } from '../../shared/providerRegistry'
import {
  editingDialectForModel,
  workspaceMutationRequestFromTool,
  workspaceMutationResultForModel
} from '../../shared/workspaceMutations'
import {
  createAgentEvalReport,
  redactEvalError,
  type AgentEvalScenarioDefinition,
  type AgentEvalMetric
} from './agentEval'
import { AgentScenarioHarness, copyEvalFixture } from './agentScenarioHarness'

const DEFAULT_ENDPOINT = 'http://127.0.0.1:1234/v1'
const DEFAULT_MODEL = 'local-loaded-model'
const endpoint = process.env.SIDEKICK_AGENT_EVAL_URL?.trim() || DEFAULT_ENDPOINT
const model = process.env.SIDEKICK_AGENT_EVAL_MODEL?.trim() || DEFAULT_MODEL
const apiKey = process.env.SIDEKICK_AGENT_EVAL_API_KEY?.trim()
const providerKind = (process.env.SIDEKICK_AGENT_EVAL_PROVIDER_KIND?.trim() ||
  'litellm') as ProviderKind
const enabled = process.env.SIDEKICK_AGENT_EVAL_RUN === '1' && Boolean(apiKey)
const suite = process.env.SIDEKICK_AGENT_EVAL_SUITE?.trim() || 'full'
const liveDescribe = enabled ? describe.sequential : describe.skip
const extendedIt = suite === 'full' ? it : it.skip
const scenarioVersion = '2026-07-21.3'
const scenarios = [
  { name: 'model-discovery', category: 'provider', weight: 2 },
  { name: 'completion', category: 'provider', weight: 4 },
  { name: 'streaming', category: 'streaming', weight: 6 },
  { name: 'natural-edit-recovery', category: 'recovery', weight: 8 },
  { name: 'verified-edit-tool-loop', category: 'workspace', weight: 8 },
  { name: 'verification-guard-tool-loop', category: 'workspace', weight: 10 },
  { name: 'multi-turn-project-create', category: 'projects', weight: 8 },
  { name: 'multi-turn-project-revise', category: 'projects', weight: 8 },
  { name: 'ambiguous-stale-edit-recovery', category: 'recovery', weight: 12 },
  { name: 'plan-contract-tool-loop', category: 'planning', weight: 10 },
  { name: 'group-artifact-collaboration', category: 'collaboration', weight: 12 },
  { name: 'group-follow-up-collaboration', category: 'collaboration', weight: 12 }
] satisfies AgentEvalScenarioDefinition[]
const plannedScenarios =
  suite === 'verification'
    ? scenarios.filter((scenario) => scenario.name === 'verification-guard-tool-loop')
    : suite === 'quick'
      ? scenarios.slice(0, 6)
      : scenarios
const scenarioByName = new Map(scenarios.map((scenario) => [scenario.name, scenario]))
const headers = {
  ...openAICompatibleHeaders(apiKey),
  ...(providerKind === 'openrouter'
    ? {
        'HTTP-Referer': 'https://github.com/eponce00/sidekick',
        'X-Title': 'SideKick development evaluation'
      }
    : {})
}
const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const metrics: AgentEvalMetric[] = []
const pendingMetricDetails = new Map<string, Partial<AgentEvalMetric>>()
const startedAt = new Date().toISOString()
let catalogDetails: Record<string, unknown> = {}

function noReasoningRequest(): Record<string, unknown> {
  return providerKind === 'openrouter' ? {} : { reasoning_effort: 'none' }
}

async function measured<T>(
  name: string,
  operation: () => Promise<T>,
  category: AgentEvalMetric['category'] = 'provider'
): Promise<T> {
  const scenario = scenarioByName.get(name)
  if (!scenario) throw new Error(`Unknown evaluation scenario: ${name}`)
  const started = performance.now()
  try {
    const value = await operation()
    const details = pendingMetricDetails.get(name)
    pendingMetricDetails.delete(name)
    metrics.push({
      ...details,
      name,
      category,
      weight: scenario.weight,
      earnedPoints: scenario.weight,
      passed: true,
      latencyMs: Math.round(performance.now() - started)
    })
    return value
  } catch (error) {
    const details = pendingMetricDetails.get(name)
    pendingMetricDetails.delete(name)
    metrics.push({
      ...details,
      name,
      category,
      weight: scenario.weight,
      earnedPoints: 0,
      passed: false,
      latencyMs: Math.round(performance.now() - started),
      error: redactEvalError(error)
    })
    throw error
  }
}

function enrichMetric(name: string, values: Partial<AgentEvalMetric>): void {
  const metric = [...metrics].reverse().find((candidate) => candidate.name === name)
  if (metric) {
    Object.assign(metric, values)
    return
  }
  pendingMetricDetails.set(name, { ...pendingMetricDetails.get(name), ...values })
}

function modelContextLength(entry: OpenAICompatibleModel): number | undefined {
  const candidates = [
    entry.context_length,
    entry.max_model_len,
    entry.max_input_tokens,
    entry.max_tokens,
    entry.model_info?.context_length,
    entry.model_info?.max_model_len,
    entry.model_info?.max_input_tokens,
    entry.model_info?.max_tokens
  ]
  return candidates.find((value) => typeof value === 'number' && Number.isFinite(value))
}

function objectArguments(call: ProviderToolCall): Record<string, unknown> {
  const value = call.function.arguments
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  if (typeof value !== 'string') throw new Error('The model returned no tool arguments')
  const parsed = JSON.parse(value) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('The model returned non-object tool arguments')
  }
  return parsed as Record<string, unknown>
}

async function waitFor<T>(
  read: () => T,
  settled: (value: T) => boolean,
  timeoutMs: number
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let value = read()
  while (!settled(value) && Date.now() < deadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250))
    value = read()
  }
  if (!settled(value)) throw new Error(`Scenario did not settle within ${timeoutMs} ms`)
  return value
}

function assertMutationTools(toolNames: string[]): void {
  expect(
    toolNames.some((name) => ['edit', 'write', 'apply_patch'].includes(name)),
    `Expected a workspace mutation tool, received: ${toolNames.join(', ')}`
  ).toBe(true)
}

async function installEvaluationLanguageServer(workspaceRoot: string): Promise<void> {
  const binRoot = join(workspaceRoot, 'node_modules', '.bin')
  const serverPath = join(workspaceRoot, '.eval-language-server.cjs')
  await fs.mkdir(binRoot, { recursive: true })
  await fs.writeFile(
    serverPath,
    `let buffer = Buffer.alloc(0)
const documents = new Map()
const send = (message) => { const body = Buffer.from(JSON.stringify(message)); process.stdout.write('Content-Length: ' + body.length + '\\r\\n\\r\\n'); process.stdout.write(body) }
process.stdin.on('data', (chunk) => { buffer = Buffer.concat([buffer, chunk]); while (true) { const marker = buffer.indexOf('\\r\\n\\r\\n'); if (marker < 0) return; const length = Number(/Content-Length:\\s*(\\d+)/i.exec(buffer.subarray(0, marker).toString())?.[1] || 0); if (buffer.length < marker + 4 + length) return; const message = JSON.parse(buffer.subarray(marker + 4, marker + 4 + length)); buffer = buffer.subarray(marker + 4 + length); if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: { capabilities: { diagnosticProvider: true } } }); else if (message.method === 'textDocument/didOpen') documents.set(message.params.textDocument.uri, message.params.textDocument.text); else if (message.method === 'textDocument/didChange') documents.set(message.params.textDocument.uri, message.params.contentChanges[0].text); else if (message.method === 'textDocument/diagnostic') send({ jsonrpc: '2.0', id: message.id, result: { kind: 'full', items: [] } }); else if (message.method === 'shutdown') send({ jsonrpc: '2.0', id: message.id, result: null }); } })`
  )
  if (process.platform === 'win32') {
    await fs.writeFile(
      join(binRoot, 'typescript-language-server.cmd'),
      `@echo off\r\n"${process.execPath}" "${serverPath}" %*\r\n`
    )
    return
  }
  const executable = join(binRoot, 'typescript-language-server')
  await fs.writeFile(
    executable,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(serverPath)} "$@"\n`
  )
  await fs.chmod(executable, 0o755)
}

afterAll(async () => {
  if (!enabled) return
  const report = createAgentEvalReport({
    endpoint,
    model,
    providerKind,
    suite,
    scenarioVersion,
    startedAt,
    completedAt: new Date().toISOString(),
    catalog: catalogDetails,
    metrics,
    plannedMetrics: plannedScenarios,
    revision: process.env.GITHUB_SHA
  })
  const reportPath = process.env.SIDEKICK_AGENT_EVAL_REPORT?.trim()
  if (reportPath) {
    const absolutePath = resolve(reportPath)
    await fs.mkdir(dirname(absolutePath), { recursive: true })
    await fs.writeFile(absolutePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  }
  console.info(`[agent-eval] ${JSON.stringify(report.summary)}`)
})

liveDescribe('provider-neutral production agent harness', () => {
  it('discovers the configured model and records provider metadata', async () => {
    const entry = await measured('model-discovery', async () => {
      const result = await fetchOpenAICompatibleModels(
        endpoint,
        headers,
        fetch,
        AbortSignal.timeout(30_000)
      )
      expect(result.ok, redactEvalError(result.error || 'Model discovery failed')).toBe(true)
      const match = result.data!.data.find((candidate) => candidate.id === model)
      expect(match, `Configured model ${model} was not returned by /models`).toBeDefined()
      const contextLength = modelContextLength(match!)
      catalogDetails = {
        providerKind,
        modelCount: result.data!.data.length,
        configuredModelFound: true,
        contextLength: contextLength || null,
        contextMetadataAvailable: contextLength !== undefined,
        supportsFunctionCalling: match!.supports_function_calling ?? null,
        supportedOpenAIParams: match!.supported_openai_params || null
      }
      return match!
    })
    enrichMetric('model-discovery', {
      details: { ...catalogDetails, ownedBy: entry.owned_by || null }
    })
  }, 35_000)

  it('completes a deterministic request', async () => {
    const completion = await measured('completion', async () => {
      const result = await completeOpenAICompatibleChat(
        endpoint,
        {
          model,
          messages: [{ role: 'user', content: 'Reply with only SIDEKICK_EVAL_COMPLETION_OK' }],
          max_tokens: 256,
          temperature: 0,
          ...noReasoningRequest()
        },
        headers,
        fetch,
        AbortSignal.timeout(90_000)
      )
      expect(result.ok, redactEvalError(result.error || 'Completion failed')).toBe(true)
      expect(result.data?.message.content).toContain('SIDEKICK_EVAL_COMPLETION_OK')
      return result.data!
    })
    enrichMetric('completion', {
      promptTokens: completion.promptTokens,
      completionTokens: completion.completionTokens,
      details: { finishReason: completion.finishReason }
    })
  }, 95_000)

  it('streams content through the production adapter', async () => {
    const chunks: ProviderStreamChunk[] = []
    const requestStarted = performance.now()
    let firstEventMs: number | undefined
    await measured(
      'streaming',
      async () => {
        const result = await streamOpenAICompatibleChat(
          endpoint,
          {
            model,
            messages: [{ role: 'user', content: 'Reply with only SIDEKICK_EVAL_STREAM_OK' }],
            max_tokens: 256,
            temperature: 0,
            ...noReasoningRequest()
          },
          headers,
          (chunk) => {
            chunks.push(chunk)
            if (firstEventMs === undefined && (chunk.message?.content || chunk.message?.thinking)) {
              firstEventMs = Math.round(performance.now() - requestStarted)
            }
          },
          fetch,
          AbortSignal.timeout(90_000)
        )
        expect(result.ok, redactEvalError(result.error || 'Streaming failed')).toBe(true)
        expect(chunks.some((chunk) => chunk.done)).toBe(true)
        expect(chunks.map((chunk) => chunk.message?.content || '').join('')).toContain(
          'SIDEKICK_EVAL_STREAM_OK'
        )
      },
      'streaming'
    )
    const terminal = [...chunks].reverse().find((chunk) => chunk.done)
    enrichMetric('streaming', {
      promptTokens: terminal?.prompt_eval_count,
      completionTokens: terminal?.eval_count,
      timeToFirstEventMs: firstEventMs,
      details: { finishReason: terminal?.done_reason }
    })
  }, 95_000)

  it('recovers from a malformed edit call without forced tool choice', async () => {
    const scenarioRoot = await fs.mkdtemp(join(tmpdir(), 'sidekick-llm-recovery-eval-'))
    const workspaceRoot = join(scenarioRoot, 'project')
    const harness = new AgentScenarioHarness(join(scenarioRoot, 'runtime'), {
      endpoint,
      model,
      headers,
      providerKind,
      maxOutputTokens: 2_048
    })
    const malformedCall = {
      id: 'sidekick_eval_malformed_edit',
      type: 'function',
      function: {
        name: 'edit',
        arguments: JSON.stringify({ file_path: 'src/status.ts', accessLevel: 'auto' })
      }
    }
    const validationError = {
      ok: false,
      success: false,
      code: 'invalid_arguments',
      error:
        'edit received invalid arguments. Missing required fields: old_string, new_string. Received fields: accessLevel, file_path.',
      retryable: true,
      recoveryAction: 'correct_input',
      recovery:
        'Submit one corrected edit call with every required field. Do not repeat the unchanged arguments.'
    }

    try {
      await fs.mkdir(join(workspaceRoot, 'src'), { recursive: true })
      await fs.writeFile(
        join(workspaceRoot, 'src/status.ts'),
        "export const status = 'before'\n",
        'utf8'
      )
      await harness.initialize()
      await measured(
        'natural-edit-recovery',
        async () => {
          const result = await harness.run({
            workspaceRoot,
            maxToolRounds: 12,
            messages: [
              {
                role: 'system',
                content:
                  'Use the available project tools to complete the request. Follow structured recovery actions exactly. Reading the current file before a corrected edit is allowed and expected. Do not use shell commands for ordinary file editing.'
              },
              {
                role: 'user',
                content:
                  "Update the existing src/status.ts export from 'before' to 'after'. Make one localized edit and do not replace the whole file."
              },
              { role: 'assistant', content: '', tool_calls: [malformedCall] },
              {
                role: 'tool',
                tool_call_id: malformedCall.id,
                content: JSON.stringify(validationError)
              }
            ]
          })
          expect(result.phase, result.error).toBe('completed')
          expect(result.toolNames).toContain('read')
          expect(result.toolNames).toContain('edit')
          expect(await fs.readFile(join(workspaceRoot, 'src/status.ts'), 'utf8')).toBe(
            "export const status = 'after'\n"
          )
          enrichMetric('natural-edit-recovery', {
            details: {
              tools: [...new Set(result.toolNames)],
              toolRounds: result.toolRounds,
              forcedToolChoice: false,
              verifiedOnDisk: true
            }
          })
        },
        'recovery'
      )
    } finally {
      await harness.close()
      await fs.rm(scenarioRoot, { recursive: true, force: true })
    }
  }, 180_000)

  it('streams, executes, verifies, and continues an exact file edit', async () => {
    const workspace = await fs.mkdtemp(join(tmpdir(), 'sidekick-llm-eval-'))
    const relativePath = 'src/status.ts'
    const absolutePath = join(workspace, relativePath)
    await fs.mkdir(dirname(absolutePath), { recursive: true })
    await fs.writeFile(absolutePath, "export const status = 'before'\n", 'utf8')

    try {
      const dialect = editingDialectForModel({ providerKind, model })
      const mutationToolName =
        dialect === 'apply-patch'
          ? 'apply_patch'
          : dialect === 'claude-edit'
            ? 'Edit'
            : dialect === 'search-replace'
              ? 'search_replace'
              : 'edit'
      const mutationTool = workspaceToolDefinitions(dialect).find(
        (definition) => definition.function.name === mutationToolName
      )
      expect(
        mutationTool,
        `Expected the ${dialect} dialect to expose ${mutationToolName}`
      ).toBeDefined()
      const mutationInstruction =
        dialect === 'apply-patch'
          ? `Use apply_patch to update src/status.ts from 'before' to 'after'. Send one canonical patch with accessLevel auto. Do not write prose before the tool call.`
          : `Use ${mutationToolName} on src/status.ts. Replace exactly 'before' with 'after'. Set accessLevel to auto and replace_all to false. Do not write prose before the tool call.`
      const messages = [
        {
          role: 'system',
          content:
            'This is a deterministic SideKick tool-loop evaluation. Call the requested tool exactly once. After a successful tool result, reply with only SIDEKICK_EVAL_EDIT_OK.'
        },
        {
          role: 'user',
          content: mutationInstruction
        }
      ]
      const chunks: ProviderStreamChunk[] = []
      const toolStarted = performance.now()
      let firstToolEventMs: number | undefined
      await measured(
        'verified-edit-tool-loop',
        async () => {
          const streamed = await streamOpenAICompatibleChat(
            endpoint,
            {
              model,
              messages,
              tools: [mutationTool],
              tool_choice: { type: 'function', function: { name: mutationToolName } },
              max_tokens: 1_024,
              temperature: 0,
              ...noReasoningRequest()
            },
            headers,
            (chunk) => {
              chunks.push(chunk)
              if (firstToolEventMs === undefined && chunk.message?.tool_calls?.length) {
                firstToolEventMs = Math.round(performance.now() - toolStarted)
              }
            },
            fetch,
            AbortSignal.timeout(90_000)
          )
          expect(streamed.ok, redactEvalError(streamed.error || 'Tool stream failed')).toBe(true)

          const calls = chunks.flatMap((chunk) => chunk.message?.tool_calls || [])
          const toolCall = [...calls]
            .reverse()
            .find((candidate) => candidate.function.name === mutationToolName)
          expect(
            toolCall,
            `The stream did not contain a completed ${mutationToolName} tool call`
          ).toBeDefined()
          const args = objectArguments(toolCall!)
          expect(args).toMatchObject({ accessLevel: 'auto' })
          if (dialect === 'apply-patch') {
            expect(args.patch).toEqual(expect.stringContaining(`*** Update File: ${relativePath}`))
          } else {
            expect(args).toMatchObject({
              file_path: relativePath,
              old_string: 'before',
              new_string: 'after'
            })
          }

          const mutation = workspaceMutationRequestFromTool(mutationToolName, args)
          const mutationResult = await executeWorkspaceMutation(workspace, mutation)
          expect(mutationResult.ok, mutationResult.error || 'Workspace mutation failed').toBe(true)
          expect(mutationResult.changed).toBe(true)
          expect(await fs.readFile(absolutePath, 'utf8')).toBe("export const status = 'after'\n")

          const toolCallId = toolCall!.id || 'sidekick_eval_edit'
          const continuation = await completeOpenAICompatibleChat(
            endpoint,
            {
              model,
              messages: [
                ...messages,
                {
                  role: 'assistant',
                  content: '',
                  tool_calls: [
                    {
                      id: toolCallId,
                      type: 'function',
                      function: { name: mutationToolName, arguments: JSON.stringify(args) }
                    }
                  ]
                },
                {
                  role: 'tool',
                  tool_call_id: toolCallId,
                  content: JSON.stringify(workspaceMutationResultForModel(mutationResult))
                }
              ],
              max_tokens: 256,
              temperature: 0,
              ...noReasoningRequest()
            },
            headers,
            fetch,
            AbortSignal.timeout(90_000)
          )
          expect(
            continuation.ok,
            redactEvalError(continuation.error || 'Tool continuation failed')
          ).toBe(true)
          expect(continuation.data?.message.content).toContain('SIDEKICK_EVAL_EDIT_OK')

          const terminal = [...chunks].reverse().find((chunk) => chunk.done)
          enrichMetric('verified-edit-tool-loop', {
            promptTokens:
              (terminal?.prompt_eval_count || 0) + (continuation.data?.promptTokens || 0),
            completionTokens:
              (terminal?.eval_count || 0) + (continuation.data?.completionTokens || 0),
            timeToFirstEventMs: firstToolEventMs,
            details: {
              dialect,
              toolName: toolCall!.function.name,
              changedFiles: mutationResult.files.map((file) => file.path),
              additions: mutationResult.additions,
              deletions: mutationResult.deletions
            }
          })
        },
        'workspace'
      )
    } finally {
      await fs.rm(workspace, { recursive: true, force: true })
    }
  }, 190_000)

  it('makes the live model verify through the production completion guard before finishing', async () => {
    const scenarioRoot = await fs.mkdtemp(join(tmpdir(), 'sidekick-verification-guard-eval-'))
    const workspaceRoot = join(scenarioRoot, 'project')
    const harness = new AgentScenarioHarness(join(scenarioRoot, 'runtime'), {
      endpoint,
      model,
      headers,
      providerKind,
      maxOutputTokens: 4_096
    })
    try {
      await copyEvalFixture(join(fixtureRoot, 'verification-guard'), workspaceRoot)
      await installEvaluationLanguageServer(workspaceRoot)
      await harness.initialize()
      await measured(
        'verification-guard-tool-loop',
        async () => {
          const result = await harness.run({
            workspaceRoot,
            maxToolRounds: 20,
            messages: [
              {
                role: 'system',
                content:
                  'This is a deterministic SideKick completion-boundary evaluation. Read AGENTS.md and src/status.ts, then use apply_patch to change the status from before to after. On the first turn after the edit, do not run a shell command or code-intelligence query: reply with only CHANGE_APPLIED. If SideKick sends an app-authored verification guard, first call code_intelligence with operation diagnostics for src/status.ts, then run the suggested project check with shell. After both succeed, reply with only SIDEKICK_EVAL_VERIFICATION_OK.'
              },
              {
                role: 'user',
                content:
                  "Change the exported status in src/status.ts from 'before' to 'after'. Do not modify AGENTS.md, package.json, or the test."
              }
            ]
          })
          expect(result.phase, result.error).toBe('completed')
          expect(result.finalResponse).toContain('SIDEKICK_EVAL_VERIFICATION_OK')
          expect(result.content).not.toContain('CHANGE_APPLIED')
          expect(await fs.readFile(join(workspaceRoot, 'src/status.ts'), 'utf8')).toContain(
            "status = 'after'"
          )
          expect(result.toolNames).toContain('read')
          expect(result.toolNames).toContain('code_intelligence')
          expect(result.toolNames).toContain('shell')
          assertMutationTools(result.toolNames)

          const guard = result.events.find(
            (event) =>
              event.type === 'run.retrying' &&
              event.payload.reason === 'workspace_verification_required'
          )
          expect(guard, 'The kernel did not inject the verification continuation').toBeDefined()
          const commandStarted = result.events.find(
            (event) => event.type === 'tool.running' && event.payload.name === 'shell'
          )
          expect(commandStarted?.sequence).toBeGreaterThan(guard!.sequence)
          const verificationUpdates = result.events
            .filter((event) => event.type === 'verification.updated')
            .map(
              (event) =>
                event.payload.summary as {
                  status?: string
                  evidence?: Array<{ kind?: string; status?: string }>
                }
            )
          expect(verificationUpdates[0]?.status).toBe('unverified')
          expect(verificationUpdates.at(-1)?.status).toBe('passed')
          expect(verificationUpdates.at(-1)?.evidence?.length).toBeGreaterThan(0)
          expect(verificationUpdates.at(-1)?.evidence).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ kind: 'diagnostics', status: 'passed' }),
              expect.objectContaining({ kind: 'test', status: 'passed' })
            ])
          )
          expect(
            result.events.some(
              (event) => event.type === 'assistant.completed' && event.payload.provisional === true
            )
          ).toBe(true)

          enrichMetric('verification-guard-tool-loop', {
            details: {
              toolRounds: result.toolRounds,
              tools: [...new Set(result.toolNames)],
              guardInjected: true,
              languageServerQueried: true,
              initialCompletionProvisional: true,
              finalVerificationStatus: verificationUpdates.at(-1)?.status,
              evidenceCount: verificationUpdates.at(-1)?.evidence?.length ?? 0
            }
          })
        },
        'workspace'
      )
    } finally {
      await harness.close()
      await fs.rm(scenarioRoot, { recursive: true, force: true })
    }
  }, 240_000)

  extendedIt(
    'runs a two-turn project workflow across multiple files through the production kernel',
    async () => {
      const scenarioRoot = await fs.mkdtemp(join(tmpdir(), 'sidekick-llm-project-eval-'))
      const workspaceRoot = join(scenarioRoot, 'project')
      const harness = new AgentScenarioHarness(join(scenarioRoot, 'runtime'), {
        endpoint,
        model,
        headers,
        providerKind,
        maxOutputTokens: 8_192
      })
      try {
        await copyEvalFixture(join(fixtureRoot, 'multi-turn-project'), workspaceRoot)
        await harness.initialize()
        const instructionsBefore = await fs.readFile(join(workspaceRoot, 'AGENTS.md'), 'utf8')
        const projectInstructions = await loadWorkspaceRules(workspaceRoot, workspaceRoot, {
          includeGlobal: false
        })
        expect(projectInstructions.sources).toContain('AGENTS.md')
        const project = new ProjectStore(harness.db).create(workspaceRoot, 'Catalog evaluation')
        const conversationId = randomUUID()
        const now = Date.now()
        harness.db
          .prepare(
            `INSERT INTO conversations
             (id, title, created_at, updated_at, project_id, title_source, title_version,
              sidebar_order, project_context_version, home_workspace_root, home_project_name)
             VALUES (?, ?, ?, ?, ?, 'generated', 1, 0, 0, ?, ?)`
          )
          .run(
            conversationId,
            'Catalog report evaluation',
            now,
            now,
            project.id,
            workspaceRoot,
            project.name
          )
        const projectContext = new ProjectStore(harness.db).getConversationContext(conversationId)
        expect(projectContext.workspaceRoot).toBe(workspaceRoot)
        expect(projectContext.projectId).toBe(project.id)

        const first = await measured(
          'multi-turn-project-create',
          async () => {
            const result = await harness.run({
              workspaceRoot,
              threadId: conversationId,
              maxToolRounds: 40,
              messages: [
                {
                  role: 'system',
                  content:
                    'You are completing a deterministic evaluation in a small isolated project. Read AGENTS.md and all relevant source and test files before editing. Use read and apply_patch for files and shell for verification. Finish only after npm test passes.'
                },
                {
                  role: 'user',
                  content: `<project_instructions trust="app-loaded-project-instructions">\n${projectInstructions.content}\n</project_instructions>`
                },
                {
                  role: 'user',
                  content:
                    "Read AGENTS.md, src/catalog.ts, src/config.ts, and test/verify.mjs. Create src/report.ts with two simple named exports: subtotal = 30 and currency = 'USD'. Run npm test and fix anything needed until it passes. Do not change AGENTS.md."
                }
              ]
            })
            expect(result.phase, result.error).toBe('completed')
            expect(await fs.readFile(join(workspaceRoot, 'src/report.ts'), 'utf8')).toContain(
              'subtotal = 30'
            )
            expect(result.toolNames).toContain('shell')
            assertMutationTools(result.toolNames)
            return result
          },
          'projects'
        )

        const second = await measured(
          'multi-turn-project-revise',
          async () => {
            const result = await harness.run({
              workspaceRoot,
              threadId: conversationId,
              maxToolRounds: 50,
              messages: [
                ...first.messages,
                {
                  role: 'user',
                  content:
                    "Follow-up turn: read the current catalog, config, report, and test first. Add { id: 'gamma', price: 5 } to src/catalog.ts, change expectedSubtotal to 35 in src/config.ts, and update src/report.ts to subtotal = 35. Preserve all existing products and currency. Run npm test and finish only when it passes."
                }
              ]
            })
            expect(result.phase, result.error).toBe('completed')
            const catalog = await fs.readFile(join(workspaceRoot, 'src/catalog.ts'), 'utf8')
            const config = await fs.readFile(join(workspaceRoot, 'src/config.ts'), 'utf8')
            const report = await fs.readFile(join(workspaceRoot, 'src/report.ts'), 'utf8')
            expect(catalog).toContain("id: 'gamma'")
            expect(config).toContain('expectedSubtotal = 35')
            expect(report).toContain('subtotal = 35')
            expect(await fs.readFile(join(workspaceRoot, 'AGENTS.md'), 'utf8')).toBe(
              instructionsBefore
            )
            expect(result.toolNames).toContain('shell')
            assertMutationTools(result.toolNames)
            return result
          },
          'projects'
        )
        enrichMetric('multi-turn-project-create', {
          details: {
            turns: 1,
            toolRounds: first.toolRounds,
            tools: [...new Set(first.toolNames)],
            projectContextResolved: true
          }
        })
        enrichMetric('multi-turn-project-revise', {
          details: {
            turns: 2,
            toolRounds: second.toolRounds,
            tools: [...new Set(second.toolNames)],
            verifiedFiles: ['src/catalog.ts', 'src/config.ts', 'src/report.ts'],
            projectInstructionsPreserved: true
          }
        })
      } finally {
        await harness.close()
        await fs.rm(scenarioRoot, { recursive: true, force: true })
      }
    },
    600_000
  )

  extendedIt(
    'recovers from both an ambiguous edit and a concurrent stale read',
    async () => {
      const scenarioRoot = await fs.mkdtemp(join(tmpdir(), 'sidekick-agent-stale-eval-'))
      const workspaceRoot = join(scenarioRoot, 'project')
      const settingsPath = join(workspaceRoot, 'src/settings.ts')
      const harness = new AgentScenarioHarness(join(scenarioRoot, 'runtime'), {
        endpoint,
        model,
        headers,
        providerKind,
        maxOutputTokens: 4_096
      })
      let changedAfterRead = false
      const ambiguousCall = {
        id: 'sidekick_eval_ambiguous_edit',
        type: 'function',
        function: {
          name: 'edit',
          arguments: JSON.stringify({
            file_path: 'src/settings.ts',
            old_string: "mode: 'draft'",
            new_string: "mode: 'published'",
            accessLevel: 'auto',
            replace_all: false
          })
        }
      }
      const ambiguousError = {
        ok: false,
        success: false,
        code: 'multiple_matches',
        error:
          'Edit rejected: old_string has 2 matches in src/settings.ts; add surrounding context or set replace_all.',
        retryable: true,
        recoveryAction: 'correct_input',
        recovery:
          'Read the current file, then retry once with enough unchanged surrounding context to identify only the primary record.'
      }

      try {
        await fs.mkdir(dirname(settingsPath), { recursive: true })
        await fs.writeFile(
          settingsPath,
          `export const primary = {\n  name: 'primary',\n  mode: 'draft'\n}\n\nexport const secondary = {\n  name: 'secondary',\n  mode: 'draft'\n}\n\nexport const externalVersion = 1\n`,
          'utf8'
        )
        await harness.initialize()
        await measured(
          'ambiguous-stale-edit-recovery',
          async () => {
            const result = await harness.run({
              workspaceRoot,
              maxToolRounds: 20,
              afterToolExecution: async (name, args) => {
                if (
                  !changedAfterRead &&
                  name === 'read' &&
                  args.file_path === 'src/settings.ts'
                ) {
                  changedAfterRead = true
                  const current = await fs.readFile(settingsPath, 'utf8')
                  await fs.writeFile(
                    settingsPath,
                    current.replace('externalVersion = 1', 'externalVersion = 2'),
                    'utf8'
                  )
                }
              },
              messages: [
                {
                  role: 'system',
                  content:
                    'Use the SideKick workspace tools. Follow structured recovery instructions. Re-read a file whenever the harness reports stale state. Preserve unrelated concurrent changes and do not use shell text replacement.'
                },
                {
                  role: 'user',
                  content:
                    "Change only primary.mode from 'draft' to 'published' in src/settings.ts. Keep secondary.mode as draft and preserve every unrelated value."
                },
                { role: 'assistant', content: '', tool_calls: [ambiguousCall] },
                {
                  role: 'tool',
                  tool_call_id: ambiguousCall.id,
                  content: JSON.stringify(ambiguousError)
                }
              ]
            })
            expect(result.phase, result.error).toBe('completed')
            const finalSettings = await fs.readFile(settingsPath, 'utf8')
            expect(finalSettings).toContain("name: 'primary',\n  mode: 'published'")
            expect(finalSettings).toContain("name: 'secondary',\n  mode: 'draft'")
            expect(finalSettings).toContain('externalVersion = 2')
            expect(
              result.toolNames.filter((name) => name === 'read').length
            ).toBeGreaterThanOrEqual(2)
            expect(
              result.toolNames.filter((name) => name === 'edit').length
            ).toBeGreaterThanOrEqual(2)
            enrichMetric('ambiguous-stale-edit-recovery', {
              details: {
                tools: [...new Set(result.toolNames)],
                toolRounds: result.toolRounds,
                ambiguousFailureSeeded: true,
                concurrentChangeInjected: changedAfterRead,
                staleStateRecovered: true,
                unrelatedChangePreserved: true
              }
            })
          },
          'recovery'
        )
      } finally {
        await harness.close()
        await fs.rm(scenarioRoot, { recursive: true, force: true })
      }
    },
    300_000
  )

  extendedIt(
    'plans read-only, crosses an approved revision boundary, executes, and proves completion',
    async () => {
      const scenarioRoot = await fs.mkdtemp(join(tmpdir(), 'sidekick-plan-contract-eval-'))
      const workspaceRoot = join(scenarioRoot, 'project')
      const harness = new AgentScenarioHarness(join(scenarioRoot, 'runtime'), {
        endpoint,
        model,
        headers,
        providerKind,
        maxOutputTokens: 4_096
      })
      try {
        await copyEvalFixture(join(fixtureRoot, 'verification-guard'), workspaceRoot)
        await installEvaluationLanguageServer(workspaceRoot)
        await harness.initialize()
        await measured(
          'plan-contract-tool-loop',
          async () => {
            const result = await harness.run({
              workspaceRoot,
              planMode: true,
              autoApprovePlan: true,
              maxToolRounds: 30,
              messages: [
                {
                  role: 'system',
                  content:
                    'This is a deterministic SideKick Plan-mode evaluation. You begin in enforced read-only planning. Read AGENTS.md and src/status.ts, then call present_plan with one requirement whose id is status-updated, one linked edit step, and one linked verification check. Do not attempt a mutation before approval. After the plan is approved, change the status export from before to after using a workspace mutation tool. Mark the seeded todo completed with manage_todo_list, run code_intelligence diagnostics for src/status.ts, run npm test, then call complete_plan using the exact approved revision and concrete evidence for status-updated. Finish with only SIDEKICK_EVAL_PLAN_OK.'
                },
                {
                  role: 'user',
                  content:
                    "Plan, implement, and verify changing src/status.ts from 'before' to 'after'."
                }
              ]
            })
            expect(result.phase, result.error).toBe('completed')
            expect(result.finalResponse).toContain('SIDEKICK_EVAL_PLAN_OK')
            expect(await fs.readFile(join(workspaceRoot, 'src/status.ts'), 'utf8')).toContain(
              "status = 'after'"
            )
            expect(result.toolNames).toEqual(
              expect.arrayContaining([
                'read',
                'present_plan',
                'manage_todo_list',
                'code_intelligence',
                'shell',
                'complete_plan'
              ])
            )
            assertMutationTools(result.toolNames)
            const approval = result.events.find(
              (event) =>
                event.type === 'question.resolved' && event.payload.kind === 'plan_approval'
            )
            const transition = result.events.find(
              (event) => event.type === 'plan.mode_changed' && event.payload.to === 'act'
            )
            const mutation = result.events.find(
              (event) =>
                event.type === 'tool.completed' &&
                ['edit', 'write', 'apply_patch'].includes(String(event.payload.name || ''))
            )
            expect(approval).toBeDefined()
            expect(transition).toBeDefined()
            expect(mutation).toBeDefined()
            expect(transition!.sequence).toBeGreaterThan(approval!.sequence)
            expect(mutation!.sequence).toBeGreaterThan(transition!.sequence)
            const planRow = harness.db
              .prepare(
                'SELECT stage, revision, contract_json, completion_json FROM agent_run_plans WHERE run_id = ?'
              )
              .get(result.runId) as
              | {
                  stage: string
                  revision: string
                  contract_json: string
                  completion_json: string
                }
              | undefined
            expect(planRow).toMatchObject({ stage: 'executing' })
            expect(planRow?.revision).toBeTruthy()
            expect(JSON.parse(planRow!.contract_json)).toMatchObject({
              requirements: [expect.objectContaining({ id: 'status-updated' })]
            })
            expect(JSON.parse(planRow!.completion_json)).toMatchObject({
              revision: planRow!.revision,
              requirements: [expect.objectContaining({ id: 'status-updated', status: 'passed' })]
            })
            enrichMetric('plan-contract-tool-loop', {
              details: {
                toolRounds: result.toolRounds,
                tools: [...new Set(result.toolNames)],
                readOnlyBeforeApproval: true,
                approvedRevision: planRow!.revision,
                contractCompleted: true,
                verifiedOnDisk: true
              }
            })
          },
          'planning'
        )
      } finally {
        await harness.close()
        await fs.rm(scenarioRoot, { recursive: true, force: true })
      }
    },
    420_000
  )

  extendedIt(
    'runs two project agents through an artifact handoff and a persistent follow-up mission',
    async () => {
      const scenarioRoot = await fs.mkdtemp(join(tmpdir(), 'sidekick-llm-group-eval-'))
      const dataRoot = join(scenarioRoot, 'data-project')
      const webRoot = join(scenarioRoot, 'web-project')
      const harness = new AgentScenarioHarness(join(scenarioRoot, 'runtime'), {
        endpoint,
        model,
        headers,
        providerKind,
        maxOutputTokens: 8_192
      })
      let supervisor: CollaborationSupervisor | undefined
      try {
        await Promise.all([
          copyEvalFixture(join(fixtureRoot, 'group-data'), dataRoot),
          copyEvalFixture(join(fixtureRoot, 'group-web'), webRoot),
          harness.initialize()
        ])
        configureCheckpointStorageRoot(join(scenarioRoot, 'history'))
        const projects = new ProjectStore(harness.db)
        const dataProject = projects.create(dataRoot, 'Data')
        const webProject = projects.create(webRoot, 'Webpage')
        const store = new CollaborationStore(harness.db)
        const target: ProviderTarget = {
          providerKind,
          model,
          contextLength: 180_000,
          maxOutputTokens: 8_192,
          editingDialect: 'structured-edit' as const
        }
        const detail = store.createGroup({
          title: 'Population artifact evaluation',
          participants: [
            { projectId: dataProject.id, label: 'Data agent', providerTarget: target },
            { projectId: webProject.id, label: 'Webpage agent', providerTarget: target }
          ]
        })
        supervisor = new CollaborationSupervisor(
          store,
          harness.collaborationRuntime() as unknown as AgentRuntimeCoordinator,
          () => undefined,
          { toolCallLimit: () => 80 }
        )
        const started = store.sendUserMessage({
          groupId: detail.group.id,
          text: `Complete this small integration as a real two-agent collaboration.

Data agent: read AGENTS.md and source/population.csv, create dist/population.json as a JSON array of {year, population} number objects, share that file to the Webpage agent with collaboration_share_file, send a concise public handoff, then claim completion only after the artifact is shared.

Webpage agent: read AGENTS.md, wait for or read the Data agent handoff, import the shared artifact with collaboration_import_artifact, use its exact three rows to update src/dashboard.js, run npm test, report the verified result publicly, then claim completion.

Both agents: take ownership publicly before private work, never access the other project folder directly, use artifact transport for the cross-project file, answer peer requests, and do not stop until your own work is verified.`
        })

        await measured(
          'group-artifact-collaboration',
          async () => {
            supervisor!.start(started.mission.id, {} as WebContents)
            const finalMission = await waitFor(
              () => store.getMission(started.mission.id),
              (mission) =>
                mission !== null &&
                ['completed', 'failed', 'paused', 'stopped'].includes(mission.status),
              720_000
            )
            expect(finalMission?.status, finalMission?.error || 'Mission did not complete').toBe(
              'completed'
            )
            const participantRuns = store.listParticipantRuns(started.mission.id)
            expect(participantRuns).toHaveLength(2)
            expect(participantRuns.every((run) => run.status === 'completed')).toBe(true)
            const artifacts = store.listArtifacts(detail.group.id)
            expect(artifacts.length).toBeGreaterThanOrEqual(1)
            const data = JSON.parse(
              await fs.readFile(join(dataRoot, 'dist/population.json'), 'utf8')
            ) as Array<{ year: number; population: number }>
            expect(data).toEqual([
              { year: 2022, population: 11_210_000 },
              { year: 2023, population: 11_090_000 },
              { year: 2024, population: 10_980_000 }
            ])
            const dashboardUrl = `${pathToFileURL(join(webRoot, 'src/dashboard.js')).href}?eval=${Date.now()}`
            const dashboard = (await import(dashboardUrl)) as {
              populationRows: Array<{ year: number; population: number }>
              latestPopulation: () => number | null
            }
            expect(dashboard.populationRows).toEqual(data)
            expect(dashboard.latestPopulation()).toBe(10_980_000)
            const events = store.listMissionEvents(started.mission.id)
            const publicAgentMessages = events.filter(
              (event) => event.actorType === 'agent' && event.kind === 'peer_message'
            )
            expect(new Set(publicAgentMessages.map((event) => event.actorParticipantId)).size).toBe(
              2
            )
            const sessions = store.listAgentSessions(detail.group.id)
            const toolNames = sessions.flatMap((session) =>
              store
                .listRecentAgentSessionMessages(session.id, 2_000)
                .flatMap((message) => message.toolCalls.map((call) => call.function.name))
            )
            expect(toolNames).toContain('collaboration_share_file')
            expect(toolNames).toContain('collaboration_import_artifact')
            expect(toolNames).toContain('collaboration_claim_complete')
            expect(toolNames).toContain('shell')
            enrichMetric('group-artifact-collaboration', {
              details: {
                participants: participantRuns.map((run) => run.status),
                publicAgentMessages: publicAgentMessages.length,
                artifacts: artifacts.length,
                tools: [...new Set(toolNames)],
                verifiedRows: data.length
              }
            })
          },
          'collaboration'
        )

        const initialArtifactCount = store.listArtifacts(detail.group.id).length
        const initialSessionIds = store
          .listAgentSessions(detail.group.id)
          .map((session) => session.id)
          .sort()
        const followUp = store.sendUserMessage({
          groupId: detail.group.id,
          text: `Follow-up integration on the same group and existing project state.

Data agent: add the exact row 2025,10850000 to source/population.csv without changing the existing rows, regenerate dist/population.json with all four rows, share the updated artifact, send a public handoff, and claim completion only after verifying the file.

Webpage agent: acknowledge the follow-up publicly, import the newly shared artifact, update src/dashboard.js to use all four rows, update test/verify.mjs to verify four rows and latestPopulation() === 10850000, run npm test, report the verified result publicly, and claim completion.

Both agents: treat this as a new mission continuing the durable private sessions. Coordinate through the group, preserve the first mission's work, never access the peer workspace directly, and finish only after the updated integration is verified.`
        })

        await measured(
          'group-follow-up-collaboration',
          async () => {
            expect(followUp.mission.id).not.toBe(started.mission.id)
            supervisor!.start(followUp.mission.id, {} as WebContents)
            const finalMission = await waitFor(
              () => store.getMission(followUp.mission.id),
              (mission) =>
                mission !== null &&
                ['completed', 'failed', 'paused', 'stopped'].includes(mission.status),
              720_000
            )
            expect(finalMission?.status, finalMission?.error || 'Follow-up did not complete').toBe(
              'completed'
            )
            const participantRuns = store.listParticipantRuns(followUp.mission.id)
            expect(participantRuns).toHaveLength(2)
            expect(participantRuns.every((run) => run.status === 'completed')).toBe(true)
            const artifacts = store.listArtifacts(detail.group.id)
            expect(artifacts.length).toBeGreaterThan(initialArtifactCount)
            const data = JSON.parse(
              await fs.readFile(join(dataRoot, 'dist/population.json'), 'utf8')
            ) as Array<{ year: number; population: number }>
            expect(data).toEqual([
              { year: 2022, population: 11_210_000 },
              { year: 2023, population: 11_090_000 },
              { year: 2024, population: 10_980_000 },
              { year: 2025, population: 10_850_000 }
            ])
            const dashboardUrl = `${pathToFileURL(join(webRoot, 'src/dashboard.js')).href}?eval=${Date.now()}`
            const dashboard = (await import(dashboardUrl)) as {
              populationRows: Array<{ year: number; population: number }>
              latestPopulation: () => number | null
            }
            expect(dashboard.populationRows).toEqual(data)
            expect(dashboard.latestPopulation()).toBe(10_850_000)
            const events = store.listMissionEvents(followUp.mission.id)
            const publicAgentMessages = events.filter(
              (event) => event.actorType === 'agent' && event.kind === 'peer_message'
            )
            expect(new Set(publicAgentMessages.map((event) => event.actorParticipantId)).size).toBe(
              2
            )
            const finalSessionIds = store
              .listAgentSessions(detail.group.id)
              .map((session) => session.id)
              .sort()
            expect(finalSessionIds).toEqual(initialSessionIds)
            const toolNames = store.listAgentSessions(detail.group.id).flatMap((session) =>
              store
                .listRecentAgentSessionMessages(session.id, 4_000)
                .filter((message) => message.missionId === followUp.mission.id)
                .flatMap((message) => message.toolCalls.map((call) => call.function.name))
            )
            expect(toolNames).toContain('collaboration_share_file')
            expect(toolNames).toContain('collaboration_import_artifact')
            expect(toolNames).toContain('collaboration_claim_complete')
            expect(toolNames).toContain('shell')
            enrichMetric('group-follow-up-collaboration', {
              details: {
                participants: participantRuns.map((run) => run.status),
                publicAgentMessages: publicAgentMessages.length,
                artifactDelta: artifacts.length - initialArtifactCount,
                durableSessionsReused: true,
                tools: [...new Set(toolNames)],
                verifiedRows: data.length
              }
            })
          },
          'collaboration'
        )
      } finally {
        supervisor?.shutdown()
        await harness.close()
        await fs.rm(scenarioRoot, { recursive: true, force: true })
      }
    },
    780_000
  )
})
