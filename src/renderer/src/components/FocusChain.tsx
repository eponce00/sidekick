import { useState } from 'react'
import { Check, ChevronDown, Circle, ListTodo } from 'lucide-react'
import type { TodoItem } from '../../../shared/types'
import './FocusChain.css'

interface FocusChainProps {
  todos: TodoItem[]
  onUpdateTodo?: (todoId: number, status: TodoItem['status']) => void
  className?: string
}

export default function FocusChain({
  todos,
  onUpdateTodo,
  className
}: FocusChainProps): React.JSX.Element {
  const [isExpanded, setIsExpanded] = useState(true)

  // Calculate progress
  const completedCount = todos.filter((t) => t.status === 'completed').length
  const totalCount = todos.length
  const progressPercent = totalCount > 0 ? (completedCount / totalCount) * 100 : 0

  // Get current task
  const currentTask = todos.find((t) => t.status === 'in-progress')

  if (todos.length === 0) {
    return <></>
  }

  return (
    <div className={`focus-chain ${className || ''}`}>
      <div className="focus-chain-header" onClick={() => setIsExpanded(!isExpanded)}>
        <div className="focus-chain-header-content">
          <div className="focus-chain-icon">
            <ListTodo size={16} />
          </div>
          <div className="focus-chain-info">
            <div className="focus-chain-title">
              <span className="focus-chain-label">Task Progress</span>
              <span className="focus-chain-counter">
                {completedCount}/{totalCount}
              </span>
            </div>
            {currentTask && (
              <div className="focus-chain-current">
                <span className="current-indicator">
                  <Circle size={6} fill="currentColor" />
                </span>
                <span className="current-text">{currentTask.title}</span>
              </div>
            )}
          </div>
        </div>
        <div className="focus-chain-toggle">
          <ChevronDown
            size={16}
            style={{
              transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
              transition: 'transform 0.2s'
            }}
          />
        </div>
      </div>

      <div className="focus-chain-progress-bar">
        <div className="focus-chain-progress-fill" style={{ width: `${progressPercent}%` }} />
      </div>

      {isExpanded && (
        <div className="focus-chain-content">
          <div className="focus-chain-list">
            {todos.map((todo) => (
              <div
                key={todo.id}
                className={`focus-chain-item ${todo.status}`}
                onClick={() => onUpdateTodo && onUpdateTodo(todo.id, todo.status)}
              >
                <div className="todo-status-indicator">
                  {todo.status === 'completed' ? (
                    <div className="todo-checkbox checked">
                      <Check size={12} />
                    </div>
                  ) : todo.status === 'in-progress' ? (
                    <div className="todo-checkbox in-progress">
                      <div className="spinner" />
                    </div>
                  ) : (
                    <div className="todo-checkbox" />
                  )}
                </div>
                <div className="todo-content">
                  <div className="todo-title">{todo.title}</div>
                  {todo.description && <div className="todo-description">{todo.description}</div>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
