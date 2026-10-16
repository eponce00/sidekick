import { describe, expect, it } from 'vitest'
import type { Message, ToolExecution } from '../types/chat.types'
import { latestRunTodos } from './runTodos'

const todoMessage = (id: string, tool: Partial<ToolExecution>): Message => ({
  id,
  role: 'agent',
  content: '',
  timestamp: 0,
  segments: [
    {
      type: 'tool',
      tool: {
        id: `${id}-tool`,
        title: 'Update the task list',
        command: 'manage_todo_list',
        name: 'manage_todo_list',
        status: 'success',
        ...tool
      }
    }
  ]
})

describe('latestRunTodos', () => {
  it('reads the newest successful list, with each step’s linked chat', () => {
    const messages = [
      todoMessage('first', {
        data: { todoList: [{ id: 1, title: 'Old', description: '', status: 'completed' }] }
      }),
      todoMessage('second', {
        data: {
          todoList: [
            {
              id: 1,
              title: 'Port schedules',
              description: '',
              status: 'not-started',
              sessionId: 'w1'
            }
          ]
        }
      }),
      todoMessage('failed', { status: 'error', data: undefined })
    ]
    expect(latestRunTodos(messages)).toEqual([
      { id: 1, title: 'Port schedules', description: '', status: 'not-started', sessionId: 'w1' }
    ])
  })

  it('falls back to the written list and drops malformed steps', () => {
    const messages = [
      todoMessage('write', {
        input: {
          operation: 'write',
          todoList: [
            { id: 1, title: 'Valid', description: '', status: 'in-progress' },
            { id: 2, title: 'Bad status', description: '', status: 'later' },
            null
          ]
        }
      })
    ]
    expect(latestRunTodos(messages).map((todo) => todo.title)).toEqual(['Valid'])
  })

  it('is empty when the chat never kept a list', () => {
    expect(latestRunTodos([{ id: 'm', role: 'user', content: 'hi', timestamp: 0 }])).toEqual([])
  })
})
