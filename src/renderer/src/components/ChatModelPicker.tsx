import React from 'react'
import {
  AlertTriangle,
  Brain,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  RotateCcw,
  Search,
  SlidersHorizontal,
  X
} from 'lucide-react'
import {
  REASONING_LEVEL_LABELS,
  type ReasoningLevel,
  type ReasoningOptions
} from '../../../shared/reasoning'
import type { PinnedModel } from '../types/models.types'
import { describeProviderAvailability } from '../../../shared/providerHealth'
import { modelNameFromId } from '../../../shared/conversationModels'
import {
  compactModelLabel,
  getModelDisplayInfo,
  uniqueModelMetadata
} from '../../../shared/modelDisplay'
import { filterModelsByQuery } from '../utils/modelSearch'
import { shouldOfferModelSearch } from '../utils/modelPickerDensity'
import { providerIconKindForModel } from '../utils/providerIconKinds'
import { EffortSlider } from './EffortSlider'
import { ProviderIcon } from './ProviderIcon'

/** What the chip says for the level: short, since it sits in the composer toolbar. */
const SHORT_LEVEL: Partial<Record<ReasoningLevel, string>> = {
  auto: 'Default',
  xhigh: 'X-High'
}

function shortReasoningLabel(level: ReasoningLevel): string {
  return SHORT_LEVEL[level] ?? REASONING_LEVEL_LABELS[level]
}

interface ChatModelPickerProps {
  selectedModelId?: string
  models: PinnedModel[]
  isOpen: boolean
  containerRef?: React.RefObject<HTMLDivElement | null>
  labelOverride?: string
  titleOverride?: string
  disabled?: boolean
  onToggle: () => void
  onModelChange: (modelId: string) => void | Promise<void>
  onManageModels: () => void
  /** The selected model's reasoning: the card opens on its effort, with the model a tap away. */
  reasoning?: {
    options: ReasoningOptions
    level: ReasoningLevel
    onChange: (level: ReasoningLevel) => void
  } | null
}

/** Compact pinned-model control shared by every chat composer. */
export function ChatModelPicker({
  selectedModelId,
  models,
  isOpen,
  containerRef,
  labelOverride,
  titleOverride,
  disabled = false,
  onToggle,
  onModelChange,
  onManageModels,
  reasoning = null
}: ChatModelPickerProps): React.JSX.Element {
  const [query, setQuery] = React.useState('')
  const [searchOpen, setSearchOpen] = React.useState(false)
  // With reasoning to set, the card opens on the effort; the model list is one step in.
  const [view, setView] = React.useState<'effort' | 'models'>('effort')
  React.useEffect(() => {
    if (!isOpen) {
      setQuery('')
      setSearchOpen(false)
      setView('effort')
    }
  }, [isOpen])
  const showEffort = Boolean(reasoning) && view === 'effort'

  const selected = selectedModelId
    ? models.find((model) => model.id === selectedModelId)
    : undefined
  const provider = selected ? providerIconKindForModel(selected) : null
  const display = selected ? getModelDisplayInfo(selected) : undefined
  // A model the chat kept that is no longer set up stays named, so the chat asks for another.
  const unavailableName = selectedModelId && !selected ? modelNameFromId(selectedModelId) : null
  const selectedAvailability = selected?.providerHealth
    ? describeProviderAvailability(selected.providerHealth)
    : undefined
  const filteredModels = React.useMemo(() => filterModelsByQuery(models, query), [models, query])
  const offersSearch = shouldOfferModelSearch(models.length)
  React.useEffect(() => {
    if (!offersSearch) {
      setQuery('')
      setSearchOpen(false)
    }
  }, [offersSearch])
  const choose = async (modelId: string): Promise<void> => {
    await onModelChange(modelId)
    onToggle()
  }

  return (
    <div className="model-menu-container" ref={containerRef}>
      <button
        type="button"
        className={`model-selector-inline${unavailableName ? ' is-unavailable' : ''}`}
        onClick={onToggle}
        disabled={disabled}
        title={
          disabled
            ? titleOverride || 'Model is busy'
            : unavailableName
              ? `${unavailableName} is no longer available. Choose another model.`
              : reasoning && selected
                ? `${compactModelLabel(selected)} · Reasoning: ${REASONING_LEVEL_LABELS[reasoning.level]}`
                : undefined
        }
        aria-label={
          titleOverride ||
          (display
            ? `${display.fullName} · ${display.fullId}`
            : unavailableName
              ? `${unavailableName} is no longer available. Choose another model`
              : disabled
                ? 'Model is busy'
                : 'Change model')
        }
        aria-expanded={isOpen}
      >
        {unavailableName ? (
          <AlertTriangle size={14} aria-hidden="true" />
        ) : (
          provider && <ProviderIcon provider={provider} size={14} />
        )}
        {selectedAvailability && (
          <i
            className={`selected-provider-health selected-provider-health-${selectedAvailability.state}`}
            title={selectedAvailability.detail}
          />
        )}
        <span className="model-selector-inline-label">
          {labelOverride ||
            (selected
              ? compactModelLabel(selected, 24)
              : unavailableName
                ? `Unavailable: ${unavailableName}`
                : 'Select model')}
        </span>
        {reasoning && selected && (
          <span className="model-selector-inline-effort">
            {shortReasoningLabel(reasoning.level)}
          </span>
        )}
        <ChevronDown size={13} />
      </button>

      {isOpen && showEffort && reasoning && (
        <div
          className="features-menu model-menu effort-card"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="effort-card-head">
            <Brain size={17} className="effort-card-icon" aria-hidden="true" />
            <strong className="effort-card-level">{REASONING_LEVEL_LABELS[reasoning.level]}</strong>
            <button
              type="button"
              className="effort-card-reset"
              onClick={() => reasoning.onChange(reasoning.options.initial)}
              disabled={reasoning.level === reasoning.options.initial}
              title={`Back to ${REASONING_LEVEL_LABELS[reasoning.options.initial]}, the model's starting level`}
              aria-label="Back to the starting level"
            >
              <RotateCcw size={16} />
            </button>
          </div>
          <button type="button" className="effort-card-model" onClick={() => setView('models')}>
            <span>{selected ? compactModelLabel(selected) : 'Choose a model'}</span>
            <ChevronRight size={14} aria-hidden="true" />
          </button>
          <EffortSlider
            levels={reasoning.options.levels}
            level={reasoning.level}
            onChange={reasoning.onChange}
          />
          {reasoning.options.levels.includes('auto') && (
            <button
              type="button"
              className={`effort-card-default${reasoning.level === 'auto' ? ' is-selected' : ''}`}
              onClick={() => reasoning.onChange('auto')}
              aria-pressed={reasoning.level === 'auto'}
            >
              Let the model decide
              {reasoning.level === 'auto' && <Check size={13} aria-hidden="true" />}
            </button>
          )}
        </div>
      )}

      {isOpen && !showEffort && (
        <div className="features-menu model-menu" onClick={(event) => event.stopPropagation()}>
          {reasoning && (
            <button type="button" className="effort-card-back" onClick={() => setView('effort')}>
              <ChevronLeft size={14} aria-hidden="true" />
              <span>Reasoning: {REASONING_LEVEL_LABELS[reasoning.level]}</span>
            </button>
          )}
          {models.length > 0 && (
            <>
              {offersSearch && (
                <div className={`model-menu-header ${searchOpen ? 'is-searching' : ''}`}>
                  {searchOpen ? (
                    <div className="model-menu-search field-shell">
                      <Search size={13} aria-hidden="true" />
                      <input
                        type="search"
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        onKeyDown={(event) => {
                          event.stopPropagation()
                          if (event.key === 'Enter' && filteredModels[0]) {
                            event.preventDefault()
                            void choose(filteredModels[0].id)
                          } else if (event.key === 'Escape') {
                            event.preventDefault()
                            setQuery('')
                            setSearchOpen(false)
                          }
                        }}
                        placeholder="Find a model"
                        aria-label="Search available chat models"
                        autoComplete="off"
                        autoFocus
                      />
                      <button
                        type="button"
                        onClick={() => {
                          setQuery('')
                          setSearchOpen(false)
                        }}
                        title="Close search"
                        aria-label="Close model search"
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ) : (
                    <>
                      <span>
                        Pinned models <small>{models.length}</small>
                      </span>
                      <button
                        type="button"
                        onClick={() => setSearchOpen(true)}
                        title="Search pinned models"
                        aria-label="Search pinned models"
                      >
                        <Search size={13} />
                      </button>
                    </>
                  )}
                </div>
              )}
              <div
                className={`model-menu-scroll ${offersSearch ? 'is-scrollable' : ''}`}
                role="listbox"
                aria-label="Pinned models"
              >
                {filteredModels.map((model) => {
                  const modelDisplay = getModelDisplayInfo(model)
                  const providerAvailability = model.providerHealth
                    ? describeProviderAvailability(model.providerHealth)
                    : undefined
                  const sourceLabel = uniqueModelMetadata([
                    modelDisplay.vendor,
                    model.providerInstanceName
                  ])[0]
                  const selectedModel = selectedModelId === model.id
                  return (
                    <button
                      type="button"
                      role="option"
                      aria-selected={selectedModel}
                      className={`model-menu-option ${selectedModel ? 'is-selected' : ''}`}
                      key={model.id}
                      onClick={() => void choose(model.id)}
                      title={`${modelDisplay.fullName} · ${modelDisplay.fullId}`}
                    >
                      <ProviderIcon provider={providerIconKindForModel(model)} size={14} />
                      <span className="model-menu-option-name">{compactModelLabel(model)}</span>
                      {sourceLabel && <small>{sourceLabel}</small>}
                      {providerAvailability && (
                        <i
                          className={`model-menu-health model-menu-health-${providerAvailability.state}`}
                          title={`${providerAvailability.label}: ${providerAvailability.detail}`}
                        />
                      )}
                      {selectedModel && <Check className="model-menu-option-check" size={13} />}
                    </button>
                  )
                })}
                {filteredModels.length === 0 && (
                  <div className="model-menu-empty">
                    <span>No matching models</span>
                    <small>Try a shorter search.</small>
                  </div>
                )}
              </div>
              <div className="model-menu-footer">
                <button
                  type="button"
                  className="model-menu-manage"
                  onClick={() => {
                    onManageModels()
                    onToggle()
                  }}
                >
                  <SlidersHorizontal size={13} />
                  <span>Manage models</span>
                </button>
              </div>
            </>
          )}
          {models.length === 0 && (
            <button
              type="button"
              className="model-menu-manage model-menu-manage-empty"
              onClick={() => {
                onManageModels()
                onToggle()
              }}
            >
              <SlidersHorizontal size={13} />
              <span>Choose models in Settings</span>
            </button>
          )}
        </div>
      )}
    </div>
  )
}
