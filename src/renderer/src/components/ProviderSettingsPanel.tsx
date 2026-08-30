import { useMemo, useState } from 'react'
import {
  Check,
  ChevronRight,
  Info,
  Plus,
  RefreshCw,
  Search,
  Server,
  SlidersHorizontal,
  Trash2,
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
import { getModelDisplayInfo } from '../../../shared/modelDisplay'
import {
  discoverProviderModels,
  testProviderConnection as checkProviderConnection
} from '../services/providers/providerDiscovery'
import { ProviderIcon } from './ProviderIcon'
import { filterModelsByQuery } from '../utils/modelSearch'

interface Props {
  instances: ProviderInstance[]
  onChange: (instances: ProviderInstance[]) => void
}

function createInstance(template: ProviderDefinition, ordinal: number): ProviderInstance {
  return {
    id: `${template.type}-${crypto.randomUUID().slice(0, 8)}`,
    name: ordinal > 1 ? `${template.name} ${ordinal}` : template.name,
    type: template.type,
    preset: template.preset,
    enabled: true,
    baseUrl: template.defaultBaseUrl,
    apiKey: '',
    modelSource: template.capabilities.discovery === 'manual' ? 'manual' : 'discover',
    models: []
  }
}

function providerDescription(instance: ProviderInstance): string {
  const shown = instance.models.filter((model) => model.enabled).length
  return `${shown} model${shown === 1 ? '' : 's'} shown · ${instance.baseUrl}`
}

export function ProviderSettingsPanel({ instances, onChange }: Props): React.JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(instances[0]?.id ?? null)
  const [showAdd, setShowAdd] = useState(instances.length === 0)
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle')
  const [statusMessage, setStatusMessage] = useState('')
  const [manualModel, setManualModel] = useState('')
  const [modelFilter, setModelFilter] = useState('')
  const [editingModelId, setEditingModelId] = useState<string | null>(null)
  const selected = instances.find((instance) => instance.id === selectedId) ?? instances[0]
  const editingModel = selected?.models.find((model) => model.id === editingModelId)
  const editingModelDisplay = editingModel ? getModelDisplayInfo(editingModel) : undefined
  const effectiveSelectedId = selected?.id ?? null
  const filteredModels = filterModelsByQuery(selected?.models ?? [], modelFilter)
  const hasModelFilter = Boolean(modelFilter.trim())

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
    setStatus('idle')
  }

  const discoverModels = async (): Promise<void> => {
    if (!selected) return
    setStatus('loading')
    setStatusMessage('Connecting…')
    try {
      const discovered = await discoverProviderModels(window.api, selected)
      updateSelected({
        models: discovered,
        health: onlineProviderHealth(undefined, discovered.length)
      })
      setStatus('success')
      setStatusMessage(`${discovered.length} models found`)
    } catch (error) {
      const message = providerHealthErrorMessage(error)
      updateSelected({ health: offlineProviderHealth(error) })
      setStatus('error')
      setStatusMessage(message)
    }
  }

  const testConnection = async (): Promise<void> => {
    if (!selected) return
    setStatus('loading')
    setStatusMessage('Connecting…')
    try {
      await checkProviderConnection(window.api, selected)
      updateSelected({ health: onlineProviderHealth() })
      setStatus('success')
      setStatusMessage('Connection successful')
    } catch (error) {
      const message = providerHealthErrorMessage(error)
      updateSelected({ health: offlineProviderHealth(error) })
      setStatus('error')
      setStatusMessage(message)
    }
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
      <div className="provider-manager-header">
        <div>
          <h2>Providers</h2>
          <p>Connect only the services you use, then choose which models appear in chat.</p>
        </div>
        <button type="button" className="settings-primary-action" onClick={() => setShowAdd(true)}>
          <Plus size={15} /> Add provider
        </button>
      </div>

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
                  setModelFilter('')
                  setEditingModelId(null)
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
              <Server size={28} />
              <h3>Add your first provider</h3>
              <p>Provider options stay hidden until you connect one.</p>
              <button
                type="button"
                className="settings-primary-action"
                onClick={() => setShowAdd(true)}
              >
                <Plus size={15} /> Choose provider
              </button>
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
                      type="password"
                      value={selected.apiKey || ''}
                      onChange={(event) => updateSelected({ apiKey: event.target.value })}
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

              <div className="provider-model-header">
                <div>
                  <h3>Models shown in chat</h3>
                  <p>
                    {selected.type === 'litellm'
                      ? 'Aliases, limits, and capabilities come from the gateway when available.'
                      : 'Context limits come from the server or provider metadata.'}
                  </p>
                </div>
                {selected.modelSource === 'discover' && (
                  <button
                    type="button"
                    className="settings-secondary-action"
                    onClick={() => void discoverModels()}
                    disabled={status === 'loading'}
                  >
                    <RefreshCw size={14} className={status === 'loading' ? 'icon-spin' : ''} />
                    {selected.models.length ? 'Refresh' : 'Connect & discover'}
                  </button>
                )}
                {selected.modelSource === 'manual' && (
                  <button
                    type="button"
                    className="settings-secondary-action"
                    onClick={() => void testConnection()}
                    disabled={status === 'loading'}
                  >
                    <RefreshCw size={14} className={status === 'loading' ? 'icon-spin' : ''} />
                    Test connection
                  </button>
                )}
              </div>

              {status !== 'idle' && (
                <div className={`provider-status provider-status-${status}`}>
                  {status === 'success' && <Check size={14} />}
                  {status === 'error' && <X size={14} />}
                  {status === 'loading' && <RefreshCw size={14} className="icon-spin" />}
                  {statusMessage}
                </div>
              )}

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

              {(selected.modelSource === 'manual' || selected.models.length === 0) && (
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
                    placeholder="Model id, for example local-model"
                  />
                  <button
                    type="button"
                    className="settings-secondary-action"
                    onClick={addManualModel}
                  >
                    Add model
                  </button>
                </div>
              )}

              {selected.models.length > 0 && (
                <>
                  <div className="provider-model-search">
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
                  <div className="model-visibility-actions">
                    <span>
                      {filteredModels.length === selected.models.length
                        ? `${selected.models.length} model${selected.models.length === 1 ? '' : 's'}`
                        : `${filteredModels.length} of ${selected.models.length} model${selected.models.length === 1 ? '' : 's'}`}
                    </span>
                    <div>
                      <button
                        type="button"
                        onClick={() => setFilteredModelsEnabled(true)}
                        disabled={filteredModels.length === 0}
                      >
                        {hasModelFilter ? 'Show filtered' : 'Show all'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setFilteredModelsEnabled(false)}
                        disabled={filteredModels.length === 0}
                      >
                        {hasModelFilter ? 'Hide filtered' : 'Hide all'}
                      </button>
                    </div>
                  </div>
                  {filteredModels.length > 0 ? (
                    <div className="provider-model-list">
                      {filteredModels.map((model) => {
                        const display = getModelDisplayInfo(model)
                        return (
                          <div key={model.id} className="provider-model-entry">
                            <div className="provider-model-row">
                              <input
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
                              <span>
                                <strong title={display.fullName}>{display.label}</strong>
                                <small title={display.fullId}>
                                  {display.vendor ? `${display.vendor} · ` : ''}
                                  {display.modelIdLabel} ·{' '}
                                  {model.contextLength
                                    ? `${Math.round(model.contextLength / 1024)}K context`
                                    : 'Context unknown'}
                                  {model.maxOutputTokens
                                    ? ` · ${Math.round(model.maxOutputTokens / 1024)}K output`
                                    : ''}
                                </small>
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
                                {selected.modelSource === 'manual' && (
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
                                )}
                              </span>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  ) : (
                    <div className="provider-model-search-empty">
                      <Search size={18} />
                      <span>No models match “{modelFilter.trim()}”</span>
                      <button type="button" onClick={() => setModelFilter('')}>
                        Clear search
                      </button>
                    </div>
                  )}
                  <label className="modern-field provider-fast-model">
                    <span>
                      <ProviderIcon
                        provider={providerDefinitionForInstance(selected).kind}
                        size={14}
                      />
                      Utility model <em>optional</em>
                    </span>
                    <select
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
                    </select>
                  </label>
                </>
              )}

              <div className="provider-danger-row">
                <button
                  type="button"
                  onClick={() => {
                    onChange(instances.filter((instance) => instance.id !== selected.id))
                    setSelectedId(null)
                  }}
                >
                  <Trash2 size={14} /> Remove provider
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
                    placeholder="Unknown"
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
                    <select
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
                    </select>
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
                      setModelFilter('')
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
