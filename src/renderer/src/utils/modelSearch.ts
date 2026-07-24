export interface SearchableModel {
  id: string
  name?: string
  provider?: string
  providerInstanceName?: string
  providerModelId?: string
  contextLength?: number
  supportsVision?: boolean
}

function normalizeSearchText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

export function filterModelsByQuery<T extends SearchableModel>(models: T[], query: string): T[] {
  const terms = normalizeSearchText(query).split(/\s+/).filter(Boolean)
  if (terms.length === 0) return models

  return models.filter((model) => {
    const contextLabel = model.contextLength
      ? `${model.contextLength} ${Math.round(model.contextLength / 1024)}k context`
      : ''
    const searchable = normalizeSearchText(
      [
        model.name,
        model.id,
        model.providerModelId,
        model.provider,
        model.providerInstanceName,
        contextLabel,
        model.supportsVision ? 'vision image multimodal' : ''
      ]
        .filter(Boolean)
        .join(' ')
    )
    return terms.every((term) => searchable.includes(term))
  })
}
