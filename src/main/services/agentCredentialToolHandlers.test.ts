import { describe, expect, it, vi } from 'vitest'
import { agentRunProfile, getAgentToolCatalog } from '../../shared/agentToolCatalog'
import type { CredentialSummary } from '../../shared/credentials'
import {
  registerCredentialToolHandlers,
  type CredentialToolAccess
} from './agentCredentialToolHandlers'
import { AgentToolHandlerRegistry } from './agentToolHandlerRegistry'

function summary(overrides: Partial<CredentialSummary> = {}): CredentialSummary {
  return {
    id: 'one',
    alias: 'partner-center',
    kind: 'secret',
    description: 'Store submissions',
    createdAt: 1,
    updatedAt: 1,
    needsValue: false,
    ...overrides
  }
}

function setup(access: Partial<CredentialToolAccess> = {}) {
  const handlers = new AgentToolHandlerRegistry()
  const openEditor = vi.fn(() => true)
  registerCredentialToolHandlers(handlers, {
    list: () => [summary(), summary({ id: 'two', alias: 'site', kind: 'sign_in' })],
    openEditor,
    ...access
  })
  const run = (name: string, args: Record<string, unknown> = {}) =>
    handlers.execute({
      name,
      title: name,
      arguments: args,
      context: { runId: 'run', conversationId: 'chat', signal: new AbortController().signal }
    })
  return { run, openEditor }
}

describe('credential tools', () => {
  it('lists names, descriptions and usernames, never a value', async () => {
    const { run } = setup({
      list: () => [
        summary(),
        summary({ id: 'two', alias: 'site', kind: 'sign_in', username: 'visible-user' })
      ]
    })
    const result = await run('credentials_list')
    expect(result.status).toBe('success')
    expect(result.modelContent).toContain('partner-center')
    expect(result.modelContent).toContain('Store submissions')
    expect(result.modelContent).toContain('visible-user')
    expect(result.modelContent).not.toMatch(/"(secret|password|value|values)":/)
  })

  it('opens Settings for a credential with a valid alias only', async () => {
    const { run, openEditor } = setup()
    const opened = await run('credentials_request', {
      alias: 'github-token',
      kind: 'secret',
      description: 'Release automation',
      website: 'https://GitHub.com/settings'
    })
    expect(opened.status).toBe('success')
    expect(openEditor).toHaveBeenCalledWith({
      alias: 'github-token',
      kind: 'secret',
      description: 'Release automation',
      site: 'github.com'
    })
    const refused = await run('credentials_request', { alias: 'Not An Alias!' })
    expect(refused.status).toBe('error')
    expect(openEditor).toHaveBeenCalledTimes(1)
  })

  it('reports when no window can show Settings', async () => {
    const { run } = setup({ openEditor: () => false })
    expect((await run('credentials_request', { alias: 'x1' })).error?.code).toBe('unsupported')
  })

  it('offers the tools to conversations only, never while planning', () => {
    const names = (options: Parameters<typeof getAgentToolCatalog>[0]) =>
      getAgentToolCatalog(options).map((entry) => entry.definition.function.name)
    expect(names({ surface: 'conversation' })).toEqual(
      expect.arrayContaining(['credentials_list', 'credentials_request'])
    )
    expect(names({ surface: 'subagent' })).not.toContain('credentials_list')
    expect(names({ surface: 'research' })).not.toContain('credentials_list')
    expect(names({ surface: 'conversation', planStage: 'planning' })).not.toContain(
      'credentials_list'
    )
    expect(agentRunProfile({ surface: 'conversation' }).capabilities).toContain('credentials')
  })
})
