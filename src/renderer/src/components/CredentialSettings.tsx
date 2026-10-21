import { useEffect, useId, useMemo, useState } from 'react'
import { Eye, EyeOff, KeyRound, Pencil, Plus, ShieldAlert, Trash2, UserRound } from 'lucide-react'
import {
  CREDENTIAL_ASK_LABELS,
  CREDENTIAL_ASK_POLICIES,
  MIN_CREDENTIAL_VALUE,
  SHORT_CREDENTIAL_VALUE,
  defaultCredentialScope,
  type CredentialAskPolicy,
  type CredentialEvent,
  type CredentialKind,
  type CredentialRequest,
  type CredentialSaveInput,
  type CredentialScope,
  type CredentialStatus,
  type CredentialSummary,
  type CredentialValues
} from '../../../shared/credentials'
import type { Project } from '../../../shared/projects'
import { Select } from './Select'
import { SettingsEmptyState, SettingsRow, SettingsSection, ToggleField } from './SettingsLayout'
import './CredentialSettings.css'

interface Draft {
  id?: string
  alias: string
  kind: CredentialKind
  description: string
  usernameVisible: boolean
  ask: CredentialAskPolicy
  scope: CredentialScope
  values: CredentialValues
  /** The description the agent suggested when it asked for this credential. */
  suggestedDescription?: string
}

function newDraft(request?: CredentialRequest | null): Draft {
  return {
    alias: request?.alias ?? '',
    kind: request?.kind ?? 'secret',
    description: request?.description ?? '',
    ...(request?.description ? { suggestedDescription: request.description } : {}),
    usernameVisible: false,
    ask: 'once_per_chat',
    scope: defaultCredentialScope(),
    values: {}
  }
}

function draftFrom(credential: CredentialSummary): Draft {
  return {
    id: credential.id,
    alias: credential.alias,
    kind: credential.kind,
    description: credential.description,
    usernameVisible: credential.usernameVisible,
    ask: credential.ask,
    scope: credential.scope,
    values: {}
  }
}

function relativeTime(at: number): string {
  const minutes = Math.round((Date.now() - at) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return new Date(at).toLocaleDateString()
}

const EVENT_LABELS: Record<CredentialEvent['kind'], string> = {
  created: 'Added',
  value_replaced: 'Value replaced',
  changed: 'Changed',
  deleted: 'Deleted',
  used: 'Used',
  denied: 'Denied',
  refused: 'Refused'
}

/**
 * A value field that never shows a stored value: it starts empty and only sets a new one. What the
 * user types is masked unless `plain`, as for a username, and can be shown while typing. A
 * `multiline` field takes a pasted key with its line breaks, masked the same way.
 */
function ValueField({
  label,
  stored,
  value,
  onChange,
  autoFocus,
  plain = false,
  multiline = false,
  hidden = true
}: {
  label: string
  stored: boolean
  value: string | undefined
  onChange: (value: string | undefined) => void
  autoFocus?: boolean
  plain?: boolean
  multiline?: boolean
  /** Whether the redactor hides this value, which decides the length warning. */
  hidden?: boolean
}): React.JSX.Element {
  const id = useId()
  const [revealed, setRevealed] = useState(false)
  const shown = plain || revealed
  const length = value?.trim().length ?? 0
  const placeholder = stored
    ? 'Stored. Type a new value to replace it.'
    : `Enter the ${label.toLowerCase()}`
  const warning = !value
    ? null
    : !plain && length < MIN_CREDENTIAL_VALUE
      ? `Enter at least ${MIN_CREDENTIAL_VALUE} characters; shorter values cannot be kept out of output.`
      : !plain && length < SHORT_CREDENTIAL_VALUE
        ? `Values under ${SHORT_CREDENTIAL_VALUE} characters may be missed in output, or hide ordinary text that matches them.`
        : plain && hidden && length < MIN_CREDENTIAL_VALUE
          ? `A username under ${MIN_CREDENTIAL_VALUE} characters is not hidden from output.`
          : null
  return (
    <label className="modern-field credential-value-field" htmlFor={id}>
      <span>{label}</span>
      <span className="credential-value-input">
        {multiline ? (
          <textarea
            id={id}
            className={shown ? undefined : 'is-masked'}
            rows={Math.min(6, Math.max(1, (value ?? '').split('\n').length))}
            value={value ?? ''}
            autoComplete="off"
            spellCheck={false}
            autoFocus={autoFocus}
            placeholder={placeholder}
            onChange={(event) => onChange(event.target.value || undefined)}
          />
        ) : (
          <input
            id={id}
            type={shown ? 'text' : 'password'}
            value={value ?? ''}
            autoComplete="off"
            spellCheck={false}
            autoFocus={autoFocus}
            placeholder={placeholder}
            onChange={(event) => onChange(event.target.value || undefined)}
          />
        )}
        {!plain && (
          <button
            type="button"
            className="settings-ghost-action is-small is-icon"
            aria-label={revealed ? 'Hide what you typed' : 'Show what you typed'}
            title={revealed ? 'Hide what you typed' : 'Show what you typed'}
            disabled={!value}
            onClick={() => setRevealed(!revealed)}
          >
            {revealed ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        )}
      </span>
      {warning && <small className="credential-warning">{warning}</small>}
    </label>
  )
}

function scopeSummary(credential: CredentialSummary): string {
  const parts = credential.username ? [`as ${credential.username}`] : []
  parts.push(`Asks: ${CREDENTIAL_ASK_LABELS[credential.ask].toLowerCase()}`)
  if (credential.scope.projects !== 'all') {
    const count = credential.scope.projects.length
    parts.push(`${count} project${count === 1 ? '' : 's'}`)
  }
  if (credential.scope.background) parts.push('background runs')
  parts.push(credential.lastUsedAt ? `used ${relativeTime(credential.lastUsedAt)}` : 'never used')
  return parts.join(' · ')
}

/**
 * Credentials the agent can use by alias but never read. Values are typed here and go straight to
 * the main process; nothing ever sends one back, so editing shows only that a value is stored.
 */
export function CredentialSettings({
  request = null
}: {
  /** Opens the editor, when SideKick's agent asked for a credential. */
  request?: { value: CredentialRequest; at: number } | null
}): React.JSX.Element {
  const [status, setStatus] = useState<CredentialStatus | null>(null)
  const [credentials, setCredentials] = useState<CredentialSummary[] | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [events, setEvents] = useState<CredentialEvent[]>([])
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const controlId = useId()

  useEffect(() => {
    let current = true
    const load = (): void => {
      void window.api.credentials
        .list()
        .then((list) => current && setCredentials(list))
        .catch(() => current && setCredentials([]))
    }
    void window.api.credentials
      .status()
      .then((value) => current && setStatus(value))
      .catch(() => current && setStatus({ available: false }))
    void window.api.projects
      .list()
      .then((list: Project[]) => current && setProjects(list))
      .catch(() => undefined)
    load()
    const stop = window.api.credentials.onChanged(load)
    return () => {
      current = false
      stop()
    }
  }, [])

  // The agent's request opens the matching entry, or a new one with its suggested name.
  useEffect(() => {
    if (!request || !credentials) return
    const existing = credentials.find((credential) => credential.alias === request.value.alias)
    setError(null)
    setDraft(existing ? draftFrom(existing) : newDraft(request.value))
    // Only a new request reopens the editor; later list refreshes must not reset the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.at, credentials === null])

  useEffect(() => {
    if (!draft?.id) {
      setEvents([])
      return
    }
    let current = true
    void window.api.credentials
      .events(draft.id)
      .then((list) => current && setEvents(list.slice(0, 8)))
      .catch(() => current && setEvents([]))
    return () => {
      current = false
    }
  }, [draft?.id])

  const editing = useMemo(
    () => (draft?.id ? credentials?.find((credential) => credential.id === draft.id) : undefined),
    [credentials, draft?.id]
  )
  // A stored value is kept only while the kind stays the same and this computer can open it.
  const valuesStored = Boolean(editing && !editing.needsValue && editing.kind === draft?.kind)

  const save = async (): Promise<void> => {
    if (!draft) return
    setSaving(true)
    setError(null)
    try {
      const input: CredentialSaveInput = {
        ...(draft.id ? { id: draft.id } : {}),
        alias: draft.alias.trim(),
        kind: draft.kind,
        description: draft.description,
        usernameVisible: draft.kind === 'sign_in' && draft.usernameVisible,
        ask: draft.ask,
        scope: draft.scope,
        values: draft.values
      }
      const result = await window.api.credentials.save(input)
      if (result.ok) {
        setCredentials(result.credentials)
        setDraft(null)
      } else if (!result.cancelled) setError(result.error)
    } catch {
      setError('The credential could not be saved.')
    } finally {
      setSaving(false)
    }
  }

  const remove = async (credential: CredentialSummary): Promise<void> => {
    const result = await window.api.credentials.delete(credential.id).catch(() => null)
    if (!result) return
    setCredentials(result.credentials)
    if (result.deleted && draft?.id === credential.id) setDraft(null)
  }

  if (status && !status.available) {
    return (
      <SettingsSection icon={KeyRound} title="Credentials">
        <SettingsEmptyState
          icon={ShieldAlert}
          title="Credentials are unavailable"
          description={status.reason}
        />
      </SettingsSection>
    )
  }

  if (draft) {
    const update = (patch: Partial<Draft>): void => setDraft({ ...draft, ...patch })
    const setValue = (field: keyof CredentialValues, value: string | undefined): void => {
      const values = { ...draft.values }
      if (value === undefined) delete values[field]
      else values[field] = value
      update({ values })
    }
    const selectedProjects = draft.scope.projects === 'all' ? [] : draft.scope.projects
    return (
      <SettingsSection
        icon={draft.kind === 'secret' ? KeyRound : UserRound}
        title={draft.id ? `Edit ${editing?.alias ?? draft.alias}` : 'New credential'}
        description="The agent uses it by its alias. It never sees the value, and neither does anything else SideKick shows or sends to a model."
        className="credential-editor"
      >
        <div className="credential-form">
          <div className="credential-kind" role="radiogroup" aria-label="Kind">
            {(['secret', 'sign_in'] as const).map((kind) => (
              <button
                key={kind}
                type="button"
                role="radio"
                aria-checked={draft.kind === kind}
                className={draft.kind === kind ? 'active' : ''}
                onClick={() => update({ kind, values: {} })}
              >
                {kind === 'secret' ? <KeyRound size={14} /> : <UserRound size={14} />}
                {kind === 'secret' ? 'Secret' : 'Sign-in'}
              </button>
            ))}
          </div>
          <label className="modern-field" htmlFor={`${controlId}-alias`}>
            <span>
              Alias <em>how the agent names it</em>
            </span>
            <input
              id={`${controlId}-alias`}
              className="credential-alias-input"
              value={draft.alias}
              placeholder="partner-center"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => update({ alias: event.target.value.toLowerCase() })}
            />
          </label>
          <label className="modern-field" htmlFor={`${controlId}-description`}>
            <span>
              Description <em>the agent sees this</em>
            </span>
            <textarea
              id={`${controlId}-description`}
              rows={2}
              value={draft.description}
              maxLength={500}
              placeholder="What it is for. Identifiers that are not secret, such as a client ID, belong here."
              onChange={(event) => update({ description: event.target.value })}
            />
            {draft.suggestedDescription && draft.description === draft.suggestedDescription && (
              <small className="credential-warning">
                The agent that asked for this credential wrote this. Check it before saving: every
                chat that lists credentials reads it.
              </small>
            )}
          </label>
          {draft.kind === 'secret' ? (
            <ValueField
              label="Secret"
              multiline
              stored={valuesStored}
              value={draft.values.secret}
              onChange={(value) => setValue('secret', value)}
              autoFocus={Boolean(draft.alias) && !draft.id}
            />
          ) : (
            <>
              <ValueField
                label="Username"
                plain
                hidden={!draft.usernameVisible}
                stored={valuesStored}
                value={draft.values.username}
                onChange={(value) => setValue('username', value)}
                autoFocus={Boolean(draft.alias) && !draft.id}
              />
              <ValueField
                label="Password"
                stored={valuesStored}
                value={draft.values.password}
                onChange={(value) => setValue('password', value)}
              />
            </>
          )}
          {editing?.needsValue && (
            <p className="settings-note">
              This computer cannot read the stored value, as happens after moving SideKick to
              another computer. Enter it again and choose where it can be used.
            </p>
          )}
        </div>
        {draft.kind === 'sign_in' && (
          <ToggleField
            label="Let the agent read the username"
            hint={
              draft.usernameVisible
                ? 'So it can say which account it used. The password stays hidden either way.'
                : `While hidden, the username is replaced with [secret: ${draft.alias || 'alias'}] wherever it appears in output, so a common name such as admin or deploy is hidden everywhere.`
            }
            checked={draft.usernameVisible}
            onChange={(usernameVisible) => update({ usernameVisible })}
          />
        )}
        <SettingsRow
          label="Ask before each use"
          description="Applies in every permission mode, including Full access."
          controlId={`${controlId}-ask`}
          control={
            <Select
              id={`${controlId}-ask`}
              value={draft.ask}
              onChange={(event) => update({ ask: event.target.value as CredentialAskPolicy })}
            >
              {CREDENTIAL_ASK_POLICIES.map((policy) => (
                <option key={policy} value={policy}>
                  {CREDENTIAL_ASK_LABELS[policy]}
                </option>
              ))}
            </Select>
          }
        />
        <SettingsRow
          label="Projects"
          description="Chats in which projects may use it."
          controlId={`${controlId}-projects`}
          control={
            <Select
              id={`${controlId}-projects`}
              value={draft.scope.projects === 'all' ? 'all' : 'selected'}
              onChange={(event) =>
                update({
                  scope: {
                    ...draft.scope,
                    projects:
                      event.target.value === 'all'
                        ? 'all'
                        : projects.slice(0, 1).map((project) => project.id)
                  }
                })
              }
            >
              <option value="all">All projects</option>
              <option value="selected" disabled={!projects.length}>
                Selected projects
              </option>
            </Select>
          }
        >
          {draft.scope.projects !== 'all' && (
            <div className="credential-projects">
              {projects.map((project) => (
                <label key={project.id}>
                  <input
                    type="checkbox"
                    checked={selectedProjects.includes(project.id)}
                    onChange={(event) => {
                      const next = event.target.checked
                        ? [...selectedProjects, project.id]
                        : selectedProjects.filter((id) => id !== project.id)
                      update({ scope: { ...draft.scope, projects: next.length ? next : 'all' } })
                    }}
                  />
                  {project.name}
                </label>
              ))}
            </div>
          )}
        </SettingsRow>
        <ToggleField
          label="Allow in background runs"
          hint="Chats a schedule or another chat started, which nobody may be watching."
          checked={draft.scope.background}
          onChange={(background) => update({ scope: { ...draft.scope, background } })}
        />
        {events.length > 0 && (
          <SettingsRow label="Recent activity" stacked>
            <ul className="credential-events">
              {events.map((event) => (
                <li key={event.id}>
                  <strong>{EVENT_LABELS[event.kind]}</strong>
                  {event.tool && <code>{event.tool}</code>}
                  {event.target && <span className="credential-event-target">{event.target}</span>}
                  {event.detail && <span>{event.detail}</span>}
                  <time dateTime={new Date(event.at).toISOString()}>{relativeTime(event.at)}</time>
                </li>
              ))}
            </ul>
          </SettingsRow>
        )}
        <div className="credential-editor-actions">
          {error && (
            <p className="credential-error" role="alert">
              {error}
            </p>
          )}
          <button
            type="button"
            className="settings-secondary-action"
            onClick={() => {
              setDraft(null)
              setError(null)
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            className="settings-primary-action"
            disabled={saving || !draft.alias.trim()}
            onClick={() => void save()}
          >
            {saving ? 'Saving…' : 'Save credential'}
          </button>
        </div>
      </SettingsSection>
    )
  }

  return (
    <SettingsSection
      icon={KeyRound}
      title="Stored credentials"
      description="A stored value is also hidden from everything SideKick shows or sends to a model, as [secret: alias]."
      actions={
        <button
          type="button"
          className="settings-secondary-action is-small"
          disabled={!status}
          onClick={() => {
            setError(null)
            setDraft(newDraft())
          }}
        >
          <Plus size={14} aria-hidden="true" />
          Add credential
        </button>
      }
    >
      {credentials && credentials.length > 0 ? (
        credentials.map((credential) => (
          <SettingsRow
            key={credential.id}
            icon={credential.kind === 'secret' ? KeyRound : UserRound}
            label={
              <span className="credential-row-label">
                <code>{credential.alias}</code>
                {credential.needsValue && <em className="credential-badge">Needs a new value</em>}
              </span>
            }
            description={
              <>
                {credential.description && (
                  <span className="credential-row-description">{credential.description}</span>
                )}
                <span className="credential-row-scope">{scopeSummary(credential)}</span>
              </>
            }
            control={
              <span className="credential-row-actions">
                <button
                  type="button"
                  className="settings-ghost-action is-small is-icon"
                  aria-label={`Edit ${credential.alias}`}
                  title="Edit"
                  onClick={() => {
                    setError(null)
                    setDraft(draftFrom(credential))
                  }}
                >
                  <Pencil size={14} />
                </button>
                <button
                  type="button"
                  className="settings-ghost-action is-small is-icon settings-remove-action"
                  aria-label={`Delete ${credential.alias}`}
                  title="Delete"
                  onClick={() => void remove(credential)}
                >
                  <Trash2 size={14} />
                </button>
              </span>
            }
          />
        ))
      ) : (
        <SettingsEmptyState
          icon={KeyRound}
          title={credentials ? 'No credentials yet.' : 'Loading…'}
          description={
            credentials
              ? 'Add an API key or a sign-in here, or let the agent ask for one when a task needs it.'
              : undefined
          }
        />
      )}
    </SettingsSection>
  )
}
