import { net, protocol } from 'electron'
import { promises as fsPromises } from 'fs'
import { extname, join, normalize, relative } from 'path'
import { is } from '@electron-toolkit/utils'

const ARTIFACT_SCHEME = 'sidekick-artifact'
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.woff2': 'font/woff2'
}

export function registerArtifactScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: ARTIFACT_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true
      }
    }
  ])
}

function resolveArtifactPath(rendererRoot: string, pathname: string): string | null {
  const targetPath = normalize(join(rendererRoot, pathname.replace(/^\/+/, '')))
  const rel = relative(rendererRoot, targetPath)
  return rel.startsWith('..') || rel.includes(':') ? null : targetPath
}

export async function installArtifactProtocol(): Promise<void> {
  await protocol.handle(ARTIFACT_SCHEME, async (request) => {
    const requestUrl = new URL(request.url)
    const pathname = requestUrl.pathname === '/' ? '/sandbox.html' : requestUrl.pathname

    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      const target = new URL(pathname + requestUrl.search, process.env['ELECTRON_RENDERER_URL'])
      return net.fetch(target.toString())
    }

    const rendererRoot = normalize(join(__dirname, '../renderer'))
    const targetPath = resolveArtifactPath(rendererRoot, pathname)
    if (!targetPath) return new Response('Not found', { status: 404 })

    try {
      const data = await fsPromises.readFile(targetPath)
      return new Response(data, {
        headers: {
          'content-type':
            CONTENT_TYPES[extname(targetPath).toLowerCase()] ?? 'application/octet-stream',
          'cache-control': 'no-store'
        }
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}
