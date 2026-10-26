// Renders every composition to an animated WebP in docs/assets/media for the README.
// Run `npm run capture` first when the app's look changed; Python with Pillow does the packing.
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const MEDIA = dirname(fileURLToPath(import.meta.url))
const OUT = join(MEDIA, '..', 'docs', 'assets', 'media')
const FRAMES = join(MEDIA, 'out', 'frames')
const only = process.argv.slice(2)
const compositions = ['hero', 'agent', 'artifacts', 'team', 'panel'].filter(
  (id) => !only.length || only.includes(id)
)
mkdirSync(OUT, { recursive: true })

for (const id of compositions) {
  const frames = join(FRAMES, id)
  rmSync(frames, { recursive: true, force: true })
  execFileSync(
    process.execPath,
    [
      join(MEDIA, 'node_modules', '@remotion', 'cli', 'remotion-cli.js'),
      'render',
      'src/index.ts',
      id,
      frames,
      '--sequence',
      '--image-format=png',
      // Twice the size it shows at in the README, so text stays sharp on high-density screens.
      '--scale=1.5',
      '--log=error'
    ],
    { cwd: MEDIA, stdio: 'inherit' }
  )
  execFileSync(
    'python',
    ['-I', join(MEDIA, 'encode.py'), frames, join(OUT, `${id}.webp`), '30', '1'],
    {
      stdio: 'inherit'
    }
  )
  rmSync(frames, { recursive: true, force: true })
}
