import { existsSync, promises as fs } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { serializeAgentScenarioMessages, withIsolatedEvalRoot } from './agentScenarioHarness'

describe('isolated agent evaluation roots', () => {
  it('removes the complete root after a successful scenario', async () => {
    let observedRoot = ''

    await withIsolatedEvalRoot('sidekick-eval-cleanup-success-', async (root) => {
      observedRoot = root
      await fs.mkdir(`${root}/project/nested`, { recursive: true })
      await fs.writeFile(`${root}/project/nested/generated.txt`, 'temporary', 'utf8')
      expect(existsSync(root)).toBe(true)
    })

    expect(existsSync(observedRoot)).toBe(false)
  })

  it('removes the complete root after a failed scenario', async () => {
    let observedRoot = ''

    await expect(
      withIsolatedEvalRoot('sidekick-eval-cleanup-failure-', async (root) => {
        observedRoot = root
        await fs.mkdir(`${root}/runtime/tool-outputs`, { recursive: true })
        await fs.writeFile(`${root}/runtime/tool-outputs/output.txt`, 'temporary', 'utf8')
        throw new Error('seeded evaluation failure')
      })
    ).rejects.toThrow('seeded evaluation failure')

    expect(existsSync(observedRoot)).toBe(false)
  })
})

describe('live scenario provider boundary', () => {
  it('materializes browser and image files before OpenAI-compatible serialization', async () => {
    await withIsolatedEvalRoot('sidekick-eval-media-', async (root) => {
      const path = join(root, 'viewport.png')
      await fs.writeFile(path, Buffer.from('89504e470d0a1a0a', 'hex'))

      const messages = await serializeAgentScenarioMessages({
        target: { providerKind: 'litellm', model: 'local-loaded-model' },
        purpose: 'conversation',
        maxOutputTokens: 128,
        temperature: 0,
        messages: [
          {
            role: 'tool',
            content: 'Browser screenshot captured.',
            tool_call_id: 'browser-1',
            media: [
              {
                type: 'image',
                mimeType: 'image/png',
                source: { type: 'file', path }
              }
            ]
          }
        ]
      })

      expect(JSON.stringify(messages)).toContain('data:image/png;base64,')
    })
  })
})
