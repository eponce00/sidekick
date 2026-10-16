import { useEffect, useMemo, useState } from 'react'
import {
  CalendarClock,
  ChevronDown,
  ChevronRight,
  MessageSquare,
  Pause,
  Pencil,
  Play,
  Plus,
  Trash2,
  X,
  Zap
} from 'lucide-react'
import type { PinnedModel } from '../../../shared/models'
import type { Project } from '../../../shared/projects'
import {
  describeScheduleTiming,
  SCHEDULE_CADENCES,
  scheduleWeekdayName,
  type Schedule,
  type ScheduleCadence,
  type ScheduleInput,
  type ScheduleRun
} from '../../../shared/schedules'
import { useModalDialog } from '../hooks/useModalDialog'
import { formatScheduleTime, scheduleRunStatus } from '../utils/scheduleDisplay'
import { SCHEDULE_TEMPLATES, type ScheduleTemplate } from '../utils/scheduleTemplates'
import ConfirmDialog from './ConfirmDialog'
import './SchedulesDialog.css'

interface SchedulesDialogProps {
  isOpen: boolean
  schedules: Schedule[]
  projects: Project[]
  models: PinnedModel[]
  /** The chat's current model, offered first for a new schedule. */
  defaultModelId: string
  defaultProjectId: string | null
  onClose: () => void
  onOpenConversation: (conversationId: string) => void
}

const CADENCE_LABELS: Record<ScheduleCadence, string> = {
  hourly: 'Hourly',
  daily: 'Daily',
  weekdays: 'Weekdays',
  weekly: 'Weekly'
}

type Editing =
  | { mode: 'create'; draft: ScheduleInput }
  | { mode: 'edit'; id: string; draft: ScheduleInput }

function blankDraft(modelId: string, projectId: string | null): ScheduleInput {
  return {
    name: '',
    prompt: '',
    projectId,
    modelId,
    cadence: 'weekdays',
    hour: 9,
    minute: 0,
    weekday: 1,
    catchUp: true
  }
}

function draftFromSchedule(schedule: Schedule): ScheduleInput {
  const { name, prompt, projectId, modelId, cadence, hour, minute, weekday, catchUp } = schedule
  return { name, prompt, projectId, modelId, cadence, hour, minute, weekday, catchUp }
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  // Electron prefixes errors thrown by a main-process handler with the channel name.
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
}

export default function SchedulesDialog({
  isOpen,
  schedules,
  projects,
  models,
  defaultModelId,
  defaultProjectId,
  onClose,
  onOpenConversation
}: SchedulesDialogProps): React.JSX.Element | null {
  const [editing, setEditing] = useState<Editing | null>(null)
  const [pendingDelete, setPendingDelete] = useState<Schedule | null>(null)
  const [error, setError] = useState('')
  const dialogRef = useModalDialog<HTMLElement>(isOpen && !pendingDelete, () => {
    if (editing) setEditing(null)
    else onClose()
  })
  const fallbackModelId = models.some(({ id }) => id === defaultModelId)
    ? defaultModelId
    : (models[0]?.id ?? '')

  if (!isOpen) return null

  const startCreate = (template?: ScheduleTemplate): void => {
    setError('')
    const draft = blankDraft(fallbackModelId, defaultProjectId ?? projects[0]?.id ?? null)
    setEditing({
      mode: 'create',
      draft: template
        ? {
            ...draft,
            name: template.name,
            prompt: template.prompt,
            cadence: template.cadence,
            hour: template.hour,
            minute: template.minute,
            weekday: template.weekday
          }
        : draft
    })
  }

  const act = async (action: () => Promise<unknown>): Promise<boolean> => {
    setError('')
    try {
      await action()
      return true
    } catch (reason) {
      setError(errorMessage(reason))
      return false
    }
  }

  const usedTemplateNames = new Set(schedules.map(({ name }) => name))
  const templates = SCHEDULE_TEMPLATES.filter(({ name }) => !usedTemplateNames.has(name))

  return (
    <div className="schedules-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="schedules-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="schedules-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div className="schedules-heading">
            <span className="schedules-icon">
              <CalendarClock size={18} />
            </span>
            <div>
              <h2 id="schedules-title">
                {editing
                  ? editing.mode === 'create'
                    ? 'New schedule'
                    : 'Edit schedule'
                  : 'Schedules'}
              </h2>
              <p>Start agent runs on their own, at the times you choose.</p>
            </div>
          </div>
          <button type="button" className="schedules-close" onClick={onClose} aria-label="Close">
            <X size={17} />
          </button>
        </header>

        {error && (
          <div className="schedules-error" role="alert">
            {error}
          </div>
        )}

        {editing ? (
          <ScheduleEditor
            key={editing.mode === 'edit' ? editing.id : 'new'}
            initial={editing.draft}
            projects={projects}
            models={models}
            submitLabel={editing.mode === 'create' ? 'Create schedule' : 'Save changes'}
            onCancel={() => {
              setError('')
              setEditing(null)
            }}
            onSubmit={async (draft) => {
              const saved = await act(() =>
                editing.mode === 'create'
                  ? window.api.schedules.create(draft)
                  : window.api.schedules.update({ ...draft, id: editing.id })
              )
              if (saved) setEditing(null)
            }}
          />
        ) : (
          <div className="schedules-body">
            {models.length === 0 ? (
              <div className="schedules-empty">
                <CalendarClock size={22} />
                <strong>No models are ready</strong>
                <span>Enable a model in Provider settings, then come back to schedule a run.</span>
              </div>
            ) : (
              <>
                <div className="schedules-toolbar">
                  <span>
                    {schedules.length
                      ? `${schedules.length} ${schedules.length === 1 ? 'schedule' : 'schedules'}`
                      : 'No schedules yet'}
                  </span>
                  <button type="button" className="schedules-primary" onClick={() => startCreate()}>
                    <Plus size={14} /> New schedule
                  </button>
                </div>
                {schedules.map((schedule) => (
                  <ScheduleCard
                    key={schedule.id}
                    schedule={schedule}
                    projectName={
                      schedule.projectId
                        ? (projects.find(({ id }) => id === schedule.projectId)?.name ??
                          'Removed project')
                        : 'Standalone chat'
                    }
                    modelName={
                      models.find(({ id }) => id === schedule.modelId)?.name ?? 'Unavailable model'
                    }
                    onEdit={() => {
                      setError('')
                      setEditing({
                        mode: 'edit',
                        id: schedule.id,
                        draft: draftFromSchedule(schedule)
                      })
                    }}
                    onAction={act}
                    onDelete={() => setPendingDelete(schedule)}
                    onOpenConversation={onOpenConversation}
                  />
                ))}
                {templates.length > 0 && (
                  <section className="schedules-templates" aria-label="Suggested schedules">
                    <h3>Start from a suggestion</h3>
                    <div className="schedules-template-grid">
                      {templates.map((template) => (
                        <button
                          type="button"
                          key={template.id}
                          className="schedules-template"
                          onClick={() => startCreate(template)}
                        >
                          <strong>{template.name}</strong>
                          <span>{template.description}</span>
                          <small>{describeScheduleTiming(template)}</small>
                        </button>
                      ))}
                    </div>
                  </section>
                )}
              </>
            )}
          </div>
        )}
      </section>
      <ConfirmDialog
        isOpen={pendingDelete !== null}
        title="Delete schedule?"
        message={`"${pendingDelete?.name ?? ''}" will stop running. The chats it already created are kept.`}
        confirmText="Delete"
        variant="danger"
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          const target = pendingDelete
          setPendingDelete(null)
          if (target) void act(() => window.api.schedules.delete(target.id))
        }}
      />
    </div>
  )
}

function ScheduleCard({
  schedule,
  projectName,
  modelName,
  onEdit,
  onAction,
  onDelete,
  onOpenConversation
}: {
  schedule: Schedule
  projectName: string
  modelName: string
  onEdit: () => void
  onAction: (action: () => Promise<unknown>) => Promise<boolean>
  onDelete: () => void
  onOpenConversation: (conversationId: string) => void
}): React.JSX.Element {
  const [showRuns, setShowRuns] = useState(false)
  const [runs, setRuns] = useState<ScheduleRun[] | null>(null)
  const [busy, setBusy] = useState(false)

  // Reload the history whenever the schedule changes, which it does after every run.
  useEffect(() => {
    if (!showRuns) return
    let cancelled = false
    void window.api.schedules.runs(schedule.id).then((list) => {
      if (!cancelled) setRuns(list)
    })
    return () => {
      cancelled = true
    }
  }, [schedule, showRuns])

  const run = async (action: () => Promise<unknown>): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await onAction(action)
    } finally {
      setBusy(false)
    }
  }

  const active = schedule.activeRun
  const state = active
    ? active.phase === 'awaiting_permission'
      ? 'Waiting for your approval'
      : active.phase === 'awaiting_user'
        ? 'Waiting for your answer'
        : 'Running now'
    : schedule.enabled && schedule.nextRunAt
      ? `Next: ${formatScheduleTime(schedule.nextRunAt)}`
      : 'Paused'

  return (
    <article className={`schedule-card ${schedule.enabled ? '' : 'is-paused'}`}>
      <div className="schedule-card-main">
        <span
          className={`schedule-status-dot ${active ? (active.phase.startsWith('awaiting') ? 'waiting' : 'working') : schedule.enabled ? 'enabled' : 'paused'}`}
          aria-hidden="true"
        />
        <div className="schedule-card-text">
          <strong>{schedule.name}</strong>
          <span>
            {describeScheduleTiming(schedule)} · {projectName} · {modelName}
          </span>
          <span className="schedule-card-state">
            {active ? (
              <button
                type="button"
                className="schedule-link"
                onClick={() => onOpenConversation(active.conversationId)}
              >
                {state}
              </button>
            ) : (
              state
            )}
            {schedule.lastRunAt ? ` · Last run ${formatScheduleTime(schedule.lastRunAt)}` : ''}
          </span>
          {schedule.pausedReason && (
            <span className="schedule-card-warning">{schedule.pausedReason}</span>
          )}
        </div>
        <div className="schedule-card-actions">
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const started = await window.api.schedules.runNow(schedule.id)
                if (started.outcome !== 'started') {
                  throw new Error(started.reason ?? 'The run did not start.')
                }
                onOpenConversation(started.conversationId!)
              })
            }
            title="Run now"
            aria-label={`Run ${schedule.name} now`}
          >
            <Zap size={14} />
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(() =>
                schedule.enabled
                  ? window.api.schedules.pause(schedule.id)
                  : window.api.schedules.resume(schedule.id)
              )
            }
            title={schedule.enabled ? 'Pause' : 'Resume'}
            aria-label={`${schedule.enabled ? 'Pause' : 'Resume'} ${schedule.name}`}
          >
            {schedule.enabled ? <Pause size={14} /> : <Play size={14} />}
          </button>
          <button type="button" onClick={onEdit} title="Edit" aria-label={`Edit ${schedule.name}`}>
            <Pencil size={14} />
          </button>
          <button
            type="button"
            className="danger"
            onClick={onDelete}
            title="Delete"
            aria-label={`Delete ${schedule.name}`}
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>
      <button
        type="button"
        className="schedule-runs-toggle"
        aria-expanded={showRuns}
        onClick={() => setShowRuns((current) => !current)}
      >
        {showRuns ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        Runs ({schedule.runCount})
      </button>
      {showRuns && (
        <ol className="schedule-runs">
          {runs === null ? (
            <li className="schedule-runs-empty">Loading…</li>
          ) : runs.length === 0 ? (
            <li className="schedule-runs-empty">No runs yet.</li>
          ) : (
            runs.map((item) => {
              const status = scheduleRunStatus(item)
              return (
                <li key={item.id} className="schedule-run">
                  <span className={`schedule-run-dot ${status.tone}`} aria-hidden="true" />
                  <span className="schedule-run-name">
                    {item.runNumber ? `Run ${item.runNumber}` : 'No run'}
                    {item.trigger === 'manual' ? ' · asked by you' : ''}
                  </span>
                  <span className="schedule-run-time">
                    {formatScheduleTime(item.startedAt ?? item.scheduledFor)}
                  </span>
                  <span className={`schedule-run-status ${status.tone}`} title={item.reason}>
                    {status.label}
                    {item.late && item.outcome === 'started' ? ' · late' : ''}
                  </span>
                  {item.conversationId ? (
                    <button
                      type="button"
                      className="schedule-run-open"
                      onClick={() => onOpenConversation(item.conversationId!)}
                      aria-label={`Open the chat for run ${item.runNumber ?? ''}`}
                      title="Open chat"
                    >
                      <MessageSquare size={13} />
                    </button>
                  ) : (
                    <span />
                  )}
                  {item.reason && <span className="schedule-run-reason">{item.reason}</span>}
                </li>
              )
            })
          )}
        </ol>
      )}
    </article>
  )
}

function ScheduleEditor({
  initial,
  projects,
  models,
  submitLabel,
  onCancel,
  onSubmit
}: {
  initial: ScheduleInput
  projects: Project[]
  models: PinnedModel[]
  submitLabel: string
  onCancel: () => void
  onSubmit: (draft: ScheduleInput) => Promise<void>
}): React.JSX.Element {
  const [draft, setDraft] = useState(initial)
  const [saving, setSaving] = useState(false)
  const set = <Key extends keyof ScheduleInput>(key: Key, value: ScheduleInput[Key]): void =>
    setDraft((current) => ({ ...current, [key]: value }))
  const time = `${String(draft.hour).padStart(2, '0')}:${String(draft.minute).padStart(2, '0')}`
  const modelMissing = !models.some(({ id }) => id === draft.modelId)
  const canSave = draft.name.trim() && draft.prompt.trim() && !modelMissing && !saving
  const summary = useMemo(() => describeScheduleTiming(draft), [draft])

  return (
    <form
      className="schedules-editor"
      onSubmit={(event) => {
        event.preventDefault()
        if (!canSave) return
        setSaving(true)
        void onSubmit(draft).finally(() => setSaving(false))
      }}
    >
      <div className="schedules-editor-fields">
        <label>
          <span>Name</span>
          <input
            autoFocus
            value={draft.name}
            maxLength={120}
            onChange={(event) => set('name', event.target.value)}
            placeholder="Morning change summary"
          />
        </label>
        <label>
          <span>Prompt</span>
          <textarea
            value={draft.prompt}
            rows={5}
            onChange={(event) => set('prompt', event.target.value)}
            placeholder="What the agent should do each time"
          />
        </label>
        <div className="schedules-editor-row">
          <label>
            <span>Project folder</span>
            <select
              value={draft.projectId ?? ''}
              onChange={(event) => set('projectId', event.target.value || null)}
            >
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
              <option value="">No project (standalone chat)</option>
            </select>
          </label>
          <label>
            <span>Model</span>
            <select value={draft.modelId} onChange={(event) => set('modelId', event.target.value)}>
              {modelMissing && <option value={draft.modelId}>Choose a model</option>}
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.providerInstanceName
                    ? `${model.name} · ${model.providerInstanceName}`
                    : model.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <fieldset className="schedules-cadence">
          <legend>Repeat</legend>
          <div className="schedules-segmented" role="radiogroup" aria-label="Repeat">
            {SCHEDULE_CADENCES.map((cadence) => (
              <button
                type="button"
                key={cadence}
                role="radio"
                aria-checked={draft.cadence === cadence}
                className={draft.cadence === cadence ? 'selected' : ''}
                onClick={() => set('cadence', cadence)}
              >
                {CADENCE_LABELS[cadence]}
              </button>
            ))}
          </div>
        </fieldset>
        <div className="schedules-editor-row">
          {draft.cadence === 'weekly' && (
            <label>
              <span>Day</span>
              <select
                value={draft.weekday}
                onChange={(event) => set('weekday', Number(event.target.value))}
              >
                {[1, 2, 3, 4, 5, 6, 0].map((day) => (
                  <option key={day} value={day}>
                    {scheduleWeekdayName(day)}
                  </option>
                ))}
              </select>
            </label>
          )}
          {draft.cadence === 'hourly' ? (
            <label>
              <span>Minute past the hour</span>
              <select
                value={draft.minute}
                onChange={(event) => set('minute', Number(event.target.value))}
              >
                {Array.from({ length: 12 }, (_, index) => index * 5).map((minute) => (
                  <option key={minute} value={minute}>
                    :{String(minute).padStart(2, '0')}
                  </option>
                ))}
                {draft.minute % 5 !== 0 && (
                  <option value={draft.minute}>:{String(draft.minute).padStart(2, '0')}</option>
                )}
              </select>
            </label>
          ) : (
            <label>
              <span>Time</span>
              <input
                type="time"
                value={time}
                required
                onChange={(event) => {
                  const [hour, minute] = event.target.value.split(':').map(Number)
                  if (Number.isInteger(hour) && Number.isInteger(minute)) {
                    setDraft((current) => ({ ...current, hour, minute }))
                  }
                }}
              />
            </label>
          )}
        </div>
        <label className="schedules-checkbox">
          <input
            type="checkbox"
            checked={draft.catchUp}
            onChange={(event) => set('catchUp', event.target.checked)}
          />
          <span>
            Run once when SideKick starts or wakes, if it was closed or asleep at the scheduled time
          </span>
        </label>
        <p className="schedules-editor-note">
          {summary}, in this computer&apos;s time zone. Each run opens a new chat and asks for
          approval exactly as your permission setting does; a run that is waiting for you holds off
          the next one.
        </p>
      </div>
      <footer>
        <button type="button" className="schedules-secondary" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="schedules-primary" disabled={!canSave}>
          {saving ? 'Saving…' : submitLabel}
        </button>
      </footer>
    </form>
  )
}
