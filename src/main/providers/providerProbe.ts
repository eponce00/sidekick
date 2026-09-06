import type {
  ProviderChatRequest,
  ProviderProbeResult,
  ProviderStreamChunk,
  ProviderStreamResult,
  ProviderTarget
} from '../../shared/providerRuntime'
import { crc32, deflateSync } from 'node:zlib'
import { randomInt } from 'node:crypto'

function imageProbe(): { image: string; answer: string } {
  const blue = randomInt(2) === 1
  const chunk = (type: string, bytes: Buffer): Buffer => {
    const data = Buffer.concat([Buffer.from(type), bytes])
    const size = Buffer.alloc(4)
    size.writeUInt32BE(bytes.length)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(data))
    return Buffer.concat([size, data, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(96, 0)
  header.writeUInt32BE(96, 4)
  header[8] = 8
  header[9] = 2
  const pixels = Buffer.alloc(96 * (96 * 3 + 1))
  for (let y = 0; y < 96; y++)
    for (let x = 0; x < 96; x++) pixels[y * 289 + 1 + x * 3 + (blue ? 2 : 0)] = 255
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0))
  ])
  return { image: `data:image/png;base64,${png.toString('base64')}`, answer: blue ? 'blue' : 'red' }
}

type Stream = (
  request: ProviderChatRequest,
  emit: (chunk: ProviderStreamChunk) => void,
  signal: AbortSignal
) => Promise<ProviderStreamResult>

/** Synthetic requests only. Proposed tools are inspected, never executed. Raw responses stay private. */
export async function probeProvider(
  target: ProviderTarget,
  stream: Stream,
  signal: AbortSignal,
  includeVision = false
): Promise<ProviderProbeResult> {
  const checks: ProviderProbeResult['checks'] = []
  const reportedModels = new Set<string>()
  for (const mode of includeVision
    ? (['streaming', 'tools', 'vision'] as const)
    : (['streaming', 'tools'] as const)) {
    const tools = mode === 'tools'
    const visual = mode === 'vision' ? imageProbe() : undefined
    if (signal.aborted) break
    const start = performance.now()
    let firstTokenMs: number | undefined
    let text = ''
    let thinking = false
    let toolName = ''
    let argumentsText = ''
    const toolIds = new Set<string | number>()
    let promptTokens: number | undefined
    let cachedTokens: number | undefined
    let streamError = false
    let ok = false
    try {
      const result = await stream(
        {
          target,
          purpose: 'other',
          maxOutputTokens: 1024,
          messages: [
            {
              role: 'user',
              ...(visual ? { images: [visual.image] } : {}),
              content: visual
                ? 'What is the dominant color of this image? Answer with only the color name.'
                : tools
                  ? 'Call capability_probe with value exactly 7. Do not answer in prose.'
                  : 'Calculate 13 multiplied by 17. Answer with the number.'
            }
          ],
          ...(tools
            ? {
                tools: [
                  {
                    type: 'function',
                    function: {
                      name: 'capability_probe',
                      description: 'Synthetic test; this tool will not execute.',
                      parameters: {
                        type: 'object',
                        properties: { value: { type: 'integer' } },
                        required: ['value'],
                        additionalProperties: false
                      }
                    }
                  }
                ]
              }
            : {})
        },
        (chunk) => {
          if (chunk.reported_model) reportedModels.add(chunk.reported_model.slice(0, 512))
          if (chunk.error) streamError = true
          if (
            chunk.message?.content ||
            chunk.message?.thinking ||
            chunk.message?.tool_calls?.length
          )
            firstTokenMs ??= performance.now() - start
          text += chunk.message?.content ?? ''
          thinking ||= Boolean(chunk.message?.thinking)
          promptTokens = chunk.prompt_eval_count ?? promptTokens
          cachedTokens = chunk.cached_prompt_tokens ?? cachedTokens
          for (const call of chunk.message?.tool_calls ?? []) {
            toolIds.add(call.index ?? call.id ?? 0)
            toolName = call.function.name || toolName
            const args = call.function.arguments
            // Adapters emit cumulative previews, not raw transport deltas.
            if (typeof args === 'string') argumentsText = args
            else if (args) argumentsText = JSON.stringify(args)
          }
        },
        signal
      )
      ok = result.ok && !streamError && !signal.aborted
    } catch {
      /* No provider error bodies or credentials leave the probe. */
    }
    let validTool = false
    try {
      const parsed = JSON.parse(argumentsText)
      validTool =
        toolIds.size === 1 &&
        toolName === 'capability_probe' &&
        parsed?.value === 7 &&
        Object.keys(parsed).length === 1
    } catch {
      /* incomplete JSON is not success */
    }
    const timing = {
      durationMs: Math.round(performance.now() - start),
      firstTokenMs,
      promptTokens,
      cachedTokens
    }
    checks.push({
      capability: mode,
      status: !ok
        ? 'failed'
        : (
              visual
                ? text.trim().toLowerCase().replace(/[.!]$/, '') === visual.answer
                : tools
                  ? validTool
                  : Boolean(text.trim())
            )
          ? 'observed'
          : 'not-observed',
      ...timing
    })
    if (mode === 'streaming')
      checks.push({
        capability: 'reasoning',
        status: !ok ? 'failed' : thinking ? 'observed' : 'not-observed',
        ...timing
      })
  }
  return { model: target.model, reportedModels: [...reportedModels], checks }
}
