export type CommandPaletteGroupId = 'actions' | 'conversations' | 'projects'

export interface CommandPaletteItem {
  id: string
  group: CommandPaletteGroupId
  title: string
  /** Shown beside the title and searched after it, such as a project name. */
  detail?: string
  /** Extra words that find the item without being shown. */
  keywords?: string
  /** The shortcut label, from the shared shortcut table. */
  shortcut?: string
  disabled?: boolean
  /** Newer first when two matches rank the same, and in the empty-query list. */
  recency?: number
  run: () => void
}

export interface CommandPaletteSection {
  id: CommandPaletteGroupId
  label: string
  items: CommandPaletteItem[]
}

const GROUP_ORDER: CommandPaletteGroupId[] = ['actions', 'conversations', 'projects']

const GROUP_LABELS: Record<CommandPaletteGroupId, string> = {
  actions: 'Actions',
  conversations: 'Conversations',
  projects: 'Projects'
}

/** Without a query the palette lists every action and only the latest chats. */
export const RECENT_CONVERSATION_LIMIT = 8
const MATCH_LIMIT_PER_GROUP = 50

export function normalizeSearchText(value: string): string {
  return value.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * How well `token` appears in `field` as a subsequence ("nwcht" in "new chat"),
 * or null. Tighter runs score higher.
 */
function subsequenceScore(field: string, token: string): number | null {
  let position = -1
  let first = -1
  for (const character of token) {
    position = field.indexOf(character, position + 1)
    if (position === -1) return null
    if (first === -1) first = position
  }
  const gaps = position - first + 1 - token.length
  return Math.max(1, 40 - gaps * 4)
}

function tokenScore(title: string, rest: string, token: string): number | null {
  if (title === token) return 400
  if (title.startsWith(token)) return 300
  if (title.includes(` ${token}`)) return 250
  if (title.includes(token)) return 200
  if (rest.includes(token)) return 100
  return subsequenceScore(title, token)
}

/**
 * Every word of the query must match: as a prefix, a substring, or (in the
 * title) a fuzzy subsequence. Returns null when the item does not match.
 */
export function scoreCommandPaletteItem(item: CommandPaletteItem, query: string): number | null {
  const tokens = normalizeSearchText(query).split(' ').filter(Boolean)
  if (!tokens.length) return 0
  const title = normalizeSearchText(item.title)
  const rest = normalizeSearchText(`${item.detail ?? ''} ${item.keywords ?? ''}`)
  let total = 0
  for (const token of tokens) {
    const score = tokenScore(title, rest, token)
    if (score === null) return null
    total += score
  }
  // A query that is the whole title beats one whose words each match a part.
  if (title === normalizeSearchText(query)) total += 1_000
  return total
}

export function filterCommandPalette(
  items: readonly CommandPaletteItem[],
  query: string
): CommandPaletteSection[] {
  const searching = normalizeSearchText(query).length > 0
  return GROUP_ORDER.flatMap((group) => {
    const candidates = items
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => item.group === group)
    let ranked: CommandPaletteItem[]
    if (!searching) {
      ranked =
        group === 'conversations'
          ? candidates
              .sort(
                (left, right) =>
                  (right.item.recency ?? 0) - (left.item.recency ?? 0) || left.index - right.index
              )
              .slice(0, RECENT_CONVERSATION_LIMIT)
              .map(({ item }) => item)
          : candidates.map(({ item }) => item)
    } else {
      ranked = candidates
        .map((candidate) => ({
          ...candidate,
          score: scoreCommandPaletteItem(candidate.item, query)
        }))
        .filter(
          (candidate): candidate is typeof candidate & { score: number } => candidate.score !== null
        )
        .sort(
          (left, right) =>
            right.score - left.score ||
            (right.item.recency ?? 0) - (left.item.recency ?? 0) ||
            left.index - right.index
        )
        .slice(0, MATCH_LIMIT_PER_GROUP)
        .map(({ item }) => item)
    }
    return ranked.length
      ? [
          {
            id: group,
            label:
              group === 'conversations' && !searching
                ? 'Recent conversations'
                : GROUP_LABELS[group],
            items: ranked
          }
        ]
      : []
  })
}

/** The next enabled row in `direction`, wrapping around; -1 when none is enabled. */
export function nextEnabledIndex(
  items: readonly CommandPaletteItem[],
  from: number,
  direction: 1 | -1
): number {
  for (let step = 1; step <= items.length; step += 1) {
    const index = (from + direction * step + items.length * step) % items.length
    if (!items[index].disabled) return index
  }
  return -1
}
