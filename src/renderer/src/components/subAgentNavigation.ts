import { createContext, useContext } from 'react'
import type { ToolExecution } from '../types/chat.types'

/** A sub-agent to open in its own view, as the delegating tool call described it. */
export interface SubAgentTarget {
  runId: string
  title: string
  task?: string
  context?: string
}

/** Opens a sub-agent over the chat. Absent where there is no chat to return to. */
export const SubAgentNavigation = createContext<((target: SubAgentTarget) => void) | null>(null)

export function useOpenSubAgent(): ((target: SubAgentTarget) => void) | null {
  return useContext(SubAgentNavigation)
}

function argument(tool: ToolExecution, name: string): string | undefined {
  const value = tool.input?.[name]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** The task's short name: the label the agent gave it, else the start of the task itself. */
export function subAgentTitle(tool: ToolExecution): string {
  const label = argument(tool, 'description')
  if (label) return label
  const task = argument(tool, 'task')?.replace(/\s+/g, ' ')
  if (!task) return 'Sub-agent'
  const sentence = task.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? task
  return sentence.length > 80 ? `${sentence.slice(0, 79).trimEnd()}…` : sentence
}

export function subAgentTarget(tool: ToolExecution, runId: string): SubAgentTarget {
  return {
    runId,
    title: subAgentTitle(tool),
    task: argument(tool, 'task'),
    context: argument(tool, 'context')
  }
}
