import { describe, expect, it, vi } from 'vitest'
import type {
  ProviderChatRequest,
  ProviderCompletionResult,
  ProviderTarget
} from '../../shared/providerRuntime'
import type { EditingContractCalibration } from '../../shared/workspaceMutations'
import { EditingCompatibilityService } from './editingCompatibilityService'

const target: ProviderTarget = {
  providerInstanceId: 'gateway',
  providerKind: 'litellm',
  model: 'local-loaded-model',
  contextLength: 180_000,
  maxOutputTokens: 32_000,
  editingDialect: 'auto'
}

const writtenComponent = `export function CalibrationCard() {
  return (
    <article data-sidekick="calibration-card">
      <h2>Editing compatibility</h2>
      <p>
        This deterministic component verifies that the model can provide complete file content
        through the active SideKick editing contract without truncating required arguments.
      </p>
    </article>
  )
}
`

function successfulToolCompletion(request: ProviderChatRequest): ProviderCompletionResult {
  const definition = request.tools?.[0] as { function: { name: string } }
  const name = definition.function.name
  const writing = request.messages.at(-1)?.content?.includes('Create src/components') === true
  const multiReplace =
    request.messages.at(-1)?.content?.includes('Replace every occurrence') === true
  const argumentsByTool: Record<string, Record<string, unknown>> = writing
    ? {
        apply_patch: {
          patch: `*** Begin Patch\n*** Add File: src/components/CalibrationCard.tsx\n${writtenComponent
            .split('\n')
            .map((line) => `+${line}`)
            .join('\n')}\n*** End Patch`,
          accessLevel: 'auto'
        },
        Write: {
          file_path: 'src/components/CalibrationCard.tsx',
          content: writtenComponent,
          accessLevel: 'auto'
        },
        write: {
          file_path: 'src/components/CalibrationCard.tsx',
          content: writtenComponent,
          accessLevel: 'auto'
        }
      }
    : multiReplace
      ? {
          apply_patch: {
            patch:
              '*** Begin Patch\n*** Update File: src/styles/components.css\n@@\n .report-link {\n-  color: var(--legacy-accent);\n+  color: var(--accent);\n }\n \n .report-badge {\n-  color: var(--legacy-accent);\n+  color: var(--accent);\n }\n*** End Patch',
            accessLevel: 'auto'
          },
          Edit: {
            file_path: 'src/styles/components.css',
            old_string: 'color: var(--legacy-accent);',
            new_string: 'color: var(--accent);',
            replace_all: true,
            accessLevel: 'auto'
          },
          search_replace: {
            file_path: 'src/styles/components.css',
            old_string: 'color: var(--legacy-accent);',
            new_string: 'color: var(--accent);',
            replace_all: true,
            accessLevel: 'auto'
          },
          edit: {
            file_path: 'src/styles/components.css',
            old_string: 'color: var(--legacy-accent);',
            new_string: 'color: var(--accent);',
            replace_all: true,
            accessLevel: 'auto'
          }
        }
      : {
          apply_patch: {
            patch:
              '*** Begin Patch\n*** Update File: src/styles/theme.css\n@@\n-  --surface: #0f1115;\n+  --surface: #ffffff;\n*** End Patch',
            accessLevel: 'auto'
          },
          Edit: {
            file_path: 'src/styles/theme.css',
            old_string: '  --surface: #0f1115;',
            new_string: '  --surface: #ffffff;',
            replace_all: false,
            accessLevel: 'auto'
          },
          search_replace: {
            file_path: 'src/styles/theme.css',
            old_string: '  --surface: #0f1115;',
            new_string: '  --surface: #ffffff;',
            replace_all: false,
            accessLevel: 'auto'
          },
          edit: {
            file_path: 'src/styles/theme.css',
            old_string: '  --surface: #0f1115;',
            new_string: '  --surface: #ffffff;',
            replace_all: false,
            accessLevel: 'auto'
          }
        }
  return {
    ok: true,
    data: {
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: `call-${name}`,
            function: { name, arguments: argumentsByTool[name] }
          }
        ]
      },
      promptTokens: 8_000,
      completionTokens: 300,
      reasoningTokens: 0,
      finishReason: 'tool_calls'
    }
  }
}

describe('EditingCompatibilityService', () => {
  it('runs long-context unique edit, multi-replace, and write probes for every dialect', async () => {
    let persisted: EditingContractCalibration | undefined
    const complete = vi.fn(async (request: ProviderChatRequest) =>
      successfulToolCompletion(request)
    )
    const service = new EditingCompatibilityService({
      complete,
      resolveTarget: () => target,
      persist: (_target, calibration) => {
        persisted = calibration
      }
    })

    const result = await service.calibrate({
      providerInstanceId: 'gateway',
      model: 'local-loaded-model'
    })

    expect(result.ok).toBe(true)
    expect(result.results).toHaveLength(4)
    expect(result.results?.every(({ passed, probes }) => passed && probes.length === 3)).toBe(true)
    expect(complete).toHaveBeenCalledTimes(12)
    expect(
      complete.mock.calls.every(
        ([request]) => (request.messages.at(-1)?.content?.length || 0) > 28_000
      )
    ).toBe(true)
    expect(persisted).toMatchObject({
      model: 'local-loaded-model',
      selectedDialect: 'structured-edit',
      verifiedDialects: ['structured-edit', 'apply-patch', 'claude-edit', 'search-replace']
    })
  })

  it('tests and promotes the first verified alternative after production schema failures', async () => {
    let persisted: EditingContractCalibration | undefined
    const complete = vi.fn(async (request: ProviderChatRequest) =>
      successfulToolCompletion(request)
    )
    const service = new EditingCompatibilityService({
      complete,
      resolveTarget: () => target,
      persist: (_target, calibration) => {
        persisted = calibration
      }
    })

    const result = await service.recover(target, 'structured-edit')

    expect(result).toMatchObject({
      switched: true,
      from: 'structured-edit',
      to: 'apply-patch'
    })
    expect(complete).toHaveBeenCalledTimes(3)
    expect(persisted?.selectedDialect).toBe('apply-patch')
    expect(persisted?.verifiedDialects).toContain('apply-patch')
  })

  it('rejects an exact-edit dialect that cannot express explicit replacement scope', async () => {
    const complete = vi.fn(async (request: ProviderChatRequest) => {
      const result = successfulToolCompletion(request)
      const call = result.data?.message.tool_calls?.[0]
      if (call?.function.name === 'edit' && call.function.arguments) {
        delete (call.function.arguments as Record<string, unknown>).replace_all
      }
      return result
    })
    const service = new EditingCompatibilityService({
      complete,
      resolveTarget: () => target,
      persist: vi.fn()
    })

    const result = await service.calibrate({
      providerInstanceId: 'gateway',
      model: 'local-loaded-model'
    })

    expect(result.ok).toBe(true)
    expect(result.calibration?.selectedDialect).toBe('apply-patch')
    expect(result.calibration?.verifiedDialects).not.toContain('structured-edit')
    expect(
      result.results?.find(({ dialect }) => dialect === 'structured-edit')?.probes[0].error
    ).toContain('replace_all is required')
  })

  it('uses an already verified fallback without spending another provider request', async () => {
    const calibration: EditingContractCalibration = {
      version: 2,
      model: target.model,
      selectedDialect: 'structured-edit',
      verifiedDialects: ['structured-edit', 'apply-patch'],
      results: [],
      calibratedAt: 1,
      source: 'active-probe'
    }
    const complete = vi.fn(async (request: ProviderChatRequest) =>
      successfulToolCompletion(request)
    )
    const service = new EditingCompatibilityService({
      complete,
      resolveTarget: () => ({ ...target, editingCalibration: calibration }),
      persist: vi.fn()
    })

    const result = await service.recover(
      { ...target, editingCalibration: calibration },
      'structured-edit'
    )

    expect(result).toMatchObject({ switched: true, to: 'apply-patch' })
    expect(complete).not.toHaveBeenCalled()
  })
})
