interface ResolvedContextDisplay {
  contextWindow: number
  reliable: boolean
}

export function resolveContextDisplay(
  selectedModel: string,
  configuredContextLength: number | undefined,
  resolvedContext: { value: number; reliable: boolean } | null,
  runtimeFallback: number
): ResolvedContextDisplay {
  if (configuredContextLength) {
    return { contextWindow: configuredContextLength, reliable: true }
  }
  if (resolvedContext?.reliable && resolvedContext.value > 0) {
    return { contextWindow: resolvedContext.value, reliable: true }
  }
  return {
    contextWindow: Math.max(1, runtimeFallback || 32_768),
    reliable: !selectedModel && runtimeFallback > 0
  }
}
