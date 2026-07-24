/**
 * Lightweight capability helpers for local/provider models.
 * We prefer explicit metadata when available, and fall back to name heuristics.
 */
export function inferVisionSupportFromModelName(modelName: string): boolean {
  const lower = modelName.toLowerCase()

  const visionMarkers = [
    'vision',
    'vl',
    'llava',
    'bakllava',
    'minicpm-v',
    'qwen-vl',
    'qwen2-vl',
    'phi-3-vision',
    'llama3.2-vision'
  ]

  return visionMarkers.some((marker) => lower.includes(marker))
}

/**
 * Detect Ollama vision capability from /api/show payload.
 * Returns undefined when the payload does not contain enough signal.
 */
export function inferVisionSupportFromOllamaShowData(showData: unknown): boolean | undefined {
  if (!showData || typeof showData !== 'object') {
    return undefined
  }

  const typed = showData as {
    capabilities?: unknown
    model_info?: unknown
  }

  if (Array.isArray(typed.capabilities)) {
    const hasVisionCapability = typed.capabilities.some(
      (cap) => typeof cap === 'string' && cap.toLowerCase() === 'vision'
    )
    return hasVisionCapability
  }

  if (typed.model_info && typeof typed.model_info === 'object') {
    const modelInfoKeys = Object.keys(typed.model_info as Record<string, unknown>)
    const hasVisionMetadata = modelInfoKeys.some((key) => {
      const lower = key.toLowerCase()
      return lower.includes('.vision.') || lower.includes('.mm.')
    })
    if (hasVisionMetadata) {
      return true
    }
  }

  return undefined
}
