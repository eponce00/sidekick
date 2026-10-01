import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { promises as fs, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, resolve, sep } from 'path'
import { applyDatabaseSchema } from '../bootstrap/database'
import { openAICompatibleHeaders } from '../providers/openAICompatibleClient'
import { durableProviderHistory, type MessageRow } from '../services/conversationRunPreparer'
import { getAgentToolDefinitions } from '../../shared/agentToolCatalog'
import { PromptComposer } from '../../shared/prompts/PromptComposer'
import { capabilitiesFromTools } from '../../shared/prompts/promptCapabilities'
import { createPromptModelProfile } from '../../shared/prompts/modelProfiles'
import { isWorkspaceMutationTool, type EditingDialect } from '../../shared/workspaceMutations'
import type { AgentCapability, AgentRunEvent } from '../../shared/agentRuntime'
import type { ProviderChatMessage } from '../../shared/providerRuntime'
import { AgentScenarioHarness, type AgentKernelScenarioResult } from './agentScenarioHarness'

// Opt-in live evaluation of file editing through the production kernel, tools and system prompt.
// Scenarios and fixture projects come from SIDEKICK_EDIT_EVAL_FIXTURES so private files are never
// committed; every run edits a fresh temporary copy and is checked byte for byte.
const enabled = process.env.SIDEKICK_EDIT_EVAL_RUN === '1'
const fixtureRoot = process.env.SIDEKICK_EDIT_EVAL_FIXTURES || ''
const endpoint = process.env.SIDEKICK_AGENT_EVAL_URL || 'http://127.0.0.1:4000/v1'
const model = process.env.SIDEKICK_AGENT_EVAL_MODEL || 'local-loaded-model'
const key = process.env.SIDEKICK_AGENT_EVAL_API_KEY || ''
const dialect = (process.env.SIDEKICK_EDIT_EVAL_DIALECT || 'apply-patch') as EditingDialect
const arm = process.env.SIDEKICK_EDIT_EVAL_ARM || dialect
const repetitions = Math.min(20, Math.max(1, Number(process.env.SIDEKICK_EDIT_EVAL_N || 3)))
const only = (process.env.SIDEKICK_EDIT_EVAL_SCENARIOS || '').split(',').filter(Boolean)
const reportPath = process.env.SIDEKICK_EDIT_EVAL_REPORT || ''
const capabilities: AgentCapability[] = ['workspace.read', 'workspace.write']

interface Scenario {
  name: string
  project: string
  prompts: string[]
  expected: Record<string, string>
  notes?: string
}

const scenarios: Scenario[] =
  enabled && fixtureRoot
    ? (JSON.parse(readFileSync(join(fixtureRoot, 'scenarios.json'), 'utf8')) as Scenario[]).filter(
        (scenario) => !only.length || only.includes(scenario.name)
      )
    : []

async function snapshot(root: string, prefix = ''): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  for (const entry of await fs.readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) Object.assign(result, await snapshot(root, path))
    else result[path] = await fs.readFile(join(root, path), 'utf8')
  }
  return result
}

function systemPrompt(workspaceRoot: string): string {
  const tools = getAgentToolDefinitions({
    surface: 'conversation',
    workspaceRoot,
    webSearchEnabled: false,
    browserEnabled: false,
    capabilities,
    editingDialect: dialect
  })
  return new PromptComposer().compose({
    platform:
      process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux',
    capabilities: capabilitiesFromTools(tools),
    permissionMode: 'full-access',
    model: createPromptModelProfile({
      id: `eval:${model}`,
      name: model,
      provider: 'lmstudio',
      providerKind: 'openai-compatible',
      providerModelId: model
    }),
    project: { workspaceRoot, instructions: '', instructionSources: [], memory: '' },
    currentDate: new Intl.DateTimeFormat('en-US', { dateStyle: 'full' }).format(new Date()),
    toolRoundLimit: 80,
    activeSkillIds: [],
    skillAssetsPath: null
  }).content
}

function row(id: string, role: MessageRow['role'], content: string, timestamp: number): MessageRow {
  return {
    id,
    role,
    content,
    thinking: null,
    segments: null,
    images: null,
    token_usage: null,
    timestamp
  }
}

interface CallRecord {
  turn: number
  name: string
  status: string
  code?: string
  message?: string
  args?: Record<string, unknown>
  unchangedOnError?: boolean
}

function usageTotals(events: AgentRunEvent[]): {
  prompt: number
  completion: number
  requests: number
} {
  const usage = events.filter((event) => event.type === 'usage.updated')
  return {
    requests: usage.length,
    prompt: usage.reduce((sum, event) => sum + Number(event.payload.promptTokens || 0), 0),
    completion: usage.reduce((sum, event) => sum + Number(event.payload.completionTokens || 0), 0)
  }
}

;(enabled ? describe.sequential : describe.skip)(`live file editing (${arm})`, () => {
  for (const scenario of scenarios)
    for (let cycle = 1; cycle <= repetitions; cycle++) {
      it(`${scenario.name} #${cycle}`, async () => {
        expect(key, 'A process-scoped evaluation key is required').not.toBe('')
        const root = await fs.mkdtemp(join(tmpdir(), 'sidekick-edit-eval-'))
        const workspace = join(root, 'project')
        await fs.cp(join(fixtureRoot, 'fixtures', scenario.project), workspace, { recursive: true })
        const original = await snapshot(workspace)
        const db = new Database(':memory:')
        applyDatabaseSchema(db)
        const harness = new AgentScenarioHarness(
          join(root, 'runtime'),
          {
            endpoint,
            model,
            headers: openAICompatibleHeaders(key),
            providerKind: 'openai-compatible',
            maxOutputTokens: 32_768,
            requestTimeoutMs: 300_000,
            editingDialect: dialect,
            temperature: null
          },
          db
        )
        await harness.initialize()
        const calls: CallRecord[] = []
        const results: AgentKernelScenarioResult[] = []
        let failure: string | undefined
        let lastSnapshot = original
        const started = performance.now()
        const threadId = `edit-eval-${scenario.name}-${cycle}`
        try {
          const system: ProviderChatMessage = { role: 'system', content: systemPrompt(workspace) }
          const rows: MessageRow[] = []
          for (const [turn, prompt] of scenario.prompts.entries()) {
            rows.push(row(`user-${turn}`, 'user', prompt, turn * 2))
            // Later turns are rebuilt the way a follow-up message is: from durable run history.
            const history = turn
              ? durableProviderHistory(db, threadId, rows, {
                  providerKind: 'openai-compatible',
                  model
                })
              : [{ role: 'user' as const, content: prompt }]
            const result = await harness.run({
              runId: `${threadId}-turn-${turn}`,
              threadId,
              outputMessageId: `agent-${turn}`,
              workspaceRoot: workspace,
              capabilities,
              maxToolRounds: 40,
              messages: [system, ...history],
              afterToolExecution: async (name, args, value) => {
                const result = value as {
                  status?: string
                  error?: { code?: string; message?: string }
                }
                const current = await snapshot(workspace)
                const failed = result.status !== 'success'
                calls.push({
                  turn,
                  name,
                  status: String(result.status),
                  code: result.error?.code,
                  message: result.error?.message?.slice(0, 600),
                  ...(failed && isWorkspaceMutationTool(name)
                    ? {
                        args: Object.fromEntries(
                          Object.entries(args).map(([k, v]) => [
                            k,
                            typeof v === 'string' && v.length > 6_000 ? `${v.slice(0, 6_000)}…` : v
                          ])
                        ),
                        unchangedOnError: JSON.stringify(current) === JSON.stringify(lastSnapshot)
                      }
                    : {})
                })
                lastSnapshot = current
              }
            })
            results.push(result)
            rows.push(
              row(
                `agent-${turn}`,
                'agent',
                result.finalResponse || result.content || '',
                turn * 2 + 1
              )
            )
            if (result.phase !== 'completed')
              throw new Error(`turn ${turn} ${result.phase}: ${result.error}`)
          }
          const actual = await snapshot(workspace)
          const expected = { ...original, ...scenario.expected }
          const wrong = Object.keys({ ...expected, ...actual }).filter(
            (path) => actual[path] !== expected[path]
          )
          if (wrong.length) throw new Error(`files differ from expected: ${wrong.join(', ')}`)
        } catch (error) {
          failure = String(error).replaceAll(key, '[REDACTED]').slice(0, 2_000)
        } finally {
          const actual = await snapshot(workspace)
          const expected = { ...original, ...scenario.expected }
          const events = results.flatMap((result) => result.events)
          const mutations = calls.filter((call) => isWorkspaceMutationTool(call.name))
          const record = {
            arm,
            dialect,
            model,
            scenario: scenario.name,
            cycle,
            passed: !failure,
            failure,
            ms: Math.round(performance.now() - started),
            usage: usageTotals(events),
            toolRounds: results.reduce((sum, result) => sum + result.toolRounds, 0),
            mutationCalls: mutations.length,
            failedMutations: mutations.filter((call) => call.status !== 'success').length,
            rejectedChangedFiles: mutations.some((call) => call.unchangedOnError === false),
            calls,
            wrongFiles: Object.keys({ ...expected, ...actual })
              .filter((path) => actual[path] !== expected[path])
              .map((path) => ({
                path,
                missing: actual[path] === undefined,
                unexpected: expected[path] === undefined,
                actualBytes: actual[path]?.length,
                expectedBytes: expected[path]?.length,
                actualSample:
                  actual[path] === undefined
                    ? undefined
                    : firstDifference(actual[path], expected[path] ?? '')
              }))
          }
          if (reportPath) {
            await fs.mkdir(dirname(resolve(reportPath)), { recursive: true })
            await fs.appendFile(reportPath, JSON.stringify(record) + '\n')
          }
          console.info(
            `[edit-eval:${arm}] ${scenario.name} #${cycle}: ${failure ? 'FAIL' : 'PASS'} in ${Math.round(record.ms / 1000)} s; ` +
              `${record.mutationCalls} edits, ${record.failedMutations} rejected; ${record.usage.requests} model requests`
          )
          await harness.close()
          const safeRoot =
            resolve(root).startsWith(resolve(tmpdir()) + sep) &&
            Boolean(root.split(sep).at(-1)?.startsWith('sidekick-edit-eval-'))
          expect(safeRoot, 'Invalid cleanup root').toBe(true)
          await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
        }
        expect(failure).toBeUndefined()
      }, 1_800_000)
    }
})

function firstDifference(actual: string, expected: string): string {
  let index = 0
  while (index < actual.length && actual[index] === expected[index]) index++
  const from = Math.max(0, index - 80)
  return JSON.stringify({
    at: index,
    actual: actual.slice(from, index + 160),
    expected: expected.slice(from, index + 160)
  })
}
