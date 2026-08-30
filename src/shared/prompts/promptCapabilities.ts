import type { AgentToolDefinition } from '../agentToolDefinitions'
import type { HostPlatform, PromptCapabilities } from './promptTypes'
import { WORKSPACE_MUTATION_TOOL_NAMES } from '../workspaceMutations'

export function capabilitiesFromTools(tools: readonly AgentToolDefinition[]): PromptCapabilities {
  const availableToolNames = tools.map((tool) => tool.function.name)
  const names = new Set(availableToolNames)
  const hasAny = (...candidates: string[]): boolean => candidates.some((name) => names.has(name))

  return {
    availableToolNames,
    artifacts: names.has('create_artifact'),
    todoList: names.has('manage_todo_list'),
    commands: names.has('shell'),
    backgroundCommands: hasAny('list_background_tasks', 'cancel_background_task'),
    subagents: names.has('spawn_subagent'),
    skills: names.has('use_skill'),
    webSearch: names.has('web_search'),
    webFetch: names.has('web_fetch'),
    imageSearch: names.has('web_image_search'),
    browser: availableToolNames.some((name) => name.startsWith('browser_')),
    workspace: hasAny('read', ...WORKSPACE_MUTATION_TOOL_NAMES),
    mcp: availableToolNames.some((name) => name.startsWith('mcp__'))
  }
}

export function detectHostPlatform(
  userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent
): HostPlatform {
  if (userAgent === 'win32') return 'windows'
  if (userAgent === 'darwin') return 'macos'
  if (/windows/i.test(userAgent)) return 'windows'
  if (/macintosh|mac os/i.test(userAgent)) return 'macos'
  return 'linux'
}
