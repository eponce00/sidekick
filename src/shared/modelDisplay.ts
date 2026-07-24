export interface ModelDisplaySource {
  id: string
  name?: string
  providerModelId?: string
}

export interface ModelDisplayInfo {
  label: string
  vendor?: string
  modelIdLabel: string
  fullId: string
  fullName: string
}

const VENDOR_LABELS: Record<string, string> = {
  ai21: 'AI21',
  anthropic: 'Anthropic',
  cohere: 'Cohere',
  deepseek: 'DeepSeek',
  google: 'Google',
  meta: 'Meta',
  'meta-llama': 'Meta',
  microsoft: 'Microsoft',
  minimax: 'MiniMax',
  mistral: 'Mistral AI',
  mistralai: 'Mistral AI',
  moonshotai: 'Moonshot AI',
  nvidia: 'NVIDIA',
  nousresearch: 'Nous Research',
  openai: 'OpenAI',
  qwen: 'Qwen',
  'x-ai': 'xAI',
  'z-ai': 'Z.ai'
}

const VENDOR_PREFIX_ALIASES: Record<string, string[]> = {
  'meta-llama': ['Meta AI'],
  mistralai: ['Mistral'],
  moonshotai: ['Moonshot'],
  nousresearch: ['Nous']
}

function normalizeIdentity(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function titleCaseVendor(value: string): string {
  return value
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function vendorLabel(vendorId: string): string {
  return VENDOR_LABELS[vendorId.toLowerCase()] || titleCaseVendor(vendorId)
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function stripMatchingVendorPrefix(name: string, vendorId: string, vendor: string): string {
  const candidates = [
    vendor,
    vendorId,
    vendorId.replace(/[-_.]+/g, ''),
    ...(VENDOR_PREFIX_ALIASES[vendorId.toLowerCase()] || [])
  ]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)

  for (const candidate of candidates) {
    const match = name.match(
      new RegExp(`^${escapeRegex(candidate)}(?:\\s*[:–—-]\\s*|\\s+)(.+)$`, 'i')
    )
    if (match?.[1]?.trim()) return match[1].trim()
  }

  const colonIndex = name.indexOf(':')
  if (colonIndex > 0) {
    const prefix = name.slice(0, colonIndex)
    if (
      normalizeIdentity(prefix) === normalizeIdentity(vendorId) ||
      normalizeIdentity(prefix) === normalizeIdentity(vendor)
    ) {
      const remainder = name.slice(colonIndex + 1).trim()
      if (remainder) return remainder
    }
  }

  return name
}

export function getModelDisplayInfo(model: ModelDisplaySource): ModelDisplayInfo {
  const fullId = (model.providerModelId || model.id).trim()
  const catalogId = fullId.replace(/^~/, '')
  const segments = catalogId.split('/').filter(Boolean)
  const vendorId = segments.length > 1 ? segments[0] : ''
  const modelIdLabel = segments.length > 1 ? segments[segments.length - 1] : catalogId
  const vendor = vendorId ? vendorLabel(vendorId) : undefined
  const fullName = model.name?.trim() || fullId
  const nameIsId =
    fullName.toLowerCase() === fullId.toLowerCase() ||
    fullName.toLowerCase() === catalogId.toLowerCase()
  const unqualifiedName = nameIsId
    ? modelIdLabel
    : vendor
      ? stripMatchingVendorPrefix(fullName, vendorId, vendor)
      : fullName
  const labelSegments = unqualifiedName.split('/').filter(Boolean)
  const label =
    (labelSegments.length > 1 ? labelSegments[labelSegments.length - 1] : unqualifiedName).trim() ||
    modelIdLabel ||
    fullId

  return { label, vendor, modelIdLabel, fullId, fullName }
}

export function compactModelLabel(model: ModelDisplaySource, maxLength = 28): string {
  const label = getModelDisplayInfo(model).label
  if (label.length <= maxLength) return label

  const visibleChars = Math.max(2, maxLength - 3)
  const startLength = Math.ceil(visibleChars * 0.65)
  const endLength = Math.floor(visibleChars * 0.35)
  return `${label.slice(0, startLength)}...${label.slice(-endLength)}`
}

export function uniqueModelMetadata(parts: Array<string | undefined>): string[] {
  const seen = new Set<string>()
  return parts.filter((part): part is string => {
    const trimmed = part?.trim()
    if (!trimmed) return false
    const identity = normalizeIdentity(trimmed)
    if (!identity || seen.has(identity)) return false
    seen.add(identity)
    return true
  })
}
