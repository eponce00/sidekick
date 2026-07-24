/** A tool call from LLM response (streaming or non-streaming) */
export interface LLMToolCall {
  id?: string
  index?: number
  type?: string
  function: {
    name: string
    arguments?: Record<string, unknown> | string
  }
}

/** Message in the LLM conversation history */
export interface ConversationMessage {
  role: string
  content: string | null
  images?: string[]
  tool_calls?: LLMToolCall[]
  tool_call_id?: string
  thinking_blocks?: import('../../../shared/providerRuntime').ProviderThinkingBlock[]
}

/** Streaming data chunk from Ollama/OpenRouter */
export interface StreamChunk {
  message?: {
    content?: string
    thinking?: string
    tool_calls?: LLMToolCall[]
    thinking_blocks?: import('../../../shared/providerRuntime').ProviderThinkingBlock[]
  }
  done?: boolean
  prompt_eval_count?: number
  eval_count?: number
  eval_duration?: number // Ollama: nanoseconds spent generating tokens
  predicted_per_second?: number // llama.cpp: server-reported generation speed
  done_reason?: string
}

export interface ParsedImageToolResult {
  success?: boolean
  include_image_data?: boolean
  results?: Array<{
    title?: string
    imageUrl?: string
    thumbnailUrl?: string
    pageUrl?: string
    source?: string
    resolution?: string
    imageBase64?: string
    mimeType?: string
  }>
}
