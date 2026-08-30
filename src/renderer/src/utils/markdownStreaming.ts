/** Split at blank lines outside fenced code so settled streaming blocks keep stable React trees. */
export function splitMarkdownRenderBlocks(source: string): string[] {
  if (!source) return []
  const lines = source.match(/.*(?:\r?\n|$)/g)?.filter(Boolean) ?? [source]
  const blocks: string[] = []
  let buffer = ''
  let fence: { marker: '`' | '~'; length: number } | null = null
  for (const line of lines) {
    buffer += line
    const marker = line.match(/^\s*(`{3,}|~{3,})/)
    if (marker) {
      const next = marker[1]
      const kind = next[0] as '`' | '~'
      if (!fence) fence = { marker: kind, length: next.length }
      else if (fence.marker === kind && next.length >= fence.length) fence = null
    }
    if (!fence && /^\s*(?:\r?\n)?$/.test(line) && buffer.trim()) {
      blocks.push(buffer)
      buffer = ''
    }
  }
  if (buffer) blocks.push(buffer)
  return blocks
}
