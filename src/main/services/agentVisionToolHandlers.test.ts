import { mkdtemp, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { AgentToolHandlerRegistry } from './agentToolHandlerRegistry'
import { registerVisionToolHandlers } from './agentVisionToolHandlers'

function context(workspaceRoot: string) {
  return {
    runId: 'run-1',
    conversationId: 'conversation-1',
    workspaceRoot,
    signal: new AbortController().signal
  }
}

describe('agent vision tools', () => {
  it('returns project images as typed model media', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sidekick-vision-'))
    await writeFile(join(root, 'pixel.png'), Buffer.from('89504e470d0a1a0a', 'hex'))
    const registry = new AgentToolHandlerRegistry()
    registerVisionToolHandlers(registry)
    const result = await registry.execute({
      name: 'view_image',
      title: 'View pixel.png',
      arguments: { path: 'pixel.png' },
      context: context(root)
    })
    expect(result.status).toBe('success')
    expect(result.media?.[0]).toMatchObject({
      type: 'image',
      mimeType: 'image/png',
      source: { type: 'file', path: join(root, 'pixel.png') }
    })
  })

  it('rejects paths outside the active project', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sidekick-vision-scope-'))
    const registry = new AgentToolHandlerRegistry()
    registerVisionToolHandlers(registry)
    const result = await registry.execute({
      name: 'view_image',
      title: 'View outside',
      arguments: { path: '../outside.png' },
      context: context(root)
    })
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('workspace_scope')
  })
})
