// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { browserTextTargetOwnsFocus } from './browserTextFocus'

// Execute the same self-contained function source injected into CDP node calls.
const ownsFocus = new Function(
  'return (' + browserTextTargetOwnsFocus.toString() + ')'
)() as typeof browserTextTargetOwnsFocus
afterEach(() => document.body.replaceChildren())

it.each(['open', 'closed', 'nested'] as const)(
  'recognizes genuine %s shadow focus and rejects wrong focus/blur',
  (mode) => {
    const host = document.createElement('div')
    document.body.append(host)
    let root = host.attachShadow({ mode: mode === 'closed' ? 'closed' : 'open' })
    if (mode === 'nested') {
      const inner = document.createElement('div')
      root.append(inner)
      root = inner.attachShadow({ mode: 'closed' })
    }
    const target = document.createElement('input')
    const wrong = document.createElement('input')
    root.append(target, wrong)
    target.focus()
    expect(document.activeElement).toBe(host)
    expect(root.activeElement).toBe(target)
    expect(document.activeElement === target).toBe(false) // Previous injected predicate rejected this.
    expect(ownsFocus(target)).toBe(true)
    wrong.focus()
    expect(ownsFocus(target)).toBe(false)
    target.focus()
    target.blur()
    expect(ownsFocus(target)).toBe(false)
  }
)

it('preserves ordinary input and contenteditable descendant focus behavior', () => {
  const input = document.createElement('input')
  const editor = document.createElement('div')
  Object.defineProperty(editor, 'isContentEditable', { value: true })
  const child = document.createElement('button')
  editor.append(child)
  document.body.append(input, editor)
  input.focus()
  expect(ownsFocus(input)).toBe(true)
  expect(ownsFocus(editor)).toBe(false)
  child.focus()
  expect(ownsFocus(editor)).toBe(true)
  expect(ownsFocus(input)).toBe(false)
})

it('rejects stale inner focus when an outer host is not active', () => {
  const other = document.createElement('div')
  const target = {
    getRootNode: () => ({
      activeElement: target,
      host: {
        getRootNode: () => ({ activeElement: other })
      }
    }),
    isContentEditable: false
  } as unknown as HTMLElement
  expect(ownsFocus(target)).toBe(false)
})
