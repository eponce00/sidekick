import type { ToolDiagnostic, ToolWorkspaceChange } from './agentRuntime'

export const VERIFICATION_KINDS = [
  'test',
  'build',
  'typecheck',
  'lint',
  'check',
  'diagnostics',
  'custom'
] as const

export type VerificationKind = (typeof VERIFICATION_KINDS)[number]

export type VerificationScope = 'workspace' | 'package' | 'targeted'
export type VerificationStatus = 'passed' | 'failed' | 'cancelled'

export interface VerificationEvidence {
  id: string
  runId: string
  workspaceRoot: string
  revision: number
  kind: VerificationKind
  scope: VerificationScope
  source: 'command' | 'lsp' | 'custom'
  status: VerificationStatus
  command?: string
  cwd?: string
  exitCode?: number
  summary: string
  changedPaths: string[]
  fingerprint?: string
  diagnostics?: ToolDiagnostic[]
  startedAt: number
  completedAt: number
}

export interface VerificationCheckSuggestion {
  kind: Exclude<VerificationKind, 'diagnostics' | 'custom'>
  command: string
  source: string
}

export interface WorkspaceVerificationSummary {
  status: 'passed' | 'failed' | 'stale' | 'unverified' | 'not_applicable'
  workspaceRoot: string
  baselineRevision: number
  currentRevision: number
  changedPaths: string[]
  evidence: VerificationEvidence[]
  suggestedChecks: VerificationCheckSuggestion[]
  headline: string
  detail?: string
}

export interface VerificationTerminalDecision {
  continue: boolean
  prompt?: string
  summary: WorkspaceVerificationSummary
}

export interface WorkspaceChangeRecord {
  runId: string
  workspaceRoot: string
  revision: number
  source: 'workspace_tool' | 'command' | 'external'
  changes: ToolWorkspaceChange[]
  createdAt: number
}

export interface CodeIntelligenceInput {
  operation:
    | 'diagnostics'
    | 'definition'
    | 'references'
    | 'hover'
    | 'document_symbols'
    | 'workspace_symbols'
    | 'implementation'
  filePath: string
  line?: number
  column?: number
  query?: string
}

export interface CodeIntelligenceResult {
  operation: CodeIntelligenceInput['operation']
  serverId: string
  filePath: string
  result: unknown
  resultCount: number
  truncated: boolean
}

export interface LanguageIntelligenceWorkspaceStatus {
  available: boolean
  detectedLanguages: string[]
  availableServers: Array<{
    id: string
    name: string
    languages: string[]
    origin: 'workspace' | 'path'
  }>
}
