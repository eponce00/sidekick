import { describe, expect, it } from 'vitest'
import {
  editingDialectCandidatesForModel,
  editingDialectForModel,
  verifiedEditingDialectFallbacks,
  workspaceMutationRequestFromTool,
  workspaceMutationResultForModel
} from './workspaceMutations'

describe('model-aware editing dialects', () => {
  it.each([
    [{ providerKind: 'openrouter' as const, model: 'openai/gpt-5.4' }, 'apply-patch'],
    [{ providerKind: 'litellm' as const, model: 'gpt-4.1' }, 'apply-patch'],
    [{ providerKind: 'litellm' as const, model: 'codex-mini-latest' }, 'apply-patch'],
    [{ providerKind: 'anthropic' as const, model: 'claude-sonnet-5' }, 'claude-edit'],
    [{ providerKind: 'openrouter' as const, model: 'x-ai/grok-5' }, 'search-replace'],
    [{ providerKind: 'openrouter' as const, model: 'qwen/qwen3-coder' }, 'structured-edit']
  ])('routes $0 to $1', (target, expected) => {
    expect(editingDialectForModel(target)).toBe(expected)
  })

  it('honors an explicit editing contract for provider aliases', () => {
    expect(
      editingDialectForModel({
        providerKind: 'litellm',
        model: 'local-loaded-model',
        dialect: 'apply-patch'
      })
    ).toBe('apply-patch')
  })

  it('uses a gateway-resolved model identity before falling back to an opaque alias', () => {
    expect(
      editingDialectForModel({
        providerKind: 'litellm',
        model: 'local-loaded-model',
        upstreamModel: 'openai/gpt-5.4-codex'
      })
    ).toBe('apply-patch')
  })

  it('uses a valid persisted calibration but never overrides a manual contract', () => {
    const calibration = {
      version: 2 as const,
      model: 'local-loaded-model',
      selectedDialect: 'apply-patch' as const,
      verifiedDialects: ['apply-patch' as const],
      results: [],
      calibratedAt: 1,
      source: 'active-probe' as const
    }
    expect(editingDialectForModel({ model: 'local-loaded-model', calibration })).toBe('apply-patch')
    expect(
      editingDialectForModel({
        model: 'local-loaded-model',
        dialect: 'claude-edit',
        calibration
      })
    ).toBe('claude-edit')
  })

  it('orders inferred dialects and restricts fallbacks to verified alternatives', () => {
    expect(editingDialectCandidatesForModel({ model: 'gpt-5.4' })[0]).toBe('apply-patch')
    expect(
      verifiedEditingDialectFallbacks(
        {
          model: 'model-a',
          calibration: {
            version: 2,
            model: 'model-a',
            selectedDialect: 'apply-patch',
            verifiedDialects: ['apply-patch', 'structured-edit'],
            results: [],
            calibratedAt: 1,
            source: 'active-probe'
          }
        },
        'apply-patch'
      )
    ).toEqual(['structured-edit'])
  })

  it('does not let model arguments own the host access decision', () => {
    expect(workspaceMutationRequestFromTool('write', { file_path: 'a.txt', content: 'a' })).toEqual(
      {
        kind: 'write',
        filePath: 'a.txt',
        content: 'a',
        accessLevel: 'auto'
      }
    )
  })

  it('bounds verified mutation details returned to model context', () => {
    const result = workspaceMutationResultForModel(
      {
        ok: true,
        changed: true,
        files: Array.from({ length: 3 }, (_, index) => ({
          path: `${index}.txt`,
          action: 'add' as const,
          additions: 1,
          deletions: 0,
          diff: 'full per-file diff'
        })),
        diff: 'x'.repeat(100),
        additions: 3,
        deletions: 0
      },
      10,
      2
    )

    expect(result).toMatchObject({
      fileCount: 3,
      filesTruncated: true,
      diffTruncated: true,
      diff: 'xxxxxxxxxx'
    })
    expect(result.files).toHaveLength(2)
    expect((result.files as Array<Record<string, unknown>>)[0]).not.toHaveProperty('diff')
  })
})
