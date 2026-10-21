import type { AxiosRequestConfig, AxiosResponse } from 'axios'
import { toolExecutionFailed, toolExecutionSucceeded } from '../../shared/agentRuntime'
import type { CredentialSend } from '../../shared/credentials'
import { HTTP_REQUEST_METHODS, HTTP_REQUEST_TOOL } from '../../shared/httpRequestTool'
import type { AgentToolHandlerRegistry } from './agentToolHandlerRegistry'
import { browserNetworkApprovals, type BrowserNetworkPolicy } from './browserNetworkApprovals'
import type { CredentialUses } from './credentialUses'
import type { ToolOutputStore } from './toolOutputStore'
import { requestAdmitted, webNetworkRefusal, type WebNetworkOptions } from './webNetworkGuard'

export type HttpSend = (
  url: URL,
  config: AxiosRequestConfig,
  options: WebNetworkOptions
) => Promise<AxiosResponse<ArrayBuffer>>

export interface HttpToolOptions {
  outputs: ToolOutputStore
  /** Absent where stored credentials cannot be used. */
  credentials?: () => CredentialUses | undefined
  send?: HttpSend
  networkPolicy?: BrowserNetworkPolicy
}

const MAX_REQUEST_BODY = 1024 * 1024
const MAX_RESPONSE_BODY = 5 * 1024 * 1024
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/
/** Headers that describe how a request travels; the HTTP client sets them. */
const CLIENT_HEADERS = new Set(['host', 'content-length', 'transfer-encoding', 'connection'])
const SHOWN_HEADERS = [
  'content-type',
  'content-length',
  'location',
  'retry-after',
  'www-authenticate',
  'etag',
  'last-modified',
  'x-request-id',
  'ms-correlationid',
  'x-ratelimit-remaining',
  'x-ratelimit-reset'
]
/** Response fields that hold a token derived from the credential the request used. */
const TOKEN_FIELDS = new Set(['access_token', 'refresh_token', 'id_token'])

function invalid(title: string, message: string) {
  return toolExecutionFailed({ title, code: 'invalid_arguments', message, retryable: false })
}

function stringRecord(value: unknown, label: string): Record<string, string> | string {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return `${label} must be an object`
  const record: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') return `${label}.${key} must be text`
    record[key] = item
  }
  return record
}

function textual(contentType: string): boolean {
  return (
    !contentType ||
    /^text\//i.test(contentType) ||
    /(json|xml|javascript|x-www-form-urlencoded|yaml|csv)/i.test(contentType)
  )
}

/**
 * Replaces tokens a credential's response returned with aliases the agent passes back, so the
 * new bearer token is as hidden as the secret that obtained it.
 */
function replaceTokens(
  value: unknown,
  derive: (token: string, expiresIn?: number) => string,
  expiresIn?: number,
  depth = 0
): { value: unknown; replaced: string[] } {
  if (!value || typeof value !== 'object' || depth > 3) return { value, replaced: [] }
  const replaced: string[] = []
  if (Array.isArray(value)) {
    return {
      value: value.map((item) => {
        const result = replaceTokens(item, derive, undefined, depth + 1)
        replaced.push(...result.replaced)
        return result.value
      }),
      replaced
    }
  }
  const record = value as Record<string, unknown>
  const ownExpiry = typeof record.expires_in === 'number' ? record.expires_in : expiresIn
  const next: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(record)) {
    if (TOKEN_FIELDS.has(key.toLowerCase()) && typeof item === 'string' && item) {
      const alias = derive(item, key.toLowerCase() === 'access_token' ? ownExpiry : undefined)
      replaced.push(alias)
      next[key] = alias
    } else {
      const result = replaceTokens(item, derive, ownExpiry, depth + 1)
      replaced.push(...result.replaced)
      next[key] = result.value
    }
  }
  return { value: next, replaced }
}

interface Body {
  kind: 'none' | 'raw' | 'json' | 'form'
  raw?: string
  json?: Record<string, unknown>
  form?: Record<string, string>
}

/** Puts the credential where its entry says, refusing anything the model already set there. */
function place(
  send: CredentialSend,
  values: { secret?: string; username?: string; password?: string },
  url: URL,
  headers: Record<string, string>,
  body: Body
): string | null {
  const secret = values.secret ?? values.password ?? ''
  const headerSet = (name: string): boolean =>
    Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase())
  switch (send.as) {
    case 'header':
      if (headerSet(send.name)) return `Leave out the ${send.name} header; SideKick sets it.`
      headers[send.name] = `${send.prefix}${secret}`
      return null
    case 'basic':
      if (headerSet('Authorization')) return 'Leave out the Authorization header; SideKick sets it.'
      headers.Authorization = `Basic ${Buffer.from(`${values.username ?? ''}:${values.password ?? ''}`).toString('base64')}`
      return null
    case 'query':
      if (url.searchParams.has(send.name)) {
        return `Leave out the ${send.name} query parameter; SideKick sets it.`
      }
      url.searchParams.set(send.name, secret)
      return null
    case 'form':
    case 'json': {
      const names = [send.name, ...(send.usernameName ? [send.usernameName] : [])]
      if (body.kind !== 'none' && body.kind !== send.as) {
        return `This credential is sent as a ${send.as === 'form' ? 'form' : 'JSON'} field; send the other fields in ${send.as}.`
      }
      const fields: Record<string, unknown> = (send.as === 'form' ? body.form : body.json) ?? {}
      const taken = names.find((name) => name in fields)
      if (taken) return `Leave out the ${taken} field; SideKick sets it.`
      fields[send.name] = secret
      if (send.usernameName) fields[send.usernameName] = values.username ?? ''
      body.kind = send.as
      if (send.as === 'form') body.form = fields as Record<string, string>
      else body.json = fields
      return null
    }
  }
}

/** Registers `http_request`, which calls APIs and adds a stored credential by alias. */
export function registerHttpToolHandlers(
  handlers: AgentToolHandlerRegistry,
  options: HttpToolOptions
): void {
  const send: HttpSend =
    options.send ?? ((url, config, network) => requestAdmitted<ArrayBuffer>(url, config, network))
  handlers.register(HTTP_REQUEST_TOOL, async ({ title, arguments: args, context }) => {
    const method = String(args.method || '').toUpperCase()
    if (!(HTTP_REQUEST_METHODS as readonly string[]).includes(method)) {
      return invalid(title, `method must be one of ${HTTP_REQUEST_METHODS.join(', ')}`)
    }
    let url: URL
    try {
      url = new URL(String(args.url || ''))
    } catch {
      return invalid(title, 'url must be an absolute http or https URL')
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return invalid(title, 'url must be an absolute http or https URL')
    }
    const headers = stringRecord(args.headers, 'headers')
    if (typeof headers === 'string') return invalid(title, headers)
    for (const [name, value] of Object.entries(headers)) {
      if (!HEADER_NAME.test(name) || CLIENT_HEADERS.has(name.toLowerCase())) {
        return invalid(title, `SideKick cannot send a ${name} header`)
      }
      if (/[\r\n\0]/.test(value)) return invalid(title, `The ${name} header has a line break`)
    }
    const form = stringRecord(args.form, 'form')
    if (typeof form === 'string') return invalid(title, form)
    const bodies = [args.body !== undefined, args.json !== undefined, args.form !== undefined]
    if (bodies.filter(Boolean).length > 1) {
      return invalid(title, 'Send at most one of body, json and form')
    }
    if (
      args.json !== undefined &&
      (!args.json || typeof args.json !== 'object' || Array.isArray(args.json))
    ) {
      return invalid(title, 'json must be an object')
    }
    const body: Body =
      args.body !== undefined
        ? { kind: 'raw', raw: String(args.body) }
        : args.json !== undefined
          ? { kind: 'json', json: { ...(args.json as Record<string, unknown>) } }
          : args.form !== undefined
            ? { kind: 'form', form: { ...form } }
            : { kind: 'none' }

    const alias = typeof args.credential === 'string' ? args.credential.trim() : ''
    let usedAlias: string | null = null
    if (alias) {
      const uses = options.credentials?.()
      if (!uses) {
        return toolExecutionFailed({
          title,
          code: 'unsupported',
          message: 'Stored credentials cannot be used in this run.',
          retryable: false
        })
      }
      const taken = uses.take({
        alias,
        tool: HTTP_REQUEST_TOOL,
        kind: 'web',
        target: url.href,
        conversationId: context.conversationId,
        runId: context.runId
      })
      if (!taken.ok) {
        return toolExecutionFailed({
          title,
          code: 'permission_denied',
          status: 'denied',
          message: taken.message,
          retryable: false,
          recoveryAction: 'change_strategy'
        })
      }
      const refusal = place(taken.send, taken.values, url, headers, body)
      if (refusal) return invalid(title, refusal)
      usedAlias = alias.replace(/~\d+$/, '')
    }
    if ((method === 'GET' || method === 'HEAD') && body.kind !== 'none') {
      return invalid(title, `${method} requests carry no body`)
    }

    const data =
      body.kind === 'raw'
        ? body.raw
        : body.kind === 'json'
          ? JSON.stringify(body.json)
          : body.kind === 'form'
            ? new URLSearchParams(body.form).toString()
            : undefined
    if (data !== undefined && Buffer.byteLength(data) > MAX_REQUEST_BODY) {
      return invalid(title, 'The request body is larger than 1 MB')
    }
    const lower = Object.keys(headers).map((key) => key.toLowerCase())
    if (body.kind === 'json' && !lower.includes('content-type')) {
      headers['Content-Type'] = 'application/json'
    }
    if (body.kind === 'form' && !lower.includes('content-type')) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded'
    }
    if (!lower.includes('user-agent')) headers['User-Agent'] = 'SideKick'

    const timeout = Math.max(1, Math.min(120, Number(args.timeout) || 30)) * 1_000
    let response: AxiosResponse<ArrayBuffer>
    try {
      response = await send(
        url,
        {
          method,
          headers,
          data,
          timeout,
          responseType: 'arraybuffer',
          maxContentLength: MAX_RESPONSE_BODY,
          maxBodyLength: MAX_REQUEST_BODY
        },
        { policy: options.networkPolicy ?? browserNetworkApprovals, signal: context.signal }
      )
    } catch (error) {
      const refusal = webNetworkRefusal(error)
      if (refusal) {
        return toolExecutionFailed({
          title,
          code: 'permission_denied',
          status: 'denied',
          message: refusal.message,
          retryable: false
        })
      }
      // Only the message: an HTTP client error object carries the request, credential included.
      const message = error instanceof Error ? error.message : 'The request failed'
      return toolExecutionFailed({
        title,
        code: context.signal.aborted ? 'cancelled' : 'transient',
        message: `The request failed: ${message}`,
        retryable: !context.signal.aborted
      })
    }

    const responseHeaders = response.headers as Record<string, unknown>
    const contentType = String(responseHeaders['content-type'] ?? '')
    const bytes = Buffer.from(response.data ?? new ArrayBuffer(0))
    let text = textual(contentType)
      ? bytes.toString('utf8')
      : `[${bytes.byteLength} bytes of ${contentType || 'binary content'}]`
    let tokens: string[] = []
    if (usedAlias && /json/i.test(contentType)) {
      try {
        const uses = options.credentials?.()
        const parsed = JSON.parse(text) as unknown
        if (uses) {
          const result = replaceTokens(parsed, (token, expiresIn) =>
            uses.addDerived(usedAlias!, context.conversationId, token, expiresIn)
          )
          if (result.replaced.length) {
            tokens = result.replaced
            text = JSON.stringify(result.value, null, 2)
          }
        }
      } catch {
        // Not JSON after all; the redactor still hides the credential itself.
      }
    }
    const shown = SHOWN_HEADERS.flatMap((name) =>
      responseHeaders[name] !== undefined ? [`${name}: ${String(responseHeaders[name])}`] : []
    )
    const status = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`
    const note = tokens.length
      ? `\nTokens in this response are aliases: pass ${tokens.join(', ')} as credential to use them.`
      : ''
    const bounded = await options.outputs.apply(
      `${status}\n${shown.join('\n')}${note}\n\n${method === 'HEAD' ? '' : text}`
    )
    return toolExecutionSucceeded({
      title,
      data: {
        status: response.status,
        headers: Object.fromEntries(shown.map((line) => line.split(/: (.*)/s, 2))),
        ...(usedAlias ? { credential: alias } : {}),
        ...(tokens.length ? { tokens } : {})
      },
      modelContent: bounded.content,
      output: bounded.output
    })
  })
}
