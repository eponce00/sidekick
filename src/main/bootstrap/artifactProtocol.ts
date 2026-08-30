import { net, protocol } from 'electron'
import { promises as fsPromises } from 'fs'
import { extname, join, normalize, relative } from 'path'
import { is } from '@electron-toolkit/utils'
import { resolveDevelopmentArtifactUrl } from './artifactProtocolSecurity'

const ARTIFACT_SCHEME = 'sidekick-artifact'
const BROWSER_ARTIFACT_SCHEME = 'sidekick-browser'
const MAX_BROWSER_ARTIFACT_BYTES = 8 * 1024 * 1024
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
let browserArtifactRoot: string | null = null
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
  '.webp': 'image/webp',
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
    },
    {
      scheme: BROWSER_ARTIFACT_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: false,
        corsEnabled: false
      }
    }
  ])
}

export function configureBrowserArtifactRoot(root: string): void {
  browserArtifactRoot = normalize(root)
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
      const target = resolveDevelopmentArtifactUrl(
        process.env['ELECTRON_RENDERER_URL'],
        pathname,
        requestUrl.search
      )
      if (!target) return new Response('Not found', { status: 404 })
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
  await protocol.handle(BROWSER_ARTIFACT_SCHEME, async (request) => {
    if (!browserArtifactRoot) return new Response('Not found', { status: 404 })
    const requestUrl = new URL(request.url)
    if (requestUrl.hostname !== 'artifact') return new Response('Not found', { status: 404 })
    let pathname: string
    try {
      pathname = decodeURIComponent(requestUrl.pathname)
    } catch {
      return new Response('Not found', { status: 404 })
    }
    const targetPath = resolveArtifactPath(browserArtifactRoot, pathname)
    const extension = targetPath ? extname(targetPath).toLowerCase() : ''
    if (!targetPath || extension !== '.png') {
      return new Response('Not found', { status: 404 })
    }
    try {
      const [realRoot, realTarget] = await Promise.all([
        fsPromises.realpath(browserArtifactRoot),
        fsPromises.realpath(targetPath)
      ])
      const realRelative = relative(realRoot, realTarget)
      if (!realRelative || realRelative.startsWith('..') || realRelative.includes(':')) {
        return new Response('Not found', { status: 404 })
      }
      const stat = await fsPromises.stat(realTarget)
      if (
        !stat.isFile() ||
        stat.size < PNG_SIGNATURE.length ||
        stat.size > MAX_BROWSER_ARTIFACT_BYTES
      ) {
        return new Response('Not found', { status: 404 })
      }
      const data = await fsPromises.readFile(realTarget)
      if (!data.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
        return new Response('Not found', { status: 404 })
      }
      return new Response(data, {
        headers: {
          'content-type': CONTENT_TYPES[extension] ?? 'application/octet-stream',
          'cache-control': 'no-store',
          'content-security-policy': "default-src 'none'",
          'x-content-type-options': 'nosniff'
        }
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}
