/**
 * A React artifact while its code is still arriving. The start of a component does not run, so
 * the draft is cut where the last complete JSX element (or word of text) ended and every element,
 * bracket and string still open there is closed. A cut that still does not run is simply not
 * shown; the next one usually does. Nothing here has to be exact, only cheap and never wrong
 * about the code that has arrived.
 */

type Frame =
  | { kind: '(' | '[' | '{' | 'template' | 'template-expr' | 'jsx-expr' }
  | { kind: 'tag' | 'children'; name: string }

const CLOSERS: Record<Exclude<Frame['kind'], 'tag' | 'children'>, string> = {
  '(': ')',
  '[': ']',
  '{': '}',
  template: '`',
  'template-expr': '}',
  'jsx-expr': '}'
}

/** Tokens after which `<` opens JSX and `/` opens a regular expression. */
const EXPRESSION_START = new Set([
  '',
  '(',
  ',',
  '=',
  ':',
  '?',
  '[',
  '{',
  '}',
  ';',
  '!',
  '&',
  '|',
  '>',
  'return'
])

const isNameStart = (char: string | undefined): boolean => !!char && /[A-Za-z_$]/.test(char)

function closersFor(stack: readonly Frame[]): string {
  let out = ''
  for (let index = stack.length - 1; index >= 0; index--) {
    const frame = stack[index]!
    if (frame.kind === 'children') out += `</${frame.name}>`
    else if (frame.kind === 'tag') return ''
    else out += CLOSERS[frame.kind]
  }
  return out
}

/** The code that has arrived, cut and closed so it can run, or null when nothing can be shown yet. */
export function closeArtifactDraft(code: string): string | null {
  const stack: Frame[] = []
  let safe: { at: number; closers: string } | null = null
  let last = ''
  const top = (): Frame | undefined => stack[stack.length - 1]
  const markSafe = (at: number): void => {
    safe = { at, closers: closersFor(stack) }
  }

  let i = 0
  while (i < code.length) {
    const char = code[i]!
    const next = code[i + 1]
    const frame = top()

    if (frame?.kind === 'template') {
      if (char === '\\') i += 2
      else if (char === '`') {
        stack.pop()
        last = 'x'
        i++
      } else if (char === '$' && next === '{') {
        stack.push({ kind: 'template-expr' })
        last = '{'
        i += 2
      } else i++
      continue
    }

    if (frame?.kind === 'tag') {
      if (char === '"' || char === "'") {
        const end = code.indexOf(char, i + 1)
        if (end < 0) break
        i = end + 1
      } else if (char === '{') {
        stack.push({ kind: 'jsx-expr' })
        last = '{'
        i++
      } else if (char === '/' && next === '>') {
        stack.pop()
        i += 2
        last = 'x'
        markSafe(i)
      } else if (char === '>') {
        stack[stack.length - 1] = { kind: 'children', name: frame.name }
        i++
        markSafe(i)
      } else i++
      continue
    }

    if (frame?.kind === 'children') {
      if (char === '{') {
        stack.push({ kind: 'jsx-expr' })
        last = '{'
        i++
      } else if (char === '<' && next === '/') {
        const end = code.indexOf('>', i + 2)
        if (end < 0) break
        stack.pop()
        i = end + 1
        last = 'x'
        markSafe(i)
      } else if (char === '<' && next === '>') {
        stack.push({ kind: 'children', name: '' })
        i += 2
        markSafe(i)
      } else if (char === '<' && isNameStart(next)) {
        const name = /^[\w$.:-]+/.exec(code.slice(i + 1))![0]
        stack.push({ kind: 'tag', name })
        i += 1 + name.length
      } else {
        i++
        // Text shows a word at a time.
        if (/\s/.test(char)) markSafe(i)
      }
      continue
    }

    // JavaScript.
    if (char === '/' && next === '/') {
      const end = code.indexOf('\n', i)
      if (end < 0) break
      i = end + 1
      continue
    }
    if (char === '/' && next === '*') {
      const end = code.indexOf('*/', i + 2)
      if (end < 0) break
      i = end + 2
      continue
    }
    if (char === '"' || char === "'") {
      let j = i + 1
      while (j < code.length && code[j] !== char && code[j] !== '\n') j += code[j] === '\\' ? 2 : 1
      if (j >= code.length || code[j] !== char) break
      i = j + 1
      last = 'x'
      continue
    }
    if (char === '`') {
      stack.push({ kind: 'template' })
      i++
      continue
    }
    if (char === '/' && EXPRESSION_START.has(last)) {
      // A regular expression literal.
      let j = i + 1
      let inClass = false
      while (j < code.length && code[j] !== '\n') {
        const c = code[j]
        if (c === '\\') j++
        else if (c === '[') inClass = true
        else if (c === ']') inClass = false
        else if (c === '/' && !inClass) break
        j++
      }
      if (code[j] !== '/') break
      i = j + 1
      last = 'x'
      continue
    }
    if (char === '<' && EXPRESSION_START.has(last) && (next === '>' || isNameStart(next))) {
      if (next === '>') {
        stack.push({ kind: 'children', name: '' })
        i += 2
        markSafe(i)
      } else {
        const name = /^[\w$.:-]+/.exec(code.slice(i + 1))![0]
        stack.push({ kind: 'tag', name })
        i += 1 + name.length
      }
      continue
    }
    if (char === '(' || char === '[' || char === '{') {
      stack.push({ kind: char })
      last = char
      i++
      continue
    }
    if (char === ')' || char === ']' || char === '}') {
      const open = top()
      if (!open || !(open.kind in CLOSERS) || CLOSERS[open.kind as keyof typeof CLOSERS] !== char) {
        // Unbalanced: the code is not what this reader expects.
        return safe ? cut(code, safe) : null
      }
      stack.pop()
      last = char === '}' ? '}' : 'x'
      i++
      continue
    }
    if (isNameStart(char)) {
      const word = /^[\w$]+/.exec(code.slice(i))![0]
      last = word === 'return' ? 'return' : 'x'
      i += word.length
      continue
    }
    if (/\s/.test(char)) {
      i++
      continue
    }
    if (/[0-9]/.test(char)) last = 'x'
    else last = char
    i++
  }

  // Reading stops early inside a comment, string or tag that has not ended yet.
  if (!stack.length && i >= code.length) return code
  return safe ? cut(code, safe) : null
}

function cut(code: string, safe: { at: number; closers: string }): string {
  return code.slice(0, safe.at) + safe.closers
}

/** Component names a draft uses before it defines them, which run as placeholders until they arrive. */
export function undefinedDraftComponents(code: string, provided: ReadonlySet<string>): string[] {
  const used = new Set<string>()
  for (const match of code.matchAll(/<([A-Z][\w$]*)[\s/>]/g)) used.add(match[1]!)
  const declared = new Set<string>()
  for (const match of code.matchAll(/\b(?:function|class|const|let|var)\s+([A-Z][\w$]*)/g)) {
    declared.add(match[1]!)
  }
  for (const match of code.matchAll(/\bimport\s+([\s\S]*?)\s+from\b/g)) {
    for (const name of match[1]!.match(/[A-Za-z_$][\w$]*/g) ?? []) declared.add(name)
  }
  return [...used].filter((name) => !declared.has(name) && !provided.has(name))
}
