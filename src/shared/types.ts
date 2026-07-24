// Shared types used across main and renderer processes

export interface ToolExecution {
  id: string
  tool: string
  args: Record<string, unknown>
  status: 'pending' | 'running' | 'success' | 'error'
  output?: string
  error?: string
  startTime: number
  endTime?: number
}

export interface ShellCommandResult {
  success: boolean
  exitCode: number
  stdout: string
  stderr: string
  error?: string
  commandId?: string
  cancelled?: boolean
  truncated?: boolean
  outputPath?: string
}

export interface CommandExecutionRequest {
  id: string
  title: string
  command: string
  cwd?: string
  workspaceRoot?: string
  timeoutSecs: number
  background: boolean
  requestedAccess: 'auto' | 'confirm'
  authorizationToken?: string
}

export interface WorkspaceMutationAuthorization {
  requestedAccess: 'auto' | 'confirm'
  authorizationToken?: string
}

export type CheckpointMutationAuthorization = WorkspaceMutationAuthorization

export type ToolRisk = 'read' | 'write' | 'execute' | 'network'

export interface RuntimeToolDefinition<
  TArgs extends Record<string, unknown> = Record<string, unknown>
> {
  name: string
  description: string
  risk: ToolRisk
  validate: (args: unknown) => args is TArgs
}

export interface RuntimeToolContext {
  conversationId?: string
  workspacePath?: string
  signal?: AbortSignal
}

export interface RuntimeTool<
  TArgs extends Record<string, unknown>,
  TResult
> extends RuntimeToolDefinition<TArgs> {
  execute: (args: TArgs, context: RuntimeToolContext) => Promise<TResult>
}

interface McpServerConfigBase {
  id: string
  name: string
  /** Read-only automation is opt-in and still requires conservative tool annotations. */
  approvalMode: 'prompt' | 'reads-auto'
  enabled: boolean
}

export interface McpStdioServerConfig extends McpServerConfigBase {
  transport: 'stdio'
  command: string
  args?: string[]
  cwd?: string
}

export interface McpHttpServerConfig extends McpServerConfigBase {
  transport: 'streamable-http'
  url: string
  authentication: 'none' | 'oauth'
  catalogId?: McpConnectorCatalogId
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig

export type McpConnectorCatalogId = 'atlassian' | 'notion' | 'airtable'

export interface McpToolAnnotations {
  title?: string
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

export interface McpToolInfo {
  serverId: string
  serverName: string
  name: string
  description?: string
  inputSchema: Record<string, unknown>
  annotations?: McpToolAnnotations
  approvalMode: McpServerConfig['approvalMode']
}

export interface McpServerStatus {
  serverId: string
  serverName: string
  status: 'disabled' | 'connecting' | 'needs_auth' | 'connected' | 'degraded' | 'error'
  toolCount: number
  error?: string
}

export interface McpListResult {
  ok: boolean
  tools: McpToolInfo[]
  statuses: McpServerStatus[]
  error?: string
}

export interface BackgroundTask {
  id: string
  title: string
  command: string
  status: 'running' | 'success' | 'error' | 'cancelled'
  startedAt: number
  endedAt?: number
  result?: ShellCommandResult
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<
      string,
      {
        type: string
        description: string
        required?: boolean
      }
    >
    required?: string[]
  }
}

// Focus Chain types
export interface TodoItem {
  id: number
  title: string
  description: string
  status: 'not-started' | 'in-progress' | 'completed'
}

export interface FocusChain {
  taskId: string
  conversationId: string
  todoList: TodoItem[]
  createdAt: number
  updatedAt: number
}
