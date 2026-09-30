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
    // The model gets the failure, not its own code back.
    expect(result.modelContent).toContain("reading 'current'")
    expect(result.modelContent).not.toContain('xxxx')
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

describe('create_artifact in a chat', () => {
  const image = { mimeType: 'image/jpeg' as const, base64: 'SU1BR0U=', width: 720, height: 300 }
  const first = 'export default function App() { return <div>NaN ft</div> }'
  const fixed = 'export default function App() { return <div>4,505 ft</div> }'

  async function build(options: {
    builder: () => Promise<unknown>
    visionEnabled?: boolean
    firstStatus?: 'rendered' | 'error'
  }) {
    const registry = new AgentToolHandlerRegistry()
    const inspect = vi.fn(async (artifact: { code: string }) => ({
      status: artifact.code === first ? (options.firstStatus ?? 'rendered') : ('rendered' as const),
      errors: [],
      width: 720,
      height: 300,
      image
    }))
    const buildArtifact = vi.fn(options.builder)
    registerSkillToolHandlers(registry, {
      activeSkillIds: new Set(['web-artifacts']),
      readReceipts: new Map(),
      childLauncher: () => ({ launch: vi.fn(), buildArtifact }) as never,
      artifactInspector: () => ({ inspect }) as never,
      visionEnabled: options.visionEnabled ?? true,
      buildArtifacts: true
    })
    const result = await registry.execute({
      name: 'create_artifact',
      title: 'Create artifact',
      arguments: { type: 'react', title: 'Elevations', code: first },
      context: { runId: 'chat-run', signal: new AbortController().signal }
    })
    return { result, inspect, buildArtifact }
  }

  it('returns the builder’s final version, checked, and the code later changes start from', async () => {
    const { result, inspect, buildArtifact } = await build({
      builder: async () => ({
        childRunId: 'builder-1',
        artifact: { type: 'react', title: 'Elevations', code: fixed },
        versions: 2,
        status: 'completed'
      })
    })

    // The builder starts from the agent's version and how it rendered.
    expect(buildArtifact).toHaveBeenCalledWith(
      {
        artifact: { type: 'react', title: 'Elevations', code: first },
        review: expect.objectContaining({ status: 'success' })
      },
      expect.objectContaining({ runId: 'chat-run' })
    )
    // The final version is rendered again, so what the agent is told is true of it.
    expect(inspect).toHaveBeenLastCalledWith(
      { type: 'react', title: 'Elevations', code: fixed },
      expect.any(AbortSignal)
    )
    expect(result.data).toMatchObject({
      artifact: { code: fixed },
      childRunId: 'builder-1',
      versions: 2
    })
    expect(result.modelContent).toContain('made 1 fix before showing it')
    // Reviewed already, so the result does not also ask the agent to fix it.
    expect(result.modelContent).not.toContain('fix it with create_artifact')
    expect(result.modelContent).toContain('do not rebuild it to polish it')
    expect(result.modelContent).toContain(fixed)
  })

  it('keeps the agent’s version when the builder fails', async () => {
    const { result } = await build({
      builder: async () => {
        throw new Error('model offline')
      }
    })

    expect(result.status).toBe('success')
    expect(result.data).toMatchObject({ artifact: { code: first } })
    expect(result.data).not.toHaveProperty('childRunId')
  })

  it('skips the builder when there is nothing it could judge', async () => {
    // Rendered cleanly, and no screenshot for a model that cannot see images.
    const { buildArtifact } = await build({
      builder: async () => ({}),
      visionEnabled: false
    })
    expect(buildArtifact).not.toHaveBeenCalled()

    // A failure is worth fixing even without a screenshot.
    const failing = await build({
      builder: async () => ({
        childRunId: 'builder-2',
        artifact: { type: 'react', title: 'Elevations', code: fixed },
        versions: 2,
        status: 'completed'
      }),
      visionEnabled: false,
      firstStatus: 'error'
    })
    expect(failing.buildArtifact).toHaveBeenCalledOnce()
    expect(failing.result.status).toBe('success')
  })
})

it('says loading a skill makes its tool ready, without telling the model to reload it later', async () => {
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

  const artifacts = (await load('web-artifacts')).modelContent
  expect(artifacts).toContain('create_artifact is ready to use in this run')
  expect(artifacts).not.toContain('load it again')
  expect((await load('pdf')).modelContent).not.toContain('is ready to use')
})

describe('create_artifact before its skill is loaded', () => {
  const inspection: ArtifactInspection = {
    status: 'rendered',
    errors: [],
    width: 720,
    height: 300
  }

  async function create(artifactContinuation: boolean) {
    const registry = new AgentToolHandlerRegistry()
    const activeSkillIds = new Set<string>()
    const inspect = vi.fn(async () => inspection)
    registerSkillToolHandlers(registry, {
      activeSkillIds,
      readReceipts: new Map(),
      childLauncher: () => undefined,
      artifactInspector: () => ({ inspect }),
      artifactContinuation
    })
    const result = await registry.execute({
      name: 'create_artifact',
      title: 'Create artifact',
      arguments: { type: 'react', title: 'Card', code: 'export default function App() {}' },
      context: { runId: 'artifact-test', signal: new AbortController().signal }
    })
    return { result, inspect, activeSkillIds }
  }

  it('renders it and returns the guidance it was written without', async () => {
    // Refusing it threw away the code the model had just written.
    const { result, inspect, activeSkillIds } = await create(false)

    expect(inspect).toHaveBeenCalled()
    expect(result.status).toBe('success')
    expect(result.modelContent).toContain('made before the web-artifacts guidance was loaded')
    expect(result.modelContent).toContain('Web Artifacts Builder')
    expect(activeSkillIds.has('web-artifacts')).toBe(true)
  })

  it("does not repeat the guidance when changing the previous reply's artifact", async () => {
    const { result } = await create(true)

    expect(result.status).toBe('success')
    expect(result.modelContent).not.toContain('Web Artifacts Builder')
  })
})
