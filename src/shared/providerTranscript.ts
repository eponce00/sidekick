import type { ProviderChatMessage, ProviderToolCall } from './providerRuntime'

export interface ProviderTranscriptRepair {
  kind:
    | 'coalesced_system_messages'
    | 'moved_system_message'
    | 'assigned_tool_call_id'
    | 'inserted_missing_tool_result'
    | 'dropped_orphan_tool_result'
    | 'dropped_duplicate_tool_result'
  toolCallId: string
  messageIndex: number
}

export interface ValidatedProviderTranscript {
  messages: ProviderChatMessage[]
  repairs: ProviderTranscriptRepair[]
}

function copyToolCall(call: ProviderToolCall, id: string): ProviderToolCall {
  return {
    ...call,
    id,
    function: {
      ...call.function,
      arguments:
        typeof call.function.arguments === 'object'
          ? { ...call.function.arguments }
          : call.function.arguments
    }
  }
}

function interruptedToolResult(toolCallId: string): ProviderChatMessage {
  return {
    role: 'tool',
    tool_call_id: toolCallId,
    content: JSON.stringify({
      ok: false,
      success: false,
      error: 'Tool execution was interrupted before a durable result was recorded',
      code: 'cancelled',
      retryable: true,
      recoveryAction: 'refresh_state',
      recovery: 'Inspect current state before deciding whether to retry the tool.'
    })
  }
}

/**
 * Produces a provider-safe transcript without mutating persisted messages.
 * Every assistant tool request is followed by exactly one result for each call,
 * and tool results can never float without a matching request.
 */
export function validateProviderTranscript(
  source: readonly ProviderChatMessage[]
): ValidatedProviderTranscript {
  const messages: ProviderChatMessage[] = []
  const repairs: ProviderTranscriptRepair[] = []
  const systemMessages = source
    .map((message, messageIndex) => ({ message, messageIndex }))
    .filter(({ message }) => message.role === 'system' && message.content?.trim())
  if (systemMessages.length) {
    messages.push({
      role: 'system',
      content: systemMessages.map(({ message }) => message.content!.trim()).join('\n\n')
    })
    if (systemMessages.length > 1) {
      repairs.push({
        kind: 'coalesced_system_messages',
        toolCallId: '',
        messageIndex: systemMessages[1].messageIndex
      })
    }
    if (systemMessages[0].messageIndex !== 0) {
      repairs.push({
        kind: 'moved_system_message',
        toolCallId: '',
        messageIndex: systemMessages[0].messageIndex
      })
    }
  }
  let pending: string[] = []
  const answered = new Set<string>()

  const settlePending = (messageIndex: number): void => {
    for (const id of pending) {
      if (answered.has(id)) continue
      messages.push(interruptedToolResult(id))
      answered.add(id)
      repairs.push({ kind: 'inserted_missing_tool_result', toolCallId: id, messageIndex })
    }
    pending = []
  }

  source.forEach((message, messageIndex) => {
    if (message.role === 'system') return
    if (message.role === 'tool') {
      const id = message.tool_call_id || ''
      if (!id || !pending.includes(id)) {
        repairs.push({
          kind: answered.has(id) ? 'dropped_duplicate_tool_result' : 'dropped_orphan_tool_result',
          toolCallId: id,
          messageIndex
        })
        return
      }
      if (answered.has(id)) {
        repairs.push({ kind: 'dropped_duplicate_tool_result', toolCallId: id, messageIndex })
        return
      }
      messages.push({ ...message })
      answered.add(id)
      if (pending.every((pendingId) => answered.has(pendingId))) pending = []
      return
    }

    if (pending.length) settlePending(messageIndex)

    if (message.role === 'assistant' && message.tool_calls?.length) {
      const calls = message.tool_calls.map((call, callIndex) => {
        const id = call.id || `tool_call_${messageIndex}_${call.index ?? callIndex}`
        if (!call.id) {
          repairs.push({ kind: 'assigned_tool_call_id', toolCallId: id, messageIndex })
        }
        return copyToolCall(call, id)
      })
      pending = calls.map(({ id }) => id!)
      for (const id of pending) answered.delete(id)
      messages.push({ ...message, tool_calls: calls })
      return
    }

    messages.push({ ...message })
  })

  if (pending.length) settlePending(source.length)
  return { messages, repairs }
}
