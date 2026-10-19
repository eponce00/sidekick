import { useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  AudioLines,
  Brain,
  Check,
  ChevronRight,
  Eye,
  FileText,
  Info,
  Plus,
  RefreshCw,
  Search,
  Server,
  SlidersHorizontal,
  Trash2,
  Wrench,
  X
} from 'lucide-react'
import type {
  ProviderInstance,
  ProviderInstanceModel,
  ProviderModelMetadataOverrides
} from '../../../shared/settings'
import {
  describeProviderHealth,
  offlineProviderHealth,
  onlineProviderHealth,
  providerHealthErrorMessage,
  unknownProviderHealth
} from '../../../shared/providerHealth'
import {
  PROVIDER_REGISTRY,
  providerDefinitionForInstance,
  type ProviderDefinition
} from '../../../shared/providerRegistry'
import { createProviderInstance, mergeDiscoveredModels } from '../../../shared/providerInstances'
import { getModelDisplayInfo } from '../../../shared/modelDisplay'
import { discoverProviderModels } from '../services/providers/providerDiscovery'
import { ProviderIcon } from './ProviderIcon'
import { filterModelsByQuery } from '../utils/modelSearch'
import { formatTokenCount, modelLimitsLabel } from '../utils/modelLimits'
import { SettingsEmptyState, SettingsPageHeader } from './SettingsLayout'
import { Select } from './Select'

interface Props {
  instances: ProviderInstance[]
  onChange: (instances: ProviderInstance[]) => void
  /** Selects an instance and focuses its key field; each request has a fresh `at`. */
  keyRequest?: { id: string; at: number } | null
}

function createInstance(template: ProviderDefinition, ordinal: number): ProviderInstance {
  return {
    ...createProviderInstance(
      template,
      `${template.type}-${crypto.randomUUID().slice(0, 8)}`,
      ordinal > 1 ? `${template.name} ${ordinal}` : template.name
    ),
    apiKey: ''
  }
}

type ModelFilter = 'tools' | 'vision' | 'reasoning'

const MODEL_FILTERS: ReadonlyArray<{ key: ModelFilter; label: string }> = [
  { key: 'tools', label: 'Tools' },
  { key: 'vision', label: 'Vision' },
  { key: 'reasoning', label: 'Reasoning' }
]

/** A capability filter keeps only models the provider says have it; unknown is not enough. */
function matchesModelFilters(
  model: ProviderInstanceModel,
  filters: ReadonlySet<ModelFilter>
): boolean {
  if (filters.has('tools') && model.supportsTools !== true) return false
  if (filters.has('vision') && model.supportsVision !== true) return false
  if (filters.has('reasoning') && model.supportsReasoning !== true) return false
  return true
}

const CAPABILITY_BADGES = [
  ['supportsTools', 'Tools', Wrench],
  ['supportsVision', 'Vision', Eye],
  ['supportsReasoning', 'Reasoning', Brain],
  ['supportsPdfInput', 'PDF input', FileText],
  ['supportsAudioInput', 'Audio input', AudioLines]
] as const

function providerDescription(instance: ProviderInstance): string {
  const shown = instance.models.filter((model) => model.enabled).length
  return `${shown} model${shown === 1 ? '' : 's'} shown · ${instance.baseUrl}`
}

export function ProviderSettingsPanel({
  instances,
  onChange,
  keyRequest = null
}: Props): React.JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(
    (keyRequest && instances.some((instance) => instance.id === keyRequest.id)
      ? keyRequest.id
      : instances[0]?.id) ?? null
  )
  const [showAdd, setShowAdd] = useState(instances.length === 0)
  const keyInputRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    if (!keyRequest || !instances.some((instance) => instance.id === keyRequest.id)) return
    setSelectedId(keyRequest.id)
    setShowAdd(false)
    // Focus after the selected instance's fields render.
    const timer = window.setTimeout(() => keyInputRef.current?.focus(), 0)
    return () => window.clearTimeout(timer)
    // Only a new request moves the selection; editing instances must not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyRequest])
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle')
  const [statusMessage, setStatusMessage] = useState('')
  const [manualModel, setManualModel] = useState('')
  const [modelFilter, setModelFilter] = useState('')
  const [modelFilters, setModelFilters] = useState<ReadonlySet<ModelFilter>>(() => new Set())
  const [editingModelId, setEditingModelId] = useState<string | null>(null)
  const modelListId = useId()
  const selected = instances.find((instance) => instance.id === selectedId) ?? instances[0]
  const editingModel = selected?.models.find((model) => model.id === editingModelId)
  const editingModelDisplay = editingModel ? getModelDisplayInfo(editingModel) : undefined
  const effectiveSelectedId = selected?.id ?? null
  const definition = selected ? providerDefinitionForInstance(selected) : undefined
  const listsModels = definition ? definition.capabilities.discovery !== 'manual' : false
  const needsKey = Boolean(
    selected &&
    definition?.capabilities.credentials === 'required' &&
    !selected.apiKey?.trim() &&
    !selected.apiKeyConfigured
  )
  const filteredModels = filterModelsByQuery(selected?.models ?? [], modelFilter).filter((model) =>
    matchesModelFilters(model, modelFilters)
  )
  const hasModelFilter = Boolean(modelFilter.trim())
  const narrowed = hasModelFilter || modelFilters.size > 0
  const shownCount = selected?.models.filter((model) => model.enabled).length ?? 0
  // Models in chat come first, so a long catalog never hides what is already chosen.
  const modelGroups = [
    { key: 'shown', title: 'In chat', models: filteredModels.filter((model) => model.enabled) },
    {
      key: 'other',
      title: listsModels ? 'Available' : 'Hidden',
      models: filteredModels.filter((model) => !model.enabled)
    }
  ].filter((group) => group.models.length > 0)
  // What the last load in this window changed: models new since the load before, and models
  // kept although the provider no longer lists them.
  const [catalogNotes, setCatalogNotes] = useState<{
    instanceId: string
    added: ReadonlySet<string>
    unlisted: ReadonlySet<string>
  } | null>(null)
  // A load finishes after the user may have changed the provider; it applies to what is there now.
  const instancesRef = useRef(instances)
  useEffect(() => {
    instancesRef.current = instances
  }, [instances])
  const autoLoaded = useRef(new Set<string>())

  const sameTypeCount = useMemo(
    () =>
      PROVIDER_REGISTRY.reduce<Record<string, number>>((counts, template) => {
        counts[template.kind] = instances.filter(
          (instance) => providerDefinitionForInstance(instance).kind === template.kind
        ).length
        return counts
      }, {}),
    [instances]
  )

  const updateSelected = (updates: Partial<ProviderInstance>): void => {
    if (!selected) return
    const invalidatesHealth = 'baseUrl' in updates || 'apiKey' in updates
    const nextUpdates = invalidatesHealth
      ? { ...updates, health: unknownProviderHealth() }
      : updates
    onChange(
      instances.map((instance) =>
        instance.id === selected.id ? { ...instance, ...nextUpdates } : instance
      )
    )
    if (invalidatesHealth) setStatus('idle')
  }

  /** Connects, and for a provider with a model list, loads it beside the models already set up. */
  const loadModels = async (): Promise<void> => {
    if (!selected) return
    const target = selected
    const lists = providerDefinitionForInstance(target).capabilities.discovery !== 'manual'
    const apply = (updates: Partial<ProviderInstance>): void =>
      onChange(
        instancesRef.current.map((instance) =>
          instance.id === target.id ? { ...instance, ...updates } : instance
        )
      )
    setStatus('loading')
    setStatusMessage(lists ? 'Loading models…' : 'Connecting…')
    try {
      const discovered = await discoverProviderModels(window.api, target)
      const current = instancesRef.current.find(({ id }) => id === target.id)
      if (!current) return
      if (lists) {
        const models = mergeDiscoveredModels(current.models, discovered)
        const listed = new Set(discovered.map(({ id }) => id))
        const known = new Set(current.models.map(({ id }) => id))
        // Only a list loaded before says what is new; on the first load everything would be.
        const loadedBefore = current.health?.discoveredModelCount !== undefined
        setCatalogNotes({
          instanceId: target.id,
          added: new Set(loadedBefore ? [...listed].filter((id) => !known.has(id)) : []),
          unlisted: new Set(models.filter(({ id }) => !listed.has(id)).map(({ id }) => id))
        })
        apply({ models, health: onlineProviderHealth(undefined, discovered.length) })
      } else {
        apply({ health: onlineProviderHealth() })
      }
      setStatus('success')
      setStatusMessage(
        lists
          ? `Connected · ${discovered.length} model${discovered.length === 1 ? '' : 's'} available`
          : 'Connection successful'
      )
    } catch (error) {
      apply({ health: offlineProviderHealth(error) })
      setStatus('error')
      setStatusMessage(providerHealthErrorMessage(error))
    }
  }

  // Opening a provider that lists its models, before any are set up, loads the list once.
  useEffect(() => {
    if (!selected || !listsModels || !selected.enabled || needsKey) return
    if (selected.models.length > 0 || autoLoaded.current.has(selected.id)) return
    autoLoaded.current.add(selected.id)
    void loadModels()
    // Only opening a provider loads; editing it must not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id])

  const toggleModelFilter = (filter: ModelFilter): void =>
    setModelFilters((current) => {
      const next = new Set(current)
      if (next.has(filter)) next.delete(filter)
      else next.add(filter)
      return next
    })

  const clearModelFilters = (): void => {
    setModelFilter('')
    setModelFilters(new Set())
  }

  const addManualModel = (): void => {
    if (!selected || !manualModel.trim()) return
    const id = manualModel.trim()
    if (!selected.models.some((model) => model.id === id)) {
      updateSelected({
        models: [...selected.models, { id, name: id, enabled: true }]
      })
    }
    setManualModel('')
  }

  const setFilteredModelsEnabled = (enabled: boolean): void => {
    if (!selected) return
    const filteredIds = new Set(filteredModels.map((model) => model.id))
    updateSelected({
      models: selected.models.map((model) =>
        filteredIds.has(model.id) ? { ...model, enabled } : model
      )
    })
  }

  const updateModel = (modelId: string, updates: Partial<ProviderInstanceModel>): void => {
    if (!selected) return
    updateSelected({
      models: selected.models.map((model) =>
        model.id === modelId ? { ...model, ...updates } : model
      )
    })
  }

  const updateMetadataOverride = <K extends keyof ProviderModelMetadataOverrides>(
    model: ProviderInstanceModel,
    key: K,
    value: ProviderModelMetadataOverrides[K]
  ): void => {
    const overrides = { ...(model.metadataOverrides || {}) }
    if (value === undefined) delete overrides[key]
    else overrides[key] = value
    updateModel(model.id, {
      [key]: value,
      metadataOverrides: Object.keys(overrides).length > 0 ? overrides : undefined,
      metadataSource: Object.keys(overrides).length > 0 ? 'configured' : 'unknown'
    })
  }

  const metadataLabel = (model: ProviderInstanceModel): string => {
    if (model.metadataOverrides && Object.keys(model.metadataOverrides).length > 0) {
      return 'Manual override'
    }
    if (model.metadataSource === 'provider') return 'Server metadata'
    if (model.metadataSource === 'inferred') return 'Inferred metadata'
    return 'Metadata unknown'
  }

  return (
    <div className="provider-manager">
      <SettingsPageHeader
        title="Providers"
        description="Connect only the services you use, then choose which models appear in chat."
        actions={
          <button
            type="button"
            className="settings-primary-action"
            onClick={() => setShowAdd(true)}
          >
            <Plus size={15} aria-hidden="true" /> Add provider
          </button>
        }
      />

      <div className="provider-manager-grid">
        <aside className="provider-instance-list">
          {instances.length === 0 && (
            <div className="provider-empty-small">No providers configured yet.</div>
          )}
          {instances.map((instance) => {
            const health = describeProviderHealth(instance.health)
            return (
              <button
                type="button"
                key={instance.id}
                className={`provider-instance-row ${effectiveSelectedId === instance.id ? 'active' : ''}`}
                onClick={() => {
                  setSelectedId(instance.id)
                  clearModelFilters()
                  setEditingModelId(null)
                  setStatus('idle')
                }}
              >
                <ProviderIcon provider={providerDefinitionForInstance(instance).kind} size={18} />
                <span>
                  <strong>{instance.name}</strong>
                  <small>{providerDescription(instance)}</small>
                </span>
                <i
                  className={instance.enabled ? health.state : 'disabled'}
                  title={instance.enabled ? health.detail : 'Provider disabled'}
                />
                <ChevronRight size={15} />
              </button>
            )
          })}
        </aside>

        <section className="provider-detail">
          {!selected ? (
            <div className="provider-detail-empty">
              <SettingsEmptyState
                icon={Server}
                title="Add your first provider"
                description="Provider options stay hidden until you connect one."
                action={
                  <button
                    type="button"
                    className="settings-primary-action"
                    onClick={() => setShowAdd(true)}
                  >
                    <Plus size={15} aria-hidden="true" /> Choose provider
                  </button>
                }
              />
            </div>
          ) : (
            <>
              <div className="provider-detail-title">
                <div>
                  <span className="settings-kicker">Provider instance</span>
                  <span className="provider-name-row">
                    <ProviderIcon
                      provider={providerDefinitionForInstance(selected).kind}
                      size={19}
                    />
                    <input
                      className="provider-name-input"
                      value={selected.name}
                      onChange={(event) => updateSelected({ name: event.target.value })}
                      aria-label="Provider name"
                    />
                  </span>
                  <span
                    className={`provider-health-summary provider-health-${describeProviderHealth(selected.health).state}`}
                  >
                    <i />
                    {selected.enabled ? describeProviderHealth(selected.health).label : 'Disabled'}
                    {selected.enabled && selected.health?.checkedAt
                      ? ` · ${describeProviderHealth(selected.health).detail}`
                      : ''}
                  </span>
                </div>
                <label className="modern-switch">
                  <input
                    type="checkbox"
                    checked={selected.enabled}
                    onChange={(event) => updateSelected({ enabled: event.target.checked })}
                  />
                  <span />
                  Enabled
                </label>
              </div>

              <div className="provider-form-grid">
                <label className="modern-field wide">
                  <span>Base URL</span>
                  <input
                    value={selected.baseUrl}
                    onChange={(event) => updateSelected({ baseUrl: event.target.value })}
                    placeholder="https://server.example/v1"
                  />
                </label>
                {providerDefinitionForInstance(selected).capabilities.credentials !== 'none' && (
                  <label className="modern-field wide">
                    <span>
                      {selected.type === 'litellm' ? 'Virtual key / API key' : 'API key'}{' '}
                      <em>
                        {providerDefinitionForInstance(selected).capabilities.credentials ===
                        'required'
                          ? 'required'
                          : 'optional'}
                      </em>
                    </span>
                    <input
                      ref={keyInputRef}
                      type="password"
                      value={selected.apiKey || ''}
                      onChange={(event) => updateSelected({ apiKey: event.target.value })}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && listsModels) {
                          event.preventDefault()
                          void loadModels()
                        }
                      }}
                      onBlur={(event) => {
                        // Pasting a key and moving on loads what it opens up.
                        if (listsModels && event.target.value.trim() && !selected.models.length) {
                          void loadModels()
                        }
                      }}
                      placeholder={
                        selected.apiKeyConfigured
                          ? 'Saved securely — type to replace'
                          : 'Enter API key'
                      }
                      autoComplete="off"
                    />
                  </label>
                )}
              </div>

              <div className="provider-connection-row">
                <button
                  type="button"
                  className="settings-secondary-action"
                  onClick={() => void loadModels()}
                  disabled={status === 'loading'}
                >
                  <RefreshCw size={14} className={status === 'loading' ? 'icon-spin' : ''} />
                  {status === 'loading'
                    ? listsModels
                      ? 'Loading models…'
                      : 'Testing…'
                    : !listsModels
                      ? 'Test connection'
                      : selected.models.length > 0
                        ? 'Refresh models'
                        : 'Connect'}
                </button>
                {status !== 'idle' && (
                  <span
                    className={`provider-connection-status provider-status-${status}`}
                    role="status"
                  >
                    {status === 'success' && <Check size={14} />}
                    {status === 'error' && <X size={14} />}
                    {statusMessage}
                  </span>
                )}
              </div>

              <div className="provider-model-header">
                <div>
                  <h3>Models</h3>
                  <p>
                    {listsModels
                      ? `Tick the models to show in chat. Limits and capabilities come from ${selected.name} when it reports them.`
                      : 'Name the models this server runs. Its context window comes from the server.'}
                  </p>
                </div>
              </div>

              {selected.type === 'litellm' &&
                selected.models.some(
                  (model) => !model.contextLength || model.metadataSource === 'unknown'
                ) && (
                  <div className="provider-metadata-guidance">
                    <Info size={15} />
                    <div>
                      <strong>Gateway metadata is incomplete</strong>
                      <p>
                        LiteLLM is listing these models without token limits. Configure model_info
                        on the gateway for an authoritative value, or use Model details for a local
                        override.
                      </p>
                    </div>
                  </div>
                )}

              {selected.models.length > 0 ? (
                <>
                  <div className="provider-model-search field-shell">
                    <Search size={14} aria-hidden="true" />
                    <input
                      type="search"
                      value={modelFilter}
                      onChange={(event) => setModelFilter(event.target.value)}
                      placeholder={`Search ${selected.models.length} models`}
                      aria-label={`Search models from ${selected.name}`}
                      autoComplete="off"
                    />
                    {hasModelFilter && (
                      <button
                        type="button"
                        onClick={() => setModelFilter('')}
                        title="Clear model search"
                        aria-label="Clear model search"
                      >
                        <X size={13} />
                      </button>
                    )}
                  </div>
                  {listsModels && (
                    <div
                      className="provider-model-filters"
                      role="group"
                      aria-label="Show only models with"
                    >
                      {MODEL_FILTERS.map(({ key, label }) => (
                        <button
                          type="button"
                          key={key}
                          aria-pressed={modelFilters.has(key)}
                          onClick={() => toggleModelFilter(key)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="model-visibility-actions">
                    <span>
                      {filteredModels.length === selected.models.length
                        ? `${selected.models.length} model${selected.models.length === 1 ? '' : 's'}`
                        : `${filteredModels.length} of ${selected.models.length} models`}
                      {` · ${shownCount} in chat`}
                    </span>
                    <div>
                      <button
                        type="button"
                        onClick={() => setFilteredModelsEnabled(true)}
                        disabled={filteredModels.length === 0}
                      >
                        {narrowed ? 'Show these' : 'Show all'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setFilteredModelsEnabled(false)}
                        disabled={filteredModels.length === 0}
                      >
                        {narrowed ? 'Hide these' : 'Hide all'}
                      </button>
                    </div>
                  </div>
                  {filteredModels.length > 0 ? (
                    <div className="provider-model-list">
                      {modelGroups.map((group) => (
                        <div key={group.key} role="group" aria-label={group.title}>
                          <div className="provider-model-group" aria-hidden="true">
                            {group.title}
                            <span>{group.models.length}</span>
                          </div>
                          {group.models.map((model) => {
                            const display = getModelDisplayInfo(model)
                            const checkboxId = `${modelListId}-${filteredModels.indexOf(model)}`
                            const notes =
                              catalogNotes?.instanceId === selected.id ? catalogNotes : null
                            const tag = notes?.unlisted.has(model.id)
                              ? 'Not listed'
                              : notes?.added.has(model.id)
                                ? 'New'
                                : undefined
                            return (
                              <div key={model.id} className="provider-model-entry">
                                <div className="provider-model-row">
                                  <input
                                    id={checkboxId}
                                    type="checkbox"
                                    checked={model.enabled}
                                    onChange={(event) =>
                                      updateModel(model.id, { enabled: event.target.checked })
                                    }
                                    aria-label={`Show ${display.label} in chat`}
                                  />
                                  <ProviderIcon
                                    provider={providerDefinitionForInstance(selected).kind}
                                    size={14}
                                  />
                                  <label htmlFor={checkboxId}>
                                    <span className="provider-model-name">
                                      <strong title={display.fullName}>{display.label}</strong>
                                      {tag && (
                                        <em
                                          className="provider-model-tag"
                                          title={
                                            tag === 'New'
                                              ? 'New since the last refresh'
                                              : `${selected.name} no longer lists this model; it stays because you chose it`
                                          }
                                        >
                                          {tag}
                                        </em>
                                      )}
                                    </span>
                                    <small title={`${display.fullId} · ${modelLimitsLabel(model)}`}>
                                      {display.vendor ? `${display.vendor} · ` : ''}
                                      {display.modelIdLabel} · {modelLimitsLabel(model)}
                                    </small>
                                  </label>
                                  <span className="provider-model-capabilities">
                                    {CAPABILITY_BADGES.filter(([key]) => model[key] === true).map(
                                      ([key, label, Icon]) => (
                                        <span key={key} role="img" aria-label={label} title={label}>
                                          <Icon size={12} aria-hidden="true" />
                                        </span>
                                      )
                                    )}
                                  </span>
                                  <span className="provider-model-actions">
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setEditingModelId(model.id)
                                      }}
                                      aria-label={`Edit metadata for ${display.label}`}
                                      title="Model metadata"
                                      className={editingModelId === model.id ? 'active' : ''}
                                    >
                                      <SlidersHorizontal size={13} />
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => {
                                        updateSelected({
                                          models: selected.models.filter(
                                            (item) => item.id !== model.id
                                          )
                                        })
                                      }}
                                      aria-label={`Remove ${display.label}`}
                                      title="Remove model"
                                    >
                                      <X size={13} />
                                    </button>
                                  </span>
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="provider-model-search-empty">
                      <Search size={18} />
                      <span>
                        {hasModelFilter
                          ? `No models match “${modelFilter.trim()}”`
                          : 'No models match these filters'}
                      </span>
                      <button type="button" onClick={clearModelFilters}>
                        Clear filters
                      </button>
                    </div>
                  )}
                </>
              ) : (
                listsModels && (
                  <p className="provider-model-empty">
                    {status === 'loading'
                      ? 'Loading models…'
                      : needsKey
                        ? 'Enter the API key, then connect to choose from the models it can use.'
                        : `Connect to choose from the models ${selected.name} offers.`}
                  </p>
                )
              )}

              <div className="manual-model-row">
                <input
                  value={manualModel}
                  onChange={(event) => setManualModel(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      addManualModel()
                    }
                  }}
                  placeholder={
                    listsModels
                      ? 'Add a model the list leaves out, by id'
                      : 'Model id, for example local-model'
                  }
                  aria-label="Model id"
                />
                <button
                  type="button"
                  className="settings-secondary-action"
                  onClick={addManualModel}
                >
                  <Plus size={14} aria-hidden="true" />
                  Add model
                </button>
              </div>

              {selected.models.length > 0 && (
                <>
                  <label className="modern-field provider-fast-model">
                    <span>
                      <ProviderIcon
                        provider={providerDefinitionForInstance(selected).kind}
                        size={14}
                      />
                      Utility model <em>optional</em>
                    </span>
                    <Select
                      value={selected.fastModelId || ''}
                      onChange={(event) =>
                        updateSelected({ fastModelId: event.target.value || undefined })
                      }
                    >
                      <option value="">Use the selected chat model</option>
                      {selected.models
                        .filter((model) => model.enabled)
                        .map((model) => {
                          const display = getModelDisplayInfo(model)
                          return (
                            <option key={model.id} value={model.id}>
                              {display.label}
                              {display.vendor ? ` — ${display.vendor}` : ''}
                            </option>
                          )
                        })}
                    </Select>
                  </label>
                  <label className="modern-field provider-fast-model">
                    <span>Sub-agents at once</span>
                    <Select
                      value={String(selected.subAgentsAtOnce ?? 1)}
                      onChange={(event) => {
                        const count = Number(event.target.value)
                        updateSelected({ subAgentsAtOnce: count > 1 ? count : undefined })
                      }}
                    >
                      <option value="1">One at a time</option>
                      <option value="2">Two</option>
                      <option value="3">Three</option>
                      <option value="4">Four</option>
                    </Select>
                    <small>
                      Tasks delegated together run side by side up to this limit; the rest wait
                      their turn. More than one helps a server that caches several prompts or serves
                      several requests at once.
                    </small>
                  </label>
                </>
              )}

              <div className="provider-danger-row">
                <button
                  type="button"
                  className="settings-danger-action is-small"
                  onClick={() => {
                    onChange(instances.filter((instance) => instance.id !== selected.id))
                    setSelectedId(null)
                  }}
                >
                  <Trash2 size={14} aria-hidden="true" /> Remove provider
                </button>
              </div>
            </>
          )}
        </section>
      </div>

      {selected && editingModel && (
        <div className="provider-add-overlay" onClick={() => setEditingModelId(null)}>
          <div
            className="provider-add-dialog provider-model-metadata-dialog"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="model-metadata-title"
          >
            <div className="provider-add-heading">
              <div>
                <span className="settings-kicker">Model details</span>
                <span className="provider-model-dialog-title">
                  <ProviderIcon provider={providerDefinitionForInstance(selected).kind} size={18} />
                  <h3 id="model-metadata-title">{editingModelDisplay?.label}</h3>
                </span>
              </div>
              <button
                type="button"
                onClick={() => setEditingModelId(null)}
                aria-label="Close model details"
              >
                <X size={17} />
              </button>
            </div>
            <p className="provider-model-dialog-id">{editingModel.id}</p>

            <div className="provider-model-metadata-status">
              <span>{metadataLabel(editingModel)}</span>
              <p>
                Server values are used automatically. Add an override only when the gateway omits or
                misreports a value.
              </p>
            </div>

            <section className="provider-model-dialog-section">
              <div>
                <h4>Token limits</h4>
                <p>Use the effective limits configured for this gateway alias.</p>
              </div>
              <div className="provider-model-metadata-grid token-limits">
                <label>
                  <span>Input / context tokens</span>
                  <input
                    type="number"
                    min="1"
                    step="1024"
                    value={editingModel.contextLength || ''}
                    placeholder="Unknown"
                    onChange={(event) => {
                      const value = Number(event.target.value)
                      updateMetadataOverride(
                        editingModel,
                        'contextLength',
                        value > 0 ? value : undefined
                      )
                    }}
                  />
                </label>
                <label>
                  <span>Maximum output tokens</span>
                  <input
                    type="number"
                    min="1"
                    step="1024"
                    value={editingModel.maxOutputTokens || ''}
                    placeholder={
                      editingModel.outputTokenLimit
                        ? `Default; the model allows ${formatTokenCount(editingModel.outputTokenLimit)}`
                        : 'Unknown'
                    }
                    onChange={(event) => {
                      const value = Number(event.target.value)
                      updateMetadataOverride(
                        editingModel,
                        'maxOutputTokens',
                        value > 0 ? value : undefined
                      )
                    }}
                  />
                </label>
              </div>
            </section>

            <section className="provider-model-dialog-section">
              <div>
                <h4>Capabilities</h4>
                <p>Unknown capabilities stay enabled conservatively unless explicitly disabled.</p>
              </div>
              <div className="provider-model-metadata-grid capabilities">
                {(
                  [
                    ['supportsTools', 'Tool calling'],
                    ['supportsVision', 'Vision'],
                    ['supportsReasoning', 'Reasoning']
                  ] as const
                ).map(([key, label]) => (
                  <label key={key}>
                    <span>{label}</span>
                    <Select
                      value={editingModel[key] === undefined ? '' : String(editingModel[key])}
                      onChange={(event) =>
                        updateMetadataOverride(
                          editingModel,
                          key,
                          event.target.value === '' ? undefined : event.target.value === 'true'
                        )
                      }
                    >
                      <option value="">Unknown</option>
                      <option value="true">Supported</option>
                      <option value="false">Not supported</option>
                    </Select>
                  </label>
                ))}
              </div>
            </section>

            <div className="provider-model-dialog-footer">
              {editingModel.metadataOverrides &&
                Object.keys(editingModel.metadataOverrides).length > 0 && (
                  <button
                    type="button"
                    className="provider-model-reset-action"
                    onClick={() =>
                      updateModel(editingModel.id, {
                        contextLength: undefined,
                        maxInputTokens: undefined,
                        maxOutputTokens: undefined,
                        supportsTools: undefined,
                        supportsVision: undefined,
                        supportsReasoning: undefined,
                        metadataOverrides: undefined,
                        metadataSource: 'unknown'
                      })
                    }
                  >
                    Clear overrides
                  </button>
                )}
              <button
                type="button"
                className="settings-primary-action"
                onClick={() => setEditingModelId(null)}
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {showAdd && (
        <div className="provider-add-overlay" onClick={() => setShowAdd(false)}>
          <div
            className="provider-add-dialog"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="provider-add-title"
          >
            <div className="provider-add-heading">
              <div>
                <span className="settings-kicker">New connection</span>
                <h3 id="provider-add-title">Add a provider</h3>
              </div>
              <button
                type="button"
                onClick={() => setShowAdd(false)}
                aria-label="Close provider picker"
              >
                <X size={17} />
              </button>
            </div>
            <p>Choose a protocol preset. You can add more than one instance of any type.</p>
            <div className="provider-template-grid">
              {PROVIDER_REGISTRY.map((template) => {
                return (
                  <button
                    type="button"
                    key={template.kind}
                    onClick={() => {
                      const instance = createInstance(
                        template,
                        (sameTypeCount[template.kind] || 0) + 1
                      )
                      onChange([...instances, instance])
                      setSelectedId(instance.id)
                      clearModelFilters()
                      setStatus('idle')
                      setShowAdd(false)
                    }}
                  >
                    <ProviderIcon provider={template.kind} size={19} />
                    <span>
                      <strong>{template.name}</strong>
                      <small>{template.description}</small>
                    </span>
                    <ChevronRight size={15} />
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
