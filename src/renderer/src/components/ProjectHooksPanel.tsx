import { useId, useState } from 'react'
import { FolderOpen, Plus, Trash2, Webhook } from 'lucide-react'
import type { ProjectStartHook } from '../../../shared/projectHooks'
import { SettingsEmptyState, SettingsSection, SettingsSwitch } from './SettingsLayout'
import { Select } from './Select'

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
  const id = useId()
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
    <SettingsSection
      icon={Webhook}
      title="Project hooks"
      className="project-hooks"
      description="Commands SideKick runs for you at set moments in one project folder. Each asks for your approval when it runs, even with full access, and they run in the order listed. They never come from a repository, and Plan mode runs none."
    >
      {listed.length > 0 ? (
        <div>
          <ul className="settings-list project-hook-list">
            {listed.map(({ stage: hookStage, label, hook, index }) => (
              <li key={`${hookStage}-${index}`} className="project-hook">
                <span title={hook.enabled ? 'On' : 'Off'}>
                  <SettingsSwitch
                    checked={hook.enabled}
                    label={`Run this hook ${label.toLowerCase()}`}
                    onChange={(enabled) => update(hookStage, index, { ...hook, enabled })}
                  />
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
                  className="settings-ghost-action is-small is-icon settings-remove-action"
                  aria-label="Remove hook"
                  title="Remove hook"
                  onClick={() => update(hookStage, index, null)}
                >
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <SettingsEmptyState compact icon={Webhook} title="No project hooks yet." />
      )}
      <div className="project-hook-form">
        <strong className="settings-row-label">Add a hook</strong>
        <label className="modern-field" htmlFor={`${id}-stage`}>
          <span>When</span>
          <Select
            id={`${id}-stage`}
            value={stage}
            onChange={(event) => setStage(event.target.value as ProjectHookStage)}
          >
            {STAGES.map(({ id: stageId, label }) => (
              <option key={stageId} value={stageId}>
                {label}
              </option>
            ))}
          </Select>
          <small>{STAGES.find(({ id: stageId }) => stageId === stage)!.hint}</small>
        </label>
        <div className="modern-field">
          <label htmlFor={`${id}-folder`}>Project folder</label>
          <span className="settings-inline-field">
            <input
              id={`${id}-folder`}
              className="settings-path-input"
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
              <FolderOpen size={14} aria-hidden="true" />
              Browse
            </button>
          </span>
        </div>
        <label className="modern-field project-hook-command-field">
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
            <Plus size={14} aria-hidden="true" />
            Add hook
          </button>
        </div>
      </div>
    </SettingsSection>
  )
}
