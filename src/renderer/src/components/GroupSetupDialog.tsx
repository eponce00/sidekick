import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Bot, Check, ChevronDown, Search, Users, X } from 'lucide-react'
import type { CreateCollaborationGroupInput } from '../../../shared/collaboration'
import type { Project } from '../../../shared/projects'
import type { PinnedModel } from '../../../shared/models'
import { getModelDisplayInfo, uniqueModelMetadata } from '../../../shared/modelDisplay'
import { providerTargetForPinnedModel } from '../utils/providerTarget'
import { ProviderIcon } from './ProviderIcon'
import { useModalDialog } from '../hooks/useModalDialog'
import './GroupSetupDialog.css'

interface GroupSetupDialogProps {
  isOpen: boolean
  projects: Project[]
  models: PinnedModel[]
  selectedModelId: string
  onCancel: () => void
  onCreate: (input: CreateCollaborationGroupInput) => Promise<void>
}

export default function GroupSetupDialog({
  isOpen,
  projects,
  models,
  selectedModelId,
  onCancel,
  onCreate
}: GroupSetupDialogProps): React.JSX.Element | null {
  const [title, setTitle] = useState('')
  const [firstProjectId, setFirstProjectId] = useState('')
  const [secondProjectId, setSecondProjectId] = useState('')
  const [firstModelId, setFirstModelId] = useState('')
  const [secondModelId, setSecondModelId] = useState('')
  const [titleEdited, setTitleEdited] = useState(false)
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)
  const dialogRef = useModalDialog<HTMLElement>(isOpen, onCancel)
  const availableModels = useMemo(
    () => models.filter(({ supportsTools }) => supportsTools !== false),
    [models]
  )

  useEffect(() => {
    if (!isOpen) return
    setTitle('')
    setTitleEdited(false)
    setFirstProjectId(projects[0]?.id || '')
    setSecondProjectId(projects[1]?.id || '')
    const fallback = availableModels.some(({ id }) => id === selectedModelId)
      ? selectedModelId
      : availableModels[0]?.id || ''
    setFirstModelId(fallback)
    setSecondModelId(fallback)
    setError('')
  }, [availableModels, isOpen, projects, selectedModelId])

  const suggestedTitle = useMemo(() => {
    const first = projects.find(({ id }) => id === firstProjectId)?.name
    const second = projects.find(({ id }) => id === secondProjectId)?.name
    return first && second ? `${first} + ${second}` : ''
  }, [firstProjectId, projects, secondProjectId])

  useEffect(() => {
    if (isOpen && !titleEdited) setTitle(suggestedTitle)
  }, [isOpen, suggestedTitle, titleEdited])

  const canCreate =
    title.trim() &&
    firstProjectId &&
    secondProjectId &&
    firstProjectId !== secondProjectId &&
    firstModelId &&
    secondModelId &&
    !creating

  const modelById = useMemo(
    () => new Map(availableModels.map((model) => [model.id, model])),
    [availableModels]
  )

  if (!isOpen) return null

  const submit = async (): Promise<void> => {
    const firstModel = modelById.get(firstModelId)
    const secondModel = modelById.get(secondModelId)
    if (!canCreate || !firstModel || !secondModel) return
    setCreating(true)
    setError('')
    try {
      await onCreate({
        title: title.trim(),
        participants: [
          { projectId: firstProjectId, providerTarget: providerTargetForPinnedModel(firstModel) },
          { projectId: secondProjectId, providerTarget: providerTargetForPinnedModel(secondModel) }
        ]
      })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="group-setup-backdrop" role="presentation" onMouseDown={onCancel}>
      <section
        ref={dialogRef}
        className="group-setup-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="group-setup-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div className="group-setup-heading">
            <span className="group-setup-icon">
              <Users size={18} />
            </span>
            <div>
              <h2 id="group-setup-title">New group chat</h2>
              <p>Bring two project agents into one shared conversation.</p>
            </div>
          </div>
          <button type="button" className="group-setup-close" onClick={onCancel} aria-label="Close">
            <X size={17} />
          </button>
        </header>

        {projects.length < 2 ? (
          <div className="group-setup-empty">
            <Users size={22} />
            <strong>Two projects are required</strong>
            <span>Open one more project folder, then create the group.</span>
          </div>
        ) : availableModels.length === 0 ? (
          <div className="group-setup-empty">
            <Bot size={22} />
            <strong>No models are ready</strong>
            <span>Enable a model in Provider settings first.</span>
          </div>
        ) : (
          <div className="group-setup-body">
            <label className="group-setup-name">
              <span>Group name</span>
              <input
                autoFocus
                value={title}
                onChange={(event) => {
                  setTitleEdited(true)
                  setTitle(event.target.value)
                }}
                placeholder="Group name"
                maxLength={120}
              />
            </label>

            <div className="group-agent-grid">
              <AgentField
                index={1}
                projects={projects}
                projectId={firstProjectId}
                onProjectChange={setFirstProjectId}
                excludedProjectId={secondProjectId}
                models={availableModels}
                modelId={firstModelId}
                onModelChange={setFirstModelId}
              />
              <AgentField
                index={2}
                projects={projects}
                projectId={secondProjectId}
                onProjectChange={setSecondProjectId}
                excludedProjectId={firstProjectId}
                models={availableModels}
                modelId={secondModelId}
                onModelChange={setSecondModelId}
              />
            </div>

            <p className="group-setup-note">
              Each agent stays inside its own project folder. Messages are shared; files and
              permissions are not.
            </p>
            {error && <div className="group-setup-error">{error}</div>}
          </div>
        )}

        <footer>
          <button type="button" className="group-setup-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="group-setup-create"
            disabled={!canCreate}
            onClick={() => void submit()}
          >
            {creating ? 'Creating…' : 'Create group'}
          </button>
        </footer>
      </section>
    </div>
  )
}

function AgentField({
  index,
  projects,
  projectId,
  onProjectChange,
  excludedProjectId,
  models,
  modelId,
  onModelChange
}: {
  index: number
  projects: Project[]
  projectId: string
  onProjectChange: (value: string) => void
  excludedProjectId: string
  models: PinnedModel[]
  modelId: string
  onModelChange: (value: string) => void
}): React.JSX.Element {
  return (
    <div className="group-agent-field">
      <div className="group-agent-label">
        <Bot size={15} /> Project agent {index}
      </div>
      <label>
        <span>Project</span>
        <select value={projectId} onChange={(event) => onProjectChange(event.target.value)}>
          {projects.map((project) => (
            <option key={project.id} value={project.id} disabled={project.id === excludedProjectId}>
              {project.name}
            </option>
          ))}
        </select>
      </label>
      <div className="group-model-field">
        <span>Model</span>
        <ModelPicker
          models={models}
          modelId={modelId}
          onChange={onModelChange}
          label={`Project agent ${index} model`}
        />
      </div>
    </div>
  )
}

function ModelPicker({
  models,
  modelId,
  onChange,
  label
}: {
  models: PinnedModel[]
  modelId: string
  onChange: (value: string) => void
  label: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [menuPosition, setMenuPosition] = useState<{
    left: number
    top?: number
    bottom?: number
    width: number
  } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const selected = models.find(({ id }) => id === modelId) || models[0]
  const selectedDisplay = selected ? getModelDisplayInfo(selected) : null
  const filteredModels = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return models
    return models.filter((model) => {
      const display = getModelDisplayInfo(model)
      return [
        display.label,
        display.vendor,
        display.fullId,
        display.fullName,
        model.providerInstanceName,
        model.providerKind,
        model.provider
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(normalized)
    })
  }, [models, query])

  const positionMenu = useCallback((): void => {
    const trigger = triggerRef.current
    if (!trigger) return
    const bounds = trigger.getBoundingClientRect()
    const estimatedHeight = Math.min(models.length, 5) * 42 + 55
    const spaceBelow = window.innerHeight - bounds.bottom - 10
    const openUpward = spaceBelow < estimatedHeight && bounds.top > estimatedHeight
    const width = Math.max(bounds.width, 270)
    setMenuPosition({
      left: Math.max(8, Math.min(bounds.left, window.innerWidth - width - 8)),
      top: openUpward ? undefined : bounds.bottom + 5,
      bottom: openUpward ? window.innerHeight - bounds.top + 5 : undefined,
      width
    })
  }, [models.length])

  useEffect(() => {
    if (!open) return
    window.requestAnimationFrame(() => searchRef.current?.focus())
    const closeOnOutsideClick = (event: MouseEvent): void => {
      const target = event.target as Node
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false)
    }
    const reposition = (): void => positionMenu()
    document.addEventListener('mousedown', closeOnOutsideClick)
    document.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick)
      document.removeEventListener('scroll', reposition, true)
      window.removeEventListener('resize', reposition)
    }
  }, [open, positionMenu])

  return (
    <div className="group-model-picker" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="group-model-trigger"
        onClick={() => {
          if (open) {
            setOpen(false)
          } else {
            setQuery('')
            positionMenu()
            setOpen(true)
          }
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
      >
        {selected && (
          <ProviderIcon provider={selected.providerKind || selected.provider} size={15} />
        )}
        <span>
          <strong>{selectedDisplay?.label || 'Choose a model'}</strong>
          {selected?.providerInstanceName && <small>{selected.providerInstanceName}</small>}
        </span>
        <ChevronDown size={14} />
      </button>
      {open &&
        menuPosition &&
        createPortal(
          <div className="group-model-menu" ref={menuRef} style={menuPosition}>
            <label className="group-model-search">
              <Search size={13} />
              <input
                ref={searchRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    event.stopPropagation()
                    setOpen(false)
                    return
                  }
                  if (event.key === 'Enter' && filteredModels[0]) {
                    event.preventDefault()
                    onChange(filteredModels[0].id)
                    setOpen(false)
                  }
                }}
                placeholder="Search models"
                aria-label="Search models"
              />
            </label>
            <div className="group-model-options" role="listbox" aria-label="Available models">
              {filteredModels.length ? (
                filteredModels.map((model) => {
                  const display = getModelDisplayInfo(model)
                  const metadata = uniqueModelMetadata([
                    model.providerInstanceName,
                    display.vendor,
                    display.fullId !== display.label ? display.fullId : undefined
                  ])
                  return (
                    <button
                      type="button"
                      role="option"
                      aria-selected={model.id === modelId}
                      className={model.id === modelId ? 'selected' : ''}
                      key={model.id}
                      onClick={() => {
                        onChange(model.id)
                        setOpen(false)
                      }}
                      title={display.fullId}
                    >
                      <ProviderIcon provider={model.providerKind || model.provider} size={15} />
                      <span>
                        <strong>{display.label}</strong>
                        {metadata.length > 0 && <small>{metadata.join(' · ')}</small>}
                      </span>
                      {model.id === modelId && <Check size={14} />}
                    </button>
                  )
                })
              ) : (
                <div className="group-model-empty">No models match “{query}”</div>
              )}
            </div>
          </div>,
          document.body
        )}
    </div>
  )
}
