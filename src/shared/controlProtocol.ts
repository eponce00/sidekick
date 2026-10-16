/**
 * Contract between the `sidekick` CLI and the running app's control endpoint: newline-delimited
 * JSON-RPC 2.0 over a per-user named pipe or Unix socket. The first request on a connection must
 * be `session.hello` carrying the token from the private endpoint file.
 */
import type { EditableSettingDescriptor, EditableSettingValue } from './settingsSchema'

export const CONTROL_PROTOCOL_VERSION = 1

/** Larger lines are refused before parsing; no legitimate request comes close. */
export const CONTROL_MAX_MESSAGE_BYTES = 64 * 1024

/** A provider key longer than this is not a key. */
export const CONTROL_MAX_SECRET_LENGTH = 8 * 1024

export const CONTROL_ERROR_CODES = [
  'internal',
  'usage',
  'not-running',
  'unauthorized',
  'not-found',
  'invalid-value',
  'denied',
  'storage-locked',
  'protocol-mismatch'
] as const
export type ControlErrorCode = (typeof CONTROL_ERROR_CODES)[number]

/** Stable process exit codes; part of the documented CLI contract. */
export const CONTROL_EXIT_CODES: Record<ControlErrorCode, number> = {
  internal: 1,
  usage: 2,
  'not-running': 3,
  unauthorized: 4,
  'not-found': 5,
  'invalid-value': 6,
  denied: 7,
  'storage-locked': 8,
  'protocol-mismatch': 9
}

export function isControlErrorCode(value: unknown): value is ControlErrorCode {
  return typeof value === 'string' && (CONTROL_ERROR_CODES as readonly string[]).includes(value)
}

/** The private file that tells a local client where to connect and how to authenticate. */
export interface ControlEndpointFile {
  protocol: number
  endpoint: string
  token: string
  pid: number
  appVersion: string
}

export interface ControlSettingEntry {
  key: string
  value: EditableSettingValue
  isDefault: boolean
  descriptor: EditableSettingDescriptor
}

export interface ControlSettingChange {
  key: string
  previous: EditableSettingValue
  value: EditableSettingValue
  changed: boolean
}

export interface ControlDoctorReport {
  appVersion: string
  protocol: number
  platform: string
  settingsFile: string
  /** Stored keys SideKick does not recognize; names only. */
  unknownKeys: string[]
  /** Schema settings whose stored value fails validation and is ignored. */
  invalidSettings: Array<{ key: string; reason: string }>
  credentialStorage: { secure: boolean; backend: string }
  providers: Array<{
    id: string
    name: string
    type: string
    enabled: boolean
    apiKeyConfigured: boolean
  }>
  mcpServers: Array<{
    id: string
    name: string
    transport: string
    enabled: boolean
    /** Whether the user approved this connector's current content. */
    approved: boolean
    status: string
    toolCount: number
    error?: string
  }>
}

/** A configured MCP server as the CLI reports it; environment values are never included. */
export interface ControlMcpServer {
  id: string
  name: string
  transport: 'stdio' | 'streamable-http'
  enabled: boolean
  approvalMode: 'prompt' | 'reads-auto'
  command?: string
  args?: string[]
  cwd?: string
  envKeys?: string[]
  url?: string
  authentication?: 'none' | 'oauth'
  /** Whether the user approved this exact content; an edited server must be approved again. */
  approved: boolean
  status: string
  toolCount: number
  error?: string
}

/** What `mcp add` sends. `env` values travel only to the app, which encrypts them. */
export interface ControlMcpAddParams {
  id: string
  name?: string
  command?: string
  args?: string[]
  cwd?: string
  url?: string
  authentication?: 'none' | 'oauth'
  approvalMode?: 'prompt' | 'reads-auto'
  enabled?: boolean
  env?: Record<string, string>
  replace?: boolean
}

/** A provider instance as the CLI reports it; the key is reported only as present or absent. */
export interface ControlProvider {
  id: string
  name: string
  kind: string
  enabled: boolean
  baseUrl: string
  modelSource: 'discover' | 'manual'
  enabledModels: string[]
  apiKeyConfigured: boolean
}

export interface ControlProviderChange {
  name?: string
  baseUrl?: string
  enabled?: boolean
}

/** Every method the endpoint serves, with its parameters and result. */
export interface ControlMethods {
  'session.hello': {
    params: { token: string; protocol: number; client?: string }
    result: { protocol: number; appVersion: string }
  }
  'config.list': { params: Record<string, never>; result: { settings: ControlSettingEntry[] } }
  'config.get': { params: { key: string }; result: ControlSettingEntry }
  'config.set': { params: { key: string; value: unknown }; result: ControlSettingChange }
  'config.unset': { params: { key: string }; result: ControlSettingChange }
  'config.reference': { params: Record<string, never>; result: { markdown: string } }
  'auth.set': {
    params: { providerInstanceId: string; secret: string }
    result: { providerInstanceId: string; apiKeyConfigured: true }
  }
  doctor: { params: Record<string, never>; result: ControlDoctorReport }
  'mcp.list': { params: Record<string, never>; result: { servers: ControlMcpServer[] } }
  'mcp.add': {
    params: ControlMcpAddParams
    result: { server: ControlMcpServer; replaced: boolean }
  }
  'mcp.remove': { params: { id: string }; result: { id: string; removed: true } }
  'provider.list': { params: Record<string, never>; result: { providers: ControlProvider[] } }
  'provider.add': {
    params: ControlProviderChange & { id: string; kind: string }
    result: { provider: ControlProvider }
  }
  'provider.set': {
    params: ControlProviderChange & { id: string }
    result: { provider: ControlProvider; changed: string[] }
  }
  'provider.remove': { params: { id: string }; result: { id: string; removed: true } }
}
export type ControlMethod = keyof ControlMethods

export interface ControlRequest<M extends ControlMethod = ControlMethod> {
  jsonrpc: '2.0'
  id: number | string
  method: M
  params: ControlMethods[M]['params']
}

export interface ControlErrorPayload {
  code: number
  message: string
  data: { code: ControlErrorCode }
}

export type ControlResponse<M extends ControlMethod = ControlMethod> =
  | { jsonrpc: '2.0'; id: number | string | null; result: ControlMethods[M]['result'] }
  | { jsonrpc: '2.0'; id: number | string | null; error: ControlErrorPayload }

/** JSON-RPC numeric codes; the string code in `data` is what clients branch on. */
export const JSON_RPC_ERROR_NUMBERS: Record<ControlErrorCode, number> = {
  internal: -32603,
  usage: -32602,
  'not-running': -32000,
  unauthorized: -32001,
  'not-found': -32002,
  'invalid-value': -32003,
  denied: -32004,
  'storage-locked': -32005,
  'protocol-mismatch': -32006
}

export class ControlError extends Error {
  constructor(
    readonly code: ControlErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'ControlError'
  }
}
