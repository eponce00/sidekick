import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ToolExecutionResult } from '../../shared/agentRuntime'
import { registerCoreToolHandlers } from './agentCoreToolHandlers'
import type { AgentToolHandler, AgentToolHandlerRegistry } from './agentToolHandlerRegistry'
import type { AgentToolExecutionContext } from './agentToolRegistry'
import { ToolOutputStore } from './toolOutputStore'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function toolOutput(): Promise<{
  outputs: ToolOutputStore
  call: (args: Record<string, unknown>) => Promise<ToolExecutionResult>
}> {
  const root = await fs.mkdtemp(join(tmpdir(), 'sidekick-core-tools-'))
  roots.push(root)
  const outputs = new ToolOutputStore(root)
  let handler: AgentToolHandler | undefined
  registerCoreToolHandlers(
    {
      register: (_name: string, registered: AgentToolHandler) => {
        handler = registered
        return () => undefined
      }
    } as unknown as AgentToolHandlerRegistry,
    outputs
  )
  return {
    outputs,
    call: (args) =>
      handler!({
        name: 'tool_output',
        title: 'Tool output',
        arguments: args,
        context: {} as AgentToolExecutionContext
      })
  }
}

describe('tool_output', () => {
  it('finds text in a kept result instead of reading a range', async () => {
    const { outputs, call } = await toolOutput()
    const json = JSON.stringify({
      fields: Array.from({ length: 2_000 }, (_, index) => ({ id: `control-${index}` })),
      editorToken: 'token-123'
    })
    const handle = await outputs.save(json)

    const found = await call({ handle, find: 'editorToken' })
    const offset = Buffer.byteLength(json.slice(0, json.indexOf('editorToken')))
    expect(found.modelContent).toBe(
      `[tool_output: 1 match for "editorToken" in ${Buffer.byteLength(json).toLocaleString('en-US')} bytes. Read on from a match with its offset.]\n` +
        `offset ${offset}: …${json.slice(json.indexOf('editorToken') - 120)}`
    )

    const none = await call({ handle, find: 'missing' })
    expect(none.modelContent).toMatch(
      /^\[tool_output: 0 matches for "missing" in [\d,]+ bytes\.\]$/
    )

    const many = await call({ handle, find: 'control-1' })
    expect(many.modelContent).toContain('1,111 matches for "control-1"')
    expect(many.modelContent).toContain('the first 20 are shown')
    expect(many.modelContent!.split('\n')).toHaveLength(21)
  })

  it('refuses text too long to look for, and reads a range when there is none', async () => {
    const { outputs, call } = await toolOutput()
    const handle = await outputs.save('kept output')
    expect((await call({ handle, find: 'x'.repeat(201) })).error).toMatchObject({
      code: 'invalid_arguments',
      recoveryAction: 'correct_input'
    })
    expect((await call({ handle, find: '  ' })).modelContent).toBe(
      'kept output\n[tool_output: bytes 0–11 of 11. This is the end of the stored output.]'
    )
  })
})
