import { promises as fs } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { SavedPrompt } from '../../shared/savedPrompts'

const MAX_PROMPTS = 50
const MAX_PROMPT_BYTES = 32 * 1024
const PROMPT_NAME = /^[a-z0-9][a-z0-9_-]*$/i

/**
 * SideKick's folders first, then Claude Code's command folders, so prompts written for either
 * work here. A project prompt replaces a personal one of the same name.
 */
const PROMPT_FOLDERS: Array<{ source: SavedPrompt['source']; parts: string[] }> = [
  { source: 'project', parts: ['.sidekick', 'prompts'] },
  { source: 'project', parts: ['.claude', 'commands'] },
  { source: 'user', parts: ['.sidekick', 'prompts'] },
  { source: 'user', parts: ['.claude', 'commands'] }
]

/** Reads a leading `---` block's `description:` line, and returns the text after the block. */
export function parseSavedPrompt(text: string): { description?: string; body: string } {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  const frontmatter = /^---\n([\s\S]*?)\n---\n?/.exec(normalized)
  if (!frontmatter) return { body: normalized.trim() }
  const description = /^description:\s*(.+)$/m
    .exec(frontmatter[1])?.[1]
    .trim()
    .replace(/^(['"])(.*)\1$/, '$2')
  return {
    ...(description ? { description } : {}),
    body: normalized.slice(frontmatter[0].length).trim()
  }
}

export async function listSavedPrompts(
  workspaceRoot: string | null,
  home: string = homedir()
): Promise<SavedPrompt[]> {
  const prompts = new Map<string, SavedPrompt>()
  for (const folder of PROMPT_FOLDERS) {
    const base = folder.source === 'project' ? workspaceRoot : home
    if (!base) continue
    const directory = join(base, ...folder.parts)
    let names: string[]
    try {
      names = (await fs.readdir(directory)).filter((name) => name.toLowerCase().endsWith('.md'))
    } catch {
      continue
    }
    for (const fileName of names.sort()) {
      const name = fileName.slice(0, -3)
      if (!PROMPT_NAME.test(name) || prompts.has(name.toLowerCase())) continue
      if (prompts.size >= MAX_PROMPTS) return [...prompts.values()]
      const path = join(directory, fileName)
      try {
        const stat = await fs.stat(path)
        if (!stat.isFile() || stat.size > MAX_PROMPT_BYTES) continue
        const parsed = parseSavedPrompt(await fs.readFile(path, 'utf8'))
        if (!parsed.body) continue
        prompts.set(name.toLowerCase(), {
          name,
          ...parsed,
          source: folder.source,
          location:
            folder.source === 'project'
              ? [...folder.parts, fileName].join('/')
              : ['~', ...folder.parts, fileName].join('/')
        })
      } catch {
        // An unreadable prompt is skipped; the others still load.
      }
    }
  }
  return [...prompts.values()]
}
