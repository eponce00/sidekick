// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import type { ToolExecution } from '../types/chat.types'
import { RichDiffBlock } from './RichDiffBlock'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

describe('RichDiffBlock', () => {
  it('says a change that has not run yet is not written, instead of an empty +0 −0 diff', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const write = (status: ToolExecution['status']): ToolExecution => ({
      id: 'write-1',
      title: 'write settings.gradle',
      command: 'write',
      name: 'write',
      status
    })

    await act(async () => root.render(<RichDiffBlock tool={write('pending')} />))
    expect(container.textContent).toBe('Not written yet')
    expect(container.querySelector('.rich-diff-block')).toBeNull()

    await act(async () => root.render(<RichDiffBlock tool={write('success')} />))
    expect(container.textContent).toBe('No line changes')

    await act(async () => root.unmount())
    container.remove()
  })
})
