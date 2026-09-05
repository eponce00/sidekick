import Database from 'better-sqlite3'
import { afterAll, describe, expect, it } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, resolve, sep } from 'path'
import { applyDatabaseSchema } from '../bootstrap/database'
import { AgentToolRuntime } from '../services/agentToolRuntime'
import { AgentToolRegistry } from '../services/agentToolRegistry'
import { CommandService } from '../services/commandService'
import { McpClientManager } from '../services/mcpClientManager'
import { ToolOutputStore } from '../services/toolOutputStore'
import { WorkspaceReadService } from '../services/workspaceReadService'
import {
  editingToolDefinitions,
  workspaceReadToolDefinitions
} from '../../shared/agentToolDefinitions'
import { openAICompatibleHeaders } from '../providers/openAICompatibleClient'
import { streamOpenAICompatibleChat } from '../providers/openAIStreamingClient'
import type { ProviderToolCall } from '../../shared/providerRuntime'
import type { ToolExecutionResult } from '../../shared/agentRuntime'

// Opt-in only. All mutations are confined to newly created synthetic temporary projects.
const enabled = process.env.SIDEKICK_PATCH_EVAL_RUN === '1'
const endpoint = process.env.SIDEKICK_AGENT_EVAL_URL || 'https://llm.midecasa.com/v1'
const model = process.env.SIDEKICK_AGENT_EVAL_MODEL || 'local-loaded-model'
const key = process.env.SIDEKICK_AGENT_EVAL_API_KEY || ''
const repetitions = Math.min(20, Math.max(1, Number(process.env.SIDEKICK_PATCH_EVAL_N || 5)))
const rows: Record<string, unknown>[] = []
const startedAt = new Date().toISOString()
const guidance = process.env.SIDEKICK_PATCH_EVAL_GUIDANCE === '1'
const grammarHelp =
  '\nPatch syntax reminder: this tool does NOT accept unified-diff line numbers or a closing @@. Use a bare @@ line, followed by exact source lines prefixed with space, - or +. No markdown fences. Minimal example (substitute the actual project path and exact current lines):\n*** Begin Patch\n*** Update File: path/file.txt\n@@\n-old text\n+new text\n*** End Patch\nRead the file again if needed, then send one corrected apply_patch call.'
const patch = (path: string, old: string, next: string) =>
  `*** Begin Patch\n*** Update File: ${path}\n@@\n-${old}\n+${next}\n*** End Patch`
const repeated =
  'export function first() {\n  return "before"\n}\n\nexport function second() {\n  return "before"\n}\n'
const scenarios = [
  {
    name: 'unicode-crlf',
    files: { 'src/café.ts': '// Preserve café ☕\r\nexport const label = "before"\r\n' },
    expected: { 'src/café.ts': '// Preserve café ☕\r\nexport const label = "after"\r\n' },
    prompt:
      'Change only the label string in src/café.ts from before to after. Preserve the comment and line endings.'
  },
  {
    name: 'repeated-context',
    files: { 'src/status.ts': repeated },
    expected: {
      'src/status.ts': repeated.replace(
        'second() {\n  return "before"',
        'second() {\n  return "after"'
      )
    },
    prompt: 'Change only second() in src/status.ts to return "after"; leave first() unchanged.'
  },
  {
    name: 'multi-file',
    files: { 'src/old.ts': 'export const status = "before"\n', 'obsolete.txt': 'obsolete\n' },
    expected: { 'src/new.ts': 'export const status = "after"\n', 'README.md': '# Patch test\n' },
    prompt:
      'In ONE apply_patch call, move src/old.ts to src/new.ts while changing status to "after", delete obsolete.txt, and add README.md containing exactly "# Patch test" plus a newline. Read existing files first.'
  },
  {
    name: 'stale-read-recovery',
    files: { 'src/status.ts': 'export const status = "before"\n' },
    expected: {
      'src/status.ts': '// external edit: preserve this\nexport const status = "after"\n'
    },
    prompt:
      'Change status in src/status.ts from "before" to "after". Preserve all comments and unrelated changes. Other editors may change the file; follow any tool error and retry safely.'
  },
  {
    name: 'ambiguous-recovery',
    files: { 'src/status.ts': repeated },
    expected: {
      'src/status.ts': repeated.replace(
        'second() {\n  return "before"',
        'second() {\n  return "after"'
      )
    },
    prompt:
      'Change only second() in src/status.ts to return "after"; leave first() unchanged. Recover from the previous rejected tool call.',
    injected: patch('src/status.ts', '  return "before"', '  return "after"')
  },
  {
    name: 'grammar-recovery',
    files: { 'src/status.ts': 'export const status = "before"\n' },
    expected: { 'src/status.ts': 'export const status = "after"\n' },
    prompt:
      'Change status in src/status.ts from "before" to "after". Recover from the previous rejected tool call.',
    injected:
      '--- a/src/status.ts\n+++ b/src/status.ts\n@@ -1 +1 @@\n-export const status = "before"\n+export const status = "after"'
  }
]

async function snapshot(root: string, prefix = ''): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  for (const entry of await fs.readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) Object.assign(result, await snapshot(root, path))
    else result[path] = await fs.readFile(join(root, path), 'utf8')
  }
  return result
}

afterAll(async () => {
  if (!enabled) return
  const report = {
    startedAt,
    completedAt: new Date().toISOString(),
    endpoint,
    model,
    repetitions,
    guidance,
    scope:
      'Production streaming parser, AgentToolRegistry and AgentToolRuntime; read/apply_patch tools only; not a full AgentRunKernel/UI evaluation. Server-default reasoning; temperature 0.6. Guidance mode changes only test error feedback, not production.',
    rows
  }
  const path = process.env.SIDEKICK_PATCH_EVAL_REPORT
  if (path) {
    await fs.mkdir(dirname(resolve(path)), { recursive: true })
    await fs.writeFile(path, JSON.stringify(report, null, 2))
  }
  console.info(
    `[patch-eval] ${rows.filter((r) => r.passed).length}/${rows.length} exact on-disk outcomes`
  )
})
;(enabled ? describe.sequential : describe.skip)('live production patch tools', () => {
  for (const scenario of scenarios)
    for (let cycle = 1; cycle <= repetitions; cycle++) {
      it(`${scenario.name} #${cycle}`, async () => {
        expect(key, 'A process-scoped evaluation key is required').not.toBe('')
        const root = await fs.mkdtemp(join(tmpdir(), 'sidekick-patch-eval-'))
        const workspace = join(root, 'project')
        await fs.mkdir(workspace)
        for (const [path, content] of Object.entries(scenario.files)) {
          await fs.mkdir(dirname(join(workspace, path)), { recursive: true })
          await fs.writeFile(join(workspace, path), content!)
        }
        const db = new Database(':memory:')
        applyDatabaseSchema(db)
        const runtime = new AgentToolRuntime(
          db,
          new WorkspaceReadService(),
          new CommandService(db, join(root, 'commands')),
          new ToolOutputStore(join(root, 'outputs')),
          new McpClientManager()
        )
        const runId = `patch-${scenario.name}-${cycle}`
        const session = await runtime.createSession({
          runId,
          surface: 'conversation',
          workspaceRoot: workspace,
          webSearchEnabled: false,
          capabilities: ['workspace.read', 'workspace.write']
        })
        const registry = new AgentToolRegistry()
        const context = { runId, workspaceRoot: workspace, signal: AbortSignal.timeout(150_000) }
        const messages: Record<string, unknown>[] = [
          {
            role: 'system',
            content:
              'Use the provided read and apply_patch tools to complete the task in this isolated project. Read existing files before editing. Follow tool recovery instructions. Do not use other tools. Preserve unrelated content. After success, reply DONE.'
          },
          { role: 'user', content: scenario.prompt }
        ]
        const events: Record<string, unknown>[] = []
        const turns: Record<string, unknown>[] = []
        let staleInjected = false
        let final = false
        let failure: string | undefined
        const started = performance.now()
        const execute = async (name: string, args: Record<string, unknown>, injected = false) => {
          const before = await snapshot(workspace)
          const t = performance.now()
          const result = await registry.execute(
            {
              catalog: session.catalog(),
              call: { id: `eval_${events.length}`, name, arguments: args },
              title: name,
              context
            },
            (prepared, executionContext) =>
              session.router.execute(
                name,
                prepared,
                executionContext
              ) as Promise<ToolExecutionResult>
          )
          const unchangedOnError =
            result.status === 'success' ||
            JSON.stringify(before) === JSON.stringify(await snapshot(workspace))
          events.push({
            name,
            injected,
            status: result.status,
            code: result.error?.code,
            message: result.error?.message,
            ...(result.status === 'error' && name === 'apply_patch'
              ? { rejectedPatch: args.patch }
              : {}),
            ms: Math.round(performance.now() - t),
            unchangedOnError
          })
          expect(unchangedOnError, 'A rejected tool call changed files').toBe(true)
          if (guidance && name === 'apply_patch' && result.status === 'error') {
            return { ...result, modelContent: result.modelContent + grammarHelp }
          }
          return result
        }
        try {
          if (scenario.injected) {
            const read = await execute('read', { path: 'src/status.ts' }, true)
            messages.push(
              {
                role: 'assistant',
                content: '',
                tool_calls: [
                  {
                    id: 'seed_read',
                    type: 'function',
                    function: { name: 'read', arguments: '{"path":"src/status.ts"}' }
                  }
                ]
              },
              { role: 'tool', tool_call_id: 'seed_read', content: read.modelContent }
            )
            const result = await execute('apply_patch', { patch: scenario.injected }, true)
            expect(result.status).toBe('error')
            messages.push(
              {
                role: 'assistant',
                content: '',
                tool_calls: [
                  {
                    id: 'seed_patch',
                    type: 'function',
                    function: {
                      name: 'apply_patch',
                      arguments: JSON.stringify({ patch: scenario.injected })
                    }
                  }
                ]
              },
              { role: 'tool', tool_call_id: 'seed_patch', content: result.modelContent }
            )
          }
          for (let round = 0; round < 10; round++) {
            const calls = new Map<string, ProviderToolCall>()
            let content = ''
            let firstEventMs: number | undefined
            let promptTokens: number | undefined
            let cachedTokens: number | undefined
            let outputTokens: number | undefined
            const t = performance.now()
            const response = await streamOpenAICompatibleChat(
              endpoint,
              {
                model,
                messages,
                tools: [
                  ...workspaceReadToolDefinitions(),
                  ...editingToolDefinitions('apply-patch')
                ],
                tool_choice: 'auto',
                max_tokens: 2048,
                temperature: 0.6
              },
              openAICompatibleHeaders(key),
              (chunk) => {
                if (firstEventMs === undefined && chunk.message)
                  firstEventMs = Math.round(performance.now() - t)
                content += chunk.message?.content || ''
                for (const call of chunk.message?.tool_calls || [])
                  calls.set(
                    call.index !== undefined ? String(call.index) : call.id || call.function.name,
                    call
                  )
                if (chunk.prompt_eval_count !== undefined) promptTokens = chunk.prompt_eval_count
                if (chunk.cached_prompt_tokens !== undefined)
                  cachedTokens = chunk.cached_prompt_tokens
                if (chunk.eval_count !== undefined) outputTokens = chunk.eval_count
              },
              fetch,
              context.signal
            )
            turns.push({
              ms: Math.round(performance.now() - t),
              firstEventMs,
              promptTokens,
              cachedTokens,
              outputTokens
            })
            if (!response.ok) throw new Error(String(response.error).replaceAll(key, '[REDACTED]'))
            if (!calls.size) {
              final = true
              break
            }
            const normalized = [...calls.values()].map((call, i) => ({
              id: call.id || `call_${round}_${i}`,
              type: 'function',
              function: {
                name: call.function.name,
                arguments:
                  typeof call.function.arguments === 'string'
                    ? call.function.arguments
                    : JSON.stringify(call.function.arguments)
              }
            }))
            messages.push({ role: 'assistant', content, tool_calls: normalized })
            for (const call of normalized) {
              const args = JSON.parse(call.function.arguments) as Record<string, unknown>
              expect(['read', 'apply_patch']).toContain(call.function.name)
              const result = await execute(call.function.name, args)
              messages.push({ role: 'tool', tool_call_id: call.id, content: result.modelContent })
              if (
                scenario.name === 'stale-read-recovery' &&
                !staleInjected &&
                call.function.name === 'read' &&
                args.path === 'src/status.ts'
              ) {
                await fs.writeFile(
                  join(workspace, 'src/status.ts'),
                  '// external edit: preserve this\nexport const status = "before"\n'
                )
                staleInjected = true
              }
            }
          }
          expect(final, 'Model exceeded ten tool rounds').toBe(true)
          expect(await snapshot(workspace)).toEqual(scenario.expected)
        } catch (error) {
          failure = String(error).replaceAll(key, '[REDACTED]')
        } finally {
          rows.push({
            scenario: scenario.name,
            cycle,
            passed: !failure,
            failure,
            actualFiles: await snapshot(workspace),
            ms: Math.round(performance.now() - started),
            events,
            turns
          })
          console.info(
            `[patch-eval] ${scenario.name} #${cycle}: ${failure ? 'FAIL' : 'PASS'}; ${turns.length} requests; ${events.filter((e) => e.status === 'error').length} rejected calls`
          )
          await runtime.close()
          db.close()
          const safeCleanup =
            !resolve(root).startsWith(resolve(tmpdir()) + sep) ||
            !root.split(sep).at(-1)?.startsWith('sidekick-patch-eval-')
          expect(safeCleanup, 'Invalid cleanup root').toBe(false)
          await fs.rm(root, { recursive: true, force: true })
        }
        expect(failure).toBeUndefined()
      }, 165_000)
    }
})
