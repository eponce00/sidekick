import { useState } from 'react'
import type { ProjectStartHook } from '../../../shared/projectHooks'

export function ProjectHooksPanel({
  hooks,
  onChange,
  stage = 'start'
}: {
  hooks: ProjectStartHook[]
  onChange: (hooks: ProjectStartHook[]) => void
  stage?: 'start' | 'completion' | 'worktree'
}): React.JSX.Element {
  const [workspaceRoot, setWorkspaceRoot] = useState('')
  const [command, setCommand] = useState('')
  return (
    <section className="settings-card">
      <div className="settings-card-heading">
        <h3>Project {stage} hooks</h3>
        <p>
          {stage === 'start'
            ? 'Run setup commands before each new agent run in an exact project folder.'
            : stage === 'worktree'
              ? 'Run setup after a new isolated fork is saved. Match the original project folder, but execute in the new worktree. Commands run once, with a two-minute limit each.'
              : 'Run once before the final response of an ordinary Act conversation. Goal-driven runs and Plan mode are excluded; hook results are checked before the final response.'}{' '}
          Each command requires approval, even in full-access mode. No repository scripts are
          discovered automatically. Commands use your selected host or isolated-shell environment.
          {stage !== 'worktree' && ' Hooks do not run in Plan mode.'}
        </p>
      </div>
      <div className="settings-card-content">
        {hooks.map((hook, index) => (
          <div key={index}>
            <label>
              <input
                type="checkbox"
                checked={hook.enabled}
                onChange={(event) =>
                  onChange(
                    hooks.map((item, position) =>
                      position === index ? { ...item, enabled: event.target.checked } : item
                    )
                  )
                }
              />
              {hook.workspaceRoot}
            </label>
            <pre>{hook.command}</pre>
            <button
              type="button"
              className="settings-secondary-action"
              onClick={() => onChange(hooks.filter((_, position) => position !== index))}
            >
              Remove hook
            </button>
          </div>
        ))}
        <label>
          Absolute project folder
          <input
            aria-label={`${stage} hook project folder`}
            value={workspaceRoot}
            onChange={(event) => setWorkspaceRoot(event.target.value)}
          />
        </label>
        <label>
          {stage === 'completion' ? 'Completion command' : 'Setup command'}
          <textarea
            aria-label={`${stage} hook command`}
            value={command}
            onChange={(event) => setCommand(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="settings-secondary-action"
          disabled={!workspaceRoot.trim() || !command.trim() || hooks.length >= 10}
          onClick={() => {
            onChange([
              ...hooks,
              { workspaceRoot: workspaceRoot.trim(), command: command.trim(), enabled: false }
            ])
            setWorkspaceRoot('')
            setCommand('')
          }}
        >
          Add disabled hook
        </button>
        <p>
          Enable the hook and save settings when ready. Hooks run in listed order.{' '}
          {stage === 'worktree'
            ? 'A denial or failure stops setup and preserves the new fork and any partial files. Private command-output paths are shown in the result dialog.'
            : 'A denial or failure stops the run; completed commands are never automatically replayed.'}
        </p>
      </div>
    </section>
  )
}
