export type WorkspaceInstructionSourceKind = 'global' | 'project'

export interface WorkspaceInstructionSource {
  /** Absolute canonical path used for deduplication. */
  path: string
  /** Compact user-facing path, relative to the project or home directory. */
  displayPath: string
  kind: WorkspaceInstructionSourceKind
  /** Project-relative directory whose descendants this instruction file governs. */
  scope: string
  truncated: boolean
}

export interface WorkspaceRulesResult {
  content: string
  sources: string[]
  sourceDetails: WorkspaceInstructionSource[]
  truncated: boolean
}

export interface WorkspaceInstructionResolution extends WorkspaceRulesResult {
  /** A mutation must be retried after the model has reviewed newly loaded scoped rules. */
  retryRequired: boolean
}
