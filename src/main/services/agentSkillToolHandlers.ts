import {
  toolExecutionFailed,
  toolExecutionSucceeded,
  type ToolExecutionResult
} from '../../shared/agentRuntime'
import type { InspectedArtifactType } from '../../shared/artifactInspection'
import { skillToolNames } from '../../shared/agentToolCatalog'
import { getSkillById, getSkillRuntimeGuidance } from '../../shared/skills'
import type { AgentChildRunLauncher } from './agentToolRuntime'
import type { AgentToolHandlerRegistry } from './agentToolHandlerRegistry'
import type { ArtifactInspection, ArtifactInspectorLike } from './artifactInspector'

/**
 * What the model learns from creating an artifact: whether it ran, what went
 * wrong, and, when the model can see images, what it looks like. The code the
 * model just wrote is not echoed back; that only spent context.
 */
export function artifactToolResult(
  title: string,
  artifact: { type: InspectedArtifactType; title: string; code: string },
  inspection: ArtifactInspection | undefined,
  visionEnabled: boolean
): ToolExecutionResult {
  const name = `Artifact "${artifact.title || 'Untitled'}"`
  const data = {
    artifact,
    ...(inspection ? { inspection: { status: inspection.status, errors: inspection.errors } } : {})
  }
  if (!inspection) {
    return toolExecutionSucceeded({
      title,
      data,
      modelContent: `${name} was added to the chat. It could not be rendered for inspection, so whether it works and how it looks are unverified; do not describe them as checked.`
    })
  }
  const media =
    visionEnabled && inspection.image
      ? [
          {
            type: 'image' as const,
            mimeType: inspection.image.mimeType,
            name: 'artifact-preview.jpg',
            description: `${name} as rendered in the chat`,
            source: {
              type: 'data_url' as const,
              dataUrl: `data:${inspection.image.mimeType};base64,${inspection.image.base64}`
            }
          }
        ]
      : undefined
  const look = media
    ? 'A screenshot of it as the user sees it is attached. Check it shows what was asked for, including any data it loads; if it is blank, broken, or wrong, fix it with create_artifact.'
    : 'No screenshot was attached because this model does not take images, so how it looks is unverified.'
  if (inspection.status === 'rendered') {
    return toolExecutionSucceeded({
      title,
      data,
      media,
      modelContent: `${name} rendered in the chat without errors. ${look}`
    })
  }
  const problem =
    inspection.status === 'timeout'
      ? `${name} did not finish rendering in the chat within 20 seconds.`
      : `${name} failed when rendered in the chat.`
  const errors = inspection.errors.length
    ? `\nErrors:\n${inspection.errors.map((error) => `- ${error}`).join('\n')}`
    : ''
  return toolExecutionFailed({
    title,
    code: 'command_failed',
    message: `${problem}${errors}`,
    retryable: true,
    recoveryAction: 'change_strategy',
    recovery:
      `Fix the code and call create_artifact again. ${media ? 'A screenshot of the failure is attached.' : ''}`.trim(),
    data,
    media
  })
}

export function registerSkillToolHandlers(
  registry: AgentToolHandlerRegistry,
  options: {
    activeSkillIds: Set<string>
    readReceipts: Map<string, string>
    childLauncher: () => AgentChildRunLauncher | undefined
    officeHelpersAvailable?: () => boolean
    artifactInspector?: () => ArtifactInspectorLike | undefined
    /** Whether the run's model accepts images, so a screenshot is worth sending. */
    visionEnabled?: boolean
  }
): void {
  registry.register('use_skill', async ({ title, arguments: args }) => {
    const skillId = String(args.skill_id || '')
    const skill = getSkillById(skillId)
    if (!skill || skill.invocation === 'manual') {
      return toolExecutionFailed({
        title,
        code: 'not_found',
        message: `Skill is not available: ${skillId}`
      })
    }
    options.activeSkillIds.add(skill.id)
    return toolExecutionSucceeded({
      title,
      data: {
        id: skill.id,
        name: skill.name,
        dependencies: {
          status: 'not_checked',
          python: skill.requiresPythonPackages ?? [],
          node: skill.requiresNodePackages ?? []
        }
      },
      modelContent:
        // Say what loading changed: the model otherwise treated a reload as
        // instructions only and never looked for the tool it had just gained.
        (skillToolNames(skill.id).length
          ? `Loaded. ${skillToolNames(skill.id).join(', ')} is now available for the rest of this run; skills load per run, so load it again in a later turn that needs it.\n`
          : '') +
        `<skill_instructions id="${skill.id}" trust="trusted-skill-instructions">\n` +
        `${getSkillRuntimeGuidance(skill)}\n${skill.systemPromptInjection}\n` +
        (options.officeHelpersAvailable?.() && ['docx', 'xlsx', 'pptx'].includes(skill.id)
          ? 'Direct Office tools are configured for this host run. Prefer advertised office_preflight for supported dependency checks and office_validate for structural validation instead of invoking those helpers through shell. They do not install dependencies or prove semantic/rendering correctness. Other creation/edit helpers still use the skill workflows.\n'
          : '') +
        '</skill_instructions>'
    })
  })

  registry.register('create_artifact', async ({ title, arguments: args, context }) => {
    if (!options.activeSkillIds.has('web-artifacts')) {
      return toolExecutionFailed({
        title,
        code: 'permission_denied',
        message: 'Load the web-artifacts skill before creating an inline artifact'
      })
    }
    const type = args.type === 'html' || args.type === 'svg' ? args.type : 'react'
    const artifact = {
      type: type as InspectedArtifactType,
      title: typeof args.title === 'string' ? args.title : '',
      code: typeof args.code === 'string' ? args.code : ''
    }
    const inspector = options.artifactInspector?.()
    const inspection = inspector
      ? await inspector.inspect(artifact, context.signal).catch((error) => {
          context.signal?.throwIfAborted()
          console.warn('[create_artifact] Inspection failed:', error)
          return undefined
        })
      : undefined
    return artifactToolResult(title, artifact, inspection, options.visionEnabled === true)
  })

  registry.register('spawn_subagent', async ({ title, arguments: args, context }) => {
    const launcher = options.childLauncher()
    if (!launcher) {
      return toolExecutionFailed({
        title,
        code: 'unsupported',
        message: 'Child-agent execution is not configured'
      })
    }
    options.readReceipts.clear()
    const data = await launcher.launch(
      String(args.task || ''),
      typeof args.context === 'string' && args.context ? args.context : undefined,
      context
    )
    return toolExecutionSucceeded({ title, data })
  })
}
