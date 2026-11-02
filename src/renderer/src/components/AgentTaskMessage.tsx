import { useLayoutEffect, useRef, useState } from 'react'
import { MessageMarkdown } from './MessageMarkdown'

/**
 * What another agent asked this one to do. It is this chat's first turn, so it reads like one, with a
 * quiet line to say the user didn't write it. A long one folds, so the work below it is what's in view.
 */
export function AgentTaskMessage({
  from,
  content,
  workspaceRoot
}: {
  from: string
  content: string
  workspaceRoot?: string | null
}): React.JSX.Element {
  const body = useRef<HTMLDivElement>(null)
  const [overflows, setOverflows] = useState(false)
  const [expanded, setExpanded] = useState(false)

  useLayoutEffect(() => {
    const element = body.current
    if (element && !expanded) setOverflows(element.scrollHeight > element.clientHeight + 1)
  }, [content, expanded])

  return (
    <div className="message message-user agent-task" aria-label={`Task from ${from}`}>
      <div className="agent-task__from">From {from}</div>
      <div className="message-bubble">
        <div
          ref={body}
          className={`message-content agent-task__body${expanded ? ' is-expanded' : ''}${
            overflows && !expanded ? ' is-folded' : ''
          }`}
        >
          <MessageMarkdown content={content} workspaceRoot={workspaceRoot ?? undefined} />
        </div>
      </div>
      {overflows && (
        <button
          type="button"
          className="agent-task__more"
          aria-expanded={expanded}
          onClick={() => {
            setExpanded((current) => !current)
            // The list below follows its newest step, which is no place to start reading from.
            requestAnimationFrame(() =>
              body.current?.closest('.agent-task')?.scrollIntoView({ block: 'start' })
            )
          }}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  )
}
