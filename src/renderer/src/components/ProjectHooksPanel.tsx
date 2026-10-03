import { useState } from 'react'
import { FolderOpen, Trash2 } from 'lucide-react'
import type { ProjectStartHook } from '../../../shared/projectHooks'

export type ProjectHookStage = 'start' | 'completion' | 'worktree'

const STAGES: Array<{ id: ProjectHookStage; label: string; hint: string }> = [
  {
    id: 'start',
    label: 'When a run starts',
    hint: 'Before the agent begins, for example to start a dev server.'
  },
  {
    id: 'completion',
    label: 'Before the final answer',
    hint: 'Once the agent is done in Act mode, for example to run the tests. Not for goals.'
  },
  {
    id: 'worktree',
    label: 'After creating a worktree',
    hint: 'Once a fork gets its own folder, for example to install dependencies there.'
  }
]

const MAX_HOOKS_PER_STAGE = 10

/**
 * Commands SideKick runs at set moments in a project, one list per moment. Hooks belong to the
 * app's settings and are never read from a repository, and each run asks before it runs one.
 */
export function ProjectHooksPanel({
  hooks,
  onChange
}: {
  hooks: Record<ProjectHookStage, ProjectStartHook[]>
  onChange: (stage: ProjectHookStage, hooks: ProjectStartHook[]) => void
}): React.JSX.Element {
  const [stage, setStage] = useState<ProjectHookStage>('start')
  const [workspaceRoot, setWorkspaceRoot] = useState('')
  const [command, setCommand] = useState('')
  const listed = STAGES.flatMap(({ id, label }) =>
    hooks[id].map((hook, index) => ({ stage: id, label, hook, index }))
  )
  const full = hooks[stage].length >= MAX_HOOKS_PER_STAGE

  const update = (target: ProjectHookStage, index: number, next: ProjectStartHook | null): void =>
    onChange(
      target,
      next
        ? hooks[target].map((hook, position) => (position === index ? next : hook))
        : hooks[target].filter((_, position) => position !== index)
    )

  return (
    <section className="settings-card project-hooks">
      <div className="settings-card-heading">
        <h3>Project hooks</h3>
        <p>
          Commands SideKick runs for you at set moments in one project folder. Each asks for your
          approval when it runs, even with full access, and they run in the order listed. They never
          come from a repository, and Plan mode runs none.
        </p>
      </div>
      <div className="settings-card-content">
        {listed.length > 0 && (
          <ul className="project-hook-list">
            {listed.map(({ stage: hookStage, label, hook, index }) => (
              <li key={`${hookStage}-${index}`} className="project-hook">
                <span className="modern-switch" title={hook.enabled ? 'On' : 'Off'}>
                  <input
                    type="checkbox"
                    checked={hook.enabled}
                    aria-label={`Run this hook ${label.toLowerCase()}`}
                    onChange={(event) =>
                      update(hookStage, index, { ...hook, enabled: event.target.checked })
                    }
                  />
                  <span />
                </span>
                <span className="project-hook-copy">
                  <span className="project-hook-stage">{label}</span>
                  <code className="project-hook-command">{hook.command}</code>
                  <span className="project-hook-folder" title={hook.workspaceRoot}>
                    {hook.workspaceRoot}
                  </span>
                </span>
                <button
                  type="button"
                  className="project-hook-remove"
                  aria-label="Remove hook"
                  title="Remove hook"
                  onClick={() => update(hookStage, index, null)}
                >
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="project-hook-form">
          <strong>Add a hook</strong>
          <label className="modern-field">
            <span>When</span>
            <select
              value={stage}
              onChange={(event) => setStage(event.target.value as ProjectHookStage)}
            >
              {STAGES.map(({ id, label }) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
            <small>{STAGES.find(({ id }) => id === stage)!.hint}</small>
          </label>
          <label className="modern-field">
            <span>Project folder</span>
            <span className="project-hook-folder-input">
              <input
                aria-label="Hook project folder"
                placeholder="C:\path\to\project"
                value={workspaceRoot}
                onChange={(event) => setWorkspaceRoot(event.target.value)}
              />
              <button
                type="button"
                className="settings-secondary-action"
                onClick={() =>
                  void window.api.workspace.selectFolder().then((result) => {
                    if (!result.canceled && result.path) setWorkspaceRoot(result.path)
                  })
                }
              >
                <FolderOpen size={14} />
                Browse
              </button>
            </span>
          </label>
          <label className="modern-field">
            <span>Command</span>
            <textarea
              aria-label="Hook command"
              placeholder="npm install"
              rows={2}
              value={command}
              onChange={(event) => setCommand(event.target.value)}
            />
          </label>
          <div className="project-hook-actions">
            <small>
              {full
                ? 'This moment already has ten hooks.'
                : 'A new hook is added switched off. Turn it on in the list to use it.'}
            </small>
            <button
              type="button"
              className="settings-secondary-action"
              disabled={!workspaceRoot.trim() || !command.trim() || full}
              onClick={() => {
                onChange(stage, [
                  ...hooks[stage],
                  // A new hook stays off until it is switched on, so adding one never runs anything.
                  { workspaceRoot: workspaceRoot.trim(), command: command.trim(), enabled: false }
                ])
                setCommand('')
              }}
            >
              Add hook
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}
