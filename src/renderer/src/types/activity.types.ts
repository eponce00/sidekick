// Activity panel types for command execution and file operations

export interface ActivityItem {
  id: string
  type:
    | 'command'
    | 'file'
    | 'info'
    | 'research'
    | 'web_search'
    | 'fetch_page'
    | 'subagent'
    | 'compaction'
    | 'tool'
  status: 'pending' | 'running' | 'success' | 'error' | 'denied'
  title: string
  command?: string
  output?: string
  error?: string
  exitCode?: number
  accessLevel?: 'auto' | 'confirm'
  approvalStatus?: 'pending' | 'approved' | 'denied' | 'auto'
  startTime: number
  endTime?: number
  description?: string // For research activities
  // Sub-agent specific fields
  subAgentId?: string
  taskSummary?: string
  iterations?: number
  toolCallsExecuted?: number
  contextPercent?: number
}
