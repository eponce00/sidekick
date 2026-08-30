import { normalizeCompletedToolInput } from '../../shared/toolCalls'

export interface OpenAICompatibleResult<T> {
  ok: boolean
  data?: T
  error?: string
  status?: number
}

export interface OpenAICompatibleModel {
  id: string
  name?: string
  object?: string
  owned_by?: string
  context_length?: number
  max_model_len?: number
  max_tokens?: number
  max_input_tokens?: number
  max_output_tokens?: number
  input_cost_per_token?: number | string
  output_cost_per_token?: number | string
  supports_function_calling?: boolean
  supports_parallel_function_calling?: boolean
  supports_vision?: boolean
  supports_reasoning?: boolean
  supports_audio_input?: boolean
  supports_audio_output?: boolean
  supports_pdf_input?: boolean
  supported_openai_params?: string[]
  mode?: string
  /** Gateway-resolved model identity when the public id is an alias. */
  upstream_model_id?: string
  model_info?: Omit<OpenAICompatibleModel, 'id' | 'model_info'>
}

export interface OpenAICompatibleModelsResponse {
  data: OpenAICompatibleModel[]
}

export interface OpenAICompatibleChatResult {
  message: {
    role: string
    content: string
    thinking?: string
    tool_calls?: Array<{
      id?: string
      type: string
      function: { name: string; arguments: string }
    }> | null
  }
  promptTokens: number
  cachedPromptTokens?: number
  completionTokens: number
  reasoningTokens: number
  finishReason: string
}

type FetchImplementation = typeof fetch

function requestFailureMessage(error: unknown): string {
  if (!(error instanceof Error)) return 'Unknown error'
  const cause = error.cause
  if (cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string') {
    return `${error.message} (${cause.code})`
  }
  return error.message
}

export function normalizeOpenAICompatibleEndpoint(endpoint: string): string {
  return endpoint.trim().replace(/\/+$/, '')
}

export function openAICompatibleHeaders(apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey?.trim()) headers.Authorization = `Bearer ${apiKey.trim()}`
  return headers
}

async function responseError(response: Response): Promise<string> {
  const message = `HTTP ${response.status}`
  try {
    const raw = (await response.json()) as {
      error?: string | { message?: string }
      message?: string
    }
    if (typeof raw.error === 'string') return raw.error
    return raw.error?.message || raw.message || message
  } catch {
    return message
  }
}

export async function fetchOpenAICompatibleModels(
  endpoint: string,
  headers: Record<string, string>,
  fetchImpl: FetchImplementation = fetch,
  signal?: AbortSignal
): Promise<OpenAICompatibleResult<OpenAICompatibleModelsResponse>> {
  try {
    const response = await fetchImpl(`${normalizeOpenAICompatibleEndpoint(endpoint)}/models`, {
      headers,
      signal
    })
    if (!response.ok) {
      return { ok: false, error: await responseError(response), status: response.status }
    }
    const data = (await response.json()) as OpenAICompatibleModelsResponse
    if (!Array.isArray(data?.data)) {
      return { ok: false, error: 'Provider returned an invalid model catalog' }
    }
    return { ok: true, data }
  } catch (error) {
    return { ok: false, error: requestFailureMessage(error) }
  }
}

export async function completeOpenAICompatibleChat(
  endpoint: string,
  requestBody: Record<string, unknown>,
  headers: Record<string, string>,
  fetchImpl: FetchImplementation = fetch,
  signal?: AbortSignal
): Promise<OpenAICompatibleResult<OpenAICompatibleChatResult>> {
  try {
    const response = await fetchImpl(
      `${normalizeOpenAICompatibleEndpoint(endpoint)}/chat/completions`,
      {
        method: 'POST',
        headers,
        signal,
        body: JSON.stringify({ ...requestBody, stream: false })
      }
    )

    if (!response.ok) {
      return { ok: false, error: await responseError(response), status: response.status }
    }

    const data = (await response.json()) as {
      choices?: Array<{
        finish_reason?: string
        message?: {
          role?: string
          content?: string
          thinking?: string
          reasoning?: string
          reasoning_content?: string
          tool_calls?: Array<{
            id?: string
            type?: string
            function?: { name?: string; arguments?: string | Record<string, unknown> }
          }>
        }
      }>
      usage?: {
        prompt_tokens?: number
        completion_tokens?: number
        prompt_tokens_details?: { cached_tokens?: number }
        completion_tokens_details?: { reasoning_tokens?: number }
      }
    }
    const choice = data.choices?.[0]
    if (!choice?.message) {
      return { ok: false, error: 'Provider returned no completion choice' }
    }

    let toolCalls =
      choice.message.tool_calls?.map((toolCall) => {
        const normalized = normalizeCompletedToolInput(toolCall.function?.arguments)
        return {
          id: toolCall.id,
          type: toolCall.type || 'function',
          function: {
            name: toolCall.function?.name || '',
            arguments:
              typeof normalized.arguments === 'string'
                ? normalized.arguments
                : JSON.stringify(normalized.arguments)
          }
        }
      }) || null

    let rawContent = choice.message.content || ''
    let thinking =
      choice.message.thinking || choice.message.reasoning_content || choice.message.reasoning || ''
    const thinkRegex = /<think>([\s\S]*?)<\/think>/g
    let match: RegExpExecArray | null
    while ((match = thinkRegex.exec(rawContent)) !== null) {
      thinking += `${thinking ? '\n' : ''}${match[1]}`
    }
    rawContent = rawContent.replace(/<think>[\s\S]*?<\/think>/g, '').trim()

    if ((!toolCalls || toolCalls.length === 0) && rawContent.includes('<tool_call>')) {
      const parsedFromContent: NonNullable<typeof toolCalls> = []
      const toolCallRegex = /<tool_call>([\s\S]*?)<\/tool_call>/g
      let toolCallMatch: RegExpExecArray | null
      while ((toolCallMatch = toolCallRegex.exec(rawContent)) !== null) {
        try {
          const parsed = JSON.parse(toolCallMatch[1].trim()) as {
            name?: string
            arguments?: string | Record<string, unknown>
          }
          parsedFromContent.push({
            id: `call_${Date.now()}_${parsedFromContent.length}`,
            type: 'function',
            function: {
              name: parsed.name || '',
              arguments:
                typeof parsed.arguments === 'string'
                  ? parsed.arguments
                  : JSON.stringify(parsed.arguments ?? {})
            }
          })
        } catch {
          // Ignore malformed fallback tags and preserve them as ordinary content.
        }
      }
      if (parsedFromContent.length > 0) {
        toolCalls = parsedFromContent
        rawContent = rawContent.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim()
      }
    }

    return {
      ok: true,
      data: {
        message: {
          role: choice.message.role || 'assistant',
          content: rawContent,
          thinking: thinking || undefined,
          tool_calls: toolCalls
        },
        promptTokens: data.usage?.prompt_tokens || 0,
        ...(typeof data.usage?.prompt_tokens_details?.cached_tokens === 'number'
          ? { cachedPromptTokens: data.usage.prompt_tokens_details.cached_tokens }
          : {}),
        completionTokens: data.usage?.completion_tokens || 0,
        reasoningTokens: data.usage?.completion_tokens_details?.reasoning_tokens || 0,
        finishReason: choice.finish_reason || 'stop'
      }
    }
  } catch (error) {
    return { ok: false, error: requestFailureMessage(error) }
  }
}
