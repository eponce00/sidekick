// @vitest-environment jsdom

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useFollowBottom } from './useFollowBottom'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let setText: (text: string) => void = () => undefined
let box: HTMLDivElement | null = null

function Streaming({ streaming }: { streaming: boolean }): React.JSX.Element {
  const [text, update] = useState('first line')
  setText = update
  const ref = useFollowBottom<HTMLDivElement>(streaming)
  return (
    <div
      ref={(element) => {
        ref.current = element
        box = element
      }}
    >
      {text}
    </div>
  )
}

/** jsdom has no layout; give the box a fixed view over content that grows with its text. */
function layOut(element: HTMLDivElement): void {
  Object.defineProperty(element, 'clientHeight', { configurable: true, value: 100 })
  Object.defineProperty(element, 'scrollHeight', {
    configurable: true,
    get: () => 40 * (element.textContent?.length ?? 0)
  })
}

describe('useFollowBottom', () => {
  let root: Root
  let container: HTMLDivElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('follows streaming text to the end until the reader scrolls up', async () => {
    // Streaming thinking grew inside its box while the box stayed at the top.
    await act(async () => root.render(<Streaming streaming={false} />))
    layOut(box!)
    await act(async () => root.render(<Streaming streaming />))
    await act(async () => setText('first line, then more thinking'))
    expect(box!.scrollTop).toBe(box!.scrollHeight)

    // Reading something above: new text no longer pulls the box down.
    box!.scrollTop = 0
    box!.dispatchEvent(new Event('scroll'))
    await act(async () => setText('first line, then more thinking, and still more'))
    expect(box!.scrollTop).toBe(0)
  })

  it('leaves a finished block where the reader opened it', async () => {
    await act(async () => root.render(<Streaming streaming={false} />))
    layOut(box!)
    await act(async () => setText('a finished thought that is long'))
    expect(box!.scrollTop).toBe(0)
  })
})
