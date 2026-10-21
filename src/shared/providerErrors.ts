export interface ProviderContextWindowErrorDetails {
  contextLength?: number
  requestedOutputTokens?: number
  inputTokens?: number
}

export interface ProviderImageLimitErrorDetails {
  maxImages?: number
}

export interface ProviderOutputLimitErrorDetails {
  maxOutputTokens: number
}

/**
 * The provider or model a request names is missing, turned off, or lacks its key in Settings, so
 * no request was sent. The user fixes it there; retrying unchanged cannot help.
 */
export class ProviderSetupError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProviderSetupError'
  }
}

// Node's fetch (undici) wraps network failures in a TypeError whose cause carries one of these.
const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT'
])
const DROPPED_CODES = new Set(['UND_ERR_SOCKET', 'ECONNRESET', 'EPIPE', 'UND_ERR_CLOSED'])
const UNREACHABLE_PREFIX = 'Could not reach the model server'
const DROPPED_PREFIX = 'Lost the connection to the model server'
// Node's fetch stops waiting after five minutes without response headers, or without a body chunk.
const TIMED_OUT_MARK = 'so SideKick stopped waiting'

function serverName(endpoint: string): string {
  try {
    return new URL(endpoint).host || endpoint
  } catch {
    return endpoint
  }
}

/**
 * Says in plain words that the model server could not be reached, closed the connection while it
 * replied, or sent nothing for so long that the request gave up, naming the server. Other failures
 * return null and keep their own message.
 */
export function providerConnectionFailureMessage(error: unknown, endpoint: string): string | null {
  if (!(error instanceof Error)) return null
  const cause = error.cause as { code?: unknown } | undefined
  const code = typeof cause?.code === 'string' ? cause.code : undefined
  const server = serverName(endpoint)
  if (code && UNREACHABLE_CODES.has(code))
    return `${UNREACHABLE_PREFIX} at ${server}. Check that it is running. (${code})`
  if (code === 'UND_ERR_HEADERS_TIMEOUT')
    return `The model server at ${server} took the request but sent no reply for 5 minutes, ${TIMED_OUT_MARK}. Check that it is not stuck or busy with another request. (${code})`
  if (code === 'UND_ERR_BODY_TIMEOUT')
    return `The model server at ${server} went silent for 5 minutes in the middle of its reply, ${TIMED_OUT_MARK}. (${code})`
  if ((code && DROPPED_CODES.has(code)) || (!code && error.message === 'terminated'))
    return `${DROPPED_PREFIX} at ${server} while it was replying; the server stopped or restarted.${code ? ` (${code})` : ''}`
  return null
}

/**
 * Whether a run failed because the model server was unreachable, dropped the connection, or went
 * silent until the request gave up.
 */
export function providerConnectionFailureKind(
  message: string | null | undefined
): 'unreachable' | 'dropped' | 'timed-out' | null {
  if (message?.includes(UNREACHABLE_PREFIX)) return 'unreachable'
  if (message?.includes(DROPPED_PREFIX)) return 'dropped'
  if (message?.includes(TIMED_OUT_MARK)) return 'timed-out'
  return null
}

/**
 * Whether a reply stopped because its stream broke off: the connection closed, or the stream ended
 * before the provider said the reply was complete. A model server or proxy that restarts, or swaps
 * the loaded model, does this.
 */
export function providerStreamDropped(message: string | null | undefined): boolean {
  return (
    providerConnectionFailureKind(message) === 'dropped' ||
    /stream ended before (?:completion|its terminal event)/i.test(message ?? '')
  )
}

/** Masks credentials a provider echoed back in an error before SideKick shows or keeps it. */
export function redactProviderCredentials(message: string): string {
  return message
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, '$1[redacted]')
    .replace(/((?:api[-_ ]?key|token)\)?\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
}

/** Only classify explicit inference failures, never infer hardware trouble from a timeout. */
export function providerInferenceFailure(
  message: string | null | undefined
): 'gpu-memory-exhausted' | 'engine-unavailable' | null {
  if (!message) return null
  if (/(?:cuda|gpu)[^\n]{0,100}out\s+of\s+memory|torch\.OutOfMemoryError/i.test(message))
    return 'gpu-memory-exhausted'
  if (/\bEngineDeadError\b|\bengine core (?:is dead|encountered an issue)\b/i.test(message))
    return 'engine-unavailable'
  return null
}

function numericMatch(message: string, pattern: RegExp): number | undefined {
  const raw = message.match(pattern)?.[1]?.replaceAll(',', '')
  if (!raw) return undefined
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : undefined
}

/** Recognizes context-limit failures across OpenAI-compatible, LiteLLM, Anthropic, and Ollama. */
export function providerContextWindowError(
  message: string | null | undefined
): ProviderContextWindowErrorDetails | null {
  if (!message) return null
  const normalized = message.toLowerCase()
  const recognized =
    [
      'contextwindowexceeded',
      'context_window_exceeded',
      'maximum context length',
      'context length exceeded',
      'context window exceeded',
      'prompt is too long',
      'input is too long',
      // Also "prompt (N tokens) + max tokens (M) exceeds the context (L)".
      'exceeds the context'
    ].some((fragment) => normalized.includes(fragment)) ||
    /too many tokens[^.\n]*(?:context|maximum|max(?:imum)? length)/i.test(message)
  if (!recognized) return null
  return {
    contextLength:
      numericMatch(message, /maximum context length is\s*([\d,]+)/i) ??
      numericMatch(message, /context(?:\s+window)?(?:\s+of|\s+is|:)\s*([\d,]+)\s*tokens/i) ??
      numericMatch(message, /exceeds the context(?:\s+window)?\s*\(([\d,]+)\)/i),
    requestedOutputTokens:
      numericMatch(message, /requested\s*([\d,]+)\s*output tokens/i) ??
      numericMatch(message, /max(?:imum)?[_\s-]*output[_\s-]*tokens[=: ]+([\d,]+)/i) ??
      numericMatch(message, /max tokens\s*\(([\d,]+)\)/i),
    inputTokens:
      numericMatch(
        message,
        /(?:prompt contains at least|input(?:_tokens| tokens)?[=:])\s*([\d,]+)/i
      ) ??
      numericMatch(message, /prompt is too long:\s*([\d,]+)\s*tokens/i) ??
      numericMatch(message, /prompt\s*\(([\d,]+)\s*tokens\)/i)
  }
}

/**
 * Recognizes a provider refusing a reply limit above the most it allows, and reads that most:
 * Groq ("`max_tokens` must be less than or equal to `16384`"), OpenAI ("supports at most 16384
 * completion tokens") and Anthropic ("max_tokens: 100000 > 64000, which is the maximum allowed
 * number of output tokens").
 */
export function providerOutputLimitError(
  message: string | null | undefined
): ProviderOutputLimitErrorDetails | null {
  if (!message) return null
  const maxOutputTokens =
    numericMatch(
      message,
      /max_(?:completion_)?tokens`?\s+must be less than or equal to\s+`?([\d,]+)/i
    ) ??
    numericMatch(message, /supports at most\s+([\d,]+)\s+completion tokens/i) ??
    numericMatch(
      message,
      /max_tokens:\s*[\d,]+\s*>\s*([\d,]+),\s*which is the maximum allowed number of output tokens/i
    )
  return maxOutputTokens ? { maxOutputTokens } : null
}

/** Recognizes image-count limits returned by OpenAI-compatible vision gateways. */
export function providerImageLimitError(
  message: string | null | undefined
): ProviderImageLimitErrorDetails | null {
  if (!message) return null
  const normalized = message.toLowerCase()
  if (
    !/at most\s+[\d,]+\s+image\(s\)\s+may be provided/i.test(message) &&
    !/maximum(?: number of)?\s+[\d,]+\s+images?/i.test(message) &&
    !normalized.includes('too many images')
  ) {
    return null
  }
  return {
    maxImages:
      numericMatch(message, /at most\s+([\d,]+)\s+image/i) ??
      numericMatch(message, /maximum(?: number of)?\s+([\d,]+)\s+images?/i)
  }
}
