import { resolve } from 'path'
import type { ToolDiagnostic, ToolWorkspaceChange } from '../../../shared/agentRuntime'
import type {
  CodeIntelligenceInput,
  CodeIntelligenceResult,
  LanguageIntelligenceWorkspaceStatus
} from '../../../shared/verification'
import { LspClient } from './lspClient'
import { resolveSecureWorkspacePath } from '../../utils/workspacePaths'
import {
  availableWorkspaceServers,
  detectWorkspaceLanguages,
  languageServerRoot,
  resolveServerForFile
} from './serverRegistry'

function bounded(
  value: unknown,
  max = 200
): { result: unknown; count: number; truncated: boolean } {
  if (!Array.isArray(value))
    return { result: value, count: value == null ? 0 : 1, truncated: false }
  return { result: value.slice(0, max), count: value.length, truncated: value.length > max }
}

function diagnosticKey(item: ToolDiagnostic): string {
  return `${item.filePath || ''}:${item.line || 0}:${item.column || 0}:${item.severity}:${item.code || ''}:${item.message}`
}

export interface LanguageDiagnosticBatch {
  diagnostics: ToolDiagnostic[]
  attemptedFiles: string[]
  failedFiles: string[]
  complete: boolean
}

export class LanguageIntelligenceService {
  private readonly clients = new Map<string, { client: LspClient; idle?: NodeJS.Timeout }>()
  private readonly priorDiagnostics = new Map<string, ToolDiagnostic[]>()
  private readonly statusCache = new Map<
    string,
    { value: LanguageIntelligenceWorkspaceStatus; checkedAt: number }
  >()

  workspaceStatus(workspaceRoot: string): LanguageIntelligenceWorkspaceStatus {
    const root = resolve(workspaceRoot)
    const cached = this.statusCache.get(root)
    if (cached && Date.now() - cached.checkedAt < 30_000) return cached.value
    const servers = availableWorkspaceServers(root)
    const status = {
      available: servers.length > 0,
      detectedLanguages: detectWorkspaceLanguages(root),
      availableServers: servers.map((server) => ({
        id: server.id,
        name: server.name,
        languages: server.languages,
        origin: server.origin
      }))
    }
    this.statusCache.set(root, { value: status, checkedAt: Date.now() })
    return status
  }

  private client(
    workspaceRoot: string,
    filePath: string,
    allowWorkspaceStart = false
  ): LspClient | null {
    const root = resolve(workspaceRoot)
    const server = resolveServerForFile(root, filePath)
    if (!server) return null
    const serverRoot = languageServerRoot(root, filePath, server)
    const key = `${serverRoot}\0${server.id}`
    let entry = this.clients.get(key)
    if (!entry) {
      if (server.origin === 'workspace' && !allowWorkspaceStart) return null
      const client = new LspClient(serverRoot, server)
      entry = { client }
      this.clients.set(key, entry)
    }
    if (entry.idle) clearTimeout(entry.idle)
    entry.idle = setTimeout(
      () => {
        void entry?.client.close()
        this.clients.delete(key)
      },
      10 * 60 * 1_000
    )
    entry.idle.unref()
    return entry.client
  }

  observeFile(workspaceRoot: string, filePath: string): void {
    void resolveSecureWorkspacePath(workspaceRoot, filePath)
      .then((absolute) => this.client(workspaceRoot, absolute)?.open(absolute))
      .catch(() => undefined)
  }

  async diagnosticsAfterChanges(
    workspaceRoot: string,
    changes: ToolWorkspaceChange[],
    signal?: AbortSignal
  ): Promise<LanguageDiagnosticBatch> {
    const diagnostics: ToolDiagnostic[] = []
    const attemptedFiles: string[] = []
    const failedFiles: string[] = []
    for (const change of changes.slice(0, 24)) {
      if (change.kind === 'delete') continue
      const absolute = await resolveSecureWorkspacePath(workspaceRoot, change.path).catch(
        () => null
      )
      if (!absolute) continue
      const client = this.client(workspaceRoot, absolute)
      if (!client) continue
      attemptedFiles.push(change.path)
      let current: ToolDiagnostic[]
      try {
        current = await client.diagnosticsFor(absolute, signal)
      } catch {
        failedFiles.push(change.path)
        continue
      }
      const previous = this.priorDiagnostics.get(absolute) ?? []
      const previousKeys = new Set(previous.map(diagnosticKey))
      const currentKeys = new Set(current.map(diagnosticKey))
      diagnostics.push(
        ...current.map((item) => ({
          ...item,
          state: previousKeys.has(diagnosticKey(item)) ? ('existing' as const) : ('new' as const)
        }))
      )
      diagnostics.push(
        ...previous
          .filter((item) => !currentKeys.has(diagnosticKey(item)))
          .map((item) => ({ ...item, state: 'resolved' as const }))
      )
      this.priorDiagnostics.set(absolute, current)
    }
    return {
      diagnostics: diagnostics.slice(0, 200),
      attemptedFiles,
      failedFiles,
      complete: attemptedFiles.length > 0 && failedFiles.length === 0
    }
  }

  async execute(
    workspaceRoot: string,
    input: CodeIntelligenceInput,
    signal?: AbortSignal
  ): Promise<CodeIntelligenceResult> {
    const absolute = await resolveSecureWorkspacePath(workspaceRoot, input.filePath)
    const client = this.client(workspaceRoot, absolute, true)
    if (!client) throw new Error(`No installed language server supports ${input.filePath}`)
    let value: unknown
    const line = Math.max(0, (input.line ?? 1) - 1)
    const column = Math.max(0, (input.column ?? 1) - 1)
    if (input.operation === 'diagnostics') value = await client.diagnosticsFor(absolute, signal)
    else if (input.operation === 'workspace_symbols')
      value = await client.workspaceSymbols(input.query || '', signal)
    else {
      const methods: Record<
        Exclude<CodeIntelligenceInput['operation'], 'diagnostics' | 'workspace_symbols'>,
        string
      > = {
        definition: 'textDocument/definition',
        references: 'textDocument/references',
        hover: 'textDocument/hover',
        document_symbols: 'textDocument/documentSymbol',
        implementation: 'textDocument/implementation'
      }
      value = await client.requestForFile(
        methods[input.operation],
        absolute,
        line,
        column,
        input.operation === 'references' ? { context: { includeDeclaration: true } } : {},
        signal
      )
    }
    const result = bounded(value)
    return {
      operation: input.operation,
      serverId: client.server.id,
      filePath: input.filePath,
      result: result.result,
      resultCount: result.count,
      truncated: result.truncated
    }
  }

  async close(): Promise<void> {
    const closing: Promise<void>[] = []
    for (const { client, idle } of this.clients.values()) {
      if (idle) clearTimeout(idle)
      closing.push(client.close())
    }
    this.clients.clear()
    await Promise.allSettled(closing)
  }
}
