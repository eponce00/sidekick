import { app, net, protocol, type Protocol } from 'electron'
import { existsSync, promises as fsPromises } from 'fs'
import { dirname, extname, join, normalize, parse, relative } from 'path'
import { is } from '@electron-toolkit/utils'
import { resolveDevelopmentArtifactUrl } from './artifactProtocolSecurity'
import {
  BROWSER_PDF_SCHEME,
  browserPdfSessionBytes,
  browserPdfSessionSignal,
  browserPdfPublicationDirectory,
  getBrowserPdfSession,
  type BrowserPdfSession
} from './browserPdfSessionRegistry'
import {
  BROWSER_PDF_VIEWER_CSS,
  BROWSER_PDF_VIEWER_HTML,
  BROWSER_PDF_VIEWER_MODULE
} from './browserPdfViewerAssets'
import { renderBrowserPdfPage } from './browserPdfRenderer'
import { BrowserPdfSnapshotError } from './browserPdfSnapshot'
import { atomicNewFile } from '../utils/atomicNewFile'
import { readBoundedRequestBody, RequestBodyTooLargeError } from '../utils/boundedRequestBody'

const ARTIFACT_SCHEME = 'sidekick-artifact'
const BROWSER_ARTIFACT_SCHEME = 'sidekick-browser'
const MAX_BROWSER_ARTIFACT_BYTES = 8 * 1024 * 1024
const MAX_BROWSER_PDF_SAVE_BYTES = 256 * 1024 * 1024
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
let browserArtifactRoot: string | null = null
const pdfProtocolInstallations = new WeakSet<object>()
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
    },
    {
      scheme: BROWSER_PDF_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        // ES modules and the PDF.js worker are loaded from this same locked,
        // token-scoped origin and require Chromium's CORS-enabled scheme path.
        corsEnabled: true
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

function browserPdfAssetResponse(body: BodyInit, contentType: string): Response {
  return new Response(body, {
    headers: {
      'content-type': contentType,
      'cache-control': 'no-store',
      'content-security-policy':
        "default-src 'none'; script-src 'self' 'unsafe-eval'; style-src 'self'; connect-src 'self'; worker-src 'self' blob:; img-src 'self' data: blob:; font-src 'self'",
      'x-content-type-options': 'nosniff'
    }
  })
}

function browserPdfRoute(requestUrl: URL): string | null {
  if (requestUrl.hostname !== 'viewer') return null
  const parts = requestUrl.pathname.split('/').filter(Boolean)
  if (parts.length !== 2 || !/^[0-9a-f-]{36}$/i.test(parts[0])) return null
  return parts[1]
}

function resolvePdfJsAssetPath(filename: 'pdf.min.mjs' | 'pdf.worker.min.mjs'): string | null {
  const candidates = [
    join(app.getAppPath(), 'node_modules', 'pdfjs-dist', 'build', filename),
    join(process.cwd(), 'node_modules', 'pdfjs-dist', 'build', filename)
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

async function writeFilledPdf(
  session: BrowserPdfSession,
  bytes: Buffer,
  signal: AbortSignal
): Promise<string> {
  signal.throwIfAborted()
  const publication = await browserPdfPublicationDirectory(session)
  await publication.prepare(signal)
  const outputDirectory = session.outputDirectory ?? dirname(session.sourcePath)
  const source = parse(session.sourceName)
  const sourceName = source.name || 'document'
  const sourceExtension = source.ext.toLowerCase() === '.pdf' ? source.ext : '.pdf'
  for (let index = 0; index < 10_000; index++) {
    signal.throwIfAborted()
    await publication.assertUnchanged(signal)
    const suffix = index === 0 ? '-filled' : `-filled-${index + 1}`
    const candidate = join(outputDirectory, `${sourceName}${suffix}${sourceExtension}`)
    // Avoid rewriting a large stage for names already occupied (including symlinks).
    // This is only an optimization; the exclusive hard link remains the race guard.
    try {
      await fsPromises.lstat(candidate)
      continue
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    try {
      // Atomic publication retains private 0600 stage permissions on POSIX. No
      // copy/overwrite fallback is permitted when the filesystem lacks hard links.
      await atomicNewFile(
        candidate,
        (handle) => handle.writeFile(bytes, { signal }),
        signal,
        () => publication.assertUnchanged()
      )
      return candidate
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw error
    }
  }
  throw new Error('Could not allocate a filename for the filled PDF')
}

async function saveBrowserPdf(request: Request, session: BrowserPdfSession): Promise<Response> {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 })
  const signal = AbortSignal.any([request.signal, browserPdfSessionSignal(session)])
  try {
    const bytes = await readBoundedRequestBody(request, MAX_BROWSER_PDF_SAVE_BYTES, signal)
    if (bytes.byteLength < 5 || !bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
      throw new Error('The browser did not produce a valid PDF')
    }
    // The publisher's hard link is the commit point. Revocation after that point
    // must never delete an already-published valid copy.
    const outputPath = await writeFilledPdf(session, bytes, signal)
    session.lastOutputPath = outputPath
    return new Response(JSON.stringify({ outputPath }), {
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
    })
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
      {
        status: error instanceof RequestBodyTooLargeError ? 413 : 400,
        headers: { 'content-type': 'application/json; charset=utf-8' }
      }
    )
  }
}

async function handleBrowserPdfRequest(request: Request): Promise<Response> {
  const requestUrl = new URL(request.url)
  const route = browserPdfRoute(requestUrl)
  const session = getBrowserPdfSession(request.url)
  if (!route || !session) return new Response('Not found', { status: 404 })

  if (route === 'index.html') {
    return browserPdfAssetResponse(BROWSER_PDF_VIEWER_HTML, 'text/html; charset=utf-8')
  }
  if (route === 'viewer.css') {
    return browserPdfAssetResponse(BROWSER_PDF_VIEWER_CSS, 'text/css; charset=utf-8')
  }
  if (route === 'viewer.mjs') {
    return browserPdfAssetResponse(BROWSER_PDF_VIEWER_MODULE, 'text/javascript; charset=utf-8')
  }
  if (route === 'metadata.json') {
    return browserPdfAssetResponse(
      JSON.stringify({ name: session.sourceName }),
      'application/json; charset=utf-8'
    )
  }
  if (route === 'document.pdf') {
    try {
      const data = await browserPdfSessionBytes(session)
      return browserPdfAssetResponse(data, 'application/pdf')
    } catch (error) {
      const safe =
        error instanceof BrowserPdfSnapshotError ? error : new BrowserPdfSnapshotError('unreadable')
      const status =
        safe.code === 'unavailable'
          ? 404
          : safe.code === 'oversized'
            ? 413
            : safe.code === 'changed'
              ? 409
              : 400
      return new Response(JSON.stringify({ error: safe.message }), {
        status,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
      })
    }
  }
  const pageMatch = /^page-(\d+)\.png$/.exec(route)
  if (pageMatch) {
    const pageNumber = Number(pageMatch[1])
    const requestedScale = Number(requestUrl.searchParams.get('scale') ?? 2)
    const scale = Math.max(0.5, Math.min(4, Number.isFinite(requestedScale) ? requestedScale : 2))
    const cacheKey = `${pageNumber}@${scale}`
    let rendering = session.renderedPages.get(cacheKey)
    if (!rendering) {
      rendering = browserPdfSessionBytes(session).then((bytes) =>
        renderBrowserPdfPage(bytes, pageNumber, scale)
      )
      session.renderedPages.set(cacheKey, rendering)
    }
    try {
      return browserPdfAssetResponse(new Uint8Array(await rendering), 'image/png')
    } catch (error) {
      session.renderedPages.delete(cacheKey)
      return new Response(error instanceof Error ? error.message : 'Could not render PDF page', {
        status: 500
      })
    }
  }
  if (route === 'pdf.mjs' || route === 'pdf.worker.mjs') {
    try {
      const assetPath = resolvePdfJsAssetPath(
        route === 'pdf.mjs' ? 'pdf.min.mjs' : 'pdf.worker.min.mjs'
      )
      if (!assetPath) throw new Error('PDF.js runtime asset is missing')
      const data = await fsPromises.readFile(assetPath)
      return browserPdfAssetResponse(data, 'text/javascript; charset=utf-8')
    } catch {
      return new Response('PDF renderer unavailable', { status: 500 })
    }
  }
  if (route === 'save') return saveBrowserPdf(request, session)
  return new Response('Not found', { status: 404 })
}

/** Install the PDF surface on an Electron session, including isolated browser partitions. */
export async function installBrowserPdfProtocol(target: Protocol): Promise<void> {
  if (pdfProtocolInstallations.has(target)) return
  await target.handle(BROWSER_PDF_SCHEME, handleBrowserPdfRequest)
  pdfProtocolInstallations.add(target)
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
  await installBrowserPdfProtocol(protocol)
}
