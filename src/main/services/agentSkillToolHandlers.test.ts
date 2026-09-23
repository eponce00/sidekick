import { describe, expect, it, vi } from 'vitest'
import { AgentToolHandlerRegistry } from './agentToolHandlerRegistry'
import { registerSkillToolHandlers } from './agentSkillToolHandlers'
import type { ArtifactInspection } from './artifactInspector'

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

describe('create_artifact', () => {
  const code = `export default function App() { return <div>${'x'.repeat(4_000)}</div> }`
  const image = { mimeType: 'image/jpeg' as const, base64: 'SU1BR0U=', width: 720, height: 300 }

  async function createArtifact(options: {
    inspection?: ArtifactInspection
    inspectorFails?: boolean
    visionEnabled?: boolean
    withInspector?: boolean
  }) {
    const registry = new AgentToolHandlerRegistry()
    const inspect = vi.fn(async () => {
      if (options.inspectorFails) throw new Error('window failed')
      return options.inspection!
    })
    registerSkillToolHandlers(registry, {
      activeSkillIds: new Set(['web-artifacts']),
      readReceipts: new Map(),
      childLauncher: () => undefined,
      artifactInspector: () => (options.withInspector === false ? undefined : { inspect }),
      visionEnabled: options.visionEnabled ?? true
    })
    const result = await registry.execute({
      name: 'create_artifact',
      title: 'Create artifact',
      arguments: { type: 'react', title: 'Clima en Reno', code },
      context: { runId: 'artifact-test', signal: new AbortController().signal }
    })
    return { result, inspect }
  }

  it('shows the model what it made instead of echoing its own code back', async () => {
    // The result used to repeat all of the model's code and say nothing about
    // whether it ran, so the model could only guess at what the user saw.
    const { result, inspect } = await createArtifact({
      inspection: { status: 'rendered', errors: [], width: 720, height: 300, image }
    })

    expect(inspect).toHaveBeenCalledWith(
      { type: 'react', title: 'Clima en Reno', code },
      expect.any(AbortSignal)
    )
    expect(result.status).toBe('success')
    expect(result.modelContent).toContain('rendered in the chat without errors')
    expect(result.modelContent).toContain('screenshot')
    expect(result.modelContent).not.toContain('xxxx')
    expect(result.media).toEqual([
      expect.objectContaining({
        type: 'image',
        mimeType: 'image/jpeg',
        source: { type: 'data_url', dataUrl: 'data:image/jpeg;base64,SU1BR0U=' }
      })
    ])
    // The chat still gets the artifact to display.
    expect(result.data).toMatchObject({ artifact: { title: 'Clima en Reno', code } })
  })

  it('reports a runtime failure as a failed call with the error the user sees', async () => {
    const { result } = await createArtifact({
      inspection: {
        status: 'error',
        errors: ["Cannot read properties of undefined (reading 'current')"],
        width: 720,
        height: 200,
        image
      }
    })

    expect(result.status).toBe('error')
    expect(result.error?.message).toContain("reading 'current'")
    expect(result.error?.recovery).toContain('call create_artifact again')
    expect(result.data).toMatchObject({ artifact: { title: 'Clima en Reno' } })
  })

  it('says when the artifact is taller than the chat frame the user scrolls', async () => {
    // Capturing only the frame hid the controls below it, and the model could
    // not tell whether they were broken or merely out of view.
    const { result } = await createArtifact({
      inspection: {
        status: 'rendered',
        errors: [],
        width: 720,
        height: 1_100,
        chatFrameHeight: 560,
        image
      }
    })

    expect(result.modelContent).toContain("taller than the chat's 560px artifact frame")
    expect(result.modelContent).toContain('The screenshot shows all of it.')
  })

  it('does not send a screenshot to a model that cannot see images', async () => {
    const { result } = await createArtifact({
      inspection: { status: 'rendered', errors: [], width: 720, height: 300, image },
      visionEnabled: false
    })

    expect(result.media).toBeUndefined()
    expect(result.modelContent).toContain('how it looks is unverified')
  })

  it('says the render is unverified when it could not be inspected', async () => {
    const withoutInspector = await createArtifact({ withInspector: false })
    const brokenInspector = await createArtifact({ inspectorFails: true })

    for (const { result } of [withoutInspector, brokenInspector]) {
      expect(result.status).toBe('success')
      expect(result.modelContent).toContain('do not describe them as checked')
    }
  })
})

it('says loading a skill adds its tool for the rest of the run, and only for that run', async () => {
  // Treating a reload as "instructions only", the model never looked for the
  // tool it would have regained.
  const registry = new AgentToolHandlerRegistry()
  registerSkillToolHandlers(registry, {
    activeSkillIds: new Set<string>(),
    readReceipts: new Map(),
    childLauncher: () => undefined
  })
  const load = (skillId: string) =>
    registry.execute({
      name: 'use_skill',
      title: 'Load skill',
      arguments: { skill_id: skillId },
      context: { runId: 'skill-test', signal: new AbortController().signal }
    })

  expect((await load('web-artifacts')).modelContent).toContain(
    'create_artifact is now available for the rest of this run'
  )
  expect((await load('pdf')).modelContent).not.toContain('is now available')
})
