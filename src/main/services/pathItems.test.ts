import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { countPathItems } from './pathItems'

describe('countPathItems', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sidekick-path-items-'))
    await mkdir(join(root, 'a', 'b'), { recursive: true })
    for (const file of ['one.txt', 'a/two.txt', 'a/b/three.txt', 'a/b/four.txt']) {
      await writeFile(join(root, file), file, 'utf8')
    }
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('stops at its limit and says there are more', async () => {
    expect(await countPathItems(root, 3)).toEqual({ count: 3, more: true })
  })
})
