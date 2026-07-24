import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import helpers from './agent-eval-env.cjs'

const { loadAgentEvalEnvironment, parseLocalEnvironment, resolveAgentEvalEnvironment } = helpers
const temporaryRoots = []

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe('agent evaluation environment', () => {
  it('loads an ignored local file without overriding the invoking process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sidekick-agent-eval-env-'))
    temporaryRoots.push(root)
    const path = join(root, '.env.agent-eval.local')
    await writeFile(
      path,
      [
        'SIDEKICK_LLM_EVAL_API_KEY=file-key',
        'SIDEKICK_LLM_EVAL_MODEL=file-model',
        'export SIDEKICK_AGENT_EVAL_SUITE="quick"'
      ].join('\n'),
      'utf8'
    )
    await chmod(path, 0o600)
    const env = { SIDEKICK_LLM_EVAL_MODEL: 'process-model' }

    const loaded = loadAgentEvalEnvironment({ env, path })

    expect(loaded).toMatchObject({ loaded: true, permissionsTooOpen: false })
    expect(env).toEqual({
      SIDEKICK_LLM_EVAL_API_KEY: 'file-key',
      SIDEKICK_LLM_EVAL_MODEL: 'process-model',
      SIDEKICK_AGENT_EVAL_SUITE: 'quick'
    })
  })

  it('resolves provider-specific credentials and preserves the generic override', () => {
    expect(
      resolveAgentEvalEnvironment({
        SIDEKICK_LLM_EVAL_API_KEY: 'local-key',
        SIDEKICK_LLM_EVAL_MODEL: 'local-model'
      })
    ).toMatchObject({
      apiKey: 'local-key',
      credentialSource: 'SIDEKICK_LLM_EVAL_API_KEY',
      providerKind: 'litellm',
      model: 'local-model'
    })
    expect(
      resolveAgentEvalEnvironment({ SIDEKICK_OPENROUTER_EVAL_API_KEY: 'router-key' })
    ).toMatchObject({
      apiKey: 'router-key',
      credentialSource: 'SIDEKICK_OPENROUTER_EVAL_API_KEY',
      providerKind: 'openrouter',
      url: 'https://openrouter.ai/api/v1'
    })
    expect(
      resolveAgentEvalEnvironment({
        SIDEKICK_AGENT_EVAL_API_KEY: 'one-run-key',
        SIDEKICK_LLM_EVAL_API_KEY: 'local-key'
      })
    ).toMatchObject({
      apiKey: 'one-run-key',
      credentialSource: 'SIDEKICK_AGENT_EVAL_API_KEY'
    })
  })

  it('rejects malformed and unrelated variables instead of silently ignoring typos', () => {
    expect(() => parseLocalEnvironment('SIDEKICK_LLM_EVAL_API_KEY', 'test.env')).toThrow(
      'NAME=value'
    )
    expect(() => parseLocalEnvironment('PATH=/untrusted', 'test.env')).toThrow(
      'unsupported variable PATH'
    )
  })
})
