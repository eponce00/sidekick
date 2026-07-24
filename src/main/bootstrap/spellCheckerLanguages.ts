function normalizeLocale(value: string): string {
  return value.trim().replace(/_/g, '-').toLowerCase()
}

export function resolveSpellCheckerLanguages(
  preferredLanguages: readonly string[],
  availableLanguages: readonly string[]
): string[] {
  const available = availableLanguages.map((language) => ({
    language,
    normalized: normalizeLocale(language)
  }))
  const resolved: string[] = []

  for (const preferredLanguage of preferredLanguages) {
    const normalized = normalizeLocale(preferredLanguage)
    const base = normalized.split('-')[0]
    const match =
      available.find((candidate) => candidate.normalized === normalized) ||
      available.find((candidate) => candidate.normalized === base) ||
      available.find((candidate) => candidate.normalized.startsWith(`${base}-`))
    if (match && !resolved.includes(match.language)) resolved.push(match.language)
  }

  return resolved.slice(0, 4)
}
