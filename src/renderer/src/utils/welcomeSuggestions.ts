export interface WelcomeSuggestion {
  label: string
  prompt: string
}

interface WelcomeSuggestionContext {
  recentConversationTitles: readonly string[]
  projectName?: string | null
}

const GENERIC_TITLES = new Set(['new conversation', 'untitled conversation'])

const FALLBACK_SUGGESTIONS: readonly WelcomeSuggestion[] = [
  {
    label: 'Plan something new',
    prompt: 'Help me turn a new idea into a clear, practical plan.'
  },
  {
    label: 'Explore an idea',
    prompt: 'Help me explore an idea, challenge my assumptions, and find a useful next step.'
  }
]

function compactTopic(title: string): string {
  const normalized = title.replace(/\s+/g, ' ').trim()
  return normalized.length <= 34 ? normalized : `${normalized.slice(0, 33).trimEnd()}…`
}

export function createWelcomeSuggestions({
  recentConversationTitles,
  projectName
}: WelcomeSuggestionContext): [WelcomeSuggestion, WelcomeSuggestion] {
  const uniqueTitles = Array.from(
    new Set(
      recentConversationTitles
        .map((title) => title.replace(/\s+/g, ' ').trim())
        .filter((title) => title && !GENERIC_TITLES.has(title.toLocaleLowerCase()))
    )
  )

  const suggestions: WelcomeSuggestion[] = []
  const normalizedProjectName = projectName?.replace(/\s+/g, ' ').trim()

  if (normalizedProjectName) {
    suggestions.push({
      label: `Explore ${compactTopic(normalizedProjectName)}`,
      prompt: `Review the ${normalizedProjectName} project and suggest the most useful concrete next step.`
    })
  }

  for (const title of uniqueTitles) {
    const action = suggestions.length === 0 ? 'Continue' : 'Revisit'
    suggestions.push({
      label: `${action} “${compactTopic(title)}”`,
      prompt: `${action} the work from “${title}”. Start by identifying the best concrete next step.`
    })
    if (suggestions.length === 2) break
  }

  for (const fallback of FALLBACK_SUGGESTIONS) {
    if (suggestions.length === 2) break
    suggestions.push(fallback)
  }

  return [suggestions[0], suggestions[1]]
}
