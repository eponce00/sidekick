import {
  toolExecutionFailed,
  toolExecutionSucceeded,
  type ToolExecutionResult
} from '../../shared/agentRuntime'
import type { InspectedArtifactType } from '../../shared/artifactInspection'
import { skillToolNames, WEB_ARTIFACTS_SKILL_ID } from '../../shared/agentToolCatalog'
import { getSkillById, getSkillRuntimeGuidance } from '../../shared/skills'
import type { AgentChildRunLauncher, ArtifactBuildResult } from './agentToolRuntime'
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
  visionEnabled: boolean,
  /** A builder has already reviewed and fixed it, so the model is not asked to. */
  reviewed = false
): ToolExecutionResult {
  const name = `Artifact "${artifact.title || 'Untitled'}"`
  const warnings = inspection?.warnings ?? []
  const data = {
    artifact,
    ...(inspection
      ? {
          inspection: {
            status: inspection.status,
            errors: inspection.errors,
            ...(warnings.length ? { warnings } : {})
          }
        }
      : {})
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
    ? reviewed
      ? 'A screenshot of it as the user sees it is attached.'
      : 'A screenshot of it as the user sees it is attached. Check it shows what was asked for, including any data it loads; if it is blank, broken, or wrong, fix it with create_artifact.'
    : 'No screenshot was attached because this model does not take images, so how it looks is unverified.'
  const fold = inspection.chatFrameHeight
    ? ` It is taller than the ${inspection.chatFrameHeight}px an artifact grows to in the chat: the user first sees its top ${inspection.chatFrameHeight}px, scrolls inside it or opens it full screen for the rest.${media ? ' The screenshot shows that top part.' : ''}`
    : ''
  if (inspection.status === 'rendered') {
    // Found in the rendered page itself, so they hold whether or not the model sees images.
    const layout = warnings.length
      ? `\nIts layout has problems the user will see:\n${warnings.map((warning) => `- ${warning}`).join('\n')}${reviewed ? '' : '\nFix them before replying.'}`
      : ''
    return toolExecutionSucceeded({
      title,
      data,
      media,
      modelContent: `${name} rendered in the chat without errors. ${look}${fold}${layout}`
    })
  }
  const problem =
    inspection.status === 'timeout'
      ? `${name} did not finish rendering in the chat within 20 seconds.`
      : `${name} failed when rendered in the chat.`
  const errors = inspection.errors.length
    ? `\nErrors:\n${inspection.errors.map((error) => `- ${error}`).join('\n')}`
    : ''
  const recovery =
    `Fix the code and call create_artifact again with the complete code. ${media ? 'A screenshot of the failure is attached.' : ''}`.trim()
  return toolExecutionFailed({
    title,
    code: 'command_failed',
    message: `${problem}${errors}`,
    retryable: true,
    recoveryAction: 'change_strategy',
    recovery,
    data,
    media,
    // The failure is what the model needs; its own code echoed back only
    // spent context, and arrived cut to the result's size limit.
    modelContent: `${problem}${errors}\n${recovery}`
  })
}

/**
 * The builder's final version as the agent's own create_artifact result: the
 * artifact the chat shows, how many versions it took, and, when the builder
 * changed it, the code that is now current, since the agent's call holds the
 * first version.
 */
export function withArtifactBuild(
  final: ToolExecutionResult,
  built: ArtifactBuildResult,
  changed: boolean
): ToolExecutionResult {
  const data = final.data && typeof final.data === 'object' ? final.data : {}
  const review =
    built.versions > 1
      ? `A builder reviewed it and made ${built.versions - 1} ${built.versions === 2 ? 'fix' : 'fixes'} before showing it; this is the version in the chat.`
      : 'A builder reviewed it and found nothing to fix.'
  const code = changed
    ? `\nIts current code, which any later change must start from:\n\`\`\`\n${built.artifact.code}\n\`\`\``
    : ''
  return {
    ...final,
    data: { ...data, childRunId: built.childRunId, versions: built.versions },
    modelContent: `${final.modelContent}\n${review} It is finished: do not rebuild it to polish it; call create_artifact again only to change what the user asked for.${code}`
  }
}

/**
 * Recent inspections by artifact. A builder's final version was inspected in the builder; its
 * result for the agent reuses that inspection instead of rendering the same code again.
 */
const recentInspections = new WeakMap<ArtifactInspectorLike, Map<string, ArtifactInspection>>()
const RECENT_INSPECTIONS = 8

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
    /** The previous reply made an artifact, so its guidance is already in the conversation. */
    artifactContinuation?: boolean
    /** Refine each artifact in a builder run rather than in the conversation. */
    buildArtifacts?: boolean
    /** This run is an artifact's builder, starting from this version; it may edit it in place. */
    builderArtifact?: { type: InspectedArtifactType; title: string; code: string }
  }
): void {
  // The version a builder's next edit applies to: the last one it made, or the agent's.
  let builderVersion = options.builderArtifact
  const inspectWith = (
    candidate: { type: InspectedArtifactType; title: string; code: string },
    signal: AbortSignal | undefined
  ): Promise<ArtifactInspection | undefined> => {
    const inspector = options.artifactInspector?.()
    if (!inspector) return Promise.resolve(undefined)
    const cache = recentInspections.get(inspector) ?? new Map<string, ArtifactInspection>()
    recentInspections.set(inspector, cache)
    const key = `${candidate.type}\n${candidate.code}`
    const recent = cache.get(key)
    if (recent) return Promise.resolve(recent)
    return inspector.inspect(candidate, signal).then(
      (inspection) => {
        cache.set(key, inspection)
        while (cache.size > RECENT_INSPECTIONS) cache.delete(cache.keys().next().value!)
        return inspection
      },
      (error) => {
        signal?.throwIfAborted()
        console.warn('[create_artifact] Inspection failed:', error)
        return undefined
      }
    )
  }

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
          ? `Loaded. ${skillToolNames(skill.id).join(', ')} is ready to use in this run.\n`
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
    // Refusing an artifact made before its skill loaded threw away the code the
    // model had just written. Render it, and when the skill's guidance is not
    // already in the conversation, return that guidance to check it against.
    const guidanceMissing =
      !options.activeSkillIds.has(WEB_ARTIFACTS_SKILL_ID) && !options.artifactContinuation
    options.activeSkillIds.add(WEB_ARTIFACTS_SKILL_ID)
    const type = args.type === 'html' || args.type === 'svg' ? args.type : 'react'
    const artifact = {
      type: type as InspectedArtifactType,
      title: typeof args.title === 'string' ? args.title : '',
      code: typeof args.code === 'string' ? args.code : ''
    }
    const inspect = (candidate: typeof artifact): Promise<ArtifactInspection | undefined> =>
      inspectWith(candidate, context.signal)
    if (builderVersion) builderVersion = artifact
    const inspection = await inspect(artifact)
    let result = artifactToolResult(title, artifact, inspection, options.visionEnabled === true)
    // In a chat, the review-and-fix loop runs in a builder the chat does not
    // show, so the conversation gets one artifact, not every attempt at it.
    // Without a render, or with nothing wrong and no screenshot to judge, there
    // is nothing for a builder to review.
    const launcher = options.childLauncher()
    if (
      options.buildArtifacts &&
      launcher &&
      inspection &&
      (inspection.status !== 'rendered' || options.visionEnabled || inspection.warnings?.length)
    ) {
      try {
        const built = await launcher.buildArtifact({ artifact, review: result }, context)
        const changed = built.artifact.code !== artifact.code
        const final = artifactToolResult(
          title,
          built.artifact,
          changed ? await inspect(built.artifact) : inspection,
          options.visionEnabled === true,
          true
        )
        result = withArtifactBuild(final, built, changed)
      } catch (error) {
        context.signal?.throwIfAborted()
        console.warn('[create_artifact] The builder failed; keeping the first version:', error)
      }
    }
    const skill = getSkillById(WEB_ARTIFACTS_SKILL_ID)
    if (!guidanceMissing || !skill) return result
    return {
      ...result,
      modelContent:
        `${result.modelContent}\n\nThis artifact was made before the web-artifacts guidance was loaded. Check it against the guidance below and revise it with create_artifact if it does not follow it.\n` +
        `<skill_instructions id="${skill.id}" trust="trusted-skill-instructions">\n${getSkillRuntimeGuidance(skill)}\n${skill.systemPromptInjection}\n</skill_instructions>`
    }
  })

  if (options.builderArtifact) {
    registry.register('edit_artifact', async ({ title, arguments: args, context }) => {
      const current = builderVersion!
      const edits = Array.isArray(args.edits) ? (args.edits as unknown[]) : []
      if (!edits.length) {
        return toolExecutionFailed({
          title,
          code: 'invalid_arguments',
          message: 'No edits were given; nothing was changed.',
          recoveryAction: 'correct_input'
        })
      }
      let code = current.code
      for (const [index, raw] of edits.entries()) {
        const edit = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
        const oldText = typeof edit.old_text === 'string' ? edit.old_text : ''
        const newText = typeof edit.new_text === 'string' ? edit.new_text : ''
        const matches = oldText ? code.split(oldText).length - 1 : 0
        if (matches !== 1) {
          return toolExecutionFailed({
            title,
            code: 'invalid_arguments',
            message: `Edit ${index + 1} ${matches ? `matches ${matches} places in` : 'matches nothing in'} the current code, so no edit was made. Copy old_text exactly from the current version, with enough around it to match one place.`,
            recoveryAction: 'correct_input'
          })
        }
        code = code.replace(oldText, () => newText)
      }
      const artifact = { ...current, code }
      builderVersion = artifact
      return artifactToolResult(
        title,
        artifact,
        await inspectWith(artifact, context.signal),
        options.visionEnabled === true
      )
    })
  }

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
    // The card keeps the title it showed while the sub-agent worked.
    const label = typeof args.description === 'string' ? args.description.trim() : ''
    return toolExecutionSucceeded({ title: label || 'Delegate task', data })
  })
}
