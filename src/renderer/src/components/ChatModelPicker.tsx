import React from 'react'
import { Check, ChevronDown, Search, SlidersHorizontal, X } from 'lucide-react'
import type { PinnedModel } from '../types/models.types'
import { describeProviderAvailability } from '../../../shared/providerHealth'
import {
  compactModelLabel,
  getModelDisplayInfo,
  uniqueModelMetadata
} from '../../../shared/modelDisplay'
import { filterModelsByQuery } from '../utils/modelSearch'
import { shouldOfferModelSearch } from '../utils/modelPickerDensity'
import { parseProviderFromModelId, providerIconKindForModel } from '../utils/providerIconKinds'
import { ProviderIcon } from './ProviderIcon'

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
  onManageModels
}: ChatModelPickerProps): React.JSX.Element {
  const [query, setQuery] = React.useState('')
  const [searchOpen, setSearchOpen] = React.useState(false)
  React.useEffect(() => {
    if (!isOpen) {
      setQuery('')
      setSearchOpen(false)
    }
  }, [isOpen])

  const selected = selectedModelId
    ? models.find((model) => model.id === selectedModelId)
    : undefined
  const provider = selected
    ? providerIconKindForModel(selected)
    : selectedModelId
      ? parseProviderFromModelId(selectedModelId)
      : null
  const display = selected ? getModelDisplayInfo(selected) : undefined
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
        className="model-selector-inline"
        onClick={onToggle}
        disabled={disabled}
        title={disabled ? titleOverride || 'Model is busy' : undefined}
        aria-label={
          titleOverride ||
          (display
            ? `${display.fullName} · ${display.fullId}`
            : disabled
              ? 'Model is busy'
              : 'Change model')
        }
        aria-expanded={isOpen}
      >
        {provider && <ProviderIcon provider={provider} size={14} />}
        {selectedAvailability && (
          <i
            className={`selected-provider-health selected-provider-health-${selectedAvailability.state}`}
            title={selectedAvailability.detail}
          />
        )}
        <span className="model-selector-inline-label">
          {labelOverride || (selected ? compactModelLabel(selected, 24) : 'Select model')}
        </span>
        <ChevronDown size={13} />
      </button>

      {isOpen && (
        <div className="features-menu model-menu" onClick={(event) => event.stopPropagation()}>
          {models.length > 0 && (
            <>
              {offersSearch && (
                <div className={`model-menu-header ${searchOpen ? 'is-searching' : ''}`}>
                  {searchOpen ? (
                    <div className="model-menu-search">
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
