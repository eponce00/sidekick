import type Database from 'better-sqlite3'
import { toolExecutionFailed, toolExecutionSucceeded } from '../../shared/agentRuntime'
import type { TodoItem } from '../../shared/types'
import type { AgentGoalToolHandler, AgentPlanToolHandler } from './agentToolRuntime'
import type { AgentToolHandlerRegistry } from './agentToolHandlerRegistry'

export function registerConversationToolHandlers(
  registry: AgentToolHandlerRegistry,
  db: Database.Database,
  options: {
    goal?: AgentGoalToolHandler
    plan?: AgentPlanToolHandler
  }
): void {
  registry.register('manage_todo_list', async ({ title, arguments: args, context }) => {
    if (args.operation === 'write') {
      const todos = Array.isArray(args.todoList) ? (args.todoList as TodoItem[]) : []
      if (todos.filter((todo) => todo.status === 'in-progress').length > 1) {
        return toolExecutionFailed({
          title,
          code: 'invalid_arguments',
          message: 'At most one todo item may be in progress',
          retryable: true
        })
      }
      db.prepare(
        `INSERT INTO agent_run_todos (run_id, todo_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET todo_json = excluded.todo_json, updated_at = excluded.updated_at`
      ).run(context.runId, JSON.stringify(todos), Date.now())
      options.goal?.onTodosUpdated?.(todos)
    }
    const row = db
      .prepare('SELECT todo_json FROM agent_run_todos WHERE run_id = ?')
      .get(context.runId) as { todo_json: string } | undefined
    const todos = row ? (JSON.parse(row.todo_json) as TodoItem[]) : []
    return toolExecutionSucceeded({ title, data: { todoList: todos } })
  })

  if (options.goal) {
    registry.register('update_goal', async ({ title, arguments: args, context }) =>
      toolExecutionSucceeded({ title, data: await options.goal!.execute(args, context) })
    )
  }
  if (options.plan) {
    registry.register('complete_plan', async ({ title, arguments: args }) => {
      const result = options.plan!.complete(args.completion)
      return toolExecutionSucceeded({
        title,
        data: result,
        modelContent: result.accepted
          ? JSON.stringify(result)
          : `${JSON.stringify(result)}\nThe plan contract is not complete. Correct every listed issue before trying complete_plan again.`
      })
    })
  }
}
