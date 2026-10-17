// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WrittenTitle } from './WrittenTitle'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

describe('WrittenTitle', () => {
  let root: Root
  const animate = vi.fn()

  beforeEach(() => {
    root = createRoot(document.createElement('div'))
    animate.mockClear()
    Element.prototype.animate = animate
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    delete (Element.prototype as Partial<Element>).animate
  })

  const render = (text: string, identity: string): Promise<void> =>
    act(async () => root.render(<WrittenTitle text={text} identity={identity} />))

  it('writes in a chat’s new title', async () => {
    await render('New Conversation', 'chat-1')
    expect(animate).not.toHaveBeenCalled()
    await render('Greet the user in Spanish', 'chat-1')
    expect(animate).toHaveBeenCalledTimes(1)
  })

  it('just shows another chat’s title', async () => {
    await render('Greet the user in Spanish', 'chat-1')
    await render('Fix the navigation bar', 'chat-2')
    expect(animate).not.toHaveBeenCalled()
  })
})
