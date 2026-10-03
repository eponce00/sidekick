import { randomUUID } from 'crypto'
import { mkdir, readdir, stat, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { browserArtifactRoot } from './browserArtifactRoot'

const PREVIEW_DIRECTORY = 'viewed-images'
const PREVIEW_MAX_WIDTH = 1280
const PREVIEW_QUALITY = 82
const PREVIEWS_KEPT = 300

/**
 * Keeps a reduced copy of an image the model looked at, so its tool row can show it. The image
 * itself may be anywhere the model was allowed to read, which the renderer cannot open; the copy
 * is served from the browser artifact store like a screenshot. Returns nothing when no store is
 * configured or the image cannot be decoded, and the row then shows its path alone.
 */
export async function saveViewedImagePreview(bytes: Buffer): Promise<string | undefined> {
  const root = browserArtifactRoot()
  if (!root) return undefined
  try {
    const { nativeImage } = await import('electron')
    let image = nativeImage.createFromBuffer(bytes)
    if (image.isEmpty()) return undefined
    if (image.getSize().width > PREVIEW_MAX_WIDTH) {
      image = image.resize({ width: PREVIEW_MAX_WIDTH, quality: 'good' })
    }
    const directory = join(root, PREVIEW_DIRECTORY)
    await mkdir(directory, { recursive: true })
    const name = `${randomUUID()}.jpg`
    await writeFile(join(directory, name), image.toJPEG(PREVIEW_QUALITY))
    void pruneViewedImagePreviews(directory).catch(() => undefined)
    return `sidekick-browser://artifact/${PREVIEW_DIRECTORY}/${name}`
  } catch {
    return undefined
  }
}

/** Keeps the newest previews; an older conversation shows the path where its image was. */
async function pruneViewedImagePreviews(directory: string): Promise<void> {
  const names = (await readdir(directory)).filter((name) => name.endsWith('.jpg'))
  if (names.length <= PREVIEWS_KEPT) return
  const dated = await Promise.all(
    names.map(async (name) => ({ name, at: (await stat(join(directory, name))).mtimeMs }))
  )
  dated.sort((left, right) => right.at - left.at)
  await Promise.all(dated.slice(PREVIEWS_KEPT).map(({ name }) => unlink(join(directory, name))))
}
