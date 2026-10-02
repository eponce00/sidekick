/** An `@` being typed at the caret: where it starts and what follows it so far. */
export interface ActiveFileMention {
  start: number
  query: string
}

/** The `@query` that ends at the caret, when it starts a word. Paths have no spaces here. */
export function activeFileMentionAtCursor(value: string, caret: number): ActiveFileMention | null {
  const match = /(^|\s)@([^\s@]*)$/.exec(value.slice(0, caret))
  if (!match) return null
  return { start: match.index + match[1].length, query: match[2] }
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** Whether every character of the query appears in order in the text. */
function isSubsequence(query: string, text: string): boolean {
  let index = 0
  for (const character of text) {
    if (character === query[index]) index++
    if (index === query.length) return true
  }
  return index === query.length
}

/**
 * Files matching the query, best first: a file name that starts with it, then one that contains
 * it, then a path that contains it, then a path holding its letters in order. Shorter paths win
 * ties, since a nearer file is the likelier one.
 */
export function rankFileMentions(files: readonly string[], query: string, limit = 8): string[] {
  const needle = query.toLowerCase()
  const scored: Array<{ path: string; score: number }> = []
  for (const path of files) {
    if (path.endsWith('/')) continue
    const lowerPath = path.toLowerCase()
    const name = basename(lowerPath)
    const score = !needle
      ? 4
      : name.startsWith(needle)
        ? 0
        : name.includes(needle)
          ? 1
          : lowerPath.includes(needle)
            ? 2
            : isSubsequence(needle, lowerPath)
              ? 3
              : -1
    if (score >= 0) scored.push({ path, score })
  }
  return scored
    .sort(
      (a, b) => a.score - b.score || a.path.length - b.path.length || a.path.localeCompare(b.path)
    )
    .slice(0, limit)
    .map(({ path }) => path)
}

/** Replaces the mention being typed with the chosen path, and puts the caret after it. */
export function insertFileMention(
  value: string,
  mention: ActiveFileMention,
  caret: number,
  path: string
): { value: string; caret: number } {
  const token = `@${path} `
  const after = value.slice(caret).replace(/^\S*/, '').replace(/^ /, '')
  const next = value.slice(0, mention.start) + token + after
  return { value: next, caret: mention.start + token.length }
}
