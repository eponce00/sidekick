import { toolExecutionFailed, toolExecutionSucceeded } from '../../shared/agentRuntime'
import { getSkillById } from '../../shared/skills'
import type { AgentChildRunLauncher } from './agentToolRuntime'
import type { AgentToolHandlerRegistry } from './agentToolHandlerRegistry'

export function registerSkillToolHandlers(
  registry: AgentToolHandlerRegistry,
  options: {
    activeSkillIds: Set<string>
    readReceipts: Map<string, string>
    childLauncher: () => AgentChildRunLauncher | undefined
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
      data: { id: skill.id, name: skill.name },
      modelContent:
        `<skill_instructions id="${skill.id}" trust="trusted-skill-instructions">\n` +
        `${skill.systemPromptInjection}\n</skill_instructions>`
    })
  })

  registry.register('create_artifact', async ({ title, arguments: args }) => {
    if (!options.activeSkillIds.has('web-artifacts')) {
      return toolExecutionFailed({
        title,
        code: 'permission_denied',
        message: 'Load the web-artifacts skill before creating an inline artifact'
      })
    }
    return toolExecutionSucceeded({
      title,
      data: { artifact: { type: args.type, title: args.title, code: args.code } }
    })
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
