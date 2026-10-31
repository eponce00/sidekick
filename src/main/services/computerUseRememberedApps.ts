import { createHash } from 'crypto'
import { createReadStream, promises as fs } from 'fs'
import { basename, dirname } from 'path'
import type { ComputerRememberedApp } from '../../shared/computerUse'

interface StoredApp extends ComputerRememberedApp {
  sha256: string
}

function sha256(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')))
  })
}

/**
 * The apps the user chose to always allow, kept apart from settings because only SideKick's own
 * dialog may add to them. Each is tied to its executable's contents: an app that changes, whether by
 * an update or a swapped file, has to ask again.
 */
export class ComputerUseRememberedApps {
  constructor(private readonly file: () => string) {}

  private async read(): Promise<StoredApp[]> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file(), 'utf8')) as unknown
      return Array.isArray(parsed)
        ? (parsed as StoredApp[]).filter(
            (app) => typeof app?.path === 'string' && typeof app.sha256 === 'string'
          )
        : []
    } catch {
      return []
    }
  }

  private async write(apps: StoredApp[]): Promise<void> {
    const file = this.file()
    await fs.mkdir(dirname(file), { recursive: true })
    await fs.writeFile(`${file}.tmp`, JSON.stringify(apps, null, 2), 'utf8')
    await fs.rename(`${file}.tmp`, file)
  }

  async has(path: string): Promise<boolean> {
    const key = path.toLowerCase()
    const stored = (await this.read()).find((app) => app.path.toLowerCase() === key)
    if (!stored) return false
    return (await sha256(path).catch(() => null)) === stored.sha256
  }

  async add(path: string): Promise<void> {
    const key = path.toLowerCase()
    const others = (await this.read()).filter((app) => app.path.toLowerCase() !== key)
    await this.write([
      ...others,
      { path, name: basename(path).replace(/\.exe$/i, ''), sha256: await sha256(path) }
    ])
  }

  async list(): Promise<ComputerRememberedApp[]> {
    return (await this.read()).map(({ path, name }) => ({ path, name }))
  }

  async remove(path: string): Promise<void> {
    const key = path.toLowerCase()
    await this.write((await this.read()).filter((app) => app.path.toLowerCase() !== key))
  }
}
