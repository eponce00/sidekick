import type { ModelProvider } from '../../../../shared/models'
import { providerKindForTransport, type ProviderKind } from '../../../../shared/providerRegistry'
import type { ConversationMessage, LLMToolCall } from '../../types/llm.types'

type UtilityCompletionApi = Pick<Window['api'], 'providers'>

export interface UtilityModelConfig {
  provider: ModelProvider
  providerKind?: ProviderKind
  providerInstanceId?: string
  model: string
  contextLength?: number
}

export interface UtilityModelInput {
  provider: ModelProvider
  providerKind?: ProviderKind
  providerInstanceId?: string
  model: string
  contextLength?: number
}

export type UtilityCompletionPurpose =
  | 'title'
  | 'checkpoint-title'
  | 'compaction'
  | 'web-extraction'
  | 'research'
  | 'sub-agent'
  | 'prompt-refinement'
  | 'other'

export interface UtilityCompletionRequest {
  model: UtilityModelConfig
  messages: ConversationMessage[]
  tools?: unknown[]
  maxOutputTokens?: number
  temperature?: number
  reasoningTokens?: number
  think?: boolean
  purpose: UtilityCompletionPurpose
  retries?: number
}

export type UtilityCompletionErrorCode =
  | 'authentication'
  | 'rate-limit'
  | 'timeout'
  | 'provider-unavailable'
  | 'invalid-request'
  | 'unknown'

export interface UtilityCompletionFailure {
  code: UtilityCompletionErrorCode
  message: string
  retryable: boolean
}

export interface UtilityAssistantMessage {
  role: string
  content: string
  thinking?: string
  thinking_blocks?: import('../../../../shared/providerRuntime').ProviderThinkingBlock[]
  tool_calls?: LLMToolCall[]
}

export interface UtilityCompletionResult {
  ok: boolean
  message?: UtilityAssistantMessage
  promptTokens: number
  completionTokens: number
  reasoningTokens: number
  finishReason?: string
  attempts: number
  error?: UtilityCompletionFailure
}

interface UtilityCompletionDependencies {
  api?: UtilityCompletionApi
  sleep?: (milliseconds: number) => Promise<void>
}

export function createUtilityModelConfig(config: UtilityModelInput): UtilityModelConfig {
  return {
    provider: config.provider,
    providerKind: config.providerKind,
    providerInstanceId: config.providerInstanceId,
    model: config.model,
    contextLength: config.contextLength
  }
}

function classifyFailure(message: string): UtilityCompletionFailure {
  const normalized = message.toLowerCase()
  if (
    normalized.includes('api key') ||
    normalized.includes('authentication') ||
    normalized.includes('unauthorized') ||
    normalized.includes('http 401') ||
    normalized.includes('http 403')
  ) {
    return { code: 'authentication', message, retryable: false }
  }
  if (normalized.includes('rate limit') || normalized.includes('http 429')) {
    return { code: 'rate-limit', message, retryable: true }
  }
  if (normalized.includes('timeout') || normalized.includes('timed out')) {
    return { code: 'timeout', message, retryable: true }
  }
  if (
    normalized.includes('connection') ||
    normalized.includes('network') ||
    normalized.includes('fetch failed') ||
    /http 5\d\d/.test(normalized)
  ) {
    return { code: 'provider-unavailable', message, retryable: true }
  }
  if (
    normalized.includes('invalid') ||
    normalized.includes('bad request') ||
    normalized.includes('http 400') ||
    normalized.includes('not found') ||
    normalized.includes('http 404')
  ) {
    return { code: 'invalid-request', message, retryable: false }
  }
  return { code: 'unknown', message, retryable: false }
}

function normalizeToolCalls(value: unknown): LLMToolCall[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.map((raw) => {
    const toolCall = raw as {
      id?: string
      index?: number
      type?: string
      function?: { name?: string; arguments?: unknown }
    }
    let args = toolCall.function?.arguments
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args) as Record<string, unknown>
      } catch {
        // Preserve incomplete or non-JSON provider output for caller-specific recovery.
      }
    }
    return {
      id: toolCall.id,
      index: toolCall.index,
      type: toolCall.type || 'function',
      function: {
        name: toolCall.function?.name || '',
        arguments: args as Record<string, unknown> | string | undefined
      }
    }
  })
}

async function executeCompletion(
  request: UtilityCompletionRequest,
  api: UtilityCompletionApi
): Promise<Omit<UtilityCompletionResult, 'attempts'>> {
  const { model } = request
  const result = await api.providers.complete({
    target: {
      providerInstanceId: model.providerInstanceId,
      providerKind: model.providerKind ?? providerKindForTransport(model.provider),
      model: model.model,
      contextLength: model.contextLength
    },
    messages: request.messages,
    tools: request.tools,
    maxOutputTokens: request.maxOutputTokens,
    temperature: request.temperature,
    reasoningTokens: request.reasoningTokens,
    thinkingEnabled: request.think,
    purpose: request.purpose
  })
  if (!result.ok || !result.data) {
    return {
      ok: false,
      promptTokens: 0,
      completionTokens: 0,
      reasoningTokens: 0,
      error: classifyFailure(result.error || 'Provider completion failed')
    }
  }
  return {
    ok: true,
    message: {
      role: result.data.message.role || 'assistant',
      content: result.data.message.content || '',
      thinking: result.data.message.thinking,
      thinking_blocks: result.data.message.thinking_blocks,
      tool_calls: normalizeToolCalls(result.data.message.tool_calls)
    },
    promptTokens: result.data.promptTokens || 0,
    completionTokens: result.data.completionTokens || 0,
    reasoningTokens: result.data.reasoningTokens || 0,
    finishReason: result.data.finishReason
  }
}

export async function completeUtilityChat(
  request: UtilityCompletionRequest,
  dependencies: UtilityCompletionDependencies = {}
): Promise<UtilityCompletionResult> {
  const api = dependencies.api || window.api
  const sleep =
    dependencies.sleep ||
    ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
  const retryCount = Math.max(0, Math.min(2, request.retries ?? 1))
  let attempts = 0
  let latest: Omit<UtilityCompletionResult, 'attempts'> | undefined

  while (attempts <= retryCount) {
    attempts += 1
    try {
      latest = await executeCompletion(request, api)
    } catch (error) {
      latest = {
        ok: false,
        promptTokens: 0,
        completionTokens: 0,
        reasoningTokens: 0,
        error: classifyFailure(error instanceof Error ? error.message : 'Utility completion failed')
      }
    }
    if (latest.ok || !latest.error?.retryable || attempts > retryCount) {
      return { ...latest, attempts }
    }
    await sleep(250 * 2 ** (attempts - 1))
  }

  return {
    ok: false,
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    attempts,
    error: classifyFailure('Utility completion failed')
  }
}

export async function completeUtilityText(
  request: UtilityCompletionRequest,
  dependencies: UtilityCompletionDependencies = {}
): Promise<UtilityCompletionResult & { text: string }> {
  const result = await completeUtilityChat(request, dependencies)
  return { ...result, text: result.message?.content || '' }
}
