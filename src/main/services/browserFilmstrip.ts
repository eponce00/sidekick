import { nativeImage } from 'electron'

/** Widest filmstrip sent to the model: about one screenshot's worth of image tokens. */
export const FILMSTRIP_MAX_WIDTH = 1536
const FILMSTRIP_GAP = 8
/** A dark neutral between frames, so their edges read as separate pictures. */
const FILMSTRIP_GAP_SHADE = 0x40

export interface RawBitmap {
  /** Four bytes a pixel, in the platform's native order; the gap shade is grey in any order. */
  data: Buffer
  width: number
  height: number
}

/** Places same-height frames side by side, left to right, with a gap between them. */
export function composeBitmapsSideBySide(
  frames: readonly RawBitmap[],
  gap = FILMSTRIP_GAP
): RawBitmap {
  if (!frames.length) throw new Error('A filmstrip needs at least one frame')
  const height = Math.max(...frames.map((frame) => frame.height))
  const width = frames.reduce((sum, frame) => sum + frame.width, 0) + gap * (frames.length - 1)
  const data = Buffer.alloc(width * height * 4, FILMSTRIP_GAP_SHADE)
  for (let index = 3; index < data.length; index += 4) data[index] = 0xff
  let left = 0
  for (const frame of frames) {
    const rowBytes = frame.width * 4
    for (let row = 0; row < frame.height; row += 1) {
      frame.data.copy(data, (row * width + left) * 4, row * rowBytes, (row + 1) * rowBytes)
    }
    left += frame.width + gap
  }
  return { data, width, height }
}

/**
 * Several screenshots of the same viewport as one image, oldest on the left, so a model can see
 * motion while the request still carries a single image.
 */
export function composeFilmstrip(pngs: readonly Buffer[]): {
  jpeg: Buffer
  width: number
  height: number
} {
  const images = pngs.map((png) => nativeImage.createFromBuffer(png))
  const first = images[0]?.getSize()
  if (!first?.width || !first.height) throw new Error('A filmstrip frame could not be decoded')
  const frameWidth = Math.max(
    1,
    Math.min(
      first.width,
      Math.floor((FILMSTRIP_MAX_WIDTH - FILMSTRIP_GAP * (images.length - 1)) / images.length)
    )
  )
  const frameHeight = Math.max(1, Math.round((first.height * frameWidth) / first.width))
  const frames = images.map((image) => {
    const resized = image.resize({ width: frameWidth, height: frameHeight, quality: 'good' })
    const size = resized.getSize()
    return { data: resized.toBitmap(), width: size.width, height: size.height }
  })
  const strip = composeBitmapsSideBySide(frames)
  const jpeg = nativeImage
    .createFromBitmap(strip.data, { width: strip.width, height: strip.height })
    .toJPEG(82)
  return { jpeg, width: strip.width, height: strip.height }
}
