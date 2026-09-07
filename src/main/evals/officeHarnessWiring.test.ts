import { createServer } from 'node:http'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { AgentScenarioHarness } from './agentScenarioHarness'
import { summarizeOfficeErrors, type OfficeToolTrace } from './officeAgentScenarios'

it.each(['available', 'missing'] as const)(
  'checks %s helpers through the real kernel without fallback installs',
  async (availability) => {
    const root = await fs.mkdtemp(join(tmpdir(), 'sidekick-office-wiring-'))
    const helpers =
      availability === 'available' ? resolve('resources/skills') : join(root, 'missing-helpers')
    const source = join(root, 'source.xlsx')
    // Opaque sentinel: this refusal case must never open or rewrite its input.
    const original = Buffer.from('synthetic unopened input sentinel')
    await fs.writeFile(source, original)
    let turn = 0
    const server = createServer((request, response) => {
      request.resume()
      request.on('end', () => {
        const calls = [
          { name: 'use_skill', arguments: JSON.stringify({ skill_id: 'xlsx' }) },
          {
            name: 'shell',
            arguments: JSON.stringify({
              command:
                availability === 'missing'
                  ? process.platform === 'win32'
                    ? "Get-Item -LiteralPath (Join-Path $env:SIDEKICK_SKILLS 'preflight.py') -ErrorAction Stop"
                    : 'test -f "$SIDEKICK_SKILLS/preflight.py"'
                  : process.platform === 'win32'
                    ? 'Write-Output $env:SIDEKICK_SKILLS'
                    : 'printf "%s" "$SIDEKICK_SKILLS"'
            })
          }
        ]
        const call = calls[turn++]
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        response.end(
          `data: ${JSON.stringify({ choices: [{ delta: call ? { tool_calls: [{ index: 0, id: `fixture-${turn}`, type: 'function', function: call }] } : { content: availability === 'missing' ? 'Blocked: bundled helper unavailable. No fallback or package installation attempted; source unchanged.' : 'DONE' }, finish_reason: call ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`
        )
      })
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const address = server.address() as { port: number }
    const harness = new AgentScenarioHarness(join(root, 'runtime'), {
      endpoint: `http://127.0.0.1:${address.port}/v1/chat/completions`,
      model: 'scripted-no-inference',
      headers: {},
      skillAssetsPath: helpers
    })
    const results: Array<{ name: string; result: unknown }> = []
    try {
      await harness.initialize()
      const result = await harness.run({
        workspaceRoot: root,
        capabilities: ['skills', 'command.execute'],
        messages: [
          {
            role: 'user',
            content:
              availability === 'missing'
                ? 'Edit source.xlsx using the bundled helper workflow. If helpers are unavailable, stop and report the blocker; do not substitute engines, install dependencies, or modify the source.'
                : 'Synthetic environment wiring check'
          }
        ],
        maxToolRounds: 4,
        afterToolExecution: async (name, _args, result) => {
          results.push({ name, result })
        }
      })
      expect(result.phase).toBe('completed')
      expect(results.map((entry) => entry.name)).toEqual(['use_skill', 'shell'])
      if (availability === 'available')
        expect(results[1].result).toMatchObject({
          status: 'success',
          data: { exitCode: 0, stdout: expect.stringContaining(helpers) }
        })
      else {
        expect(results[1].result).toMatchObject({
          status: 'error',
          error: { code: 'command_failed' }
        })
        expect(result.content || result.finalResponse).toContain(
          'Blocked: bundled helper unavailable'
        )
        const failure = results[1].result as {
          status: string
          error: { code: string; recoveryAction: string }
        }
        const trace: OfficeToolTrace[] = [
          {
            name: 'shell',
            arguments: {},
            status: failure.status,
            errorCode: failure.error.code,
            recoveryAction: failure.error.recoveryAction
          }
        ]
        expect(summarizeOfficeErrors(trace)[0]).toMatchObject({
          code: 'command_failed',
          provenance: 'tool_execution_result',
          laterSameToolSucceeded: false
        })
        expect(await fs.readFile(source)).toEqual(original)
        expect(await fs.readdir(root)).not.toContain('updated.xlsx')
        // Exactly the skill and read-only helper check executed: no fallback or installer call.
        expect(results).toHaveLength(2)
      }
    } finally {
      await harness.close()
      await new Promise<void>((done) => server.close(() => done()))
      await fs.rm(root, { recursive: true, force: true })
    }
  },
  30_000
)
