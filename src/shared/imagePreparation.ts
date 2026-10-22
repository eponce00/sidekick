import type { ToolResultImageMimeType } from './agentRuntime'
import type { ReadableImageMimeType } from './imageContent'
import type { ProviderKind } from './providerRegistry'

/** Larger than any real photo or screenshot; above this an image is refused, not reduced. */
export const MAX_IMAGE_INPUT_BYTES = 100 * 1024 * 1024
/**
 * Decoding takes four bytes per pixel, so this bounds the memory one image can claim. It matches
 * the order of Pillow's decompression-bomb limit and still fits 8K screens and phone panoramas.
 */
export const MAX_IMAGE_INPUT_PIXELS = 100_000_000
export const MAX_IMAGE_INPUT_DIMENSION = 32_768

/** What one provider's servers accept per image and per request. */
export interface ProviderImageProfile {
  /** Longest side worth sending; the model's own resizing discards anything larger. */
  maxLongEdge: number
  /** Total pixels worth sending, for models whose vision encoder works to a pixel budget. */
  maxPixels?: number
  /** Encoded bytes before base64. */
  maxBytes: number
  /** Formats sent as they are; anything else is converted to PNG or JPEG. */
  formats: readonly ToolResultImageMimeType[]
  /** Images per request, shared by attachments and tool screenshots. */
  maxImages: number
}

/** Fits 5 MB once base64-encoded: Anthropic on Bedrock and Vertex, and OpenCode's budget. */
const PORTABLE_IMAGE_BYTES = (5 * 1024 * 1024 * 3) / 4

// Anthropic rejects either side over 8000 px and advises 2000 px, the limit once a request holds
// more than 20 images. OpenAI's "high" detail fits 2048 px. Claude Code and OpenCode send 2000.
const CLOUD: ProviderImageProfile = {
  maxLongEdge: 2000,
  maxBytes: PORTABLE_IMAGE_BYTES,
  formats: ['image/png', 'image/jpeg', 'image/webp'],
  maxImages: 4
}

// Local vision encoders (Qwen-VL, Gemma 3, llama.cpp's) work to about 1.3 megapixels, and
// llama.cpp decodes with stb_image, which reads neither WebP nor AVIF.
const LOCAL: ProviderImageProfile = {
  maxLongEdge: 1568,
  maxPixels: 1280 * 32 * 32,
  maxBytes: PORTABLE_IMAGE_BYTES,
  formats: ['image/png', 'image/jpeg'],
  // Local vision gateways commonly cap a request at two images.
  maxImages: 2
}

/** The longest side any provider is sent; OpenAI's "high" detail fits 2048 px. */
export const MAX_PREPARED_IMAGE_LONG_EDGE = 2048

// A gateway or self-hosted server may front any model, including a local one.
const GATEWAY: ProviderImageProfile = {
  ...CLOUD,
  maxLongEdge: MAX_PREPARED_IMAGE_LONG_EDGE,
  maxImages: 2
}

const PROFILES: Readonly<Record<ProviderKind, ProviderImageProfile>> = {
  anthropic: CLOUD,
  openrouter: CLOUD,
  litellm: GATEWAY,
  'openai-compatible': GATEWAY,
  lmstudio: LOCAL,
  llamacpp: LOCAL,
  ollama: LOCAL,
  'ollama-cloud': LOCAL
}

export function providerImageProfile(kind: ProviderKind | undefined): ProviderImageProfile {
  return (kind && PROFILES[kind]) || GATEWAY
}

export interface ImageSourceInfo {
  mimeType: ReadableImageMimeType
  /** As shown, after any EXIF rotation. */
  width: number
  height: number
  bytes: number
  orientation?: number
}

export interface ImagePreparationPlan {
  width: number
  height: number
  /** The pixel size changes. */
  resize: boolean
  /** The image must be decoded and encoded again; false means its bytes are sent unchanged. */
  reencode: boolean
}

export interface ImagePreparationOptions {
  /**
   * The model points at this image by pixel coordinates, so its size is kept unless a provider
   * cannot take it at all. It is still re-encoded to fit the byte limit.
   */
  keepDimensions?: boolean
}

/** Anthropic's hard limit, the strictest any provider sets. */
export const MAX_PROVIDER_IMAGE_DIMENSION = 8000

function fitScale(width: number, height: number, longEdge: number, pixels?: number): number {
  let scale = Math.min(1, longEdge / Math.max(width, height))
  if (pixels && width * height * scale * scale > pixels) {
    scale = Math.sqrt(pixels / (width * height))
  }
  return scale
}

/** The size and treatment an image needs to fit a provider, without decoding it. */
export function planImagePreparation(
  source: ImageSourceInfo,
  profile: ProviderImageProfile,
  options: ImagePreparationOptions = {}
): ImagePreparationPlan {
  const scale = options.keepDimensions
    ? fitScale(source.width, source.height, MAX_PROVIDER_IMAGE_DIMENSION)
    : fitScale(source.width, source.height, profile.maxLongEdge, profile.maxPixels)
  // Rounding down keeps the result inside both limits; the epsilon keeps exact fits exact.
  const width = Math.max(1, Math.floor(source.width * scale + 1e-6))
  const height = Math.max(1, Math.floor(source.height * scale + 1e-6))
  const resize = width !== source.width || height !== source.height
  return {
    width,
    height,
    resize,
    reencode:
      resize ||
      source.bytes > profile.maxBytes ||
      !(profile.formats as readonly string[]).includes(source.mimeType) ||
      source.orientation !== undefined
  }
}

/**
 * One line for the person when the copy a model receives is smaller than what they attached, or
 * nothing when it gets the image as it is. A change of format alone is not worth mentioning.
 */
export function describeImageReduction(
  source: ImageSourceInfo,
  profile: ProviderImageProfile
): string | undefined {
  const plan = planImagePreparation(source, profile)
  if (plan.resize) {
    return `This model receives a ${plan.width} × ${plan.height} copy. The original stays in the chat.`
  }
  if (source.bytes > profile.maxBytes) {
    return 'This model receives a smaller copy. The original stays in the chat.'
  }
  return undefined
}
