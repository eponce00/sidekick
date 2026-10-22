// The WebMCP part of the native browser smoke: a page that offers two tools, one read-only and one
// that changes it, driven by the real agent kernel with a scripted model, real handlers, real
// permission modes and real Chromium.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { applyDatabaseSchema } from '../src/main/bootstrap/database'
import { agentRunProfile, type AgentToolCatalogOptions } from '../src/shared/agentToolCatalog'
import type { ToolExecutionResult } from '../src/shared/agentRuntime'
import type { PermissionMode } from '../src/shared/permissions'
import {
  AgentRunKernel,
  type AgentKernelProviderSampler
} from '../src/main/services/agentRunKernel'
import { AgentRunStore } from '../src/main/services/agentRunStore'
import { AgentToolHandlerRegistry } from '../src/main/services/agentToolHandlerRegistry'
import {
  AgentBrowserSessionManager,
  browserScope,
  registerBrowserToolHandlers,
  webMcpCallAccess
} from '../src/main/services/agentBrowserToolHandlers'
import { ToolOutputStore } from '../src/main/services/toolOutputStore'
import type { NativeBrowserSessionService } from '../src/main/services/nativeBrowserSessionService'

/**
 * A page written as Chrome's guide shows it: `document.modelContext`, an awaited registration and
 * `execute(input, {signal})`. Chromium 150 needs SideKick's compatibility script for both.
 * The `next` page is the same site's next document, offering only the read-only tool.
 */
export function webMcpFixtureHtml(variant: 'shop' | 'next'): string {
  const addNote = `
    document.modelContext.registerTool({
      name: 'add_note',
      description: 'Adds a note to the page.',
      inputSchema: {
        type: 'object',
        required: ['text'],
        properties: { text: { type: 'string', minLength: 1 } }
      },
      async execute({ text }) {
        notes.push(text)
        const item = document.createElement('li')
        item.textContent = text
        document.getElementById('notes').append(item)
        return { added: text, count: notes.length }
      }
    })`
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>WebMCP ${variant}</title></head>
  <body>
    <h1>WebMCP ${variant}</h1>
    <ul id="notes"></ul>
    <script>
      const notes = []
      document.modelContext
        .registerTool({
          name: 'count_notes',
          description: 'Returns how many notes the page holds.',
          inputSchema: { type: 'object', properties: {} },
          annotations: { readOnlyHint: true },
          async execute(_input, { signal }) {
            return { count: notes.length, signalled: signal instanceof AbortSignal }
          }
        })
        .then(() => { document.body.dataset.registered = 'yes' })
      ${variant === 'shop' ? addNote : ''}
    </script>
  </body>
</html>`
}

interface ScriptedCall {
  name: string
  arguments: Record<string, unknown>
}

interface AgentRun {
  results: ToolExecutionResult[]
  /** The tools the user was asked about, in order. */
  asked: string[]
}

function scriptedModel(calls: readonly ScriptedCall[]): AgentKernelProviderSampler {
  let turn = 0
  return async () => {
    const call = calls[turn]
    turn++
    return {
      result: { ok: true },
      turn: {
        content: call ? '' : 'Done.',
        thinking: '',
        thinkingBlocks: [],
        toolCalls: call
          ? [{ id: `call-${turn}`, function: { name: call.name, arguments: call.arguments } }]
          : [],
        usage: { promptTokens: 10, completionTokens: 5, doneReason: 'stop' }
      }
    }
  }
}

export async function runWebMcpSmoke(
  service: NativeBrowserSessionService,
  shopUrl: string,
  otherSiteUrl: string,
  progress: (step: string) => void
): Promise<{ toolCalls: number; asked: number }> {
  const db = new Database(':memory:')
  applyDatabaseSchema(db)
  const store = new AgentRunStore(db)
  const manager = new AgentBrowserSessionManager(service)
  const handlers = new AgentToolHandlerRegistry()
  registerBrowserToolHandlers(
    handlers,
    manager,
    new ToolOutputStore(mkdtempSync(join(tmpdir(), 'sidekick-webmcp-smoke-output-')))
  )
  const catalog: AgentToolCatalogOptions = {
    surface: 'conversation',
    webSearchEnabled: false,
    browserEnabled: true
  }
  const origin = new URL(shopUrl).origin
  const conversationId = 'webmcp-smoke'
  let runs = 0
  let toolCalls = 0
  let asked = 0

  const runAgent = async (mode: PermissionMode, calls: ScriptedCall[]): Promise<AgentRun> => {
    const runId = `webmcp-run-${++runs}`
    const results: ToolExecutionResult[] = []
    const run: AgentRun = { results, asked: [] }
    const kernel = new AgentRunKernel(store, undefined, scriptedModel(calls))
    const running = kernel.start({
      id: runId,
      threadId: conversationId,
      profile: agentRunProfile(catalog),
      provider: 'ollama',
      model: 'scripted',
      catalog,
      messages: [{ role: 'user', content: 'Use the page tools.' }],
      request: {
        target: { providerKind: 'ollama', model: 'scripted' },
        maxOutputTokens: 1_024,
        purpose: 'conversation'
      },
      maxToolRounds: 50,
      permissionMode: mode,
      toolRouter: {
        execute: async (name, args, context) => {
          const result = await handlers.execute({ name, title: name, arguments: args, context })
          results.push(result)
          return result
        },
        approvalPreview: (name, args, context) => handlers.preview(name, args, context),
        requestedAccess: (name, args, context) =>
          name === 'browser_call_webmcp_tool'
            ? webMcpCallAccess(manager, browserScope(context), args)
            : undefined
      }
    })
    let finished = false
    void running.finally(() => {
      finished = true
    })
    while (!finished) {
      for (const interaction of store.listPendingInteractions(runId)) {
        assert.equal(interaction.kind, 'permission')
        const request = interaction.request as { name: string; arguments: { tool?: string } }
        run.asked.push(
          request.name === 'browser_call_webmcp_tool'
            ? String(request.arguments.tool)
            : request.name
        )
        kernel.resolveInteraction(interaction.id, { approved: true })
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25))
    }
    const outcome = await running
    assert.equal(outcome.phase, 'completed', `WebMCP agent run ${runId} ended ${outcome.phase}`)
    assert.equal(results.length, calls.length, 'Every scripted call reaches the browser handlers')
    toolCalls += results.length
    asked += run.asked.length
    return run
  }

  const call = (tool: string, args: Record<string, unknown> = {}, site = origin): ScriptedCall => ({
    name: 'browser_call_webmcp_tool',
    arguments: { origin: site, tool, arguments: args }
  })
  const list: ScriptedCall = { name: 'browser_list_webmcp_tools', arguments: {} }
  const content = (result: ToolExecutionResult): string => String(result.modelContent ?? '')

  try {
    progress('WebMCP: listing and calling page tools in Ask for sensitive actions')
    const sensitive = await runAgent('sensitive-only', [
      { name: 'browser_open', arguments: { url: shopUrl } },
      list,
      call('count_notes'),
      call('add_note', { text: 'from the agent' }),
      call('add_note', { text: '' }),
      { name: 'browser_navigate', arguments: { action: 'url', url: `${shopUrl}-next` } },
      call('count_notes'),
      list,
      { name: 'browser_navigate', arguments: { action: 'url', url: otherSiteUrl } },
      call('count_notes')
    ])
    const [opened, listed, read, added, invalid, , stale, relisted, , crossSite] = sensitive.results
    assert.equal(opened.status, 'success', content(opened))
    assert.equal(listed.status, 'success')
    assert.ok(
      content(listed).startsWith(`<webmcp_tools origin="${origin}" trust="untrusted-data">`),
      content(listed)
    )
    const listing = JSON.parse(content(listed).split('\n')[1]) as {
      tools: Array<{ name: string; read_only: boolean }>
    }
    assert.deepEqual(
      listing.tools.map((tool) => [tool.name, tool.read_only]),
      [
        ['add_note', false],
        ['count_notes', true]
      ]
    )
    assert.equal(read.status, 'success', content(read))
    // The page's execute received a signal: the compatibility script works in this Chromium.
    assert.match(content(read), /"count":0,"signalled":true/)
    assert.equal(added.status, 'success', content(added))
    assert.match(content(added), /"count":1/)
    assert.equal(invalid.error?.code, 'invalid_arguments', JSON.stringify(invalid.error))
    assert.equal(stale.error?.code, 'conflict', JSON.stringify(stale.error))
    assert.match(stale.error?.message ?? '', /new document/)
    assert.match(content(relisted), /"name":"count_notes"/)
    assert.doesNotMatch(content(relisted), /add_note/)
    assert.equal(crossSite.status, 'denied', JSON.stringify(crossSite.error))
    assert.equal(crossSite.error?.code, 'permission_denied')
    // Only the tool that changes the page asked. The read-only call and every call bound to be
    // refused, including the one whose arguments the schema rejects, asked nothing.
    assert.deepEqual(sensitive.asked, ['add_note'])
    progress('WebMCP: read-only ran unasked, add_note asked, stale and cross-site calls refused')

    progress('WebMCP: checking the other permission modes')
    const full = await runAgent('full-access', [
      { name: 'browser_navigate', arguments: { action: 'url', url: shopUrl } },
      list,
      call('add_note', { text: 'in full access' })
    ])
    assert.equal(full.results[2].status, 'success', content(full.results[2]))
    assert.deepEqual(full.asked, [])
    const sessionId = manager.sessionFor(conversationId)!
    const notes = await service.evaluate({
      sessionId,
      expression: '[...document.querySelectorAll("#notes li")].map((item) => item.textContent)'
    })
    assert.deepEqual(notes.value, ['in full access'])
    const strict = await runAgent('always-ask', [list, call('count_notes')])
    assert.equal(strict.results[1].status, 'success')
    assert.deepEqual(strict.asked, ['count_notes'])
    assert.equal(service.workspaceSnapshot(sessionId).pageTools?.tools.length, 2)
    progress('WebMCP: full access ran unasked; ask-before-every-change asked even for read-only')
    return { toolCalls, asked }
  } finally {
    await manager.closeScope(conversationId).catch(() => undefined)
    db.close()
  }
}
