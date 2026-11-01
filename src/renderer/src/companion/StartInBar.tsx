import { useCallback, useState } from 'react'
import { ChevronDown, Folder, GitBranch, MessageSquare } from 'lucide-react'
import type { CompanionProject } from '../../../shared/companion'
import { Sheet, SheetAction, SheetSection } from './Sheet'

export interface StartIn {
  projectId: string | null
  workIn: 'folder' | 'worktree'
}

/**
 * Where a new chat starts, above its message box as the desktop's Work in bar sits: a project or
 * none, and for a project in a Git repository, its folder or a new worktree of its own.
 */
export function StartInBar({
  projects,
  value,
  onChange
}: {
  projects: readonly CompanionProject[]
  value: StartIn
  onChange: (value: StartIn) => void
}) {
  const [sheet, setSheet] = useState<'project' | 'work' | null>(null)
  const close = useCallback(() => setSheet(null), [])
  const project = projects.find((candidate) => candidate.id === value.projectId) ?? null
  if (!projects.length) return null
  const worktree = Boolean(project?.canUseWorktree && value.workIn === 'worktree')
  return (
    <div className="cp-start-in" role="group" aria-label="Where this chat starts">
      <button
        type="button"
        className="cp-start-chip"
        aria-haspopup="dialog"
        onClick={() => setSheet('project')}
      >
        {project ? (
          <Folder size={16} aria-hidden="true" />
        ) : (
          <MessageSquare size={16} aria-hidden="true" />
        )}
        <span>{project?.name ?? 'No project'}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {project?.canUseWorktree && (
        <button
          type="button"
          className={`cp-start-chip${worktree ? ' is-on' : ''}`}
          aria-haspopup="dialog"
          onClick={() => setSheet('work')}
        >
          <GitBranch size={16} aria-hidden="true" />
          <span>{worktree ? 'New worktree' : 'This folder'}</span>
          <ChevronDown size={14} aria-hidden="true" />
        </button>
      )}
      {sheet === 'project' && (
        <Sheet label="Start in" onClose={close}>
          <SheetSection label="Start this chat in">
            <SheetAction
              icon={<MessageSquare size={20} />}
              label="No project"
              selected={!project}
              onClick={() => {
                onChange({ projectId: null, workIn: 'folder' })
                close()
              }}
            />
            {projects.map((candidate) => (
              <SheetAction
                key={candidate.id}
                icon={<Folder size={20} />}
                label={candidate.name}
                selected={candidate.id === project?.id}
                onClick={() => {
                  onChange({ projectId: candidate.id, workIn: value.workIn })
                  close()
                }}
              />
            ))}
          </SheetSection>
        </Sheet>
      )}
      {sheet === 'work' && project && (
        <Sheet label="Work in" onClose={close}>
          <SheetSection label="Work in">
            <SheetAction
              icon={<Folder size={20} />}
              label="This folder"
              description={`Changes go straight into ${project.name}`}
              selected={!worktree}
              onClick={() => {
                onChange({ ...value, workIn: 'folder' })
                close()
              }}
            />
            <SheetAction
              icon={<GitBranch size={20} />}
              label="New worktree"
              description="Its own copy of the project, on its own branch"
              selected={worktree}
              onClick={() => {
                onChange({ ...value, workIn: 'worktree' })
                close()
              }}
            />
          </SheetSection>
        </Sheet>
      )}
    </div>
  )
}
