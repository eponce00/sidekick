import type { ProviderKind } from '../../../shared/providerRegistry'
import type { ModelProvider } from '../../../shared/models'
import type { LLMToolCall } from '../types/llm.types'
import { completeUtilityText, createUtilityModelConfig } from '../services/providers'
import { createFallbackConversationTitle } from '../../../shared/conversationTitles'
export { createFallbackConversationTitle } from '../../../shared/conversationTitles'
export {
  estimateConversationTokens,
  estimateProviderRequestTokens
} from '../../../shared/contextBudget'

/**
 * Configuration for generating a conversation title via LLM
 */
export interface TitleGenerationConfig {
  provider: ModelProvider
  providerInstanceId?: string
  providerKind?: ProviderKind
  model: string
  contextLength: number
  purpose?: 'title' | 'checkpoint-title'
  fallbackTitle?: string
  retries?: number
  onUpdateTitle: (conversationId: string, title: string) => Promise<void> | void
}

export function isPlaceholderConversationTitle(title: string | null | undefined): boolean {
  return !title?.trim() || /^new conversation$/i.test(title.trim())
}

export function normalizeGeneratedConversationTitle(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const withoutThinking = value.replace(/<think>[\s\S]*?<\/think>/gi, ' ').trim()
  const firstMeaningfulLine = withoutThinking
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
  if (!firstMeaningfulLine) return null

  const normalized = firstMeaningfulLine
    .replace(/^#{1,6}\s*/, '')
    .replace(/^(?:title|t[ií]tulo)\s*:\s*/i, '')
    .replace(/[.!?;:]+$/g, '')
    .replace(/^[`"'“”‘’]+|[`"'“”‘’]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!normalized) return null

  return normalized.split(' ').slice(0, 8).join(' ').slice(0, 72).trim() || null
}

/**
 * Auto-generate a conversation title using the configured LLM provider.
 * Falls back to a deterministic title so a provider failure never leaves the
 * sidebar stuck on "New Conversation".
 */
export async function generateConversationTitle(
  config: TitleGenerationConfig,
  conversationId: string,
  titleMessages: Array<{ role: string; content: string }>
): Promise<string | null> {
  const { provider, model, contextLength } = config
  let rawTitle: unknown

  try {
    const titleResult = await completeUtilityText({
      model: createUtilityModelConfig({ ...config, provider, model, contextLength }),
      messages: titleMessages,
      maxOutputTokens: 128,
      temperature: 0.2,
      think: false,
      purpose: config.purpose ?? 'title',
      retries: config.retries
    })
    if (!titleResult.ok) {
      throw new Error(titleResult.error?.message || 'Title request failed')
    }
    rawTitle = titleResult.text || titleResult.message?.thinking
  } catch (error) {
    console.warn('[Title] Failed to auto-generate title:', error)
  }

  const title =
    normalizeGeneratedConversationTitle(rawTitle) ||
    (config.fallbackTitle ? createFallbackConversationTitle(config.fallbackTitle) : null)
  if (!title) return null
  try {
    await config.onUpdateTitle(conversationId, title)
    return title
  } catch (error) {
    console.warn('[Title] Failed to persist generated title:', error)
    return null
  }
}

/**
 * Check if a set of tool calls includes a create_artifact call.
 * Returns artifact metadata if found, null otherwise.
 */
export function getArtifactIntentFromToolCalls(
  calls: LLMToolCall[]
): { title: string; type: 'react' | 'html' | 'svg' } | null {
  const artifactCall = calls.find((tc) => tc.function?.name === 'create_artifact')
  if (!artifactCall) return null

  let artifactTitle = 'artifact'
  let artifactType: 'react' | 'html' | 'svg' = 'react'
  const args = artifactCall.function?.arguments
  if (args) {
    if (typeof args === 'string') {
      try {
        const parsed = JSON.parse(args) as { title?: unknown; type?: unknown }
        if (typeof parsed.title === 'string' && parsed.title.trim()) artifactTitle = parsed.title
        if (parsed.type === 'react' || parsed.type === 'html' || parsed.type === 'svg') {
          artifactType = parsed.type
        }
      } catch {
        // Arguments may still be streaming in.
      }
    } else if (typeof args === 'object') {
      if (typeof args.title === 'string' && args.title.trim()) artifactTitle = args.title
      if (args.type === 'react' || args.type === 'html' || args.type === 'svg') {
        artifactType = args.type
      }
    }
  }

  return { title: artifactTitle, type: artifactType }
}

/**
 * Check if a tool result JSON indicates failure
 */
export function didToolResultFail(content: string): boolean {
  try {
    const parsed = JSON.parse(content) as { success?: boolean }
    return parsed.success === false
  } catch {
    return false
  }
}

/**
 * Calculate tokens per second from completion token count and timing data
 */
export function calcTokensPerSecond(
  completionTokens: number,
  evalDurationNs?: number,
  firstTokenTime?: number,
  streamEndTime?: number
): number | undefined {
  // Prefer Ollama's precise eval_duration (nanoseconds)
  if (evalDurationNs && evalDurationNs > 0 && completionTokens > 0) {
    return completionTokens / (evalDurationNs / 1e9)
  }
  // Fall back to wall-clock timing (first token -> stream end)
  if (firstTokenTime && streamEndTime && completionTokens > 0) {
    const durationSec = (streamEndTime - firstTokenTime) / 1000
    if (durationSec > 0.1) return completionTokens / durationSec
  }
  return undefined
}
