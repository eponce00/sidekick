import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { listSavedPrompts, parseSavedPrompt } from './savedPrompts'

const roots: string[] = []
async function folder(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sidekick-prompts-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('saved prompts', () => {
  it('reads a description from frontmatter and keeps the rest as the prompt', () => {
    expect(
      parseSavedPrompt('---\ndescription: "Review changes"\nmodel: x\n---\nReview $ARGUMENTS.\n')
    ).toEqual({ description: 'Review changes', body: 'Review $ARGUMENTS.' })
    expect(parseSavedPrompt('Just a prompt\r\n')).toEqual({ body: 'Just a prompt' })
  })

  it('lists project prompts before personal ones, and lets a project prompt win a name', async () => {
    const project = await folder()
    const home = await folder()
    await mkdir(join(project, '.sidekick', 'prompts'), { recursive: true })
    await mkdir(join(project, '.claude', 'commands'), { recursive: true })
    await mkdir(join(home, '.sidekick', 'prompts'), { recursive: true })
    await writeFile(join(project, '.sidekick', 'prompts', 'review.md'), 'Project review')
    await writeFile(join(project, '.claude', 'commands', 'ship.md'), 'Ship it')
    await writeFile(join(home, '.sidekick', 'prompts', 'review.md'), 'Personal review')
    await writeFile(join(home, '.sidekick', 'prompts', 'notes.md'), 'Personal notes')
    // Not a usable command name, not Markdown, or empty: left out.
    await writeFile(join(home, '.sidekick', 'prompts', 'two words.md'), 'Skipped')
    await writeFile(join(home, '.sidekick', 'prompts', 'draft.txt'), 'Skipped')
    await writeFile(join(home, '.sidekick', 'prompts', 'empty.md'), '---\ndescription: x\n---\n')

    const prompts = await listSavedPrompts(project, home)

    expect(
      prompts.map(({ name, body, source, location }) => [name, body, source, location])
    ).toEqual([
      ['review', 'Project review', 'project', '.sidekick/prompts/review.md'],
      ['ship', 'Ship it', 'project', '.claude/commands/ship.md'],
      ['notes', 'Personal notes', 'user', '~/.sidekick/prompts/notes.md']
    ])
    expect((await listSavedPrompts(null, home)).map(({ name }) => name)).toEqual([
      'notes',
      'review'
    ])
  })
})
