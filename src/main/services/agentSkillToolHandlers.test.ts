import { expect, it } from 'vitest'
import { AgentToolHandlerRegistry } from './agentToolHandlerRegistry'
import { registerSkillToolHandlers } from './agentSkillToolHandlers'

it('loads dependency declarations without claiming runtime availability or launching a command', async () => {
  const registry = new AgentToolHandlerRegistry()
  const activeSkillIds = new Set<string>()
  registerSkillToolHandlers(registry, {
    activeSkillIds,
    readReceipts: new Map(),
    childLauncher: () => undefined
  })
  const result = await registry.execute({
    name: 'use_skill',
    title: 'Load PDF workflow',
    arguments: { skill_id: 'pdf' },
    context: { runId: 'skill-test', signal: new AbortController().signal }
  })
  expect(result).toMatchObject({
    data: {
      dependencies: {
        status: 'not_checked',
        python: ['pypdf', 'pdfplumber', 'reportlab', 'pdf2image']
      }
    }
  })
  expect(result.modelContent).toContain('does not install or verify dependencies')
  expect(activeSkillIds.has('pdf')).toBe(true)
})
