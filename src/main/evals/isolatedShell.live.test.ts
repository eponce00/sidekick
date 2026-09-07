import { expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentScenarioHarness } from './agentScenarioHarness'
import { openAICompatibleHeaders } from '../providers/openAICompatibleClient'

it.skipIf(process.env.SIDEKICK_DOCKER_AGENT_EVAL_RUN !== '1')(
  'real model completes a verified file task through the isolated shell and production kernel',
  async () => {
    const key = process.env.SIDEKICK_AGENT_EVAL_API_KEY || ''
    expect(Boolean(key)).toBe(true)
    const root = await mkdtemp(join(tmpdir(), 'sidekick-isolated-agent-'))
    const workspaceRoot = join(root, 'project')
    await mkdir(workspaceRoot)
    const harness = new AgentScenarioHarness(join(root, 'runtime'), {
      endpoint: process.env.SIDEKICK_AGENT_EVAL_URL || 'http://127.0.0.1:8000/v1',
      model: process.env.SIDEKICK_AGENT_EVAL_MODEL || 'local-loaded-model',
      headers: openAICompatibleHeaders(key),
      shellIsolation: true,
      maxOutputTokens: 2048
    })
    try {
      await harness.initialize()
      const result = await harness.run({
        workspaceRoot,
        capabilities: ['command.execute'],
        maxToolRounds: 8,
        messages: [
          {
            role: 'system',
            content:
              'Shell commands execute in an isolated Linux /bin/sh container. Node is installed, the writable project is /workspace, and networking is disabled. Use project-relative paths and POSIX syntax. Do not request background commands. Complete and verify the task using the shell tool.'
          },
          {
            role: 'user',
            content:
              'Create result.txt containing exactly sandboxed followed by a newline. In the same command, assert Node process.platform is linux and read the file back to verify its exact bytes. Do not modify any other file. Then reply DONE.'
          }
        ]
      })
      expect(result.phase, 'Kernel must finish successfully').toBe('completed')
      expect(result.toolNames).toContain('shell')
      expect(await readFile(join(workspaceRoot, 'result.txt'), 'utf8')).toBe('sandboxed\n')
      expect(
        result.events.some(
          (event) =>
            event.type === 'tool.completed' &&
            (event.payload.result as { status?: string })?.status === 'success'
        )
      ).toBe(true)
    } finally {
      await harness.close()
      await rm(root, { recursive: true, force: true })
    }
  },
  180000
)
