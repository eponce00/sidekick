/**
 * Client-side image compression for LLM vision payloads.
 *
 * Aggressively downsizes base64 images before sending them to the LLM
 * to minimize token/context usage, while the UI continues to display
 * full-resolution images via their original URLs.
 */

const LLM_VISION_MAX_DIMENSION = 256
const LLM_VISION_JPEG_QUALITY = 0.25

/**
 * Compress a base64 image for LLM vision context.
 * Resizes to a small dimension and re-encodes as low-quality JPEG.
 * Returns a much smaller base64 string suitable for the `images` array.
 */
export function compressImageForLLM(base64Data: string): Promise<string> {
  return new Promise((resolve) => {
    const src = base64Data.startsWith('data:')
      ? base64Data
      : `data:image/jpeg;base64,${base64Data}`

    const img = new Image()
    img.onload = (): void => {
      const { width, height } = img
      const scale = Math.min(1, LLM_VISION_MAX_DIMENSION / Math.max(width, height))
      const targetW = Math.max(1, Math.round(width * scale))
      const targetH = Math.max(1, Math.round(height * scale))

      const canvas = document.createElement('canvas')
      canvas.width = targetW
      canvas.height = targetH

      const ctx = canvas.getContext('2d')
      if (!ctx) {
        resolve(base64Data)
        return
      }

      ctx.drawImage(img, 0, 0, targetW, targetH)

      const dataUrl = canvas.toDataURL('image/jpeg', LLM_VISION_JPEG_QUALITY)
      const compressed = dataUrl.replace(/^data:image\/jpeg;base64,/, '')

      resolve(compressed)
    }

    img.onerror = (): void => {
      resolve(base64Data)
    }

    img.src = src
  })
}

/**
 * Compress multiple base64 images in parallel for LLM vision context.
 */
export async function compressImagesForLLM(base64Images: string[]): Promise<string[]> {
  return Promise.all(base64Images.map(compressImageForLLM))
}
