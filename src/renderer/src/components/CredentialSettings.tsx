import { useEffect, useId, useMemo, useState } from 'react'
import {
  Eye,
  EyeOff,
  KeyRound,
  LockKeyhole,
  Pencil,
  Plus,
  Search,
  ShieldAlert,
  Trash2,
  UserRound
} from 'lucide-react'
import {
  MIN_CREDENTIAL_VALUE,
  SHORT_CREDENTIAL_VALUE,
  credentialSitesFrom,
  type CredentialEvent,
  type CredentialKind,
  type CredentialRequest,
  type CredentialSaveInput,
  type CredentialStatus,
  type CredentialSummary,
  type CredentialValues
} from '../../../shared/credentials'
import { SettingsEmptyState, SettingsSection } from './SettingsLayout'
import { loadSiteIcon } from '../utils/siteIcons'
import './CredentialSettings.css'

/** The editor as typed, the way a password manager asks: a name, notes, a username, a password. */
interface Draft {
  id?: string
  alias: string
  description: string
  /** A sign-in's username, shown as stored; empty for a key or token on its own. */
  username: string
  /** Websites as typed, separated by commas or spaces. */
  sites: string
  /** A new password or key; absent keeps the stored one. */
  secret?: string
  /** The description the agent suggested when it asked for this credential. */
  suggestedDescription?: string
}

/** With a username it is a sign-in; without one, a secret such as an API key. */
function draftKind(draft: Draft): CredentialKind {
  return draft.username.trim() ? 'sign_in' : 'secret'
}

/** A name the agent can use, typed as words: lowercase, with spaces as hyphens. */
function aliasFrom(text: string): string {
  return text.toLowerCase().replace(/\s+/g, '-')
}

function newDraft(request?: CredentialRequest | null): Draft {
  return {
    alias: request?.alias ?? '',
    description: request?.description ?? '',
    ...(request?.description ? { suggestedDescription: request.description } : {}),
    username: '',
    sites: ''
  }
}

function draftFrom(credential: CredentialSummary): Draft {
  return {
    id: credential.id,
    alias: credential.alias,
    description: credential.description,
    username: credential.username ?? '',
    sites: (credential.sites ?? []).join(', ')
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

const KIND_LABELS: Record<CredentialKind, string> = {
  sign_in: 'Sign-in',
  secret: 'Key or token'
}

/** The first letters of a name's words, as a password manager's tile shows a site. */
function monogram(alias: string): string {
  const words = alias.split(/[-_]+/).filter(Boolean)
  const letters = words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? '?').slice(0, 2)
  return letters.toUpperCase()
}

/**
 * The tile for an entry: its website's own icon once one has loaded, as a password manager shows
 * a login, and the name's first letters until then or when the site has none.
 */
function CredentialAvatar({
  alias,
  site,
  size = 'md'
}: {
  alias: string
  site?: string
  size?: 'md' | 'lg'
}): React.JSX.Element {
  const [icon, setIcon] = useState<{ site: string; dataUrl: string } | null>(null)
  useEffect(() => {
    if (!site) return
    let current = true
    void loadSiteIcon(`https://${site}`).then((dataUrl) => {
      if (current && dataUrl) setIcon({ site, dataUrl })
    })
    return () => {
      current = false
    }
  }, [site])
  const shown = icon && icon.site === site ? icon.dataUrl : null
  return (
    <span className={`credential-avatar is-${size}${shown ? ' has-icon' : ''}`} aria-hidden="true">
      {shown ? (
        <img src={shown} alt="" onError={() => setIcon(null)} />
      ) : alias ? (
        monogram(alias)
      ) : (
        <KeyRound size={size === 'lg' ? 18 : 14} />
      )}
    </span>
  )
}

/**
 * A password or key field that never shows a stored value: it starts empty and only sets a new
 * one. What the user types is masked, can be shown while typing, and keeps a pasted key's line
 * breaks.
 */
function SecretField({
  stored,
  value,
  onChange,
  autoFocus
}: {
  stored: boolean
  value: string | undefined
  onChange: (value: string | undefined) => void
  autoFocus?: boolean
}): React.JSX.Element {
  const id = useId()
  const [revealed, setRevealed] = useState(false)
  const length = value?.trim().length ?? 0
  const warning = !value
    ? null
    : length < MIN_CREDENTIAL_VALUE
      ? `Enter at least ${MIN_CREDENTIAL_VALUE} characters; shorter values cannot be kept out of output.`
      : length < SHORT_CREDENTIAL_VALUE
        ? `Values under ${SHORT_CREDENTIAL_VALUE} characters may be missed in output, or hide ordinary text that matches them.`
        : null
  return (
    <div className="modern-field credential-value-field">
      <label htmlFor={id}>
        <span>Password or key</span>
        {stored && <em className="credential-stored">Stored</em>}
      </label>
      <span className="credential-value-input">
        <textarea
          id={id}
          className={revealed ? undefined : 'is-masked'}
          rows={Math.min(6, Math.max(1, (value ?? '').split('\n').length))}
          value={value ?? ''}
          autoComplete="off"
          spellCheck={false}
          autoFocus={autoFocus}
          placeholder={stored ? 'Type to replace' : 'Password or key'}
          onChange={(event) => onChange(event.target.value || undefined)}
        />
        <button
          type="button"
          className="credential-reveal"
          aria-label={revealed ? 'Hide what you typed' : 'Show what you typed'}
          title={revealed ? 'Hide what you typed' : 'Show what you typed'}
          disabled={!value}
          onClick={() => setRevealed(!revealed)}
        >
          {revealed ? <EyeOff size={15} /> : <Eye size={15} />}
        </button>
      </span>
      {warning && <small className="credential-warning">{warning}</small>}
    </div>
  )
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
  const [draft, setDraft] = useState<Draft | null>(null)
  const [events, setEvents] = useState<CredentialEvent[]>([])
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [query, setQuery] = useState('')
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
      .then((list) => current && setEvents(list.slice(0, 6)))
      .catch(() => current && setEvents([]))
    return () => {
      current = false
    }
  }, [draft?.id])

  const editing = useMemo(
    () => (draft?.id ? credentials?.find((credential) => credential.id === draft.id) : undefined),
    [credentials, draft?.id]
  )
  const shown = useMemo(() => {
    const words = query.trim().toLowerCase()
    if (!words || !credentials) return credentials
    return credentials.filter((credential) =>
      [credential.alias, credential.description, credential.username ?? '']
        .join(' ')
        .toLowerCase()
        .includes(words)
    )
  }, [credentials, query])
  const kind = draft ? draftKind(draft) : 'secret'
  // A stored value is kept while the entry stays a sign-in or a key and this computer can open it.
  const valueStored = Boolean(editing && !editing.needsValue && editing.kind === kind)

  const open = (next: Draft): void => {
    setError(null)
    setDraft(next)
  }

  const save = async (): Promise<void> => {
    if (!draft) return
    setSaving(true)
    setError(null)
    try {
      const username = draft.username.trim()
      const values: CredentialValues = {}
      if (kind === 'sign_in' && (!valueStored || username !== editing?.username)) {
        values.username = username
      }
      if (draft.secret) values[kind === 'sign_in' ? 'password' : 'secret'] = draft.secret
      const input: CredentialSaveInput = {
        ...(draft.id ? { id: draft.id } : {}),
        alias: draft.alias.trim().replace(/-+$/, ''),
        kind,
        description: draft.description,
        sites: credentialSitesFrom(draft.sites),
        values
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
    const title = draft.id ? `Edit ${editing?.alias ?? draft.alias}` : 'New credential'
    return (
      <section className="credential-editor" aria-label={title}>
        <header className="credential-editor-head">
          <CredentialAvatar alias={draft.alias} site={editing?.sites?.[0]} size="lg" />
          <div className="credential-editor-title">
            <h3>{title}</h3>
            <p>
              <span className={`credential-kind-pill is-${kind}`}>
                {kind === 'sign_in' ? <UserRound size={12} /> : <KeyRound size={12} />}
                {KIND_LABELS[kind]}
              </span>
            </p>
          </div>
        </header>

        <div className="credential-form">
          <label className="modern-field" htmlFor={`${controlId}-alias`}>
            <span>Name</span>
            <input
              id={`${controlId}-alias`}
              className="credential-alias-input"
              value={draft.alias}
              placeholder="github"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => update({ alias: aliasFrom(event.target.value) })}
            />
          </label>
          <label className="modern-field" htmlFor={`${controlId}-sites`}>
            <span>
              Website <em>optional</em>
            </span>
            <input
              id={`${controlId}-sites`}
              value={draft.sites}
              placeholder="github.com"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => update({ sites: event.target.value })}
            />
          </label>
          <label className="modern-field" htmlFor={`${controlId}-username`}>
            <span>
              Username <em>optional</em>
            </span>
            <input
              id={`${controlId}-username`}
              value={draft.username}
              placeholder="Leave empty for a key"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => update({ username: event.target.value })}
            />
          </label>
          <SecretField
            stored={valueStored}
            value={draft.secret}
            onChange={(secret) => update({ secret })}
            autoFocus={Boolean(draft.alias) && !draft.id}
          />
          <label className="modern-field is-wide" htmlFor={`${controlId}-description`}>
            <span>
              Description <em>what it’s for</em>
            </span>
            <textarea
              id={`${controlId}-description`}
              rows={2}
              value={draft.description}
              maxLength={500}
              placeholder="My GitHub account, for github.com"
              onChange={(event) => update({ description: event.target.value })}
            />
            {draft.suggestedDescription && draft.description === draft.suggestedDescription && (
              <small className="credential-warning">
                Written by the agent. Check it before saving.
              </small>
            )}
          </label>
          {editing?.needsValue && (
            <p className="credential-callout is-warning is-wide">
              <ShieldAlert size={15} aria-hidden="true" />
              <span>Enter the value again; this computer can’t read it.</span>
            </p>
          )}
        </div>

        {events.length > 0 && (
          <div className="credential-activity">
            <h4>Recent activity</h4>
            <ol className="credential-events">
              {events.map((event) => (
                <li key={event.id} className={`is-${event.kind}`}>
                  <strong>{EVENT_LABELS[event.kind]}</strong>
                  {event.tool && <code>{event.tool}</code>}
                  {event.target && <span className="credential-event-target">{event.target}</span>}
                  {event.detail && <span>{event.detail}</span>}
                  <time dateTime={new Date(event.at).toISOString()}>{relativeTime(event.at)}</time>
                </li>
              ))}
            </ol>
          </div>
        )}

        <footer className="credential-editor-actions">
          {error && (
            <p className="credential-error" role="alert">
              {error}
            </p>
          )}
          {editing && !error && (
            <button
              type="button"
              className="settings-danger-action credential-delete"
              aria-label={`Delete ${editing.alias}`}
              onClick={() => void remove(editing)}
            >
              <Trash2 size={14} aria-hidden="true" />
              Delete
            </button>
          )}
          <span className="credential-editor-spacer" />
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
        </footer>
      </section>
    )
  }

  const count = credentials?.length ?? 0
  return (
    <SettingsSection
      icon={KeyRound}
      title="Stored credentials"
      className="credential-list-section"
      actions={
        <button
          type="button"
          className="settings-primary-action is-small"
          disabled={!status}
          onClick={() => open(newDraft())}
        >
          <Plus size={14} aria-hidden="true" />
          Add credential
        </button>
      }
    >
      {count > 3 && (
        <div className="credential-search">
          <Search size={14} aria-hidden="true" />
          <input
            type="search"
            value={query}
            placeholder="Search"
            aria-label="Search credentials"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      )}
      {shown && shown.length > 0 ? (
        <ul className="credential-list">
          {shown.map((credential) => (
            <li key={credential.id} className="credential-item">
              <button
                type="button"
                className="credential-item-main"
                aria-label={`Edit ${credential.alias}`}
                onClick={() => open(draftFrom(credential))}
              >
                <CredentialAvatar alias={credential.alias} site={credential.sites?.[0]} />
                <span className="credential-item-text">
                  <span className="credential-item-name">
                    <strong>{credential.alias}</strong>
                    <span className={`credential-kind-pill is-${credential.kind}`}>
                      {KIND_LABELS[credential.kind]}
                    </span>
                    {credential.needsValue && (
                      <em className="credential-badge">Needs a new value</em>
                    )}
                  </span>
                  <span className="credential-item-detail">
                    {credential.username && (
                      <span className="credential-item-username">{credential.username}</span>
                    )}
                    {credential.sites?.[0] && <span>{credential.sites.join(', ')}</span>}
                    {credential.description && <span>{credential.description}</span>}
                  </span>
                </span>
                <span className="credential-item-used">
                  {credential.lastUsedAt
                    ? `Used ${relativeTime(credential.lastUsedAt)}`
                    : 'Never used'}
                </span>
                <Pencil size={14} className="credential-item-edit" aria-hidden="true" />
              </button>
              <span className="credential-item-actions">
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
            </li>
          ))}
        </ul>
      ) : credentials && credentials.length > 0 ? (
        <p className="credential-search-empty">No credential matches “{query.trim()}”.</p>
      ) : (
        <SettingsEmptyState
          icon={LockKeyhole}
          title={credentials ? 'No credentials yet' : 'Loading…'}
          description={credentials ? 'Add a sign-in or an API key.' : undefined}
        />
      )}
    </SettingsSection>
  )
}
