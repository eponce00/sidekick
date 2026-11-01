import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  executeWorkspaceMutation,
  type WorkspaceMutationExecutionOptions
} from './workspaceMutationService'

// Failure modes from a real run that edited a canvas game: an ambiguous short old_string, a
// retry retyped with different indentation, and a ~150-line block copied with drift.

const temporaryRoots: string[] = []

async function workspace(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sidekick-edit-matching-'))
  temporaryRoots.push(root)
  for (const [path, content] of Object.entries(files)) {
    await writeFile(join(root, path), content, 'utf8')
  }
  return root
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

function edit(
  root: string,
  filePath: string,
  oldText: string,
  newText: string,
  replaceAll = false,
  options?: WorkspaceMutationExecutionOptions
) {
  return executeWorkspaceMutation(
    root,
    { kind: 'replace', filePath, oldText, newText, replaceAll, accessLevel: 'auto' },
    options
  )
}

const read = (root: string, path: string) => readFile(join(root, path), 'utf8')

const GAME = [
  '<script>', //                      1
  '    function drawBird(x, y) {', // 2
  '        ctx.beginPath();', //       3
  '        ctx.fill();', //            4
  '    }', //                          5
  '', //                              6
  '    function drawBike(x, y) {', // 7
  '        ctx.beginPath();', //       8
  '        ctx.fill();', //            9
  '    }', //                         10
  '</script>', //                     11
  ''
].join('\n')

describe('edit matching for drifted model copies', () => {
  it('rejects an ambiguous old_string and shows where every match is', async () => {
    const root = await workspace({ 'game.html': GAME })
    const result = await edit(root, 'game.html', 'ctx.fill();', 'ctx.stroke();')

    expect(result).toMatchObject({ ok: false, changed: false })
    expect(result.failure).toMatchObject({
      code: 'multiple_matches',
      matchCount: 2,
      matchStartLines: [4, 9]
    })
    // Each location comes with the line before it, so the model can add disambiguating context.
    expect(result.error).toContain('3:         ctx.beginPath();\n  4:         ctx.fill();')
    expect(result.error).toContain('8:         ctx.beginPath();\n  9:         ctx.fill();')
    expect(await read(root, 'game.html')).toBe(GAME)

    const retry = await edit(
      root,
      'game.html',
      'function drawBike(x, y) {\n        ctx.beginPath();\n        ctx.fill();',
      'function drawBike(x, y) {\n        ctx.beginPath();\n        ctx.stroke();'
    )
    expect(retry.ok).toBe(true)
    expect(await read(root, 'game.html')).toBe(
      GAME.replace('ctx.fill();\n    }\n</script>', 'ctx.stroke();\n    }\n</script>')
    )
  })

  it('accepts lines retyped at a different indentation and re-indents the replacement', async () => {
    const root = await workspace({ 'game.html': GAME })
    const result = await edit(
      root,
      'game.html',
      'function drawBike(x, y) {\n  ctx.beginPath();\n  ctx.fill();\n}',
      'function drawBike(x, y) {\n  ctx.beginPath();\n  ctx.arc(x, y, 4, 0, Math.PI * 2);\n  ctx.fill();\n}'
    )

    expect(result).toMatchObject({ ok: true, changed: true })
    expect(await read(root, 'game.html')).toBe(
      GAME.replace(
        '        ctx.fill();\n    }\n</script>',
        '        ctx.arc(x, y, 4, 0, Math.PI * 2);\n        ctx.fill();\n    }\n</script>'
      )
    )
  })

  it('maps space indentation onto a tab-indented CRLF file', async () => {
    const original = 'if (a) {\r\n\tif (b) {\r\n\t\trun();\r\n\t}\r\n}\r\n'
    const root = await workspace({ 'tabs.js': original })
    const result = await edit(
      root,
      'tabs.js',
      'if (b) {\n    run();\n}',
      'if (b) {\n    run();\n    log();\n}'
    )

    expect(result.ok).toBe(true)
    expect(await read(root, 'tabs.js')).toBe(
      'if (a) {\r\n\tif (b) {\r\n\t\trun();\r\n\t\tlog();\r\n\t}\r\n}\r\n'
    )
  })

  it('accepts a copy whose inner whitespace differs and keeps unchanged file lines verbatim', async () => {
    const root = await workspace({
      'calc.py': 'def f(a, b):\n    total  =  a + b\n    return total\n'
    })
    const result = await edit(
      root,
      'calc.py',
      'total = a + b\nreturn total',
      'total = a + b\nreturn total * 2'
    )

    expect(result.ok).toBe(true)
    expect(await read(root, 'calc.py')).toBe(
      'def f(a, b):\n    total  =  a + b\n    return total * 2\n'
    )
  })

  it('ignores a final newline in old_string that the file does not have', async () => {
    const root = await workspace({ 'end.txt': 'first\nlast' })
    const result = await edit(root, 'end.txt', 'last\n', 'final\n')
    expect(result.ok).toBe(true)
    expect(await read(root, 'end.txt')).toBe('first\nfinal')
  })

  it('ignores blank lines at the edges of old_string', async () => {
    const root = await workspace({ 'a.md': '# Title\nbody line\nnext\n' })
    const result = await edit(root, 'a.md', '\n\nbody line\n\n', '\n\nnew body\n\n')
    expect(result.ok).toBe(true)
    expect(await read(root, 'a.md')).toBe('# Title\nnew body\nnext\n')
  })

  it('deletes drifted lines without leaving a blank line behind', async () => {
    const root = await workspace({ 'list.txt': 'keep one\n    drop me\nkeep two\n' })
    const result = await edit(root, 'list.txt', 'drop  me\n', '')
    expect(result.ok).toBe(true)
    expect(await read(root, 'list.txt')).toBe('keep one\nkeep two\n')
  })

  it('reports the exact differing lines of a large block instead of applying it', async () => {
    const block = Array.from({ length: 150 }, (_, index) => `    const part${index} = ${index};`)
    const file = ['<script>', ...block, '</script>', ''].join('\n')
    const root = await workspace({ 'big.html': file })
    // A copy from memory: two lines in the middle differ from the file.
    const stale = [...block]
    stale[40] = '    const part40 = 4000;'
    stale[90] = '    const part90 = 9000;'
    const result = await edit(
      root,
      'big.html',
      stale.join('\n'),
      stale.join('\n').replace('part0 = 0', 'part0 = -1')
    )

    expect(result).toMatchObject({ ok: false, changed: false })
    expect(result.failure?.code).toBe('text_not_found')
    expect(result.error).toContain(
      'Closest match: file lines 2-151, where 148 of 150 old_string lines match'
    )
    expect(result.error).toContain('old_string line 41 (not in file):     const part40 = 4000;')
    expect(result.error).toContain('file line 42 (not in old_string):     const part40 = 40;')
    expect(result.error).toContain('old_string line 91 (not in file):     const part90 = 9000;')
    expect(result.failure?.recovery).toContain('Read lines 2-151 of big.html again')
    expect(await read(root, 'big.html')).toBe(file)
  })

  it('applies a large block that differs only in indentation', async () => {
    const block = Array.from({ length: 150 }, (_, index) => `        line(${index});`)
    const file = ['function draw() {', ...block, '}', ''].join('\n')
    const root = await workspace({ 'big.js': file })
    const copy = block.map((line) => line.trimStart())
    const replacement = copy.map((line) => line.replace('line(', 'segment('))

    const result = await edit(root, 'big.js', copy.join('\n'), replacement.join('\n'))

    expect(result.ok).toBe(true)
    expect(await read(root, 'big.js')).toBe(file.replaceAll('line(', 'segment('))
  })

  it('writes $ sequences in new_string literally', async () => {
    const root = await workspace({ 'price.js': 'const label = price\n' })
    const result = await edit(
      root,
      'price.js',
      'const label = price',
      "const label = `$${price}` + '$&'"
    )
    expect(result.ok).toBe(true)
    expect(await read(root, 'price.js')).toBe("const label = `$${price}` + '$&'\n")
  })

  describe('stale text', () => {
    it('points at the current text when old_string predates the model’s own earlier edit', async () => {
      const root = await workspace({ 'game.html': GAME })
      expect(
        (await edit(root, 'game.html', 'function drawBird(x, y) {', 'function drawPelican(x, y) {'))
          .ok
      ).toBe(true)

      const result = await edit(
        root,
        'game.html',
        'function drawBird(x, y) {\n        ctx.beginPath();',
        'function drawBird(x, y, scale) {\n        ctx.beginPath();'
      )

      expect(result.failure?.code).toBe('text_not_found')
      expect(result.error).toContain('including through an earlier edit in this run')
      expect(result.error).toContain(
        'file line 2 (not in old_string):     function drawPelican(x, y) {'
      )
    })
  })

  describe('adversarial', () => {
    it('refuses a loose match that occurs at two nesting levels', async () => {
      const original = 'a() {\n  done();\n}\nb() {\n  if (x) {\n    done();\n  }\n}\n'
      const root = await workspace({ 'nest.js': original })
      const result = await edit(root, 'nest.js', '      done();', '      finish();')

      expect(result.failure).toMatchObject({ code: 'multiple_matches', matchStartLines: [2, 6] })
      expect(result.error).toContain('Matching ignored indentation')
      expect(await read(root, 'nest.js')).toBe(original)
    })

    it('prefers a stricter unique match over a looser one elsewhere', async () => {
      const original = 'outer {\n  item();\n}\ninner {\n    item();\n}\n'
      const root = await workspace({ 'pick.txt': original })
      // Only line 5 matches with its indentation; line 2 matches loosely and must stay untouched.
      const result = await edit(root, 'pick.txt', '    item();\n}\n', '    changed();\n}\n')
      expect(result.ok).toBe(true)
      expect(await read(root, 'pick.txt')).toBe(
        'outer {\n  item();\n}\ninner {\n    changed();\n}\n'
      )
    })

    it('never matches part of a line through the loose fallback', async () => {
      const root = await workspace({ 'part.txt': 'prefix value\n' })
      const result = await edit(root, 'part.txt', '    value', 'other')
      expect(result.failure?.code).toBe('text_not_found')
      expect(await read(root, 'part.txt')).toBe('prefix value\n')
    })

    it('never edits a different file that contains old_string', async () => {
      const root = await workspace({ 'a.txt': 'alpha\n', 'b.txt': '    target line\n' })
      const result = await edit(root, 'a.txt', 'target line', 'changed')
      expect(result.ok).toBe(false)
      expect(await read(root, 'a.txt')).toBe('alpha\n')
      expect(await read(root, 'b.txt')).toBe('    target line\n')
    })

    it('never applies a block whose first and last lines match but whose middle differs', async () => {
      const original = 'start();\nkeepUserChange();\nend();\n'
      const root = await workspace({ 'mid.js': original })
      const result = await edit(
        root,
        'mid.js',
        'start();\nold();\nend();',
        'start();\nnew();\nend();'
      )
      expect(result.failure?.code).toBe('text_not_found')
      expect(result.error).toContain('file line 2 (not in old_string): keepUserChange();')
      expect(await read(root, 'mid.js')).toBe(original)
    })

    it('changes every loose match, and only those, with replace_all', async () => {
      const original = 'x {\n  call( a );\n}\ny {\n      call( a );\n}\ncall( ab );\n'
      const root = await workspace({ 'all.txt': original })
      const result = await edit(root, 'all.txt', 'call(  a  );', 'call(b);', true)
      expect(result.ok).toBe(true)
      expect(await read(root, 'all.txt')).toBe(
        'x {\n  call(b);\n}\ny {\n      call(b);\n}\ncall( ab );\n'
      )
    })

    it('still requires a read receipt before a loose match is applied', async () => {
      const root = await workspace({ 'r.txt': '    value  one\n' })
      const result = await edit(root, 'r.txt', 'value one', 'other', false, {
        requireReadReceipt: true
      })
      expect(result.failure?.code).toBe('read_required')
      expect(await read(root, 'r.txt')).toBe('    value  one\n')
    })
  })
})
