import type { TodoItem } from '../../../shared/types'
import type { Message } from '../types/chat.types'

const STATUSES = new Set<TodoItem['status']>(['not-started', 'in-progress', 'completed'])

function todoList(value: unknown): TodoItem[] | null {
  if (!value || typeof value !== 'object') return null
  const list = (value as { todoList?: unknown }).todoList
  if (!Array.isArray(list)) return null
  return list.filter(
    (item): item is TodoItem =>
      Boolean(item) &&
      typeof item === 'object' &&
      typeof (item as TodoItem).title === 'string' &&
      STATUSES.has((item as TodoItem).status)
  )
}

/**
 * The chat's current task list: the result of its latest `manage_todo_list` call. The tool
 * returns the whole list on every read and write, so the newest successful call is the list.
 */
export function latestRunTodos(messages: readonly Message[]): TodoItem[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const segments = messages[index].segments ?? []
    for (let segment = segments.length - 1; segment >= 0; segment -= 1) {
      const tool = segments[segment].tool
      if (segments[segment].type !== 'tool' || tool?.name !== 'manage_todo_list') continue
      if (tool.status !== 'success') continue
      const list = todoList(tool.data) ?? todoList(tool.input)
      if (list) return list
    }
  }
  return []
}
