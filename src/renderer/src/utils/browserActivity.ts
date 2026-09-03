import type { AgentRunEvent } from '../../../shared/agentRuntime'

export type BrowserActivityItemStatus =
  | 'pending'
  | 'running'
  | 'success'
  | 'partial'
  | 'error'
  | 'denied'

export interface BrowserActivityItem {
  callId: string
  name: string
  title: string
  status: BrowserActivityItemStatus
  startedAt: number
  completedAt?: number
  summary?: string
}

export interface BrowserViewport {
  width: number
  height: number
  deviceScaleFactor?: number
}

export interface BrowserActivityPointer {
  x: number
  y: number
  action: string
  targetMode?: string
  updatedAt?: number
}

export interface BrowserVerification {
  status: 'running' | 'review' | 'passed' | 'failed'
  label: string
}

export interface BrowserActivityState {
  hasActivity: boolean
  runId?: string
  lastSequence: number
  screenshot?: string
  screenshotKind?: 'viewport' | 'fullPage' | 'element'
  screenshotSize?: { width: number; height: number }
  pageTitle?: string
  url?: string
  sessionId?: string
  sessionState?: string
  viewport?: BrowserViewport
  pointer?: BrowserActivityPointer
  latestAction?: string
  progress?: string
  verification?: BrowserVerification
  consoleErrors: string[]
  failedRequests: string[]
  timeline: BrowserActivityItem[]
  toolNames: Record<string, string>
}

export const EMPTY_BROWSER_ACTIVITY: BrowserActivityState = {
  hasActivity: false,
  lastSequence: 0,
  consoleErrors: [],
  failedRequests: [],
  timeline: [],
  toolNames: {}
}

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function cleanString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const clean = value.trim()
  return clean || undefined
}

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, '')
}

function collectRecords(root: unknown, maxDepth = 4): UnknownRecord[] {
  if (!isRecord(root)) return []
  const records: UnknownRecord[] = []
  const seen = new Set<object>()
  const queue: Array<{ value: UnknownRecord; depth: number }> = [{ value: root, depth: 0 }]
  while (queue.length) {
    const current = queue.shift()
    if (!current || seen.has(current.value)) continue
    seen.add(current.value)
    records.push(current.value)
    if (current.depth >= maxDepth) continue
    for (const value of Object.values(current.value)) {
      if (isRecord(value)) queue.push({ value, depth: current.depth + 1 })
      else if (Array.isArray(value)) {
        for (const item of value) {
          if (isRecord(item)) queue.push({ value: item, depth: current.depth + 1 })
        }
      }
    }
  }
  return records
}

function firstValue(records: UnknownRecord[], keys: readonly string[]): unknown {
  const wanted = new Set(keys.map(normalizedKey))
  for (const record of records) {
    for (const [key, value] of Object.entries(record)) {
      if (wanted.has(normalizedKey(key)) && value !== undefined && value !== null) return value
    }
  }
  return undefined
}

function firstString(records: UnknownRecord[], keys: readonly string[]): string | undefined {
  const value = firstValue(records, keys)
  return cleanString(value)
}

function preferredString(records: UnknownRecord[], keys: readonly string[]): string | undefined {
  for (const preferredKey of keys) {
    const wanted = normalizedKey(preferredKey)
    for (const record of records) {
      for (const [key, value] of Object.entries(record)) {
        if (normalizedKey(key) === wanted) {
          const clean = cleanString(value)
          if (clean) return clean
        }
      }
    }
  }
  return undefined
}

function sourceFromPath(value: string): string | undefined {
  const clean = value.trim()
  if (!clean) return undefined
  if (/^(?:data:image\/|blob:|https?:\/\/|sidekick-browser:\/\/)/i.test(clean)) {
    return clean
  }
  // Never turn a path from event data into an arbitrary file:// renderer read.
  // Browser screenshots are exposed through the locked sidekick-browser scheme.
  return undefined
}

function sourceFromImageRecord(record: UnknownRecord): string | undefined {
  const source = isRecord(record.source) ? record.source : undefined
  const sources = source ? [record, source] : [record]
  const direct = preferredString(sources, [
    'dataUrl',
    'imageUrl',
    'screenshotUrl',
    'url',
    'screenshotPath',
    'filePath',
    'path'
  ])
  const directSource = direct ? sourceFromPath(direct) : undefined
  if (directSource) return directSource

  const encoded = firstString(sources, ['base64', 'data', 'bytes'])
  if (!encoded) return undefined
  const mime = firstString(sources, ['mimeType', 'mediaType', 'mime']) ?? 'image/png'
  if (!mime.startsWith('image/')) return undefined
  return encoded.startsWith('data:image/') ? encoded : `data:${mime};base64,${encoded}`
}

interface BrowserScreenshotInfo {
  source: string
  kind?: BrowserActivityState['screenshotKind']
  width?: number
  height?: number
}

function screenshotInfo(source: string, records: UnknownRecord[]): BrowserScreenshotInfo {
  const rawKind = firstString(records, ['kind', 'screenshotKind'])
  const kind =
    rawKind === 'viewport' || rawKind === 'fullPage' || rawKind === 'element' ? rawKind : undefined
  const width = Number(firstValue(records, ['width', 'screenshotWidth']))
  const height = Number(firstValue(records, ['height', 'screenshotHeight']))
  return {
    source,
    ...(kind ? { kind } : {}),
    ...(Number.isFinite(width) && width > 0 ? { width } : {}),
    ...(Number.isFinite(height) && height > 0 ? { height } : {})
  }
}

function findScreenshot(root: unknown): BrowserScreenshotInfo | undefined {
  if (!isRecord(root)) return undefined
  const records = collectRecords(root)
  for (const record of records) {
    const type = firstString([record], ['type', 'kind'])?.toLowerCase()
    const mimeType = firstString([record], ['mimeType', 'mediaType', 'mime'])?.toLowerCase()
    if (mimeType?.startsWith('image/')) {
      const source = sourceFromImageRecord(record)
      if (source) return screenshotInfo(source, [record])
    }
    if (type === 'image' || type === 'screenshot' || type === 'image_url') {
      const source = sourceFromImageRecord(record)
      if (source) return screenshotInfo(source, [record])
    }
    for (const [key, value] of Object.entries(record)) {
      const normalized = normalizedKey(key)
      if (
        !normalized.includes('screenshot') &&
        normalized !== 'image' &&
        normalized !== 'imageurl'
      ) {
        continue
      }
      if (typeof value === 'string') {
        const source = sourceFromPath(value)
        if (source) return screenshotInfo(source, [record])
        if (/^(?:iVBOR|\/9j\/|UklGR)/.test(value)) {
          return screenshotInfo(`data:image/png;base64,${value}`, [record])
        }
      }
      if (isRecord(value)) {
        const source = sourceFromImageRecord(value)
        if (source) return screenshotInfo(source, [value, record])
      }
    }
  }
  return undefined
}

function pointerProjection(records: UnknownRecord[]): {
  present: boolean
  value?: BrowserActivityPointer
} {
  for (const record of records) {
    for (const [key, raw] of Object.entries(record)) {
      if (!['pointer', 'lastpointer', 'cursor', 'cursorposition'].includes(normalizedKey(key))) {
        continue
      }
      if (raw === null) return { present: true }
      if (!isRecord(raw)) continue
      const x = Number(firstValue([raw], ['x']))
      const y = Number(firstValue([raw], ['y']))
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) {
        return { present: true }
      }
      return {
        present: true,
        value: {
          x,
          y,
          action: firstString([raw], ['action']) ?? 'interact',
          ...(firstString([raw], ['targetMode'])
            ? { targetMode: firstString([raw], ['targetMode']) }
            : {}),
          ...(Number.isFinite(Number(firstValue([raw], ['updatedAt'])))
            ? { updatedAt: Number(firstValue([raw], ['updatedAt'])) }
            : {})
        }
      }
    }
  }
  return { present: false }
}

function humanizeToolName(name: string): string {
  return name
    .replace(/^browser_/, '')
    .split('_')
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join(' ')
}

function stringList(records: UnknownRecord[], keys: readonly string[]): string[] | undefined {
  const raw = firstValue(records, keys)
  if (!Array.isArray(raw)) return undefined
  return raw
    .map((item) => {
      if (typeof item === 'string') return item.trim()
      if (!isRecord(item)) return ''
      const message = firstString([item], ['message', 'text', 'error', 'url', 'requestUrl'])
      const status = firstString([item], ['status', 'statusText', 'code'])
      return [message, status].filter(Boolean).join(' · ')
    })
    .filter(Boolean)
    .slice(-8)
}

function consoleErrorList(records: UnknownRecord[]): string[] | undefined {
  const explicit = stringList(records, ['consoleErrors', 'consoleError', 'pageErrors'])
  const consoleEntries = firstValue(records, ['console'])
  if (!Array.isArray(consoleEntries)) return explicit
  const captured = consoleEntries
    .filter((item) => isRecord(item) && String(item.level || '').toLowerCase() === 'error')
    .map((item) => (isRecord(item) ? firstString([item], ['message', 'text', 'error']) : undefined))
    .filter((item): item is string => Boolean(item))
  const merged = [...(explicit ?? []), ...captured]
  return merged.length ? [...new Set(merged)].slice(-8) : undefined
}

function failedRequestList(records: UnknownRecord[]): string[] | undefined {
  const raw = firstValue(records, ['failedRequests', 'requestFailures', 'networkErrors'])
  if (!Array.isArray(raw)) return undefined
  const failures = raw
    .map((item) => {
      if (typeof item === 'string') return item.trim()
      if (!isRecord(item)) return ''
      const url = firstString([item], ['url', 'requestUrl'])
      const error = firstString([item], ['errorText', 'message', 'error', 'statusText', 'status'])
      return [url, error].filter(Boolean).join(' · ')
    })
    .filter(Boolean)
  return failures.length ? failures.slice(-8) : undefined
}

function parseViewport(records: UnknownRecord[]): BrowserViewport | undefined {
  const viewport = firstValue(records, ['viewport', 'viewportSize', 'screen'])
  const source = isRecord(viewport) ? viewport : undefined
  if (!source) return undefined
  const width = Number(firstValue([source], ['width', 'viewportWidth']))
  const height = Number(firstValue([source], ['height', 'viewportHeight']))
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return undefined
  }
  const scale = Number(firstValue([source], ['deviceScaleFactor', 'dpr', 'scaleFactor']))
  return {
    width: Math.round(width),
    height: Math.round(height),
    ...(Number.isFinite(scale) && scale > 0 ? { deviceScaleFactor: scale } : {})
  }
}

function resultFor(event: AgentRunEvent): UnknownRecord | undefined {
  return isRecord(event.payload.result) ? event.payload.result : undefined
}

function callIdFor(event: AgentRunEvent): string {
  return String(
    event.payload.toolCallId || event.payload.callId || `${event.runId}:${event.sequence}`
  )
}

function toolNameFor(event: AgentRunEvent, state: BrowserActivityState): string | undefined {
  const callId = callIdFor(event)
  const result = resultFor(event)
  const name =
    cleanString(event.payload.name) ?? firstString(result ? [result] : [], ['name', 'toolName'])
  return name ?? state.toolNames[callId]
}

function statusFor(event: AgentRunEvent, result?: UnknownRecord): BrowserActivityItemStatus {
  if (event.type === 'tool.pending') return 'pending'
  if (event.type === 'tool.running' || event.type === 'tool.output.delta') return 'running'
  const status = firstString(result ? [result] : [], ['status'])?.toLowerCase()
  if (status === 'success') return 'success'
  if (status === 'denied') return 'denied'
  const data = result && isRecord(result.data) ? result.data : undefined
  if (data?.outcome === 'partial') return 'partial'
  return 'error'
}

function verificationFor(
  name: string,
  status: BrowserActivityItemStatus,
  records: UnknownRecord[]
): BrowserVerification | undefined {
  const raw = firstValue(records, ['verification', 'verified', 'passed'])
  const verificationRecord = isRecord(raw) ? raw : undefined
  const explicitStatus = (
    verificationRecord
      ? firstString([verificationRecord], ['status', 'state'])
      : typeof raw === 'string'
        ? raw
        : undefined
  )?.toLowerCase()
  const evidenceCaptured = ['evidence', 'captured', 'review', 'ready_for_review'].includes(
    explicitStatus ?? ''
  )
  const explicitPassed =
    raw === true ||
    firstValue(records, ['passed', 'verified']) === true ||
    explicitStatus === 'passed'
  const explicitFailed =
    raw === false ||
    firstValue(records, ['passed', 'verified']) === false ||
    ['failed', 'error'].includes(explicitStatus ?? '')
  if (!name.includes('verify') && raw === undefined) return undefined
  const detail =
    firstString(verificationRecord ? [verificationRecord] : records, [
      'label',
      'summary',
      'message',
      'detail'
    ]) ??
    (status === 'running'
      ? 'Visual verification in progress'
      : explicitPassed
        ? 'Visual check passed'
        : status === 'success' && !explicitFailed
          ? 'Visual evidence captured for model review'
          : 'Visual check needs attention')
  return {
    status:
      status === 'running' || status === 'pending'
        ? 'running'
        : explicitPassed
          ? 'passed'
          : evidenceCaptured || (status === 'success' && !explicitFailed)
            ? 'review'
            : 'failed',
    label: detail
  }
}

function updateTimeline(
  timeline: BrowserActivityItem[],
  next: BrowserActivityItem
): BrowserActivityItem[] {
  const index = timeline.findIndex((item) => item.callId === next.callId)
  const updated =
    index < 0 ? [...timeline, next] : timeline.map((item, i) => (i === index ? next : item))
  return updated.slice(-40)
}

/**
 * Reduces durable agent-run events into a bounded, UI-safe browser activity snapshot.
 * Screenshot bytes are retained only for the latest observation, never in the timeline.
 */
export function applyBrowserActivityEvent(
  state: BrowserActivityState,
  event: AgentRunEvent
): BrowserActivityState {
  if (
    !['tool.pending', 'tool.running', 'tool.output.delta', 'tool.completed'].includes(event.type)
  ) {
    return state
  }
  const callId = callIdFor(event)
  const name = toolNameFor(event, state)
  if (!name?.startsWith('browser_')) return state

  const result = resultFor(event)
  const data = result && isRecord(result.data) ? result.data : result
  const records = collectRecords(data)
  const status = statusFor(event, result)
  const existing = state.timeline.find((item) => item.callId === callId)
  const title =
    firstString(result ? [result] : [], ['title']) ??
    cleanString(event.payload.title) ??
    existing?.title ??
    humanizeToolName(name)
  const startedAt =
    Number(firstValue(result ? collectRecords(result) : [], ['startedAt'])) ||
    existing?.startedAt ||
    event.timestamp
  const completedAt =
    event.type === 'tool.completed'
      ? Number(firstValue(result ? collectRecords(result) : [], ['completedAt'])) || event.timestamp
      : undefined
  const summary =
    firstString(records, ['actionSummary', 'summary', 'message', 'description']) ??
    (event.type === 'tool.completed' ? cleanString(result?.modelContent) : undefined)
  const item: BrowserActivityItem = {
    callId,
    name,
    title,
    status,
    startedAt,
    ...(completedAt ? { completedAt } : {}),
    ...(summary ? { summary: summary.slice(0, 240) } : {})
  }

  const screenshot = findScreenshot(data) ?? findScreenshot(result)
  const consoleErrors = consoleErrorList(records)
  const failedRequests = failedRequestList(records)
  const verification = verificationFor(name, status, records)
  const tabValue = firstValue(records, ['tab'])
  const tab = isRecord(tabValue) ? tabValue : undefined
  const pageTitle =
    firstString(records, ['pageTitle', 'documentTitle', 'currentTitle']) ??
    (tab ? firstString([tab], ['title']) : undefined)
  const url =
    firstString(records, ['pageUrl', 'currentUrl', 'documentUrl']) ??
    (tab ? firstString([tab], ['url']) : undefined)
  const sessionId = firstString(records, ['sessionId', 'browserSessionId', 'contextId'])
  const explicitSessionState = firstString(records, [
    'sessionState',
    'browserState',
    'connectionState'
  ])
  const sessionState =
    name.includes('close') && status === 'success'
      ? 'closed'
      : (explicitSessionState ?? (sessionId ? 'active' : undefined))
  const progress = firstString(records, ['progress', 'progressLabel', 'phaseLabel'])
  const latestAction = firstString(records, ['latestAction', 'actionLabel']) ?? title

  const viewport = parseViewport(records)
  const parsedPointer = pointerProjection(records)
  const pointer = name.includes('close') && status === 'success' ? { present: true } : parsedPointer
  return {
    ...state,
    hasActivity: true,
    runId: event.runId,
    lastSequence: Math.max(state.lastSequence, event.sequence),
    toolNames: { ...state.toolNames, [callId]: name },
    timeline: updateTimeline(state.timeline, item),
    latestAction,
    ...(screenshot
      ? {
          screenshot: screenshot.source,
          screenshotKind: screenshot.kind,
          screenshotSize:
            screenshot.width && screenshot.height
              ? { width: screenshot.width, height: screenshot.height }
              : undefined
        }
      : {}),
    ...(pageTitle ? { pageTitle } : {}),
    ...(url ? { url } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(sessionState ? { sessionState } : {}),
    ...(viewport ? { viewport } : {}),
    ...(pointer.present ? { pointer: pointer.value } : {}),
    ...(consoleErrors ? { consoleErrors } : {}),
    ...(failedRequests ? { failedRequests } : {}),
    ...(verification ? { verification } : {}),
    ...(progress ? { progress } : {})
  }
}
