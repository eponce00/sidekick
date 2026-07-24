import type { PermissionMode } from '../permissions'
import type { ModelProvider, PinnedModel } from '../models'
import type { ProviderKind } from '../providerRegistry'
import type { ConversationProjectTransition } from '../projects'

export const AGENT_PROMPT_VERSION = 'sidekick-agent-v8'

export type HostPlatform = 'windows' | 'macos' | 'linux'
export type ModelFamily =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'qwen'
  | 'llama'
  | 'mistral'
  | 'deepseek'
  | 'grok'
  | 'generic'

export interface PromptModelProfile {
  family: ModelFamily
  provider: ModelProvider
  providerKind?: ProviderKind
  modelId: string
  displayName: string
  instructionStyle: 'compact-structured' | 'direct'
}

export interface PromptCapabilities {
  availableToolNames: readonly string[]
  artifacts: boolean
  todoList: boolean
  commands: boolean
  backgroundCommands: boolean
  subagents: boolean
  skills: boolean
  webSearch: boolean
  webFetch: boolean
  imageSearch: boolean
  workspace: boolean
  mcp: boolean
}

export interface PromptProjectContext {
  workspaceRoot: string | null
  instructions: string
  instructionSources: readonly string[]
  memory: string
  latestTransition?: ConversationProjectTransition | null
  homeWorkspaceRoot?: string | null
  homeProjectName?: string | null
  isDetached?: boolean
}

export interface PromptLocation {
  city?: string
  country?: string
  timezone?: string
}

export interface PromptComposerInput {
  platform: HostPlatform
  capabilities: PromptCapabilities
  permissionMode: PermissionMode
  model: PromptModelProfile
  project: PromptProjectContext
  currentDate: string
  location?: PromptLocation
  toolRoundLimit: number
  activeSkillIds: readonly string[]
  skillAssetsPath: string | null
}

export interface ComposedPrompt {
  version: typeof AGENT_PROMPT_VERSION
  content: string
  sectionIds: readonly string[]
  modelFamily: ModelFamily
  projectInstructionsMessage: string
}

export type PromptModelInput = Pick<
  PinnedModel,
  'id' | 'name' | 'provider' | 'providerKind' | 'providerModelId'
>
